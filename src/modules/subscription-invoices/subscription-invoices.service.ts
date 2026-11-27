import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ErrorCode } from '../../common/errors/error-codes';

// Hoá đơn gói chỉ đọc.
@Injectable()
export class SubscriptionInvoiceService {
  constructor(private readonly prisma: PrismaService) {}

  listForTenant(tenantId: string) {
    return this.prisma.subscriptionInvoice.findMany({
      where: { tenantId },
      include: { plan: { select: { planName: true, planCode: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  listAll() {
    return this.prisma.subscriptionInvoice.findMany({
      include: {
        plan: { select: { planName: true, planCode: true } },
        tenant: { select: { name: true, phoneNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getStatus(tenantId: string, invoiceId: string) {
    const invoice = await this.prisma.subscriptionInvoice.findFirst({
      where: { id: invoiceId, tenantId },
    });
    if (!invoice)
      throw new NotFoundException({
        code: ErrorCode.INVOICE_NOT_FOUND,
        message: 'Invoice not found',
      });
    return { status: invoice.status, paidAt: invoice.paidAt };
  }
}
