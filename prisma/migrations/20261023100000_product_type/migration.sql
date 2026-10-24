-- AlterTable
ALTER TABLE "products" ADD COLUMN     "product_type" TEXT NOT NULL DEFAULT 'PRODUCT';

-- Backfill from the SKUs: a product whose every SKU is COMBO (or SERVICE) takes that type,
-- anything else - including a product that mixes PRODUCT and COMBO SKUs - stays PRODUCT.
-- A mixed product breaks the "every SKU has the product's type" rule and has to be split by
-- hand; list them with:
--   SELECT p.id, p.name FROM products p JOIN product_items pi ON pi.product_id = p.id
--   GROUP BY p.id HAVING count(DISTINCT pi.item_type) > 1;
UPDATE "products" p
SET "product_type" = t."item_type"
FROM (
    SELECT "product_id", min("item_type") AS "item_type"
    FROM "product_items"
    GROUP BY "product_id"
    HAVING count(DISTINCT "item_type") = 1
) t
WHERE t."product_id" = p."id"
  AND t."item_type" IN ('COMBO', 'SERVICE');

-- CreateIndex
CREATE INDEX "products_tenant_id_product_type_idx" ON "products"("tenant_id", "product_type");
