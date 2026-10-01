-- Two clean-ups on tables that already exist in every database. The furniture-flow tables
-- and columns (lots, channel_fee, damaged_location_id, ...) are not here: they arrive with
-- the furniture migration (P0-1), generated from the schema.

-- ─── 1. Foreign keys that were plain text columns ────────────────────────────

-- Null out anything that points at nothing first, or the constraint cannot be added.
-- `changed_by` is the likely offender: iKiotMS-BE wrote the *tenant* id into it for
-- webhook-driven changes, and migrated rows may still carry one.
UPDATE "tenants" SET "tenant_owner_id" = NULL
WHERE "tenant_owner_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = "tenants"."tenant_owner_id");

UPDATE "subscription_history_logs" SET "from_plan_id" = NULL
WHERE "from_plan_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "plans" p WHERE p."id" = "subscription_history_logs"."from_plan_id");

UPDATE "subscription_history_logs" SET "to_plan_id" = NULL
WHERE "to_plan_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "plans" p WHERE p."id" = "subscription_history_logs"."to_plan_id");

UPDATE "subscription_history_logs" SET "changed_by" = NULL
WHERE "changed_by" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = "subscription_history_logs"."changed_by");

-- Names and actions exactly as Prisma generates them, so a later `migrate diff` sees no drift.
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_tenant_owner_id_fkey" FOREIGN KEY ("tenant_owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "subscription_history_logs" ADD CONSTRAINT "subscription_history_logs_from_plan_id_fkey" FOREIGN KEY ("from_plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "subscription_history_logs" ADD CONSTRAINT "subscription_history_logs_to_plan_id_fkey" FOREIGN KEY ("to_plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "subscription_history_logs" ADD CONSTRAINT "subscription_history_logs_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 2. Permission catalog: resources no route checks ────────────────────────

-- `staff:*` duplicates `users:*` (every staff route checks `users`), and no route is gated
-- on `notifications:*`. Granting either changed nothing, yet both showed in the role editor.
-- The seed no longer lists them; re-seeding only upserts, so the rows go here.
DELETE FROM "role_permissions" WHERE "resource" IN ('staff', 'notifications');
DELETE FROM "permission_catalog" WHERE "resource" IN ('staff', 'notifications');
