import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate, skipFor } from '../../common/utils/pagination';
import { fromShiftTime, toShiftTime } from './shift-time';
import {
  QueryShiftTemplateDto,
  ShiftTemplateDto,
} from './dto/shift-template.dto';
import type { Prisma, ShiftTemplate } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

/** ACTIVE | DELETED - a shift template is soft-deleted, schedules point at it. */
export const ShiftTemplateStatus = {
  ACTIVE: 'ACTIVE',
  DELETED: 'DELETED',
} as const;

/** Named shift patterns that `WorkingSchedule` rows are cut from. Every read filters `status: ACTIVE`, including the by-id one: a deleted template is gone as far as this module is concerned, but the rows still point at it, so it is never removed. */
@Injectable()
export class ShiftTemplateService {
  constructor(private readonly prisma: PrismaService) {}

  /** Times go out as `HH:mm`, the shape the old string columns had. */
  private toResponse(row: ShiftTemplate) {
    return {
      ...row,
      startTime: fromShiftTime(row.startTime),
      endTime: fromShiftTime(row.endTime),
    };
  }

  async findAll(tenantId: string, query: QueryShiftTemplateDto) {
    const where: Prisma.ShiftTemplateWhereInput = {
      tenantId,
      status: ShiftTemplateStatus.ACTIVE,
    };
    if (query.name) {
      where.name = { contains: query.name, mode: 'insensitive' };
    }

    const [rows, total] = await Promise.all([
      this.prisma.shiftTemplate.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.shiftTemplate.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toResponse(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(tenantId: string, id: string) {
    return this.toResponse(await this.findRow(tenantId, id));
  }

  async create(tenantId: string, dto: ShiftTemplateDto) {
    const created = await this.prisma.shiftTemplate.create({
      data: {
        tenantId,
        name: dto.name,
        startTime: toShiftTime(dto.startTime),
        endTime: toShiftTime(dto.endTime),
        status: ShiftTemplateStatus.ACTIVE,
      },
    });
    return { message: 'Tạo ca mẫu thành công', data: this.toResponse(created) };
  }

  /** A full replace, not a merge - the old service `$set` the whole DTO. */
  async update(tenantId: string, id: string, dto: ShiftTemplateDto) {
    await this.findRow(tenantId, id);
    const updated = await this.prisma.shiftTemplate.update({
      where: { id },
      data: {
        name: dto.name,
        startTime: toShiftTime(dto.startTime),
        endTime: toShiftTime(dto.endTime),
      },
    });
    return {
      message: 'Cập nhật ca mẫu thành công',
      data: this.toResponse(updated),
    };
  }

  /** Soft delete: `WorkingSchedule.shiftTemplateId` is a real foreign key, so a hard delete would fail once the template had ever been scheduled - and those rows still need to say which shift they were. */
  async remove(tenantId: string, id: string) {
    await this.findRow(tenantId, id);
    const deleted = await this.prisma.shiftTemplate.update({
      where: { id },
      data: { status: ShiftTemplateStatus.DELETED },
    });
    return {
      message: 'Xóa ca mẫu thành công',
      data: { id: deleted.id, status: deleted.status },
    };
  }

  /** Every template a batch of schedules names, keyed by id. Keeping the lookup here means "a usable template is ACTIVE and in this tenant" is stated once, rather than in WorkingScheduleService's own copy. */
  async activeByIds(
    tenantId: string,
    ids: string[],
  ): Promise<Map<string, ShiftTemplate>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();

    const templates = await this.prisma.shiftTemplate.findMany({
      where: {
        id: { in: unique },
        tenantId,
        status: ShiftTemplateStatus.ACTIVE,
      },
    });
    if (templates.length !== unique.length) {
      throw new NotFoundException({
        code: ErrorCode.SHIFT_TEMPLATE_INVALID,
        message: 'One or more shift templates are invalid',
      });
    }
    return new Map(templates.map((template) => [template.id, template]));
  }

  private async findRow(tenantId: string, id: string): Promise<ShiftTemplate> {
    const row = await this.prisma.shiftTemplate.findFirst({
      where: { id, tenantId, status: ShiftTemplateStatus.ACTIVE },
    });
    if (!row)
      throw new NotFoundException({
        code: ErrorCode.SHIFT_TEMPLATE_NOT_FOUND,
        message: 'Shift template not found',
      });
    return row;
  }
}
