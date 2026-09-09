-- One PUBLIC_HOLIDAY per tenant per date - restoring what the Mongo index enforced.
--
-- `@@unique([tenantId, date, branchId, type])` looks like it already says this, and in
-- Mongo it did: a compound unique index there treats null as a value. Postgres does not -
-- a row with a NULL in an indexed column is never equal to another such row, so the
-- constraint is silently inert for exactly the rows this module creates, which always have
-- branch_id NULL. Two syncs racing, or a manual holiday added on a date the calendar also
-- carries, would both have inserted duplicates.
--
-- Left as SQL rather than expressed in schema.prisma because the DSL has no WHERE clause,
-- the same reason cash_drawer_sessions_one_open_per_branch lives here. The plain @@unique
-- stays in the schema: it is what covers the branch-scoped COMPANY_HOLIDAY rows, where
-- branch_id is not null and the index does bite.
--
-- A future `prisma migrate dev` will propose dropping this index; edit that migration
-- rather than applying it.

CREATE UNIQUE INDEX "holidays_one_public_per_tenant_date"
  ON "holidays"("tenant_id", "date", "type")
  WHERE "branch_id" IS NULL;
