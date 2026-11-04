import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate, skipFor } from '../../common/utils/pagination';
import {
  holidayDate,
  HolidaySource,
  HolidayType,
  yearRange,
} from './holiday.constants';
import {
  CreateHolidayDto,
  isRealCalendarDate,
  HOLIDAY_DATE_MESSAGE,
  QueryHolidayDto,
  ToggleHolidayStatusDto,
  UpdateHolidayDto,
} from './dto/holiday.dto';
import type { Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

/** Lịch ngày lễ của tenant: mọi dòng là `PUBLIC_HOLIDAY` với `branchId: null`. `isManuallyEdited` quan trọng: dòng người dùng sửa được đánh dấu và sync bỏ qua vĩnh viễn. */
@Injectable()
export class HolidayService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(tenantId: string, query: QueryHolidayDto) {
    const where: Prisma.HolidayWhereInput = {
      tenantId,
      type: HolidayType.PUBLIC_HOLIDAY,
      branchId: null,
    };
    if (query.year !== undefined) where.date = yearRange(query.year);
    if (query.isActive !== undefined) where.isActive = query.isActive;
    if (query.source) where.source = query.source;
    if (query.name) {
      where.name = { contains: query.name, mode: 'insensitive' };
    }

    const [rows, total] = await Promise.all([
      this.prisma.holiday.findMany({
        where,
        orderBy: { date: 'asc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.holiday.count({ where }),
    ]);

    return paginate(rows, total, query.page, query.limit);
  }

  async create(tenantId: string, dto: CreateHolidayDto) {
    this.assertRealDate(dto.date);

    return this.guardDuplicate(() =>
      this.prisma.holiday.create({
        data: {
          tenantId,
          date: holidayDate(dto.date),
          name: dto.name,
          type: HolidayType.PUBLIC_HOLIDAY,
          branchId: null,
          isActive: dto.isActive ?? true,
          source: HolidaySource.MANUAL,
          isManuallyEdited: true,
        },
      }),
    );
  }

  async update(tenantId: string, id: string, dto: UpdateHolidayDto) {
    if (dto.date === undefined && dto.name === undefined) {
      throw new BadRequestException({
        code: ErrorCode.HOLIDAY_UPDATE_EMPTY,
        message: 'Either date or name must be provided',
      });
    }
    if (dto.date !== undefined) this.assertRealDate(dto.date);
    await this.findRow(tenantId, id);

    return this.guardDuplicate(() =>
      this.prisma.holiday.update({
        where: { id },
        data: {
          ...(dto.date !== undefined ? { date: holidayDate(dto.date) } : {}),
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          isManuallyEdited: true,
        },
      }),
    );
  }

  /** Bật/tắt là route riêng (`ToggleHolidayStatusDto`), không nằm trong PATCH. */
  async updateStatus(
    tenantId: string,
    id: string,
    dto: ToggleHolidayStatusDto,
  ) {
    await this.findRow(tenantId, id);
    return this.prisma.holiday.update({
      where: { id },
      data: { isActive: dto.isActive, isManuallyEdited: true },
    });
  }

  /** Xoá cứng như service cũ: không có foreign key nào trỏ tới Holiday, nên không cần giữ vết; xoá nhầm thì lần sync sau sẽ đưa lại. */
  async remove(tenantId: string, id: string) {
    await this.findRow(tenantId, id);
    return this.prisma.holiday.delete({ where: { id } });
  }

  private async findRow(tenantId: string, id: string) {
    const holiday = await this.prisma.holiday.findFirst({
      where: { id, tenantId },
    });
    if (!holiday)
      throw new NotFoundException({
        code: ErrorCode.HOLIDAY_NOT_FOUND,
        message: 'Holiday not found',
      });
    return holiday;
  }

  /** `@Matches` chỉ kiểm tra định dạng; hàm này kiểm tra ngày có thật không (chặn `2026-02-31`). */
  private assertRealDate(value: string): void {
    if (!isRealCalendarDate(value)) {
      throw new BadRequestException({
        code: ErrorCode.HOLIDAY_DATE_INVALID,
        message: HOLIDAY_DATE_MESSAGE,
      });
    }
  }

  /** Đổi P2002 của `@@unique([tenantId, date, branchId, type])` thành thông báo của service cũ. Index chỉ có tác dụng nhờ migration partial index, vì `branchId` NULL sẽ không ràng buộc gì. */
  private async guardDuplicate<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === 'P2002'
      ) {
        throw new ConflictException({
          code: ErrorCode.HOLIDAY_DUPLICATE,
          message: 'This holiday already exists',
        });
      }
      throw error;
    }
  }
}
