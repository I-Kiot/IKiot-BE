-- Goods packed for an order are locked until the order moves to SHIPPING (2026-10-04).
-- Shelf stock (actualStock) = stock - locked_stock and is never stored.
-- Every row starts at 0: a fulfillment verified before this migration ran under the earlier
-- design, which deducted the stock at packing, so those goods have already left `stock` and
-- there is nothing left to lock for them.
ALTER TABLE "inventories" ADD COLUMN "locked_stock" INTEGER NOT NULL DEFAULT 0;

-- HAND-WRITTEN: Prisma cannot express CHECK constraints - keep this when regenerating.
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_locked_stock_valid"
  CHECK ("locked_stock" >= 0 AND "locked_stock" <= "stock");
