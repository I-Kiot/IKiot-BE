-- Két tiền ghi sổ quỹ (2026-11-27). Mở két: chủ bỏ thêm tiền lẻ là chuyển quỹ OWNER -> DRAWER, két hụt so với số
-- để lại phiên trước là thiếu két. Chốt két: chênh lệch đếm được là thừa / thiếu két, số chủ rút về là chuyển quỹ
-- DRAWER -> OWNER. Chuyển quỹ ghi hai dòng (chi ở quỹ đi, thu ở quỹ đến) và không tính vào tổng thu chi.

-- 1. Số chủ rút về khi chốt; phần còn lại là tiền lẻ để lại cho phiên sau.
ALTER TABLE "cash_drawer_sessions" ADD COLUMN "withdrawn_amount" DECIMAL(14,2);
ALTER TABLE "cash_drawer_sessions" ADD CONSTRAINT "cash_drawer_sessions_withdrawn_within_count"
  CHECK ("withdrawn_amount" IS NULL OR ("withdrawn_amount" >= 0 AND "final_log_amount" IS NOT NULL AND "withdrawn_amount" <= "final_log_amount"));

-- 2. Dòng sổ do phiên két ghi.
ALTER TABLE "cash_flows" ADD COLUMN "cash_drawer_session_id" TEXT;
ALTER TABLE "cash_flows" ADD CONSTRAINT "cash_flows_cash_drawer_session_id_fkey"
  FOREIGN KEY ("cash_drawer_session_id") REFERENCES "cash_drawer_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "cash_flows_cash_drawer_session_id_idx" ON "cash_flows"("cash_drawer_session_id");

-- 3. Bốn loại mới; hướng thu / chi vẫn do loại quyết định.
ALTER TABLE "cash_flows" DROP CONSTRAINT "cash_flows_category_check";
ALTER TABLE "cash_flows" ADD CONSTRAINT "cash_flows_category_check" CHECK ("category" IN ('ORDER_PAYMENT', 'UNALLOCATED_RECEIPT', 'ORDER_REFUND', 'SALE_CHANGE', 'SUPPLIER_PAYMENT', 'UNALLOCATED_REFUND', 'FUND_TRANSFER_IN', 'FUND_TRANSFER_OUT', 'DRAWER_SURPLUS', 'DRAWER_SHORTAGE'));
ALTER TABLE "cash_flows" DROP CONSTRAINT "cash_flows_category_direction";
ALTER TABLE "cash_flows" ADD CONSTRAINT "cash_flows_category_direction" CHECK (("flow_type" = 'INCOME') = ("category" IN ('ORDER_PAYMENT', 'UNALLOCATED_RECEIPT', 'FUND_TRANSFER_IN', 'DRAWER_SURPLUS')));

-- 4. Dòng két tự ghi luôn gắn phiên, là tiền mặt, và chỉ ở quỹ két / chủ.
ALTER TABLE "cash_flows" ADD CONSTRAINT "cash_flows_drawer_rows_have_session" CHECK (
  "category" NOT IN ('FUND_TRANSFER_IN', 'FUND_TRANSFER_OUT', 'DRAWER_SURPLUS', 'DRAWER_SHORTAGE')
  OR ("cash_drawer_session_id" IS NOT NULL AND "payment_method" = 'CASH' AND "fund" IN ('DRAWER', 'OWNER'))
);
