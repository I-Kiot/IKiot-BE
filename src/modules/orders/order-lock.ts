import type { Prisma } from '../../../generated/prisma/client';

/**
 * Khoá dòng đơn (`SELECT … FOR UPDATE`) làm câu ĐẦU TIÊN của mọi transaction đụng tới tiền: thu tiền mặt, tạo lại QR, huỷ, sửa, hoàn tiền, nộp tiền, chốt đơn quầy, webhook SePay.
 * Hai request cùng đơn xếp hàng ở đây, nên khi vào được thì đọc lại các khoản và suy ra trạng thái trong transaction là đọc đúng; các lệnh chiếm có điều kiện vẫn giữ làm lớp phòng thủ thứ hai.
 * Thứ tự khoá luôn là: dòng sổ SePay → đơn → các khoản. Transaction của người dùng không bao giờ chạm `sepay_transactions` sau khi giữ đơn, nên không có vòng chờ nhau.
 * Trả `false` khi không có đơn đó trong tenant (người gọi quyết định 404 hay 409).
 */
export async function lockOrder(
  tx: Prisma.TransactionClient,
  tenantId: string,
  orderId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM orders WHERE id = ${orderId} AND tenant_id = ${tenantId} FOR UPDATE
  `;
  return rows.length === 1;
}
