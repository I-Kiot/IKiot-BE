-- Lịch sử giá bán lẻ / giá vốn danh mục của từng mặt hàng (Phase 9). from_value NULL = lúc tạo mặt hàng.
-- changed_by NULL = hệ thống (giá vốn combo tự tính lại khi giá món con đổi) hoặc tài khoản đã bị xoá.
CREATE TABLE "product_item_price_changes" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "product_item_id" TEXT NOT NULL,
  "field" TEXT NOT NULL,
  "from_value" DECIMAL(12,2),
  "to_value" DECIMAL(12,2) NOT NULL,
  "changed_by" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "product_item_price_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "product_item_price_changes_field_check" CHECK ("field" IN ('RETAIL_PRICE', 'COST_PRICE'))
);
ALTER TABLE "product_item_price_changes"
  ADD CONSTRAINT "product_item_price_changes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "product_item_price_changes_product_item_id_fkey" FOREIGN KEY ("product_item_id") REFERENCES "product_items"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "product_item_price_changes_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "product_item_price_changes_tenant_id_product_item_id_create_idx" ON "product_item_price_changes"("tenant_id", "product_item_id", "created_at");

-- Chỉ ghi thêm: UPDATE bị chặn, trừ ON DELETE SET NULL của changed_by. DELETE vẫn được (cascade khi xoá mặt hàng, dọn dẹp e2e).
CREATE FUNCTION product_item_price_changes_no_update() RETURNS trigger AS $$
BEGIN
  IF NEW.changed_by IS NULL AND (to_jsonb(NEW) - 'changed_by') = (to_jsonb(OLD) - 'changed_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'product price history is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "product_item_price_changes_no_update" BEFORE UPDATE ON "product_item_price_changes" FOR EACH ROW EXECUTE FUNCTION product_item_price_changes_no_update();
