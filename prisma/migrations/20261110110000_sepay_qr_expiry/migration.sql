-- Hạn mã QR SePay: 15 phút từ lúc phát (orders/sepay-qr.ts). Đơn quầy không có cột: hạn = created_at + 15 phút.
-- AlterTable
ALTER TABLE "payments" ADD COLUMN "expires_at" TIMESTAMPTZ(6);

-- Khoản QR đang chờ từ trước đợt này: tính hạn theo giờ tạo (cron sẽ chuyển các khoản đã quá hạn sang EXPIRED).
UPDATE "payments" SET "expires_at" = "created_at" + interval '15 minutes'
  WHERE "method" = 'SEPAY' AND "kind" = 'BALANCE' AND "expires_at" IS NULL;

-- CreateIndex
CREATE INDEX "payments_status_expires_at_idx" ON "payments"("status", "expires_at");

-- CreateIndex
CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at");

-- Sổ giao dịch SePay: khoá chống xử lý lặp + bản ghi bền của tiền về không chốt được.
-- CreateTable
CREATE TABLE "sepay_transactions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "sepay_transaction_id" TEXT NOT NULL,
    "payment_reference" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "outcome" TEXT NOT NULL,
    "reject_reason" TEXT,
    "order_id" TEXT,
    "payment_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sepay_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sepay_transactions_tenant_id_sepay_transaction_id_key" ON "sepay_transactions"("tenant_id", "sepay_transaction_id");

-- AddForeignKey
ALTER TABLE "sepay_transactions" ADD CONSTRAINT "sepay_transactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sepay_transactions" ADD CONSTRAINT "sepay_transactions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- SQL-only: outcome thuộc bộ giá trị của SepayTransactionOutcome (constants/payment-method.ts).
ALTER TABLE "sepay_transactions" ADD CONSTRAINT "sepay_transactions_outcome_check" CHECK ("outcome" IN ('SETTLED', 'SETTLED_LATE', 'REJECTED'));
