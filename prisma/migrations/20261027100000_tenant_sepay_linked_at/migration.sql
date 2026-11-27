-- Webhook SePay chung (2026-10-27): shop được nhận diện theo số tài khoản nhận tiền, và "đã liên kết" là lúc BE thấy STK đó trong tài khoản SePay của nền tảng.
ALTER TABLE "tenants" ADD COLUMN "banking_sepay_linked_at" TIMESTAMPTZ(6);

-- Webhook tìm shop theo số tài khoản.
CREATE INDEX "tenants_banking_account_number_idx" ON "tenants"("banking_account_number");
