-- AlterTable
ALTER TABLE "product_item_details" ADD COLUMN     "attribute_id" TEXT;

-- CreateTable
CREATE TABLE "product_attributes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_attributes_tenant_id_idx" ON "product_attributes"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_attributes_product_id_name_key" ON "product_attributes"("product_id", "name");

-- CreateIndex
CREATE INDEX "product_item_details_attribute_id_idx" ON "product_item_details"("attribute_id");

-- AddForeignKey
ALTER TABLE "product_attributes" ADD CONSTRAINT "product_attributes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_attributes" ADD CONSTRAINT "product_attributes_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_item_details" ADD CONSTRAINT "product_item_details_attribute_id_fkey" FOREIGN KEY ("attribute_id") REFERENCES "product_attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: mỗi tên thuộc tính khác nhau trên các SKU của một sản phẩm thành một thuộc tính của sản phẩm đó (vị trí =
-- vị trí nhỏ nhất đã dùng), rồi nối giá trị cũ vào. Bỏ qua SKU custom sinh từ dòng đơn (order_items.is_custom): thông
-- số riêng của khách không phải thuộc tính của sản phẩm gốc - các dòng đó giữ attribute_id NULL.
INSERT INTO "product_attributes" ("id", "tenant_id", "product_id", "name", "position")
SELECT gen_random_uuid()::text, pi."tenant_id", pi."product_id", btrim(d."name"), MIN(d."position")
FROM "product_item_details" d
JOIN "product_items" pi ON pi."id" = d."product_item_id"
WHERE d."name" IS NOT NULL AND btrim(d."name") <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "order_items" oi WHERE oi."product_item_id" = pi."id" AND oi."is_custom"
  )
GROUP BY pi."tenant_id", pi."product_id", btrim(d."name");

UPDATE "product_item_details" d
SET "attribute_id" = a."id", "name" = a."name"
FROM "product_items" pi, "product_attributes" a
WHERE pi."id" = d."product_item_id"
  AND a."product_id" = pi."product_id"
  AND a."name" = btrim(d."name")
  AND NOT EXISTS (
    SELECT 1 FROM "order_items" oi WHERE oi."product_item_id" = pi."id" AND oi."is_custom"
  );

-- Đơn vị gõ lẫn vào giá trị ("140×70×75 cm"): thuộc tính mà MỌI giá trị đều kết thúc bằng cùng một đơn vị thì
-- chuyển đơn vị lên thuộc tính và cắt khỏi giá trị. Thuộc tính có giá trị lẫn đơn vị khác nhau thì để nguyên.
WITH u AS (
  SELECT d."attribute_id",
         MIN(lower(substring(d."value" from '\s(cm|mm|m|kg|g)$'))) AS unit,
         COUNT(*) AS n,
         COUNT(substring(d."value" from '\s(cm|mm|m|kg|g)$')) AS with_unit,
         COUNT(DISTINCT lower(substring(d."value" from '\s(cm|mm|m|kg|g)$'))) AS kinds
  FROM "product_item_details" d
  WHERE d."attribute_id" IS NOT NULL AND d."value" IS NOT NULL
  GROUP BY d."attribute_id"
)
UPDATE "product_attributes" a
SET "unit" = u.unit
FROM u
WHERE a."id" = u."attribute_id" AND a."unit" IS NULL AND u.n = u.with_unit AND u.kinds = 1;

UPDATE "product_item_details" d
SET "value" = btrim(regexp_replace(d."value", '\s+' || a."unit" || '$', ''))
FROM "product_attributes" a
WHERE a."id" = d."attribute_id" AND a."unit" IS NOT NULL AND d."value" ~ ('\s' || a."unit" || '$');
