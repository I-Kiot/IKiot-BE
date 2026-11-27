-- Location becomes the generic tenant-owned place; Branch and Warehouse shrink to 1:1
-- specializations of it, and every table that pointed at "a branch or a warehouse" through
-- a pair of nullable FKs now points at one Location instead (see the schema header).
--
-- Written by hand rather than taken from `prisma migrate diff`, because the generated script
-- drops the old columns before anything could be copied out of them - on a database with
-- data that loses every branch name, every posting and every stock line's location.
--
-- The one decision this migration makes: a Location reuses the id of the Branch/Warehouse it
-- is created from, and `branches.id = branches.location_id` (likewise warehouses) is kept as
-- a CHECK below. That is what lets every existing reference survive untouched - orders,
-- holidays, promotions and cash drawer sessions still hold a `branch_id`, the API's
-- `locationId`/`branchId`/`warehouseId` values stay the same, and the new `location_id`
-- columns can be filled by copying the old id across. Branch and Warehouse ids never
-- collide (both are v4 UUIDs), so both can share the one `locations` key space.

-- ─── 1. The new table ────────────────────────────────────────────────────────

CREATE TABLE "locations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "address" TEXT,
    "phone_number" TEXT[],
    "email" TEXT,
    "manager_id" TEXT,
    "attendance_latitude" DOUBLE PRECISION,
    "attendance_longitude" DOUBLE PRECISION,
    "attendance_allowed_radius_meters" INTEGER DEFAULT 100,
    "attendance_max_accuracy_meters" INTEGER DEFAULT 100,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "locations_tenant_id_location_type_idx" ON "locations"("tenant_id", "location_type");

-- Only the two kinds the application has a specialization for. `location_type` stays a TEXT
-- column (like every other status/type column in this schema) rather than a Postgres enum,
-- so adding a kind later is one CHECK swap instead of an ALTER TYPE.
ALTER TABLE "locations" ADD CONSTRAINT "locations_type_known" CHECK ("location_type" IN ('BRANCH', 'WAREHOUSE'));

ALTER TABLE "locations" ADD CONSTRAINT "locations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "locations" ADD CONSTRAINT "locations_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 2. One Location per existing branch and warehouse, same id ──────────────

INSERT INTO "locations" (
    "id", "tenant_id", "name", "location_type", "status", "address", "phone_number",
    "email", "manager_id", "attendance_latitude", "attendance_longitude",
    "attendance_allowed_radius_meters", "attendance_max_accuracy_meters",
    "created_at", "updated_at"
)
SELECT "id", "tenant_id", "name", 'BRANCH', "status", "address", "phone_number",
       "email", "manager_id", "attendance_latitude", "attendance_longitude",
       "attendance_allowed_radius_meters", "attendance_max_accuracy_meters",
       "created_at", "updated_at"
FROM "branches";

INSERT INTO "locations" (
    "id", "tenant_id", "name", "location_type", "status", "address", "phone_number",
    "email", "manager_id", "attendance_latitude", "attendance_longitude",
    "attendance_allowed_radius_meters", "attendance_max_accuracy_meters",
    "created_at", "updated_at"
)
SELECT "id", "tenant_id", "name", 'WAREHOUSE', "status", "address", "phone_number",
       "email", "manager_id", "attendance_latitude", "attendance_longitude",
       "attendance_allowed_radius_meters", "attendance_max_accuracy_meters",
       "created_at", "updated_at"
FROM "warehouses";

-- ─── 3. Branch / Warehouse become specializations ────────────────────────────

ALTER TABLE "branches" ADD COLUMN "location_id" TEXT;
UPDATE "branches" SET "location_id" = "id";
ALTER TABLE "branches" ALTER COLUMN "location_id" SET NOT NULL;
CREATE UNIQUE INDEX "branches_location_id_key" ON "branches"("location_id");
ALTER TABLE "branches" ADD CONSTRAINT "branches_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouses" ADD COLUMN "location_id" TEXT;
UPDATE "warehouses" SET "location_id" = "id";
ALTER TABLE "warehouses" ALTER COLUMN "location_id" SET NOT NULL;
CREATE UNIQUE INDEX "warehouses_location_id_key" ON "warehouses"("location_id");
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The shared-id rule from the header, written down where it cannot drift. LocationService
-- creates the specialization with the Location's own id; this refuses anything else.
-- Not expressible in schema.prisma (no CHECK in the DSL), and Prisma leaves constraints it
-- does not know about alone, so `migrate dev` will not propose dropping these.
ALTER TABLE "branches" ADD CONSTRAINT "branches_id_is_location_id" CHECK ("id" = "location_id");
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_id_is_location_id" CHECK ("id" = "location_id");

-- ─── 4. Copy every polymorphic pair into its single column ───────────────────

-- users: a posting at both (the old create route accepted that) keeps the branch, which is
-- what the old scope checks read first.
ALTER TABLE "users" ADD COLUMN "location_id" TEXT;
UPDATE "users" SET "location_id" = COALESCE("branch_id", "warehouse_id");

-- inventories: inventories_exactly_one_location guaranteed one side is set.
ALTER TABLE "inventories" ADD COLUMN "location_id" TEXT;
UPDATE "inventories" SET "location_id" = COALESCE("branch_id", "warehouse_id");
ALTER TABLE "inventories" ALTER COLUMN "location_id" SET NOT NULL;

-- stock_movement_requests: each end was held to "at most one" by CHECK, so COALESCE is exact.
ALTER TABLE "stock_movement_requests" ADD COLUMN "from_location_id" TEXT,
ADD COLUMN "to_location_id" TEXT;
UPDATE "stock_movement_requests"
SET "from_location_id" = COALESCE("from_branch_id", "from_warehouse_id"),
    "to_location_id" = COALESCE("to_branch_id", "to_warehouse_id");

-- cash_flows: branch first, as for users.
ALTER TABLE "cash_flows" ADD COLUMN "location_id" TEXT;
UPDATE "cash_flows" SET "location_id" = COALESCE("branch_id", "warehouse_id");

-- ─── 5. Drop the old pairs ───────────────────────────────────────────────────

-- The hand-written CHECKs from 20260903010000 go with their columns; dropped by name so
-- the intent is visible rather than left to DROP COLUMN's cascade.
ALTER TABLE "inventories" DROP CONSTRAINT "inventories_exactly_one_location";
ALTER TABLE "stock_movement_requests" DROP CONSTRAINT "stock_movement_requests_source_at_most_one_location";
ALTER TABLE "stock_movement_requests" DROP CONSTRAINT "stock_movement_requests_destination_at_most_one_location";

ALTER TABLE "users" DROP CONSTRAINT "users_warehouse_id_fkey";
ALTER TABLE "users" DROP CONSTRAINT "users_branch_id_fkey";
ALTER TABLE "branches" DROP CONSTRAINT "branches_manager_id_fkey";
ALTER TABLE "warehouses" DROP CONSTRAINT "warehouses_manager_id_fkey";
ALTER TABLE "inventories" DROP CONSTRAINT "inventories_branch_id_fkey";
ALTER TABLE "inventories" DROP CONSTRAINT "inventories_warehouse_id_fkey";
ALTER TABLE "stock_movement_requests" DROP CONSTRAINT "stock_movement_requests_from_branch_id_fkey";
ALTER TABLE "stock_movement_requests" DROP CONSTRAINT "stock_movement_requests_from_warehouse_id_fkey";
ALTER TABLE "stock_movement_requests" DROP CONSTRAINT "stock_movement_requests_to_branch_id_fkey";
ALTER TABLE "stock_movement_requests" DROP CONSTRAINT "stock_movement_requests_to_warehouse_id_fkey";
ALTER TABLE "cash_flows" DROP CONSTRAINT "cash_flows_branch_id_fkey";
ALTER TABLE "cash_flows" DROP CONSTRAINT "cash_flows_warehouse_id_fkey";

DROP INDEX "inventories_tenant_id_branch_id_min_stock_idx";
DROP INDEX "inventories_tenant_id_warehouse_id_min_stock_idx";
DROP INDEX "inventories_tenant_id_branch_id_product_item_id_key";
DROP INDEX "inventories_tenant_id_warehouse_id_product_item_id_key";
DROP INDEX "cash_flows_tenant_id_branch_id_created_at_idx";
DROP INDEX "cash_flows_tenant_id_warehouse_id_created_at_idx";

ALTER TABLE "users" DROP COLUMN "branch_id",
DROP COLUMN "warehouse_id";

ALTER TABLE "branches" DROP COLUMN "address",
DROP COLUMN "attendance_allowed_radius_meters",
DROP COLUMN "attendance_latitude",
DROP COLUMN "attendance_longitude",
DROP COLUMN "attendance_max_accuracy_meters",
DROP COLUMN "created_at",
DROP COLUMN "email",
DROP COLUMN "manager_id",
DROP COLUMN "name",
DROP COLUMN "phone_number",
DROP COLUMN "status",
DROP COLUMN "updated_at";

ALTER TABLE "warehouses" DROP COLUMN "address",
DROP COLUMN "attendance_allowed_radius_meters",
DROP COLUMN "attendance_latitude",
DROP COLUMN "attendance_longitude",
DROP COLUMN "attendance_max_accuracy_meters",
DROP COLUMN "created_at",
DROP COLUMN "email",
DROP COLUMN "manager_id",
DROP COLUMN "name",
DROP COLUMN "phone_number",
DROP COLUMN "status",
DROP COLUMN "updated_at";

ALTER TABLE "inventories" DROP COLUMN "branch_id",
DROP COLUMN "warehouse_id";

ALTER TABLE "stock_movement_requests" DROP COLUMN "from_branch_id",
DROP COLUMN "from_warehouse_id",
DROP COLUMN "to_branch_id",
DROP COLUMN "to_warehouse_id";

ALTER TABLE "cash_flows" DROP COLUMN "branch_id",
DROP COLUMN "warehouse_id";

-- ─── 6. Indexes and FKs on the new columns ───────────────────────────────────

CREATE INDEX "inventories_tenant_id_location_id_min_stock_idx" ON "inventories"("tenant_id", "location_id", "min_stock");
CREATE UNIQUE INDEX "inventories_tenant_id_location_id_product_item_id_key" ON "inventories"("tenant_id", "location_id", "product_item_id");
CREATE INDEX "stock_movement_requests_tenant_id_from_location_id_idx" ON "stock_movement_requests"("tenant_id", "from_location_id");
CREATE INDEX "stock_movement_requests_tenant_id_to_location_id_idx" ON "stock_movement_requests"("tenant_id", "to_location_id");
CREATE INDEX "cash_flows_tenant_id_location_id_created_at_idx" ON "cash_flows"("tenant_id", "location_id", "created_at");

ALTER TABLE "users" ADD CONSTRAINT "users_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_movement_requests" ADD CONSTRAINT "stock_movement_requests_from_location_id_fkey" FOREIGN KEY ("from_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stock_movement_requests" ADD CONSTRAINT "stock_movement_requests_to_location_id_fkey" FOREIGN KEY ("to_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cash_flows" ADD CONSTRAINT "cash_flows_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
