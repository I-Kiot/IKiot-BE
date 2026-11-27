-- Phase 5 (2026-11-11): sổ giao dịch SePay phía nền tảng (tenant trả tiền gói cho iKiot) và số tiền thực nhận trên hoá đơn gói.

ALTER TABLE "subscription_invoices" ADD COLUMN "amount_received" DECIMAL(12,2);

CREATE TABLE "platform_sepay_transactions" (
  "id" TEXT NOT NULL,
  "dedupe_key" TEXT NOT NULL,
  "sepay_transaction_id" TEXT,
  "account_number" TEXT,
  "content" TEXT,
  "bank_reference_code" TEXT,
  "amount" DECIMAL(14,2) NOT NULL,
  "outcome" TEXT NOT NULL,
  "payment_reference" TEXT,
  "subscription_invoice_id" TEXT,
  "tenant_id" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_sepay_transactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_sepay_transactions_outcome_check"
    CHECK ("outcome" IN ('ACTIVATED','UNDERPAID','INVOICE_NOT_PENDING','UNMATCHED','NO_REFERENCE'))
);

CREATE UNIQUE INDEX "platform_sepay_transactions_dedupe_key_key" ON "platform_sepay_transactions"("dedupe_key");
CREATE INDEX "platform_sepay_transactions_tenant_id_created_at_idx" ON "platform_sepay_transactions"("tenant_id", "created_at");
CREATE INDEX "platform_sepay_transactions_outcome_idx" ON "platform_sepay_transactions"("outcome");

ALTER TABLE "platform_sepay_transactions"
  ADD CONSTRAINT "platform_sepay_transactions_subscription_invoice_id_fkey"
  FOREIGN KEY ("subscription_invoice_id") REFERENCES "subscription_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "platform_sepay_transactions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
