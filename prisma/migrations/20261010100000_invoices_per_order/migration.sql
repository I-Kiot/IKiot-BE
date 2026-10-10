-- Every order has one SALE invoice: PENDING from creation, ISSUED when the order is COMPLETED.
-- The number is only allocated on issue, so it has to be nullable.
ALTER TABLE "invoices" ALTER COLUMN "invoice_number" DROP NOT NULL;
ALTER TABLE "invoices" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- One live (PENDING or ISSUED) SALE invoice per order. Prisma cannot express a partial index, so
-- a future migrate dev will propose dropping it - edit this migration instead of applying that.
CREATE UNIQUE INDEX "invoices_one_live_sale_per_order"
  ON "invoices" ("order_id")
  WHERE "type" = 'SALE' AND "status" <> 'CANCELLED';

CREATE INDEX "invoices_tenant_id_status_created_at_idx" ON "invoices" ("tenant_id", "status", "created_at");

-- Backfill. COMPLETED orders get an ISSUED invoice, numbered HD000001... per shop in order of creation;
-- orders still on their way get a PENDING one. CANCELLED and RETURNED orders get none: they predate invoices.
WITH completed AS (
  SELECT o."id", o."tenant_id", o."subtotal", o."vat_total", o."grand_total", o."user_id", o."created_at", o."updated_at",
         row_number() OVER (PARTITION BY o."tenant_id" ORDER BY o."created_at", o."id") AS rn
  FROM "orders" o
  WHERE o."status" = 'COMPLETED'
)
INSERT INTO "invoices" ("id", "tenant_id", "order_id", "invoice_number", "type", "status", "subtotal", "vat_amount", "total", "issued_at", "created_by", "created_at", "updated_at")
SELECT gen_random_uuid()::text, c."tenant_id", c."id", 'HD' || lpad(c.rn::text, 6, '0'), 'SALE', 'ISSUED',
       c."subtotal", c."vat_total", c."grand_total", c."updated_at", c."user_id", c."created_at", now()
FROM completed c;

INSERT INTO "invoices" ("id", "tenant_id", "order_id", "type", "status", "subtotal", "vat_amount", "total", "created_by", "created_at", "updated_at")
SELECT gen_random_uuid()::text, o."tenant_id", o."id", 'SALE', 'PENDING',
       o."subtotal", o."vat_total", o."grand_total", o."user_id", o."created_at", now()
FROM "orders" o
WHERE o."status" NOT IN ('COMPLETED', 'CANCELLED', 'RETURNED');

-- Lines of the ISSUED backfill (a combo's components carry no price and stay off the invoice).
INSERT INTO "invoice_lines" ("id", "invoice_id", "order_item_id", "description", "quantity", "unit_price", "vat_rate", "amount", "position")
SELECT gen_random_uuid()::text, i."id", oi."id",
       trim(both ' ' from coalesce(oi."product_name", oi."sku", 'Sản phẩm') || coalesce(' - ' || oi."variant_label", '')),
       oi."quantity", oi."unit_price", coalesce(oi."vat_rate", 0), oi."line_total",
       (row_number() OVER (PARTITION BY i."id" ORDER BY oi."id") - 1)::int
FROM "invoices" i
JOIN "order_items" oi ON oi."order_id" = i."order_id"
WHERE i."status" = 'ISSUED' AND i."type" = 'SALE' AND oi."parent_item_id" IS NULL;
