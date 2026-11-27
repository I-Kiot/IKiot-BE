-- Nền sổ tiền (2026-11-11): đơn có completed_at, dòng sổ thu chi có loại + quỹ, khoản thanh toán ghi ai huỷ / số yêu cầu, két ghi lúc chốt, phiếu kho ghi ai huỷ.

-- Orders: lúc COMPLETED. Báo cáo doanh thu sẽ theo ngày này, không theo created_at.
ALTER TABLE "orders" ADD COLUMN "completed_at" TIMESTAMPTZ(6);
UPDATE "orders" o SET "completed_at" = COALESCE(
  (SELECT min(i."issued_at") FROM "invoices" i WHERE i."order_id" = o."id" AND i."type" = 'SALE' AND i."status" = 'ISSUED'),
  CASE WHEN o."status" = 'COMPLETED' THEN o."updated_at" END)
 WHERE o."status" IN ('COMPLETED', 'RETURNED');
ALTER TABLE "orders" ADD CONSTRAINT "orders_completed_at_required" CHECK ("status" <> 'COMPLETED' OR "completed_at" IS NOT NULL);
CREATE INDEX "orders_tenant_id_completed_at_idx" ON "orders"("tenant_id", "completed_at");

-- Cash flows: loại tiền (category) và quỹ nơi tiền nằm (fund).
ALTER TABLE "cash_flows" ADD COLUMN "category" TEXT;
UPDATE "cash_flows" SET "category" = CASE
  WHEN "supplier_id" IS NOT NULL THEN 'SUPPLIER_PAYMENT'
  WHEN "flow_type" = 'INCOME' THEN 'ORDER_PAYMENT'
  WHEN "description" LIKE 'Tiền thối%' THEN 'SALE_CHANGE'
  ELSE 'ORDER_REFUND' END;
ALTER TABLE "cash_flows" ALTER COLUMN "category" SET NOT NULL;
ALTER TABLE "cash_flows" ADD CONSTRAINT "cash_flows_category_check" CHECK ("category" IN ('ORDER_PAYMENT', 'UNALLOCATED_RECEIPT', 'ORDER_REFUND', 'SALE_CHANGE', 'SUPPLIER_PAYMENT', 'UNALLOCATED_REFUND'));
ALTER TABLE "cash_flows" ADD CONSTRAINT "cash_flows_category_direction" CHECK (("flow_type" = 'INCOME') = ("category" IN ('ORDER_PAYMENT', 'UNALLOCATED_RECEIPT')));
CREATE INDEX "cash_flows_tenant_id_category_created_at_idx" ON "cash_flows"("tenant_id", "category", "created_at");

-- Quỹ: DRAWER (tiền mặt qua két chi nhánh), OWNER (tiền mặt đã giao thẳng chủ shop: shipper nộp, trả nhà cung cấp), BANK (mọi thứ không phải tiền mặt).
-- Dòng cũ: tiền mặt shipper đã nộp và tiền mặt trả nhà cung cấp là OWNER, phần tiền mặt còn lại là DRAWER.
ALTER TABLE "cash_flows" ADD COLUMN "fund" TEXT;
UPDATE "cash_flows" c SET "fund" = CASE
  WHEN c."payment_method" IS DISTINCT FROM 'CASH' THEN 'BANK'
  WHEN c."supplier_id" IS NOT NULL THEN 'OWNER'
  WHEN c."payment_id" IN (SELECT p."id" FROM "payments" p WHERE p."remittance_status" = 'RECEIVED') THEN 'OWNER'
  ELSE 'DRAWER' END;
-- Một dòng DRAWER không gắn nơi nào thì không thuộc két nào: chuyển sang OWNER thay vì để lọt khỏi đối soát.
UPDATE "cash_flows" SET "fund" = 'OWNER' WHERE "fund" = 'DRAWER' AND "location_id" IS NULL;
ALTER TABLE "cash_flows" ALTER COLUMN "fund" SET NOT NULL;
ALTER TABLE "cash_flows" ADD CONSTRAINT "cash_flows_fund_check" CHECK ("fund" IN ('DRAWER', 'OWNER', 'BANK'));
ALTER TABLE "cash_flows" ADD CONSTRAINT "cash_flows_drawer_is_cash" CHECK ("fund" <> 'DRAWER' OR "payment_method" = 'CASH');
-- DRAWER phải có nơi (location_id) do code đảm bảo (writePaymentCashFlow nhận locationId bắt buộc), không phải CHECK: location_id có FK ON DELETE SET NULL nên một CHECK về nó làm hỏng việc xoá nơi.
-- cash_flows_order_money_has_payment (đơn → phải có payment) cố ý chưa thêm: tới Phase 3 đơn quầy mới có dòng Payment, thêm sớm thì mọi lần bán tại quầy bị từ chối.

-- Payments: số QR đã yêu cầu, ai huỷ / lúc nào, ghi chú của người xác nhận nhận tiền.
ALTER TABLE "payments" ADD COLUMN "requested_amount" DECIMAL(14,2),
  ADD COLUMN "cancelled_at" TIMESTAMPTZ(6),
  ADD COLUMN "cancelled_by" TEXT,
  ADD COLUMN "remittance_note" TEXT;
UPDATE "payments" SET "requested_amount" = "amount" WHERE "method" = 'SEPAY';
ALTER TABLE "payments" ADD CONSTRAINT "payments_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_kind_check" CHECK ("kind" IN ('FULL', 'DEPOSIT', 'BALANCE', 'REFUND', 'CHANGE'));
-- Tiền ra (hoàn / thối) luôn trỏ về khoản đã nhận. NOT VALID: chỉ kiểm dòng mới.
ALTER TABLE "payments" ADD CONSTRAINT "payments_outflow_has_origin" CHECK ("kind" NOT IN ('REFUND', 'CHANGE') OR "refund_of_payment_id" IS NOT NULL) NOT VALID;

-- Cash drawer: lúc chốt két.
ALTER TABLE "cash_drawer_sessions" ADD COLUMN "closed_at" TIMESTAMPTZ(6);
UPDATE "cash_drawer_sessions" SET "closed_at" = "updated_at" WHERE "status" = 'CLOSED';

-- Stock movements: ai huỷ phiếu.
ALTER TABLE "stock_movement_requests" ADD COLUMN "cancelled_by" TEXT;
ALTER TABLE "stock_movement_requests" ADD CONSTRAINT "stock_movement_requests_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
