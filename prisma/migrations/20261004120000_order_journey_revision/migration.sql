-- The revised order journey (docs/hanh-trinh-don-hang.md, meeting of 2026-10-02;
-- docs/api-contract-order-flow.md §6). Generated with `prisma migrate diff` from the schema at
-- HEAD, then edited by hand in the places marked "HAND-WRITTEN":
--   0. preconditions - refuse to run while an order sits in a status the journey dropped;
--   1. orders.deposit_required renamed (not dropped), orders.code added nullable;
--   2. backfill - order codes, order-line and return statuses into the new vocabulary;
--   3. SQL-only constraints: the assignee CHECK without DRAFT, deposit bounds. Prisma cannot
--      express CHECKs and a later `migrate diff` will NOT propose dropping them;
--   4. drop stock reservations - refuses while any hold is still ACTIVE.
-- Stock reservations go: nothing holds stock for an order any more, so stock_reservations and
-- inventories.reserved are dropped (section 4), and with them the CHECK that tied the two.

-- ─── 0. HAND-WRITTEN: preconditions ──────────────────────────────────────────
-- DRAFT / READY_TO_PACK / DELIVERED no longer exist. A DRAFT has no person in charge (the new
-- CHECK would reject it) and a READY_TO_PACK still holds reservations nothing will release, so
-- each needs a human decision rather than a silent mapping.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "orders" WHERE "status" IN ('DRAFT', 'READY_TO_PACK', 'DELIVERED')) THEN
    RAISE EXCEPTION 'orders still in DRAFT / READY_TO_PACK / DELIVERED - confirm, ship or cancel them before migrating';
  END IF;
  -- An ACTIVE hold is goods somebody was promised; dropping it silently frees them for anyone.
  IF EXISTS (SELECT 1 FROM "stock_reservations" WHERE "status" = 'ACTIVE') THEN
    RAISE EXCEPTION 'stock_reservations still has ACTIVE holds - release them before migrating';
  END IF;
END $$;

-- AlterTable
-- HAND-WRITTEN (1): deposit_required is renamed, not dropped - Prisma's diff would lose the
-- amounts. code is added nullable here and set NOT NULL after the backfill below.
ALTER TABLE "orders" RENAME COLUMN "deposit_required" TO "deposit_amount";
ALTER TABLE "orders" ADD COLUMN     "code" TEXT,
ADD COLUMN     "deposit_percent" DECIMAL(5,2),
ADD COLUMN     "priority" TEXT NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "shipped_at" TIMESTAMPTZ(6),
ADD COLUMN     "shipped_by" TEXT;

-- AlterTable
ALTER TABLE "order_returns" ADD COLUMN     "completed_at" TIMESTAMPTZ(6),
ADD COLUMN     "received_at" TIMESTAMPTZ(6),
ADD COLUMN     "received_by" TEXT,
ADD COLUMN     "replacement_order_id" TEXT,
ALTER COLUMN "status" SET DEFAULT 'REQUESTED';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "remittance_confirmed_at" TIMESTAMPTZ(6),
ADD COLUMN     "remittance_confirmed_by" TEXT,
ADD COLUMN     "remittance_status" TEXT NOT NULL DEFAULT 'NOT_APPLICABLE';

-- CreateIndex
CREATE INDEX "orders_tenant_id_status_priority_idx" ON "orders"("tenant_id", "status", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "orders_tenant_id_code_key" ON "orders"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "payments_tenant_id_remittance_status_idx" ON "payments"("tenant_id", "remittance_status");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_shipped_by_fkey" FOREIGN KEY ("shipped_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_replacement_order_id_fkey" FOREIGN KEY ("replacement_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_remittance_confirmed_by_fkey" FOREIGN KEY ("remittance_confirmed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 2. HAND-WRITTEN: backfill ───────────────────────────────────────────────
-- Every order so far came from the till, which always set payment_reference
-- (generateReference(ORDER)) - the same code new orders get. The fallback only guards rows
-- written by hand.
UPDATE "orders"
SET "code" = COALESCE("payment_reference", 'DH-' || upper(left(replace("id", '-', ''), 12)));
ALTER TABLE "orders" ALTER COLUMN "code" SET NOT NULL;

-- Line statuses no longer track held stock. PACKED and DELIVERED lines had their stock
-- deducted already (packing consumed it), which is what SHIPPED means now; the waiting ones
-- deducted nothing.
UPDATE "order_items" SET "status" = 'SHIPPED' WHERE "status" IN ('PACKED', 'DELIVERED');
UPDATE "order_items" SET "status" = 'PENDING' WHERE "status" IN ('WAITING_STOCK', 'READY');

UPDATE "order_returns" SET "status" = 'REQUESTED' WHERE "status" = 'PENDING';
UPDATE "order_returns" SET "status" = 'COMPLETED', "completed_at" = "inspected_at"
WHERE "status" = 'INSPECTED';

-- ─── 3. HAND-WRITTEN: SQL-only constraints ───────────────────────────────────
-- A manual order is born CONFIRMED with its person in charge; only a marketplace order waiting
-- for confirmation may have none.
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_assignee_required";
ALTER TABLE "orders" ADD CONSTRAINT "orders_assignee_required"
  CHECK ("status" = 'PENDING_CONFIRMATION' OR "assignee_id" IS NOT NULL);

-- A deposit never exceeds the order, and a percentage is a percentage.
ALTER TABLE "orders" ADD CONSTRAINT "orders_deposit_valid"
  CHECK (("deposit_amount" IS NULL OR ("deposit_amount" >= 0 AND "deposit_amount" <= "grand_total"))
     AND ("deposit_percent" IS NULL OR ("deposit_percent" > 0 AND "deposit_percent" <= 100)));

-- ─── 4. HAND-WRITTEN: drop stock reservations ────────────────────────────────
-- The CHECK named reserved, so it goes first and comes back on stock alone.
ALTER TABLE "inventories" DROP CONSTRAINT IF EXISTS "inventories_stock_reserved_valid";
ALTER TABLE "inventories" DROP COLUMN "reserved";
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_stock_non_negative" CHECK ("stock" >= 0);

DROP TABLE "stock_reservations";
