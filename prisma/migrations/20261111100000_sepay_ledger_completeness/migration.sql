-- Phase 4 (2026-11-11): sổ SePay đủ mọi giao dịch (không tenant, không mã, mã lạ, không có id), chuyển thiếu là khoản trả một phần, trả dư ghi lại, và tiền về chưa gắn được đơn vào sổ thu chi.

ALTER TABLE "sepay_transactions" ALTER COLUMN "tenant_id" DROP NOT NULL,
  ALTER COLUMN "sepay_transaction_id" DROP NOT NULL,
  ALTER COLUMN "payment_reference" DROP NOT NULL,
  ADD COLUMN "dedupe_key" TEXT,
  ADD COLUMN "account_number" TEXT,
  ADD COLUMN "content" TEXT,
  ADD COLUMN "bank_reference_code" TEXT,
  ADD COLUMN "transaction_date" TEXT,
  ADD COLUMN "excess_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "resolved_at" TIMESTAMPTZ(6),
  ADD COLUMN "resolved_by" TEXT,
  ADD COLUMN "resolution" TEXT,
  ADD COLUMN "resolution_note" TEXT;

-- Dòng cũ đều có mã giao dịch: khoá chống lặp là `id:<mã>` (cùng cách `sepayDedupeKey` tạo ra).
UPDATE "sepay_transactions" SET "dedupe_key" = 'id:' || "sepay_transaction_id";
ALTER TABLE "sepay_transactions" ALTER COLUMN "dedupe_key" SET NOT NULL;

DROP INDEX "sepay_transactions_tenant_id_sepay_transaction_id_key";
-- Hai unique một phần: Postgres coi NULL là khác nhau nên một unique (tenant_id, dedupe_key) không chống lặp được dòng không có tenant. `INSERT … ON CONFLICT DO NOTHING` (không chỉ định đích) bắt được cả hai.
CREATE UNIQUE INDEX "sepay_transactions_tenant_dedupe_key" ON "sepay_transactions"("tenant_id", "dedupe_key") WHERE "tenant_id" IS NOT NULL;
CREATE UNIQUE INDEX "sepay_transactions_unknown_tenant_dedupe_key" ON "sepay_transactions"("account_number", "dedupe_key") WHERE "tenant_id" IS NULL;
CREATE INDEX "sepay_transactions_tenant_id_outcome_resolved_at_idx" ON "sepay_transactions"("tenant_id", "outcome", "resolved_at");

ALTER TABLE "sepay_transactions" ADD CONSTRAINT "sepay_transactions_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sepay_transactions" DROP CONSTRAINT "sepay_transactions_outcome_check";
ALTER TABLE "sepay_transactions" ADD CONSTRAINT "sepay_transactions_outcome_check" CHECK ("outcome" IN ('SETTLED', 'SETTLED_LATE', 'SETTLED_PARTIAL', 'REJECTED', 'UNMATCHED'));
ALTER TABLE "sepay_transactions" ADD CONSTRAINT "sepay_transactions_resolution_check" CHECK ("resolution" IS NULL OR "resolution" IN ('REFUNDED_MANUALLY', 'MATCHED_MANUALLY', 'IGNORED'));
-- Đã xử lý thì có người và lúc xử lý; chưa xử lý thì không có.
ALTER TABLE "sepay_transactions" ADD CONSTRAINT "sepay_transactions_resolved_together" CHECK (("resolved_at" IS NULL) = ("resolution" IS NULL));

-- Tiền về không gắn được đơn (UNALLOCATED_RECEIPT) và lần hoàn lại nó (UNALLOCATED_REFUND) trỏ về dòng sổ SePay của chúng, để sổ thu chi khớp sao kê ngân hàng.
ALTER TABLE "cash_flows" ADD COLUMN "sepay_ledger_id" TEXT;
ALTER TABLE "cash_flows" ADD CONSTRAINT "cash_flows_sepay_ledger_id_fkey" FOREIGN KEY ("sepay_ledger_id") REFERENCES "sepay_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- Mỗi dòng sổ SePay có tối đa một dòng thu (UNALLOCATED_RECEIPT) và một dòng hoàn (UNALLOCATED_REFUND).
CREATE UNIQUE INDEX "cash_flows_sepay_ledger_category_key" ON "cash_flows"("sepay_ledger_id", "category") WHERE "sepay_ledger_id" IS NOT NULL;
