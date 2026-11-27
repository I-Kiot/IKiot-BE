-- Số tài khoản cũ về một cách viết, như normalizeAccountNumber.
UPDATE "tenants"
SET "banking_account_number" = NULLIF(upper(regexp_replace("banking_account_number", '[^0-9a-zA-Z]', '', 'g')), '')
WHERE "banking_account_number" IS NOT NULL;

-- Một số chỉ thuộc một shop. Số trùng: giữ shop đã liên kết, rồi shop tạo trước; các shop còn lại phải nhập lại.
UPDATE "tenants" t
SET "banking_account_number" = NULL, "banking_sepay_linked_at" = NULL
FROM (
  SELECT "id", row_number() OVER (
    PARTITION BY "banking_account_number"
    ORDER BY ("banking_sepay_webhook_api_key" IS NULL AND "banking_sepay_linked_at" IS NULL), "created_at"
  ) AS rank
  FROM "tenants"
  WHERE "banking_account_number" IS NOT NULL
) ranked
WHERE t."id" = ranked."id" AND ranked.rank > 1;

DROP INDEX "tenants_banking_account_number_idx";
CREATE UNIQUE INDEX "tenants_banking_account_number_key" ON "tenants"("banking_account_number");

-- Đơn POS trước đây không ghi payment_status.
UPDATE "orders" SET "payment_status" = 'PAID'
WHERE "fulfillment_type" = 'TAKEAWAY' AND "status" = 'COMPLETED' AND "payment_status" = 'UNPAID';
UPDATE "orders" SET "payment_status" = 'REFUNDED'
WHERE "fulfillment_type" = 'TAKEAWAY' AND "status" = 'RETURNED' AND "payment_status" = 'UNPAID';
