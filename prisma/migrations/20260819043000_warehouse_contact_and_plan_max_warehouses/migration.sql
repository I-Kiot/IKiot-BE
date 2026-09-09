-- Hand-written: `prisma migrate dev` refuses to generate this automatically because
-- plans.max_warehouses is a required column and the table already holds the 5 seeded plans.

-- AlterTable: a warehouse now carries the same contact details as a branch.
ALTER TABLE "warehouses" ADD COLUMN     "email" TEXT,
ADD COLUMN     "phone_number" TEXT[];

-- Prisma never writes NULL into a scalar list, but rows that predate the column would hold
-- one. Backfill so the client always reads an array.
UPDATE "warehouses" SET "phone_number" = ARRAY[]::TEXT[] WHERE "phone_number" IS NULL;

-- AlterTable: per-plan warehouse quota. Existing plans predate it, so backfill -1 (unlimited)
-- and then drop the default - new plans must state a limit explicitly, exactly like
-- max_branches / max_users / max_products. `prisma db seed` overwrites these with real values.
ALTER TABLE "plans" ADD COLUMN     "max_warehouses" INTEGER NOT NULL DEFAULT -1;
ALTER TABLE "plans" ALTER COLUMN "max_warehouses" DROP DEFAULT;

-- AlterTable: the quota snapshot a subscription froze at purchase time.
ALTER TABLE "subscriptions" ADD COLUMN     "quota_snapshot_max_warehouses" INTEGER;
