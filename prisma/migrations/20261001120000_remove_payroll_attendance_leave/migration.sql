-- Payroll (K5), attendance (K4) and leave requests are out of the product's scope.
-- Their modules are gone from the code; this removes their tables and columns.
--
-- Written by hand: `prisma migrate diff` would emit the same DROPs, but not the data
-- clean-up at the end (permission rows and plan feature flags pointing at the removed
-- features), which has to run in the same migration or the role editor and the plan
-- editor keep offering things that no longer exist.
--
-- Irreversible: every row in these tables is deleted. Take a backup first if the history
-- is still wanted for anything.

-- ─── 1. Columns on tables that stay ──────────────────────────────────────────

-- Dropping a column drops its FK and its indexes with it.
ALTER TABLE "users" DROP COLUMN "paysheet_id";
ALTER TABLE "users" DROP COLUMN "leave_balance_annual_days";
ALTER TABLE "users" DROP COLUMN "leave_balance_remaining_days";

ALTER TABLE "cash_flows" DROP COLUMN "payroll_period_id";

-- The attendance geofence moved up to `locations` in 20260929065032.
ALTER TABLE "locations" DROP COLUMN "attendance_latitude";
ALTER TABLE "locations" DROP COLUMN "attendance_longitude";
ALTER TABLE "locations" DROP COLUMN "attendance_allowed_radius_meters";
ALTER TABLE "locations" DROP COLUMN "attendance_max_accuracy_meters";

-- ─── 2. Tables, children before parents ──────────────────────────────────────

DROP TABLE "payslip_leave_line_dates";
DROP TABLE "payslip_leave_lines";
DROP TABLE "payslip_allowance_lines";
DROP TABLE "payslip_bonus_lines";
DROP TABLE "payslip_deduction_lines";
DROP TABLE "payslip_manual_adjustments";
DROP TABLE "payslips";
DROP TABLE "payroll_periods";
DROP TABLE "paysheet_bonus_tiers";
DROP TABLE "paysheet_bonuses";
DROP TABLE "paysheet_allowances";
DROP TABLE "paysheet_deductions";
DROP TABLE "paysheets";
DROP TABLE "payroll_settings";
DROP TABLE "attendances";
DROP TABLE "leave_request_handover_schedules";
DROP TABLE "leave_requests";

-- ─── 3. Data that still points at the removed features ───────────────────────

-- The seed no longer lists these resources, but re-seeding only upserts - it never
-- deletes - so the rows (and any role still granting them) would otherwise stay.
DELETE FROM "role_permissions"
WHERE "resource" IN ('attendances', 'leaveRequests', 'paysheets', 'payrollSettings', 'payroll', 'payslips');
DELETE FROM "permission_catalog"
WHERE "resource" IN ('attendances', 'leaveRequests', 'paysheets', 'payrollSettings', 'payroll', 'payslips');

-- `payroll` is no longer a valid plan feature (UpdatePlanDto validates against the list),
-- so a plan still carrying it could not be saved from the admin screen.
UPDATE "plans" SET "features" = array_remove("features", 'payroll');
