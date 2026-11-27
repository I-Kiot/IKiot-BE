-- Mã vạch (barcode) duy nhất trong tenant khi có điền.
--
-- Mã vạch là tuỳ chọn. Trống phải là NULL (Postgres không coi hai NULL là trùng), nhưng form tạo hàng
-- từng ghi chuỗi rỗng '' - nên trước hết đổi mọi giá trị chỉ có khoảng trắng thành NULL và bỏ khoảng
-- trắng hai đầu.
UPDATE product_items SET barcode = NULLIF(btrim(barcode), '') WHERE barcode IS NOT NULL;

-- Mã vạch thật bị trùng thì KHÔNG tự sửa: mã vạch in trên hàng, chỉ người biết hàng mới chọn được mặt
-- hàng nào giữ nó. Dừng migration và nêu tên các mã để sửa tay rồi chạy lại.
DO $$
DECLARE
  dupes text;
BEGIN
  SELECT string_agg(format('tenant %s: %s (%s dòng)', tenant_id, barcode, n), '; ')
    INTO dupes
  FROM (
    SELECT tenant_id, barcode, count(*) AS n
    FROM product_items
    WHERE barcode IS NOT NULL
    GROUP BY tenant_id, barcode
    HAVING count(*) > 1
  ) d;
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION 'Mã vạch bị trùng, sửa tay trước khi chạy lại migration: %', dupes;
  END IF;
END $$;

-- DropIndex
DROP INDEX "product_items_tenant_id_barcode_idx";

-- CreateIndex
CREATE UNIQUE INDEX "product_items_tenant_id_barcode_key" ON "product_items"("tenant_id", "barcode");
