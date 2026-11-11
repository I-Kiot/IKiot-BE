-- Phase 3 (2026-11-11): đơn quầy có dòng Payment (FULL / CHANGE) như mọi đơn khác, nên mọi dòng sổ thu chi của đơn đều phải gắn một khoản và một đơn.
-- Hoãn từ migration money_foundations vì lúc đó đơn quầy chưa có Payment. NOT VALID: dòng cũ (đơn quầy trước Phase 3, không có Payment) được miễn, chỉ dòng mới bị kiểm.
ALTER TABLE "cash_flows" ADD CONSTRAINT "cash_flows_order_money_has_payment" CHECK ("category" NOT IN ('ORDER_PAYMENT', 'ORDER_REFUND', 'SALE_CHANGE') OR ("payment_id" IS NOT NULL AND "order_id" IS NOT NULL)) NOT VALID;
