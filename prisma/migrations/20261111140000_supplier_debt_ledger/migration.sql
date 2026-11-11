-- Sổ công nợ nhà cung cấp (Phase 9). Mỗi lần suppliers.outstanding_debt đổi là một dòng ở đây, trong cùng transaction: amount là số đổi (+ nhận hàng, - trả nợ), balance_after là dư nợ sau lần đổi đó.
-- Bất biến: outstanding_debt = SUM(amount). created_by NULL = hệ thống (hoặc tài khoản đã bị xoá).
CREATE TABLE "supplier_debt_entries" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "supplier_id" TEXT NOT NULL,
  "entry_type" TEXT NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "balance_after" DECIMAL(14,2) NOT NULL,
  "reference_type" TEXT,
  "reference_id" TEXT,
  "reference_code" TEXT,
  "cash_flow_id" TEXT,
  "created_by" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "supplier_debt_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "supplier_debt_entries_type_check" CHECK ("entry_type" IN ('OPENING', 'CHARGE', 'PAYMENT')),
  CONSTRAINT "supplier_debt_entries_sign_check" CHECK (
    ("entry_type" = 'PAYMENT' AND "amount" < 0) OR ("entry_type" <> 'PAYMENT' AND "amount" > 0)),
  CONSTRAINT "supplier_debt_entries_balance_check" CHECK ("balance_after" >= 0),
  CONSTRAINT "supplier_debt_entries_reference_type_check" CHECK (
    "reference_type" IS NULL OR "reference_type" IN ('STOCK_MOVEMENT', 'PRODUCTION_REQUEST', 'CASH_FLOW'))
);

ALTER TABLE "supplier_debt_entries"
  ADD CONSTRAINT "supplier_debt_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_debt_entries_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_debt_entries_cash_flow_id_fkey" FOREIGN KEY ("cash_flow_id") REFERENCES "cash_flows"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "supplier_debt_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "supplier_debt_entries_cash_flow_id_key" ON "supplier_debt_entries"("cash_flow_id");
CREATE INDEX "supplier_debt_entries_tenant_id_supplier_id_created_at_idx" ON "supplier_debt_entries"("tenant_id", "supplier_id", "created_at");

-- Dư nợ đang có trước migration: một dòng OPENING để tổng sổ khớp với suppliers.outstanding_debt.
INSERT INTO "supplier_debt_entries" ("id", "tenant_id", "supplier_id", "entry_type", "amount", "balance_after", "created_at")
SELECT gen_random_uuid()::text, "tenant_id", "id", 'OPENING', "outstanding_debt", "outstanding_debt", now()
FROM "suppliers" WHERE "outstanding_debt" > 0;

-- Chỉ ghi thêm: UPDATE bị chặn. DELETE vẫn được (cascade khi xoá NCC, dọn dẹp e2e). Ngoại lệ duy nhất: ON DELETE SET NULL của created_by / cash_flow_id (chỉ hai cột đó, chỉ về NULL).
CREATE FUNCTION supplier_debt_entries_no_update() RETURNS trigger AS $$
BEGIN
  IF (NEW.created_by IS NULL OR NEW.created_by IS NOT DISTINCT FROM OLD.created_by)
     AND (NEW.cash_flow_id IS NULL OR NEW.cash_flow_id IS NOT DISTINCT FROM OLD.cash_flow_id)
     AND (to_jsonb(NEW) - 'created_by' - 'cash_flow_id') = (to_jsonb(OLD) - 'created_by' - 'cash_flow_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'supplier debt ledger is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "supplier_debt_entries_no_update" BEFORE UPDATE ON "supplier_debt_entries" FOR EACH ROW EXECUTE FUNCTION supplier_debt_entries_no_update();
