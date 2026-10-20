import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

// Thuộc tính của sản phẩm (2026-10-16): định nghĩa ở Product (`ProductAttribute`), mỗi SKU giữ giá trị trong
// `ProductItemDetail.attributeId`. Mọi chỗ ghi giá trị thuộc tính của SKU đi qua `writeItemDetails` để một tên
// thuộc tính luôn trỏ về đúng một dòng của sản phẩm.

export type DetailInput = { name?: string | null; value?: string | null };
export type AttributeInput = {
  id?: string;
  name: string;
  unit?: string | null;
};

// NFC: cùng một chữ tiếng Việt gõ bằng bộ gõ khác nhau có thể ra dạng dựng sẵn hoặc tổ hợp - phải so như nhau.
const clean = (text: string | null | undefined) =>
  (text ?? '').normalize('NFC').trim();

/** Bộ giá trị của một SKU theo thuộc tính: attributeId → giá trị đã trim. Dòng ghi tự do (không có thuộc tính) bị bỏ qua. */
export function valueMap(
  details: { attributeId: string | null; value: string | null }[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const detail of details) {
    if (detail.attributeId && clean(detail.value)) {
      map.set(detail.attributeId, clean(detail.value));
    }
  }
  return map;
}

/** Hai bộ giá trị có giống hệt nhau không (cùng thuộc tính, cùng giá trị) - hai SKU là một phiên bản. */
export function sameValues(
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key)?.toLocaleLowerCase('vi') !== value.toLocaleLowerCase('vi'))
      return false;
  }
  return true;
}

/** Thay toàn bộ danh sách thuộc tính của sản phẩm: giữ dòng theo `id` (đổi tên / đơn vị), thêm dòng mới, xoá dòng vắng mặt (giá trị của nó trên các SKU xoá theo). */
export async function replaceAttributes(
  tx: Prisma.TransactionClient,
  tenantId: string,
  productId: string,
  attributes: AttributeInput[],
): Promise<void> {
  const rows = attributes
    .map((attr) => ({
      ...attr,
      name: clean(attr.name),
      unit: clean(attr.unit) || null,
    }))
    .filter((attr) => attr.name);
  const names = rows.map((attr) => attr.name.toLocaleLowerCase('vi'));
  if (new Set(names).size !== names.length) {
    throw new BadRequestException({
      code: ErrorCode.PRODUCT_ATTRIBUTE_DUPLICATE,
      message: 'Two attributes of the product have the same name',
    });
  }
  const existing = await tx.productAttribute.findMany({
    where: { productId },
    select: { id: true },
  });
  const keep = new Set(rows.map((attr) => attr.id).filter(Boolean));
  const removed = existing
    .filter((row) => !keep.has(row.id))
    .map((row) => row.id);
  if (removed.length > 0) {
    await tx.productAttribute.deleteMany({ where: { id: { in: removed } } });
  }
  // Đổi tên trước bằng tên tạm để hai thuộc tính đổi chỗ tên cho nhau không vướng @@unique([productId, name]).
  const updates = rows.filter(
    (attr) => attr.id && existing.some((row) => row.id === attr.id),
  );
  for (const attr of updates) {
    await tx.productAttribute.update({
      where: { id: attr.id },
      data: { name: `__${attr.id}` },
    });
  }
  for (const [position, attr] of rows.entries()) {
    if (attr.id && updates.includes(attr)) {
      await tx.productAttribute.update({
        where: { id: attr.id },
        data: { name: attr.name, unit: attr.unit, position },
      });
      await tx.productItemDetail.updateMany({
        where: { attributeId: attr.id },
        data: { name: attr.name },
      });
    } else {
      await tx.productAttribute.create({
        data: {
          tenantId,
          productId,
          name: attr.name,
          unit: attr.unit,
          position,
        },
      });
    }
  }
}

/** Thêm đơn vị cho các thuộc tính có trong `attributes` mà chưa có - dùng lúc tạo sản phẩm, khi SKU đầu tiên đã tạo các thuộc tính theo tên. */
export async function upsertAttributeUnits(
  tx: Prisma.TransactionClient,
  tenantId: string,
  productId: string,
  attributes: AttributeInput[],
): Promise<void> {
  for (const [position, attr] of attributes.entries()) {
    const name = clean(attr.name);
    if (!name) continue;
    await tx.productAttribute.upsert({
      where: { productId_name: { productId, name } },
      create: {
        tenantId,
        productId,
        name,
        unit: clean(attr.unit) || null,
        position,
      },
      update: { unit: clean(attr.unit) || null, position },
    });
  }
}

/**
 * Ghi lại toàn bộ giá trị thuộc tính của một SKU. Mỗi tên được nối vào thuộc tính cùng tên của sản phẩm; tên mới
 * thì thêm thuộc tính cho sản phẩm (đứng cuối). Dòng thiếu tên hoặc giá trị bị bỏ.
 */
export async function writeItemDetails(
  tx: Prisma.TransactionClient,
  tenantId: string,
  productId: string,
  productItemId: string,
  details: DetailInput[],
): Promise<void> {
  const rows = details
    .map((detail) => ({ name: clean(detail.name), value: clean(detail.value) }))
    .filter((detail) => detail.name && detail.value);
  await tx.productItemDetail.deleteMany({ where: { productItemId } });
  if (rows.length === 0) return;

  const attributes = await tx.productAttribute.findMany({
    where: { productId },
    select: { id: true, name: true, position: true },
  });
  const byName = new Map(
    attributes.map((attr) => [attr.name.toLocaleLowerCase('vi'), attr]),
  );
  let nextPosition = attributes.reduce(
    (max, attr) => Math.max(max, attr.position + 1),
    0,
  );
  const data: Prisma.ProductItemDetailCreateManyInput[] = [];
  for (const row of rows) {
    let attr = byName.get(row.name.toLocaleLowerCase('vi'));
    if (!attr) {
      attr = await tx.productAttribute.create({
        data: { tenantId, productId, name: row.name, position: nextPosition++ },
        select: { id: true, name: true, position: true },
      });
      byName.set(row.name.toLocaleLowerCase('vi'), attr);
    }
    data.push({
      productItemId,
      attributeId: attr.id,
      name: attr.name,
      value: row.value,
      position: attr.position,
    });
  }
  await tx.productItemDetail.createMany({ data });
}
