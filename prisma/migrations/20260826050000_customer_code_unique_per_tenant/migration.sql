-- Written by hand: `prisma migrate dev` needs an interactive terminal, which this
-- environment doesn't have. Matches `@@unique([tenantId, customerCode])` on Customer.
--
-- `customer_code` is nullable, so Postgres only constrains rows that actually carry a
-- code - which is exactly the rule the app wants: any number of customers with no code,
-- never two answering to the same one. It is also what lets the walk-in customer
-- (`KH_VANGLAI`) be resolved with an upsert instead of find-then-create, so two
-- simultaneous anonymous sales can't create two walk-in rows.
CREATE UNIQUE INDEX "customers_tenant_id_customer_code_key" ON "customers"("tenant_id", "customer_code");
