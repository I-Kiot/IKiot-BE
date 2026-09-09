-- An inventory row sits in exactly one place: a branch, or a warehouse, never both and
-- never neither.
--
-- The schema has carried this as a comment since the init migration (the last of the
-- follow-ups flagged there). `toLocationColumns` in src/common/dto/location-ref.dto.ts is
-- the only writer, and it sets one column and nulls the other by construction, so today
-- nothing violates it - which is exactly the moment to write the constraint down, before a
-- second writer appears and the invariant becomes something you have to go and check.
--
-- Two nullable FKs is the shape Postgres needs to reference two different tables (Mongo
-- stored one `locationId` plus a `locationType` discriminator and could not reference
-- either). The cost of that shape is that the type system stops saying "one of these",
-- and nothing but a CHECK says it instead: without this, `{branchId: null, warehouseId:
-- null}` is a perfectly good row that `toLocationRef` renders as `location: null` and the
-- unique indexes below never constrain, since neither of them matches it.
--
-- `num_nonnulls` is a Postgres builtin (9.6+) and counts its non-null arguments, so `= 1`
-- rejects both the "neither" and the "both" case in one expression.
--
-- Not expressible in schema.prisma - the DSL has no CHECK - the same reason
-- users_one_email_per_tenant and holidays_one_public_per_tenant_date live in SQL. Prisma
-- ignores constraints it does not know about, so `migrate dev` will not propose dropping
-- this one (unlike the partial indexes); it survives untouched.

ALTER TABLE "inventories"
  ADD CONSTRAINT "inventories_exactly_one_location"
  CHECK (num_nonnulls("branch_id", "warehouse_id") = 1);

-- The same follow-up, for the other polymorphic pair the schema header names:
-- StockMovementRequest carries two of these references, a source and a destination.
--
-- "At most one", not "exactly one", because null is a meaningful state on both sides here
-- and which side may be null depends on the movement type (see `assertEndpointsValid`):
--   * IMPORT has no location source at all - stock arrives from a supplier, so
--     from_supplier_id is set and both from_* columns are null.
--   * ADJUST is a stocktake at a single place - it has a source and no destination.
--   * EXPORT / RETURN are transfers and carry both.
--
-- Writing those rules into the constraint would mean encoding the movement-type state
-- machine in SQL and revisiting it every time a type is added; the service owns that. What
-- the database can say without knowing any of it is that a single reference never points at
-- two places at once, which is corrupt under every movement type - `sourceRef` and
-- `destinationRef` would silently return the branch and drop the warehouse.

ALTER TABLE "stock_movement_requests"
  ADD CONSTRAINT "stock_movement_requests_source_at_most_one_location"
  CHECK (num_nonnulls("from_branch_id", "from_warehouse_id") <= 1);

ALTER TABLE "stock_movement_requests"
  ADD CONSTRAINT "stock_movement_requests_destination_at_most_one_location"
  CHECK (num_nonnulls("to_branch_id", "to_warehouse_id") <= 1);
