import { LocationType } from '../../common/constants/location-type';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemRole } from '../../common/constants/system-role';
import { paginate, skipFor } from '../../common/utils/pagination';
import type { AuthUser } from '../../common/types/auth-user.type';
import {
  ApplicableRuleType,
  DiscountType,
  PromotionStatus,
} from './promotion.constants';
import {
  buildCandidateList,
  resolveSelectedPromotions,
} from './pricing-engine';
import type {
  CartContext,
  CartItem,
  PricingPromotion,
  PricingResult,
} from './pricing-engine';
import {
  CreatePromotionDto,
  PriceCartDto,
  QueryPromotionDto,
  UpdatePromotionDto,
} from './dto/promotion.dto';
import type { Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import { WALK_IN_CUSTOMER_CODE } from '../../common/constants/walk-in-customer';
import {
  BRANCH_NAME_SELECT,
  namedBranch,
} from '../../common/dto/location-ref.dto';

/** Log không thuộc đơn này. `orderId: { not }` một mình bỏ luôn log không gắn đơn (NULL <> x là NULL trong SQL). */
function notThisOrder(orderId: string): Prisma.PromotionLogWhereInput {
  return { OR: [{ orderId: null }, { orderId: { not: orderId } }] };
}

const PROMOTION_INCLUDE = {
  branches: { select: { branchId: true } },
  ruleCategories: { select: { categoryId: true } },
  ruleProductItems: { select: { productItemId: true } },
} as const satisfies Prisma.PromotionInclude;

type PromotionRow = Prisma.PromotionGetPayload<{
  include: typeof PROMOTION_INCLUDE;
}>;

/** Service khuyến mãi: phạm vi chi nhánh, tính toán ở `pricing-engine.ts`. */
@Injectable()
export class PromotionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: CreatePromotionDto) {
    this.assertDateOrder(dto.startDate, dto.endDate);
    this.assertCapOnlyForPercent(dto.discountType, dto.maxDiscountAmount);
    await this.assertBranchesExist(tenantId, dto.branchIds ?? []);
    await this.assertRuleTargetsExist(tenantId, dto.applicableRule);

    const created = await this.prisma.promotion.create({
      data: {
        tenantId,
        promoName: dto.promoName,
        description: dto.description,
        discountType: dto.discountType,
        discountValue: dto.discountValue,
        maxDiscountAmount: dto.maxDiscountAmount,
        minOrderValue: dto.minOrderValue ?? 0,
        applicableRuleType: dto.applicableRule.type,
        startDate: new Date(dto.startDate),
        endDate: new Date(dto.endDate),
        stackable: dto.stackable ?? false,
        usageLimit: dto.usageLimit,
        usageLimitPerCustomer: dto.usageLimitPerCustomer,
        usedCount: 0,
        status: PromotionStatus.ACTIVE,
        branches: {
          create: (dto.branchIds ?? []).map((branchId) => ({ branchId })),
        },
        ruleCategories: {
          create: (dto.applicableRule.categoryIds ?? []).map((categoryId) => ({
            categoryId,
          })),
        },
        ruleProductItems: {
          create: (dto.applicableRule.productItemIds ?? []).map(
            (productItemId) => ({ productItemId }),
          ),
        },
      },
      include: PROMOTION_INCLUDE,
    });

    return this.toResponse(created);
  }

  async findAll(user: AuthUser, tenantId: string, query: QueryPromotionDto) {
    const where: Prisma.PromotionWhereInput = {
      tenantId,
      ...this.branchScope(user, query.branchId),
    };
    if (query.status) where.status = query.status;
    if (query.search) {
      where.promoName = { contains: query.search, mode: 'insensitive' };
    }

    const [rows, total] = await Promise.all([
      this.prisma.promotion.findMany({
        where,
        include: PROMOTION_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.promotion.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toResponse(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(user: AuthUser, tenantId: string, id: string) {
    const promotion = await this.findRow(tenantId, id);
    this.assertBranchAccess(user, promotion);
    return this.toResponse(promotion);
  }

  async update(
    user: AuthUser,
    tenantId: string,
    id: string,
    dto: UpdatePromotionDto,
  ) {
    const existing = await this.findRow(tenantId, id);
    this.assertBranchAccess(user, existing);

    // Rule có điều kiện đọc field khác, nên được kiểm lại trên kết quả đã gộp chứ không chỉ trên request.
    const discountType = dto.discountType ?? existing.discountType;
    // Đổi sang số tiền cố định thì bỏ trần đang lưu, thay vì để nó gây lỗi.
    const clearsCap =
      discountType !== DiscountType.PERCENT && dto.maxDiscountAmount == null;
    const maxDiscountAmount = clearsCap
      ? undefined
      : (dto.maxDiscountAmount ??
        (existing.maxDiscountAmount === null
          ? undefined
          : Number(existing.maxDiscountAmount)));
    this.assertCapOnlyForPercent(discountType, maxDiscountAmount);
    this.assertDateOrder(
      dto.startDate ?? existing.startDate,
      dto.endDate ?? existing.endDate,
    );
    if (dto.branchIds) await this.assertBranchesExist(tenantId, dto.branchIds);
    if (dto.applicableRule) {
      await this.assertRuleTargetsExist(tenantId, dto.applicableRule);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.branchIds) {
        await tx.promotionBranch.deleteMany({ where: { promotionId: id } });
        await tx.promotionBranch.createMany({
          data: dto.branchIds.map((branchId) => ({
            promotionId: id,
            branchId,
          })),
        });
      }
      if (dto.applicableRule) {
        await tx.promotionCategory.deleteMany({ where: { promotionId: id } });
        await tx.promotionProductItem.deleteMany({
          where: { promotionId: id },
        });
        await tx.promotionCategory.createMany({
          data: (dto.applicableRule.categoryIds ?? []).map((categoryId) => ({
            promotionId: id,
            categoryId,
          })),
        });
        await tx.promotionProductItem.createMany({
          data: (dto.applicableRule.productItemIds ?? []).map(
            (productItemId) => ({ promotionId: id, productItemId }),
          ),
        });
      }

      return tx.promotion.update({
        where: { id },
        data: {
          promoName: dto.promoName,
          description: dto.description,
          discountType: dto.discountType,
          discountValue: dto.discountValue,
          maxDiscountAmount: clearsCap ? null : dto.maxDiscountAmount,
          minOrderValue: dto.minOrderValue,
          applicableRuleType: dto.applicableRule?.type,
          startDate: dto.startDate ? new Date(dto.startDate) : undefined,
          endDate: dto.endDate ? new Date(dto.endDate) : undefined,
          stackable: dto.stackable,
          usageLimit: dto.usageLimit,
          usageLimitPerCustomer: dto.usageLimitPerCustomer,
          status: dto.status,
          // usedCount cố ý không cho ghi - xem UpdatePromotionDto.
        },
        include: PROMOTION_INCLUDE,
      });
    });

    return this.toResponse(updated);
  }

  /** Xoá mềm về INACTIVE. */
  async deactivate(user: AuthUser, tenantId: string, id: string) {
    const existing = await this.findRow(tenantId, id);
    this.assertBranchAccess(user, existing);

    const updated = await this.prisma.promotion.update({
      where: { id },
      data: { status: PromotionStatus.INACTIVE },
      include: PROMOTION_INCLUDE,
    });
    return this.toResponse(updated);
  }

  async findLogs(
    user: AuthUser,
    tenantId: string,
    id: string,
    query: QueryPromotionDto,
  ) {
    const promotion = await this.findRow(tenantId, id);
    this.assertBranchAccess(user, promotion);

    const where: Prisma.PromotionLogWhereInput = { tenantId, promotionId: id };
    const [rows, total] = await Promise.all([
      this.prisma.promotionLog.findMany({
        where,
        include: {
          order: { select: { id: true, paymentReference: true } },
          customer: { select: { id: true, name: true, phone: true } },
          branch: BRANCH_NAME_SELECT,
        },
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.promotionLog.count({ where }),
    ]);

    const data = rows.map(({ discountAmount, ...log }) => ({
      ...log,
      branch: namedBranch(log.branch),
      discountAmount: Number(discountAmount),
      paymentReference: log.order?.paymentReference ?? null,
    }));

    return paginate(data, total, query.page, query.limit);
  }

  async listCandidates(tenantId: string, dto: PriceCartDto) {
    const { cart, candidates, usage } = await this.resolveCart(tenantId, dto);
    const entries = buildCandidateList(candidates, cart, new Date(), usage);

    const shape = (entry: (typeof entries)[number]) => ({
      id: entry.promotion.id,
      promoName: entry.promotion.promoName,
      description: entry.promotion.description,
      discountType: entry.promotion.discountType,
      discountValue: entry.promotion.discountValue,
      maxDiscountAmount: entry.promotion.maxDiscountAmount,
      minOrderValue: entry.promotion.minOrderValue,
      branchIds: entry.promotion.branchIds,
      stackable: entry.promotion.stackable,
      eligible: entry.eligible,
      reason: entry.reason,
      previewDiscount: entry.previewDiscount,
    });

    // Sắp: dùng được trước, giảm nhiều trước.
    const byUsefulness = (a: (typeof entries)[number], b: typeof a) =>
      a.eligible !== b.eligible
        ? a.eligible
          ? -1
          : 1
        : b.previewDiscount - a.previewDiscount;

    return {
      branchPromotions: entries
        .filter((entry) => entry.promotion.branchIds.length > 0)
        .sort(byUsefulness)
        .map(shape),
      systemPromotions: entries
        .filter((entry) => entry.promotion.branchIds.length === 0)
        .sort(byUsefulness)
        .map(shape),
    };
  }

  /** Chỉ xem trước: không ghi log, không đổi usedCount, không lưu gì. */
  async calculate(tenantId: string, dto: PriceCartDto): Promise<PricingResult> {
    const { cart, candidates, usage } = await this.resolveCart(tenantId, dto);
    return resolveSelectedPromotions(
      candidates,
      dto.promotionIds ?? [],
      cart,
      new Date(),
      usage,
    );
  }

  /**
   * Ghi lượt dùng khuyến mãi cho một đơn đã tạo. Từ 2026-11-27 tạo đơn (`POST /orders`, đơn quầy) tự ghi lượt trong
   * transaction của đơn, nên route này chỉ còn cho client cũ: lượt đã ghi cho đơn thì bỏ qua, không tính hai lần.
   */
  async apply(
    tenantId: string,
    userId: string,
    dto: PriceCartDto,
  ): Promise<PricingResult> {
    if (!dto.orderId) {
      throw new BadRequestException({
        code: ErrorCode.PROMOTION_ORDER_ID_REQUIRED,
        message: 'orderId is required to apply a promotion',
      });
    }
    const orderId = dto.orderId;

    const { cart, candidates, usage } = await this.resolveCart(tenantId, dto);
    const result = resolveSelectedPromotions(
      candidates,
      dto.promotionIds ?? [],
      cart,
      new Date(),
      usage,
    );
    if (result.appliedPromotions.length === 0) return result;

    await this.prisma.$transaction((tx) =>
      this.recordUsage(tx, tenantId, {
        orderId,
        branchId: cart.branchId,
        customerId: cart.customerId,
        applied: result.appliedPromotions,
        userId,
      }),
    );
    return result;
  }

  /**
   * Một lượt dùng cho mỗi khuyến mãi của đơn, trong transaction của bên gọi (tạo đơn, sửa đơn, `/apply`). Đây là nơi
   * duy nhất tăng `usedCount` và ghi `promotion_logs`, nên tính tiền và đếm lượt không thể lệch nhau: đơn rollback thì
   * lượt cũng rollback.
   *
   * Hai giới hạn được kiểm lại ở đây vì số đọc lúc tính giá có thể đã cũ (hai quầy, một khách mở hai tab):
   * - giới hạn chung qua `updateMany` có điều kiện, chỉ tăng khi còn lượt;
   * - giới hạn theo khách bằng cách đếm lại log của khách, không tính đơn này. Khách vãng lai (null hoặc dòng
   *   `KH_VANGLAI`) không dùng được khuyến mãi có giới hạn này. Khách mới tạo cùng đơn có 0 log nên lượt đầu qua.
   *
   * Khuyến mãi đã có log cho đơn thì bỏ qua: gọi lại không tính lượt lần hai.
   */
  async recordUsage(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: {
      orderId: string;
      branchId: string | null;
      customerId: string | null;
      applied: readonly {
        promotionId: string;
        promoName: string;
        discountAmount: number;
      }[];
      userId: string | null;
    },
  ): Promise<void> {
    if (input.applied.length === 0) return;
    const ids = input.applied.map((p) => p.promotionId);
    const [logged, promotions, customerId] = await Promise.all([
      tx.promotionLog.findMany({
        where: { orderId: input.orderId, promotionId: { in: ids } },
        select: { promotionId: true },
      }),
      tx.promotion.findMany({
        where: { tenantId, id: { in: ids } },
        select: { id: true, usageLimitPerCustomer: true },
      }),
      this.realCustomerId(tx, tenantId, input.customerId),
    ]);
    const done = new Set(logged.map((l) => l.promotionId));
    const capOf = new Map(
      promotions.map((p) => [p.id, p.usageLimitPerCustomer]),
    );

    for (const applied of input.applied) {
      if (done.has(applied.promotionId)) continue;
      const claimed = await tx.promotion.updateMany({
        where: {
          id: applied.promotionId,
          tenantId,
          OR: [
            { usageLimit: null },
            { usedCount: { lt: this.prisma.promotion.fields.usageLimit } },
          ],
        },
        data: { usedCount: { increment: 1 } },
      });
      if (claimed.count === 0) {
        throw new BadRequestException({
          code: ErrorCode.PROMOTION_USAGE_EXHAUSTED,
          message: `Promotion "${applied.promoName}" has no uses left`,
        });
      }

      const cap = capOf.get(applied.promotionId) ?? null;
      if (cap !== null) {
        if (!customerId) {
          throw new BadRequestException({
            code: ErrorCode.PROMOTION_CUSTOMER_REQUIRED,
            message: `Promotion "${applied.promoName}" is limited per customer and cannot go to a walk-in customer`,
          });
        }
        const used = await tx.promotionLog.count({
          where: {
            tenantId,
            promotionId: applied.promotionId,
            customerId,
            ...notThisOrder(input.orderId),
          },
        });
        if (used >= cap) {
          throw new BadRequestException({
            code: ErrorCode.PROMOTION_CUSTOMER_USAGE_EXHAUSTED,
            message: `This customer has no uses left for promotion "${applied.promoName}"`,
          });
        }
      }

      await tx.promotionLog.create({
        data: {
          tenantId,
          promotionId: applied.promotionId,
          orderId: input.orderId,
          branchId: input.branchId,
          customerId,
          discountAmount: applied.discountAmount,
          createdById: input.userId,
          description: `Áp dụng khuyến mãi "${applied.promoName}" cho đơn hàng`,
        },
      });
    }
  }

  /**
   * Đưa lượt dùng của một đơn về đúng các khuyến mãi đơn đang mang (sửa đơn). Khuyến mãi bị bỏ, hoặc mọi khuyến mãi khi
   * khách đổi, được trả lượt (giảm `usedCount`, xoá log); khuyến mãi còn lại cập nhật số tiền giảm; khuyến mãi mới đi
   * qua `recordUsage` với khách hiện tại.
   */
  async syncOrderUsage(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: {
      orderId: string;
      branchId: string | null;
      customerId: string | null;
      applied: readonly {
        promotionId: string;
        promoName: string;
        discountAmount: number;
      }[];
      userId: string | null;
    },
  ): Promise<void> {
    const [logs, customerId] = await Promise.all([
      tx.promotionLog.findMany({
        where: { tenantId, orderId: input.orderId },
        select: {
          id: true,
          promotionId: true,
          customerId: true,
          discountAmount: true,
        },
      }),
      this.realCustomerId(tx, tenantId, input.customerId),
    ]);
    const wanted = new Map(input.applied.map((p) => [p.promotionId, p]));
    for (const log of logs) {
      const keep = wanted.get(log.promotionId);
      if (keep && log.customerId === customerId) {
        if (Number(log.discountAmount) !== keep.discountAmount) {
          await tx.promotionLog.update({
            where: { id: log.id },
            data: { discountAmount: keep.discountAmount },
          });
        }
        continue;
      }
      // Trả lượt: chặn dưới 0 phòng dữ liệu cũ có log mà chưa từng tăng usedCount.
      await tx.promotion.updateMany({
        where: { id: log.promotionId, tenantId, usedCount: { gt: 0 } },
        data: { usedCount: { decrement: 1 } },
      });
      await tx.promotionLog.delete({ where: { id: log.id } });
    }
    await this.recordUsage(tx, tenantId, { ...input, customerId });
  }

  /** Khách thật của đơn, hoặc null cho khách vãng lai (chưa gắn khách, hoặc dòng `KH_VANGLAI`). */
  private async realCustomerId(
    tx: Prisma.TransactionClient,
    tenantId: string,
    customerId: string | null,
  ): Promise<string | null> {
    if (!customerId) return null;
    const customer = await tx.customer.findFirst({
      where: { id: customerId, tenantId },
      select: { customerCode: true },
    });
    return customer && customer.customerCode !== WALK_IN_CUSTOMER_CODE
      ? customerId
      : null;
  }

  private async resolveCart(tenantId: string, dto: PriceCartDto) {
    await this.assertCartRefs(tenantId, dto);
    const cart = await this.buildCartContext(tenantId, dto);
    cart.customerId = await this.realCustomerId(
      this.prisma,
      tenantId,
      cart.customerId,
    );
    // Chỉ khi chưa có khách: có `customerId` thì đó là khách thật hoặc vãng lai, không phải khách mới.
    cart.newCustomer = !dto.customerId && dto.newCustomer === true;
    const candidates = await this.findCandidates(tenantId, cart.branchId);
    // Tính lại một đơn đã có khuyến mãi (sửa đơn): lượt của chính đơn đó không được tính là đã dùng hết.
    if (dto.orderId) {
      const own = await this.prisma.promotionLog.findMany({
        where: { tenantId, orderId: dto.orderId },
        select: { promotionId: true },
      });
      const mine = new Set(own.map((l) => l.promotionId));
      for (const promotion of candidates) {
        if (mine.has(promotion.id)) {
          promotion.usedCount = Math.max(0, promotion.usedCount - 1);
        }
      }
    }
    const usage = await this.customerUsageCounts(
      tenantId,
      cart.customerId,
      candidates,
      dto.orderId,
    );
    return { cart, candidates, usage };
  }

  /** Kiểm mọi id trong giỏ thuộc tenant. */
  private async assertCartRefs(tenantId: string, dto: PriceCartDto) {
    const [branch, customer, order] = await Promise.all([
      dto.branchId
        ? this.prisma.branch.findFirst({
            where: { id: dto.branchId, tenantId },
            select: { id: true },
          })
        : null,
      dto.customerId
        ? this.prisma.customer.findFirst({
            where: { id: dto.customerId, tenantId, isDeleted: false },
            select: { id: true },
          })
        : null,
      dto.orderId
        ? this.prisma.order.findFirst({
            where: { id: dto.orderId, tenantId },
            select: { id: true },
          })
        : null,
    ]);
    if (dto.branchId && !branch) {
      throw new NotFoundException({
        code: ErrorCode.BRANCH_NOT_FOUND,
        message: 'Branch not found',
      });
    }
    if (dto.customerId && !customer) {
      throw new NotFoundException({
        code: ErrorCode.CUSTOMER_NOT_FOUND,
        message: 'Customer not found',
      });
    }
    if (dto.orderId && !order) {
      throw new NotFoundException({
        code: ErrorCode.ORDER_NOT_FOUND,
        message: 'Order not found',
      });
    }
  }

  /** Lấy danh mục cho từng dòng giỏ. */
  private async buildCartContext(
    tenantId: string,
    dto: PriceCartDto,
  ): Promise<CartContext> {
    const ids = [...new Set(dto.items.map((item) => item.productItemId))];
    const variants = await this.prisma.productItem.findMany({
      where: { tenantId, id: { in: ids } },
      select: {
        id: true,
        // Giá lấy từ server.
        retailPrice: true,
        product: { select: { categoryId: true } },
      },
    });
    if (variants.length !== ids.length) {
      throw new NotFoundException({
        code: ErrorCode.PRODUCT_ITEM_NOT_FOUND,
        message: 'Product item not found in the cart',
      });
    }
    const byId = new Map(variants.map((v) => [v.id, v]));

    // Index là định danh dòng.
    const items: CartItem[] = dto.items.map((item, lineId) => {
      const unitPrice = Number(byId.get(item.productItemId)!.retailPrice);
      return {
        lineId,
        productItemId: item.productItemId,
        categoryId: byId.get(item.productItemId)!.product.categoryId,
        quantity: item.quantity,
        unitPrice,
        lineTotal: Math.round(item.quantity * unitPrice),
      };
    });

    return {
      branchId: dto.branchId ?? null,
      customerId: dto.customerId ?? null,
      subtotal: items.reduce((sum, item) => sum + item.lineTotal, 0),
      items,
    };
  }

  private async findCandidates(
    tenantId: string,
    branchId: string | null,
  ): Promise<PricingPromotion[]> {
    const now = new Date();
    const rows = await this.prisma.promotion.findMany({
      where: {
        tenantId,
        status: PromotionStatus.ACTIVE,
        startDate: { lte: now },
        endDate: { gte: now },
        OR: [
          { branches: { none: {} } },
          ...(branchId ? [{ branches: { some: { branchId } } }] : []),
        ],
      },
      include: PROMOTION_INCLUDE,
    });
    return rows.map((row) => this.toPricingPromotion(row));
  }

  /** Số lần khách đã dùng các khuyến mãi có giới hạn. */
  private async customerUsageCounts(
    tenantId: string,
    customerId: string | null,
    candidates: PricingPromotion[],
    exceptOrderId?: string,
  ): Promise<Record<string, number>> {
    const capped = candidates
      .filter((p) => p.usageLimitPerCustomer !== null)
      .map((p) => p.id);
    if (!customerId || capped.length === 0) return {};

    const rows = await this.prisma.promotionLog.groupBy({
      by: ['promotionId'],
      where: {
        tenantId,
        customerId,
        promotionId: { in: capped },
        ...(exceptOrderId ? notThisOrder(exceptOrderId) : {}),
      },
      _count: { _all: true },
    });

    return Object.fromEntries(
      rows.map((row) => [row.promotionId, row._count._all]),
    );
  }

  private async findRow(tenantId: string, id: string): Promise<PromotionRow> {
    const promotion = await this.prisma.promotion.findFirst({
      where: { id, tenantId },
      include: PROMOTION_INCLUDE,
    });
    if (!promotion)
      throw new NotFoundException({
        code: ErrorCode.PROMOTION_NOT_FOUND,
        message: 'Promotion not found',
      });
    return promotion;
  }

  private assertDateOrder(start: Date | string, end: Date | string): void {
    if (new Date(end) <= new Date(start)) {
      throw new BadRequestException({
        code: ErrorCode.DATE_RANGE_INVALID,
        message: 'The end date must be after the start date',
      });
    }
  }

  /** Trần cho số tiền cố định chỉ là một số tiền cố định nhỏ hơn; từ chối để tránh nhầm lẫn. */
  private assertCapOnlyForPercent(
    discountType: string,
    cap?: number | null,
  ): void {
    // `null` cũng nghĩa là "không có trần" như `undefined`: form gửi null khi ô để trống.
    if (cap != null && discountType !== 'PERCENT') {
      throw new BadRequestException({
        code: ErrorCode.PROMOTION_MAX_DISCOUNT_INVALID,
        message: 'maxDiscountAmount is only valid for a percentage discount',
      });
    }
  }

  private async assertBranchesExist(tenantId: string, branchIds: string[]) {
    const unique = [...new Set(branchIds)];
    if (unique.length === 0) return;
    const found = await this.prisma.branch.count({
      where: {
        tenantId,
        id: { in: unique },
        location: { type: LocationType.BRANCH },
      },
    });
    if (found !== unique.length) {
      throw new NotFoundException({
        code: ErrorCode.BRANCH_NOT_FOUND,
        message: 'Branch not found',
      });
    }
  }

  private async assertRuleTargetsExist(
    tenantId: string,
    rule: { type: string; categoryIds?: string[]; productItemIds?: string[] },
  ) {
    if (rule.type === ApplicableRuleType.CATEGORY) {
      const unique = [...new Set(rule.categoryIds ?? [])];
      const found = await this.prisma.category.count({
        where: { tenantId, id: { in: unique } },
      });
      if (found !== unique.length) {
        throw new NotFoundException({
          code: ErrorCode.CATEGORY_NOT_FOUND,
          message: 'Category not found',
        });
      }
    }
    if (rule.type === ApplicableRuleType.PRODUCT) {
      const unique = [...new Set(rule.productItemIds ?? [])];
      const found = await this.prisma.productItem.count({
        where: { tenantId, id: { in: unique } },
      });
      if (found !== unique.length) {
        throw new NotFoundException({
          code: ErrorCode.PRODUCT_ITEM_NOT_FOUND,
          message: 'Product item not found',
        });
      }
    }
  }

  private branchScope(
    user: AuthUser,
    requestedBranchId?: string,
  ): Prisma.PromotionWhereInput {
    if (this.seesEveryBranch(user)) {
      return requestedBranchId
        ? { branches: { some: { branchId: requestedBranchId } } }
        : {};
    }
    return {
      OR: [
        { branches: { none: {} } },
        ...(user.branchId
          ? [{ branches: { some: { branchId: user.branchId } } }]
          : []),
      ],
    };
  }

  private assertBranchAccess(user: AuthUser, promotion: PromotionRow): void {
    if (this.seesEveryBranch(user)) return;
    if (promotion.branches.length === 0) return;
    const inScope = promotion.branches.some(
      (link) => link.branchId === user.branchId,
    );
    if (!inScope) {
      throw new ForbiddenException({
        code: ErrorCode.PROMOTION_BRANCH_DENIED,
        message: 'This promotion does not apply to your branch',
      });
    }
  }

  private seesEveryBranch(user: AuthUser): boolean {
    return (
      user.systemRole === SystemRole.TENANT_OWNER ||
      user.systemRole === SystemRole.ADMIN
    );
  }

  private toPricingPromotion(row: PromotionRow): PricingPromotion {
    return {
      id: row.id,
      promoName: row.promoName,
      description: row.description,
      status: row.status,
      startDate: row.startDate,
      endDate: row.endDate,
      discountType: row.discountType,
      discountValue: Number(row.discountValue),
      maxDiscountAmount:
        row.maxDiscountAmount === null ? null : Number(row.maxDiscountAmount),
      minOrderValue: Number(row.minOrderValue),
      stackable: row.stackable,
      usageLimit: row.usageLimit,
      usageLimitPerCustomer: row.usageLimitPerCustomer,
      usedCount: row.usedCount,
      branchIds: row.branches.map((link) => link.branchId),
      applicableRuleType: row.applicableRuleType,
      ruleCategoryIds: row.ruleCategories.map((link) => link.categoryId),
      ruleProductItemIds: row.ruleProductItems.map(
        (link) => link.productItemId,
      ),
    };
  }

  private toResponse(row: PromotionRow) {
    const {
      branches,
      ruleCategories,
      ruleProductItems,
      discountValue,
      maxDiscountAmount,
      minOrderValue,
      applicableRuleType,
      ...rest
    } = row;

    return {
      ...rest,
      discountValue: Number(discountValue),
      maxDiscountAmount:
        maxDiscountAmount === null ? null : Number(maxDiscountAmount),
      minOrderValue: Number(minOrderValue),
      branchIds: branches.map((link) => link.branchId),
      applicableRule: {
        type: applicableRuleType,
        categoryIds: ruleCategories.map((link) => link.categoryId),
        productItemIds: ruleProductItems.map((link) => link.productItemId),
      },
    };
  }
}
