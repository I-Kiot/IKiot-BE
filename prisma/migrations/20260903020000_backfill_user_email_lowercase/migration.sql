-- Canonicalise the `users.email` rows written before @NormalizeEmail existed.
--
-- `User.email` is a lookup key, not just contact detail: /auth/firebase-login resolves an
-- account by `decoded.email.toLowerCase().trim()`. iKiotMS-BE normalised on the way in; the
-- first NestJS pass dropped that, so any row written in that window can hold `Foo@Bar.com`
-- - an address whose owner can no longer sign in with Google, and which the "is this email
-- taken" check does not see when someone else registers the lowercase spelling.
--
-- The decorator is back on all four write paths (register, PATCH /auth/me, POST /users,
-- PATCH /users/:id), so nothing new lands unnormalised. This is the one-off repair of the
-- rows already stored. Trim as well as lowercase - the decorator does both, and a trailing
-- space fails the same lookup for the same reason.
--
-- Collisions are left alone rather than resolved. Two active rows in one tenant differing
-- only by case are two accounts the application would never have allowed to coexist, and
-- picking a winner here would either take an address away from a working login or abort the
-- deploy over data a migration cannot judge. They are reported instead: `users_one_email_
-- per_tenant` (migration 20260828010000) is a partial unique index over exactly this set,
-- so lowercasing both would trip it. Such rows stay as broken as they are today - no worse
-- - and the WARNING names them so an operator can merge them by hand.
--
-- DELETED rows are included on purpose. They sit outside that index (anonymised staff keep
-- a row, see UserService.remove), so no collision is possible, and normalising them keeps
-- the column uniform for anything that reads history.

DO $$
DECLARE
  collisions text;
  repaired   bigint;
BEGIN
  -- Rows whose normalised form would land on another row that is already in, or is also
  -- heading for, the same (tenant_id, lower(btrim(email))) slot among non-DELETED rows.
  WITH candidates AS (
    SELECT id, tenant_id, email, lower(btrim(email)) AS normalised
    FROM users
    WHERE email IS NOT NULL AND status <> 'DELETED'
  )
  SELECT string_agg(format('tenant %s: %s', tenant_id, emails), E'\n')
    INTO collisions
  FROM (
    SELECT tenant_id, string_agg(quote_literal(email), ', ' ORDER BY email) AS emails
    FROM candidates
    GROUP BY tenant_id, normalised
    HAVING count(*) > 1
  ) grouped;

  UPDATE users u
     SET email = lower(btrim(u.email))
   WHERE u.email IS NOT NULL
     AND u.email <> lower(btrim(u.email))
     AND (
       u.status = 'DELETED'
       OR NOT EXISTS (
         SELECT 1
         FROM users other
         WHERE other.id <> u.id
           AND other.tenant_id IS NOT DISTINCT FROM u.tenant_id
           AND other.status <> 'DELETED'
           AND other.email IS NOT NULL
           AND lower(btrim(other.email)) = lower(btrim(u.email))
       )
     );

  GET DIAGNOSTICS repaired = ROW_COUNT;
  RAISE NOTICE 'backfill_user_email_lowercase: normalised % row(s)', repaired;

  IF collisions IS NOT NULL THEN
    RAISE WARNING E'backfill_user_email_lowercase: left % group(s) of case-duplicate emails untouched; merge these accounts by hand:\n%',
      (SELECT count(*) FROM regexp_split_to_table(collisions, E'\n')), collisions;
  END IF;
END $$;
