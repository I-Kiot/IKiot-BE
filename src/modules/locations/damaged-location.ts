import { BadRequestException } from '@nestjs/common';
import { LocationStatus } from '../../common/constants/location-status';
import { ErrorCode } from '../../common/errors/error-codes';
import type { Prisma } from '../../../generated/prisma/client';

// Địa điểm hàng hỏng (D-4, contract §3): kho `isSellable = false` nhận hàng lỗi của đợt giao xưởng (B-5) và
// phần hỏng của đơn trả (D-5). Mỗi chi nhánh / kho nêu kho hỏng của mình ở `damagedLocationId`. Hai luật dưới giữ
// liên kết đó có nghĩa; DB chỉ có khoá ngoại.

/** Bất kỳ thứ gì đọc được địa điểm: `this.prisma` hay client trong transaction đều được. */
type LocationReader = Pick<Prisma.TransactionClient, 'location'>;

/**
 * `damagedLocationId` phải là địa điểm khác cùng tenant, chưa xoá, không bán hàng; nếu không hàng hỏng quay lại kệ bán.
 * `null` / `undefined` luôn qua.
 */
export async function assertDamagedLocationTarget(
  reader: LocationReader,
  tenantId: string,
  selfId: string | null,
  damagedLocationId: string | null | undefined,
): Promise<void> {
  if (!damagedLocationId) return;

  const invalid = (message: string) =>
    new BadRequestException({
      code: ErrorCode.LOCATION_DAMAGED_INVALID,
      message,
    });

  if (damagedLocationId === selfId) {
    throw invalid('A location cannot be its own damaged-goods location');
  }
  const target = await reader.location.findFirst({
    where: {
      id: damagedLocationId,
      tenantId,
      status: { not: LocationStatus.DELETED },
    },
    select: { isSellable: true },
  });
  // Địa điểm của tenant khác trả về y như không tồn tại.
  if (!target) {
    throw invalid('The damaged-goods location does not exist');
  }
  if (target.isSellable) {
    throw invalid(
      'The damaged-goods location must be a non-sellable warehouse (isSellable = false)',
    );
  }
}

/**
 * Đổi kho hỏng thành kho bán được sẽ phá luật trên với mọi địa điểm còn trỏ tới nó, nên bị từ chối
 * cho tới khi họ trỏ chỗ khác.
 */
export async function assertCanBecomeSellable(
  reader: LocationReader,
  tenantId: string,
  id: string,
): Promise<void> {
  const users = await reader.location.findMany({
    where: {
      tenantId,
      damagedLocationId: id,
      status: { not: LocationStatus.DELETED },
    },
    select: { name: true },
  });
  if (users.length > 0) {
    throw new BadRequestException({
      code: ErrorCode.LOCATION_DAMAGED_INVALID,
      message: `This warehouse is still the damaged-goods location of: ${users
        .map((location) => location.name)
        .join(', ')}. Point them elsewhere before making it sellable.`,
    });
  }
}
