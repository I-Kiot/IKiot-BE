import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreatePayrollSettingDto,
  UpdatePayrollSettingDto,
} from './dto/payroll-setting.dto';
import type { PayrollSetting } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

/** One row per tenant - the numbers every payroll calculation divides by, and exactly one setting per tenant (the old service enforced that by refusing a second create, and the schema carries no `@@unique`). `lateGraceMinutes` is read from here by attendance, the schedule view and payroll, which is why it is one tenant setting rather than three constants. */
@Injectable()
export class PayrollSettingService {
  constructor(private readonly prisma: PrismaService) {}

  /** The tenant's settings, or a 404: payroll needs these to compute anything, so "not configured" has to fail explicitly rather than divide salaries by a number nobody chose. */
  async findOne(tenantId: string): Promise<PayrollSetting> {
    const setting = await this.prisma.payrollSetting.findFirst({
      where: { tenantId },
    });
    if (!setting)
      throw new NotFoundException({
        code: ErrorCode.PAYROLL_SETTING_NOT_FOUND,
        message: 'Payroll settings not found',
      });
    return setting;
  }

  async create(tenantId: string, dto: CreatePayrollSettingDto) {
    const existing = await this.prisma.payrollSetting.findFirst({
      where: { tenantId },
      select: { id: true },
    });
    if (existing)
      throw new ConflictException({
        code: ErrorCode.PAYROLL_SETTING_EXISTS,
        message: 'Payroll settings already exist',
      });

    const data = await this.prisma.payrollSetting.create({
      data: { tenantId, ...dto },
    });
    return { message: 'Cấu hình lương đã được tạo thành công', data };
  }

  async update(tenantId: string, dto: UpdatePayrollSettingDto) {
    if (Object.keys(dto).length === 0) {
      throw new BadRequestException({
        code: ErrorCode.PAYROLL_SETTING_UPDATE_EMPTY,
        message: 'There is nothing to update',
      });
    }
    const current = await this.findOne(tenantId);
    const data = await this.prisma.payrollSetting.update({
      where: { id: current.id },
      data: dto,
    });
    return { message: 'Cấu hình lương đã được cập nhật thành công', data };
  }
}
