-- Phase 7 (2026-11-11): nhật ký doanh thu chỉ ghi thêm (SALE khi đơn COMPLETED, RETURN âm khi trả hàng, OTHER_INCOME khi shop giữ tiền) + chia giảm giá cả đơn vào dòng hoá đơn.
-- Không backfill (quyết định D9): dữ liệu mẫu, dev được seed lại.
CREATE TABLE "sales_journal_entries" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "branch_id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "order_return_id" TEXT,
  "entry_type" TEXT NOT NULL,
  "posted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "business_date" DATE NOT NULL,
  "goods_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "shipping_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "other_income_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "total_amount" DECIMAL(14,2) NOT NULL,
  "cogs_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "shipping_cost" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "channel_fee" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "customer_id" TEXT,
  "assignee_id" TEXT,
  "creator_id" TEXT,
  "channel" TEXT,
  "fulfillment_type" TEXT,
  "source" TEXT NOT NULL,
  "actor_id" TEXT,
  CONSTRAINT "sales_journal_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sales_journal_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sales_journal_entries_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "sales_journal_entries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sales_journal_entries_order_return_id_fkey" FOREIGN KEY ("order_return_id") REFERENCES "order_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sales_journal_entries_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "sales_journal_entries_type_check" CHECK ("entry_type" IN ('SALE','RETURN','OTHER_INCOME')),
  CONSTRAINT "sales_journal_entries_sign_check" CHECK (
    ("entry_type" = 'RETURN' AND "total_amount" <= 0) OR ("entry_type" <> 'RETURN' AND "total_amount" >= 0)),
  CONSTRAINT "sales_journal_entries_total_check" CHECK ("total_amount" = "goods_amount" + "shipping_amount" + "other_income_amount")
);
CREATE UNIQUE INDEX "sales_journal_one_sale" ON "sales_journal_entries"("order_id") WHERE "entry_type" = 'SALE';
CREATE UNIQUE INDEX "sales_journal_one_other_income" ON "sales_journal_entries"("order_id") WHERE "entry_type" = 'OTHER_INCOME';
CREATE UNIQUE INDEX "sales_journal_one_per_return" ON "sales_journal_entries"("order_return_id") WHERE "order_return_id" IS NOT NULL;
CREATE UNIQUE INDEX "sales_journal_one_pos_return" ON "sales_journal_entries"("order_id") WHERE "entry_type" = 'RETURN' AND "order_return_id" IS NULL;
CREATE INDEX "sales_journal_entries_tenant_id_business_date_idx" ON "sales_journal_entries"("tenant_id", "business_date");
CREATE INDEX "sales_journal_entries_tenant_id_branch_id_business_date_idx" ON "sales_journal_entries"("tenant_id", "branch_id", "business_date");

CREATE TABLE "sales_journal_lines" (
  "id" TEXT NOT NULL,
  "entry_id" TEXT NOT NULL,
  "order_item_id" TEXT NOT NULL,
  "product_item_id" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "cogs" DECIMAL(14,2) NOT NULL DEFAULT 0,
  CONSTRAINT "sales_journal_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sales_journal_lines_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "sales_journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sales_journal_lines_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "sales_journal_lines_entry_id_idx" ON "sales_journal_lines"("entry_id");
CREATE INDEX "sales_journal_lines_product_item_id_idx" ON "sales_journal_lines"("product_item_id");

-- Chỉ ghi thêm: UPDATE bị chặn. DELETE vẫn được (cascade khi xoá đơn, dọn dẹp e2e). Ngoại lệ duy nhất: ON DELETE SET NULL của khoá actor_id khi xoá tài khoản (chỉ cột actor_id, và chỉ về NULL).
CREATE FUNCTION sales_journal_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'sales journal is append-only';
END $$ LANGUAGE plpgsql;
CREATE FUNCTION sales_journal_entry_no_update() RETURNS trigger AS $$
BEGIN
  IF NEW.actor_id IS NULL AND (to_jsonb(NEW) - 'actor_id') = (to_jsonb(OLD) - 'actor_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'sales journal is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "sales_journal_entries_no_update" BEFORE UPDATE ON "sales_journal_entries" FOR EACH ROW EXECUTE FUNCTION sales_journal_entry_no_update();
CREATE TRIGGER "sales_journal_lines_no_update" BEFORE UPDATE ON "sales_journal_lines" FOR EACH ROW EXECUTE FUNCTION sales_journal_no_update();

ALTER TABLE "invoice_lines" ADD COLUMN "discount_amount" DECIMAL(14,2) NOT NULL DEFAULT 0;
