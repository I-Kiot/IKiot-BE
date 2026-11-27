import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionService } from '../subscriptions/subscriptions.service';
import { LocationStatus } from '../../common/constants/location-status';
import { UserStatus } from '../../common/constants/user-status';
import { paginate, skipFor } from '../../common/utils/pagination';
import { isSameName } from '../../common/utils/same-name';
import { LOCATION_INCLUDE } from './location.types';
import type { LocationConfig, LocationRow } from './location.types';
import { locationReadScope } from './location-read-scope';
import type { AuthUser } from '../../common/types/auth-user.type';
import { ErrorCode } from '../../common/errors/error-codes';
import type { Prisma } from '../../../generated/prisma/client';

/** Tham số danh sách địa điểm. */
export interface LocationQuery {
  search?: string;
  status?: string;
  page: number;
  limit: number;
}

/** Các trường client được đặt, dùng chung cho CreateBranchDto và CreateWarehouseDto. */
export interface LocationInput {
  name?: string;
  phoneNumber?: string[];
  address?: string;
  email?: string;
  status?: string;
}

/** Logic chung cho chi nhánh và kho. */
export abstract class LocationService {
  protected constructor(
    protected readonly prisma: PrismaService,
    protected readonly subscriptions: SubscriptionService,
    private readonly config: LocationConfig,
  ) {}

  /** Bỏ `type` vì route đã cho biết loại. */
  protected toResponse(row: LocationRow) {
    const { type, ...rest } = row;
    return rest;
  }

  /** `read_own` chỉ thấy nơi được phân công. */
  async findAll(user: AuthUser, tenantId: string, query: LocationQuery) {
    const where: Prisma.LocationWhereInput = {
      tenantId,
      type: this.config.kind,
      // Không có bộ lọc rõ ràng thì ẩn thùng rác.
      status: query.status ?? { not: LocationStatus.DELETED },
    };

    const readScope = locationReadScope(user, this.config.kind);
    if (readScope.scope === 'OWN') {
      if (readScope.ownLocationId === null) {
        return paginate([], 0, query.page, query.limit);
      }
      where.id = readScope.ownLocationId;
    }
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }

    const [rows, total] = await Promise.all([
      this.prisma.location.findMany({
        where,
        include: LOCATION_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.location.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toResponse(row)),
      total,
      query.page,
      query.limit,
    );
  }

  /** Lọc theo tenant, không thấy thì 404. */
  protected async findRow(tenantId: string, id: string): Promise<LocationRow> {
    const row = await this.prisma.location.findFirst({
      where: { id, tenantId, type: this.config.kind },
      include: LOCATION_INCLUDE,
    });
    if (!row) throw this.notFound();
    return row;
  }

  private notFound() {
    return new NotFoundException({
      code: ErrorCode.LOCATION_NOT_FOUND,
      message: this.config.messages.notFound,
    });
  }

  /** Chỉ có `read_own` thì địa điểm không phải nơi được phân công trả 404, như không tồn tại. */
  async findOne(user: AuthUser, tenantId: string, id: string) {
    const readScope = locationReadScope(user, this.config.kind);
    if (readScope.scope === 'OWN' && readScope.ownLocationId !== id) {
      throw this.notFound();
    }
    return this.toResponse(await this.findRow(tenantId, id));
  }

  /** Tên chi nhánh / kho không trùng trong shop. */
  private async assertNameFree(
    tenantId: string,
    name: string,
    exceptId?: string,
  ) {
    const rows = await this.prisma.location.findMany({
      where: {
        tenantId,
        type: this.config.kind,
        status: { not: LocationStatus.DELETED },
      },
      select: { id: true, name: true },
    });
    if (rows.some((row) => row.id !== exceptId && isSameName(row.name, name))) {
      throw new ConflictException({
        code: ErrorCode.LOCATION_NAME_TAKEN,
        message: `A ${this.config.specialization} named "${name.trim()}" already exists`,
      });
    }
  }

  async create(tenantId: string, dto: LocationInput & { name: string }) {
    await this.assertNameFree(tenantId, dto.name);
    // Kiểm gói và hạn mức.
    await this.subscriptions.assertQuota(
      tenantId,
      this.config.quotaField,
      () =>
        this.prisma.location.count({
          where: {
            tenantId,
            type: this.config.kind,
            status: { not: LocationStatus.DELETED },
          },
        }),
      this.config.messages.quotaLabel,
    );
    // Tạo dòng chuyên biệt dùng chung id với Location.
    const id = randomUUID();
    const specialization = { create: { id, tenantId } };
    const row = await this.prisma.location.create({
      data: {
        id,
        tenantId,
        type: this.config.kind,
        branch: specialization,
        ...(this.config.specialization === 'warehouse'
          ? { warehouse: specialization }
          : {}),
        name: dto.name,
        phoneNumber: dto.phoneNumber ?? [],
        address: dto.address,
        email: dto.email,
      },
      include: LOCATION_INCLUDE,
    });

    // Địa điểm mới chưa có dòng tồn.
    return this.toResponse(row);
  }

  async update(tenantId: string, id: string, dto: LocationInput) {
    // Kiểm tenant trước khi update theo id.
    const existing = await this.findRow(tenantId, id);
    if (dto.name !== undefined && !isSameName(dto.name, existing.name)) {
      await this.assertNameFree(tenantId, dto.name, id);
    }

    const row = await this.prisma.location.update({
      where: { id },
      data: {
        name: dto.name,
        phoneNumber: dto.phoneNumber,
        address: dto.address,
        email: dto.email,
        status: dto.status,
      },
      include: LOCATION_INCLUDE,
    });
    return this.toResponse(row);
  }

  /** Xoá mềm địa điểm. */
  async remove(tenantId: string, id: string) {
    const existing = await this.findRow(tenantId, id);
    if (existing.status === LocationStatus.DELETED) {
      throw new BadRequestException({
        code: ErrorCode.LOCATION_ALREADY_DELETED,
        message: this.config.messages.alreadyDeleted,
      });
    }

    // Chặn xoá khi còn nhân viên gắn vào.
    const staffCount = await this.prisma.user.count({
      where: {
        tenantId,
        locationId: id,
        status: { not: UserStatus.DELETED },
      },
    });
    if (staffCount > 0) {
      throw new BadRequestException({
        code: ErrorCode.LOCATION_STAFF_STILL_ATTACHED,
        message: this.config.messages.staffStillAttached(staffCount),
      });
    }

    const row = await this.prisma.location.update({
      where: { id },
      data: { status: LocationStatus.DELETED, managerId: null },
      include: LOCATION_INCLUDE,
    });
    return this.toResponse(row);
  }

  /** Bổ nhiệm quản lý địa điểm. */
  protected async appointManager(
    tenantId: string,
    locationId: string,
    staffId: string,
  ) {
    const location = await this.prisma.location.findFirst({
      where: {
        id: locationId,
        tenantId,
        type: this.config.kind,
        status: { not: LocationStatus.DELETED },
      },
      include: LOCATION_INCLUDE,
    });
    if (!location)
      throw new NotFoundException({
        code: ErrorCode.LOCATION_NOT_FOUND,
        message: this.config.messages.notFound,
      });

    const staff = await this.prisma.user.findFirst({
      where: { id: staffId, tenantId, status: UserStatus.ACTIVE },
    });
    if (!staff) {
      throw new BadRequestException({
        code: ErrorCode.LOCATION_STAFF_NOT_ELIGIBLE,
        message: this.config.messages.staffNotEligible,
      });
    }

    // Bổ nhiệm không được âm thầm chuyển người đi, nên nơi công tác cũ được gỡ trước chứ không ghi đè.
    if (staff.locationId !== null && staff.locationId !== locationId) {
      throw new BadRequestException({
        code: ErrorCode.LOCATION_STAFF_POSTED_ELSEWHERE,
        message: this.config.messages.staffPostedElsewhere,
      });
    }

    const [, updated] = await this.prisma.$transaction([
      // Mỗi user làm đúng một địa điểm, theo cột `location_id`.
      this.prisma.user.update({
        where: { id: staffId },
        data: { locationId },
      }),
      this.prisma.location.update({
        where: { id: locationId },
        data: { managerId: staffId },
        include: LOCATION_INCLUDE,
      }),
    ]);

    return updated.manager;
  }
}
