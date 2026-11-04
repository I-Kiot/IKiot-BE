import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { ErrorCode } from '../../common/errors/error-codes';

// Port từ phần quản lý gói của SubscriptionService. Cố ý không có create()/remove(): hệ thống cũ cũng không có, gói được quản lý trực tiếp trong DB.
@Injectable()
export class PlanService {
  constructor(private readonly prisma: PrismaService) {}

  listActive() {
    return this.prisma.plan.findMany({
      where: { isActive: true },
      orderBy: { price: 'asc' },
    });
  }

  listAll() {
    return this.prisma.plan.findMany({ orderBy: { price: 'asc' } });
  }

  findByCode(planCode: string, activeOnly = true) {
    return this.prisma.plan.findFirst({
      where: { planCode, ...(activeOnly ? { isActive: true } : {}) },
    });
  }

  async update(id: string, dto: UpdatePlanDto) {
    const payload = Object.fromEntries(
      Object.entries(dto).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(payload).length === 0) {
      throw new BadRequestException({
        code: ErrorCode.PLAN_UPDATE_EMPTY,
        message: 'No editable fields provided',
      });
    }
    return this.applyUpdate(id, payload);
  }

  setActive(id: string, isActive: boolean) {
    return this.applyUpdate(id, { isActive });
  }

  private async applyUpdate(id: string, data: Prisma.PlanUpdateInput) {
    try {
      return await this.prisma.plan.update({ where: { id }, data });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException({
          code: ErrorCode.PLAN_NOT_FOUND,
          message: 'Plan not found',
        });
      }
      throw error;
    }
  }
}
