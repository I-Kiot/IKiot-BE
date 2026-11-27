-- Mở lại két chốt nhầm trong ngày (2026-11-27): phiên quay về OPEN, kết quả chốt và các dòng sổ ghi lúc chốt bị gỡ,
-- chốt lại thì ghi lại theo số mới. Lưu lần mở lại gần nhất (ai, lúc nào, lý do) và số lần; nhật ký đầy đủ ở audit log.
ALTER TABLE "cash_drawer_sessions" ADD COLUMN "reopen_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "cash_drawer_sessions" ADD COLUMN "last_reopened_at" TIMESTAMPTZ(6);
ALTER TABLE "cash_drawer_sessions" ADD COLUMN "last_reopened_by" TEXT;
ALTER TABLE "cash_drawer_sessions" ADD COLUMN "last_reopen_reason" TEXT;
ALTER TABLE "cash_drawer_sessions" ADD CONSTRAINT "cash_drawer_sessions_last_reopened_by_fkey"
  FOREIGN KEY ("last_reopened_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
