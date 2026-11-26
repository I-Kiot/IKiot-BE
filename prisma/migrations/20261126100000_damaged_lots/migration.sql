-- Hàng hỏng chuyển từ "kho hàng hỏng riêng" (locations.is_sellable = false + damaged_location_id) sang cờ trên lô
-- (2026-11-26). Lô hỏng nằm ngay tại địa điểm của nó nhưng không thuộc inventories.stock.

-- 1. Cờ trên lô.
ALTER TABLE "inventory_lots" ADD COLUMN "is_sellable" BOOLEAN NOT NULL DEFAULT true;

-- 2. Kho hàng hỏng cũ thành kho thường: mọi lô ở đó là lô hỏng và rời khỏi stock. Chưa có dữ liệu thật
--    (chốt với chủ dự án 2026-11-26), nhưng giữ dữ liệu dev nhất quán thay vì xoá kho có khoá ngoại khắp nơi.
UPDATE "inventory_lots" lot
SET "is_sellable" = false
FROM "locations" loc
WHERE loc."id" = lot."location_id" AND loc."is_sellable" = false;

UPDATE "inventories" inv
SET "stock" = 0, "locked_stock" = 0, "updated_at" = now()
FROM "locations" loc
WHERE loc."id" = inv."location_id" AND loc."is_sellable" = false;

-- 3. Bỏ cấu hình kho hỏng ở cấp địa điểm.
ALTER TABLE "locations" DROP CONSTRAINT "locations_damaged_location_id_fkey";
ALTER TABLE "locations" DROP COLUMN "damaged_location_id";
ALTER TABLE "locations" DROP COLUMN "is_sellable";

-- 4. Tìm nhanh hàng hỏng còn lại (danh sách hàng hoá lọc "Có hàng hỏng"). Lô hỏng ít nên index nhỏ.
CREATE INDEX "inventory_lots_damaged_idx"
  ON "inventory_lots" ("tenant_id", "location_id", "product_item_id")
  WHERE "is_sellable" = false AND "remaining_quantity" > 0;

-- 5. Quyền đánh dấu hỏng / sửa xong / huỷ hàng hỏng. Seed `CATALOG` có cùng cặp; ON CONFLICT để DB đã seed không bị đụng.
INSERT INTO "permission_catalog" ("resource", "action", "label", "description") VALUES
  ('inventory', 'manage_damaged', 'Tồn kho',
   'Đánh dấu hàng hỏng, xác nhận sửa xong và huỷ / thanh lý hàng hỏng tại nơi mình làm việc. Hàng hỏng nằm ngoài tồn bán được.')
ON CONFLICT ("resource", "action") DO NOTHING;
