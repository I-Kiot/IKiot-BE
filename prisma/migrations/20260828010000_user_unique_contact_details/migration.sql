-- One email, and one citizen ID, per person within a shop.
--
-- iKiotMS-BE checked both in `checkStaffUniqueness` before every insert and update, but
-- Mongo held no index behind that check, so two concurrent creates could still land on the
-- same address. The first NestJS pass then dropped the check from the create path
-- altogether (it survived only on update), which meant two colleagues could be created on
-- one email and the clash surfaced weeks later, when somebody edited one of them and got a
-- 409 out of nowhere - by which time both rows carried orders, attendances and payslips.
--
-- The application check is back in `UserService.create`; this is the guarantee underneath
-- it. Emails are lowercased and trimmed on the way in by @NormalizeEmail, so a plain column
-- index is enough - no lower() expression needed, and using one would let a row written by
-- some future path that skips the decorator slip past the application check but still trip
-- the index, which is the confusing half of both worlds.
--
-- Partial on two counts:
--   * DELETED rows are excluded. Deleting a staff member anonymises them (see
--     `UserService.remove`), and a departed employee's old address must not block rehiring
--     them or hiring someone who inherited it.
--   * NULLs never conflict in Postgres anyway, so employees with no email on file - the
--     common case, since phone is the login handle - are unaffected.
--
-- Tenant-scoped, matching the application check. `identificationId` was global in the old
-- system; narrowing it is deliberate (a global index would let one shop discover that
-- another employs a particular person by watching for a 409).
--
-- Not expressible in schema.prisma (no WHERE clause in the DSL), same as
-- working_schedules_one_per_slot and holidays_one_public_per_tenant_date. A future
-- `prisma migrate dev` will propose dropping these; edit that migration instead.

CREATE UNIQUE INDEX "users_one_email_per_tenant"
  ON "users"("tenant_id", "email")
  WHERE "email" IS NOT NULL AND "status" <> 'DELETED';

CREATE UNIQUE INDEX "users_one_identification_per_tenant"
  ON "users"("tenant_id", "profile_identification_id")
  WHERE "profile_identification_id" IS NOT NULL AND "status" <> 'DELETED';
