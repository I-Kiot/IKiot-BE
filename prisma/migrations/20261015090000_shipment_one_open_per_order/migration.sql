-- An order has at most ONE shipment that has not ended (waiting for pickup, or on the road), and any
-- number of ended ones - a FAILED attempt is retried with a new shipment.
--
-- Until 2026-10-15 nothing needed this: handing over moved the order PACKED -> PICKED_UP in the same
-- transaction, and that status claim stopped a second hand-over. Now an INTERNAL hand-over only assigns
-- the driver (shipment CREATED, order still PACKED) until the driver confirms the pickup, so the order's
-- status no longer tells two hand-overs apart. `ShipmentService.create` locks the order row and checks
-- first (SHIPMENT_ALREADY_OPEN); this index is the backstop.
--
-- Prisma cannot express a WHERE clause on an index, so this lives in SQL only (listed in the header
-- comment of schema.prisma). A future `prisma migrate dev` may propose dropping it; edit that
-- migration instead of applying it.
CREATE UNIQUE INDEX "shipments_one_open_per_order"
  ON "shipments"("order_id")
  WHERE "status" NOT IN ('DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED');
