-- A branch may have at most ONE OPEN cash drawer at a time, and any number of closed ones.
--
-- The init migration created a plain unique index on (tenant_id, branch_id, status), which
-- says something quite different: at most one row per status per branch, forever. The first
-- day's session closes fine; the second day's `finalize` collides with it. The schema
-- flagged this as a follow-up because Prisma's DSL cannot express a WHERE clause, and
-- porting the module is the point at which it stops being theoretical.
--
-- Prisma does not know about partial indexes, so `@@unique([tenantId, branchId, status])`
-- has been removed from schema.prisma. A future `prisma migrate dev` will propose dropping
-- this index; edit that migration instead of applying it.
DROP INDEX "cash_drawer_sessions_tenant_id_branch_id_status_key";

CREATE UNIQUE INDEX "cash_drawer_sessions_one_open_per_branch"
  ON "cash_drawer_sessions"("tenant_id", "branch_id")
  WHERE "status" = 'OPEN';
