-- Mã hàng (product_code) duy nhất trong tenant, như sku.
--
-- Trước migration này hai đường tạo mặt hàng chép nguyên mã hàng của mặt hàng gốc:
-- ProductVariantService.createVariant (phiên bản mới, SKU "<gốc>-V<n>") và
-- OrderCustomizationService.apply (hàng đặt riêng, SKU "<gốc>-C<...>"). Code mới cho chúng
-- mã hàng = SKU của chính nó; ở đây sửa các dòng đã ghi theo cùng quy tắc.
--
-- Trong mỗi nhóm trùng, dòng tạo sớm nhất giữ mã. Các dòng còn lại lấy SKU của mình nếu SKU đó chưa
-- là mã hàng của dòng nào trong tenant (và không bị hai dòng cùng xin), nếu không thì
-- "<mã cũ>-<8 ký tự đầu id>".
WITH ranked AS (
  SELECT id, tenant_id, product_code, sku,
         row_number() OVER (PARTITION BY tenant_id, product_code ORDER BY created_at, id) AS rn
  FROM product_items
),
losers AS (
  SELECT * FROM ranked WHERE rn > 1
),
proposed AS (
  SELECT l.id, l.tenant_id, l.product_code,
         CASE
           WHEN l.sku IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM product_items p
              WHERE p.tenant_id = l.tenant_id AND p.product_code = l.sku
            )
            AND (SELECT count(*) FROM losers o WHERE o.tenant_id = l.tenant_id AND o.sku = l.sku) = 1
           THEN l.sku
           ELSE l.product_code || '-' || left(l.id, 8)
         END AS new_code
  FROM losers l
)
UPDATE product_items p
SET product_code = proposed.new_code
FROM proposed
WHERE p.id = proposed.id;

-- DropIndex
DROP INDEX "product_items_tenant_id_product_code_idx";

-- CreateIndex
CREATE UNIQUE INDEX "product_items_tenant_id_product_code_key" ON "product_items"("tenant_id", "product_code");
