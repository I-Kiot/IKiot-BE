-- One live schedule per (tenant, shift template, day, type, times).
--
-- This replaces ~150 lines of response-normalisation the old service carried
-- (`deduplicateWorkingSchedules`), whose own comment said it "only normalises the
-- response, doesn't fix the database". Mongo enforced no uniqueness here, so real data
-- had grown duplicate schedule rows and every read had to merge them back together -
-- which is also why the old list endpoint loaded every matching schedule and paginated in
-- memory. Postgres can just forbid the duplicates.
--
-- Partial, because CANCELLED and DELETED rows must not block re-rostering the same slot:
-- calling off Tuesday's morning shift and scheduling it again is normal.
--
-- Not expressible in schema.prisma (no WHERE clause in the DSL), same as
-- cash_drawer_sessions_one_open_per_branch and holidays_one_public_per_tenant_date. A
-- future `prisma migrate dev` will propose dropping it; edit that migration instead.

CREATE UNIQUE INDEX "working_schedules_one_per_slot"
  ON "working_schedules"(
    "tenant_id", "shift_template_id", "work_date", "schedule_type", "start_at", "end_at"
  )
  WHERE "status" IN ('SCHEDULED', 'COMPLETED');
