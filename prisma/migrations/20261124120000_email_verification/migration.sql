-- Email OTP replaces eSMS: email becomes the platform-wide unique contact + login handle.
-- Hand-written; the partial unique index cannot be expressed in schema.prisma.

-- 1. Verification marker. NULL = the mailbox has not been proven yet; /auth/login then answers with an OTP challenge instead of tokens.
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMPTZ(6);

-- 2. Normalise addresses (the app lowercases/trims on write; older rows may not be), and turn blanks into NULL.
UPDATE "users" SET "email" = lower(trim("email")) WHERE "email" IS NOT NULL;
UPDATE "users" SET "email" = NULL WHERE "email" = '';

-- 3. D2 dedupe: the old index was unique per tenant only. Across shops the oldest live account keeps the address;
--    the later ones get NULL (they keep logging in by phone, and must have an email set before their next OTP).
UPDATE "users" u
SET "email" = NULL
WHERE u."email" IS NOT NULL
  AND u."status" <> 'DELETED'
  AND EXISTS (
    SELECT 1 FROM "users" o
    WHERE o."email" = u."email"
      AND o."status" <> 'DELETED'
      AND o."id" <> u."id"
      AND (o."created_at", o."id") < (u."created_at", u."id")
  );

-- 4. Replace the per-tenant unique index with a platform-wide one (soft-deleted rows do not hold an address).
DROP INDEX IF EXISTS "users_one_email_per_tenant";
CREATE UNIQUE INDEX "users_email_unique"
  ON "users"("email")
  WHERE "email" IS NOT NULL AND "status" <> 'DELETED';

-- 5. D3: accounts that can already log in are treated as verified, so nobody is locked out by this release.
UPDATE "users" SET "email_verified_at" = now()
WHERE "password" IS NOT NULL AND "status" <> 'DELETED';
