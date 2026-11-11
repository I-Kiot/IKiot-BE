-- Lịch sử đổi thông tin nhận tiền của shop (Phase 9): tài khoản ngân hàng, key webhook SePay, trạng thái liên kết SePay.
-- changes = { "<trường>": { "from": ..., "to": ... } }. Key webhook KHÔNG bao giờ được lưu: chỉ { "bankingSepayWebhookApiKey": { "keyChanged": true } }.
-- changed_by NULL = hệ thống (cron đồng bộ SePay) hoặc tài khoản đã bị xoá; source cho biết là loại nào.
CREATE TABLE "tenant_banking_changes" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "changed_by" TEXT,
  "source" TEXT NOT NULL,
  "changes" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "tenant_banking_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tenant_banking_changes_source_check" CHECK ("source" IN ('OWNER', 'ADMIN', 'SEPAY_SYNC'))
);
ALTER TABLE "tenant_banking_changes"
  ADD CONSTRAINT "tenant_banking_changes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "tenant_banking_changes_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "tenant_banking_changes_tenant_id_created_at_idx" ON "tenant_banking_changes"("tenant_id", "created_at");

-- Chỉ ghi thêm: UPDATE bị chặn, trừ ON DELETE SET NULL của changed_by. DELETE vẫn được (dọn dẹp e2e).
CREATE FUNCTION tenant_banking_changes_no_update() RETURNS trigger AS $$
BEGIN
  IF NEW.changed_by IS NULL AND (to_jsonb(NEW) - 'changed_by') = (to_jsonb(OLD) - 'changed_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'tenant banking history is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "tenant_banking_changes_no_update" BEFORE UPDATE ON "tenant_banking_changes" FOR EACH ROW EXECUTE FUNCTION tenant_banking_changes_no_update();
