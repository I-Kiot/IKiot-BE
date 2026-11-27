-- order_events chỉ ghi thêm (cùng kiểu sales_journal_entries): UPDATE bị chặn. DELETE vẫn được (cascade khi xoá đơn, dọn dẹp e2e). Ngoại lệ duy nhất: ON DELETE SET NULL của khoá actor_id khi xoá tài khoản (chỉ cột actor_id, và chỉ về NULL).
CREATE FUNCTION order_events_no_update() RETURNS trigger AS $$
BEGIN
  IF NEW.actor_id IS NULL AND (to_jsonb(NEW) - 'actor_id') = (to_jsonb(OLD) - 'actor_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'order events are append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "order_events_no_update" BEFORE UPDATE ON "order_events" FOR EACH ROW EXECUTE FUNCTION order_events_no_update();

-- Tạo lại order_events_type_check thêm 'HELD_KEPT' (chủ shop quyết định giữ tiền treo của đơn đã kết thúc; order-event-type.spec.ts đọc migration cuối cùng định nghĩa CHECK này).
ALTER TABLE "order_events" DROP CONSTRAINT "order_events_type_check";
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_type_check" CHECK ("type" IN (
  'CREATED','EDITED','CUSTOMIZATION_SET','ASSIGNEE_CHANGED','PRIORITY_CHANGED','PACKED',
  'SHIPMENT_CREATED','PICKED_UP','DRIVER_CHANGED','SHIPPED','OUT_FOR_DELIVERY','DELIVERED','DELIVERY_FAILED',
  'DEPOSIT_RECORDED','CASH_COLLECTED','QR_PAID','REMITTANCE_CONFIRMED','PAID_OFFLINE',
  'PICKUP_COLLECTED','PICKUP_HANDED_OVER','CANCELLED','STATUS_CHANGED',
  'RETURN_CREATED','RETURN_RECEIVED','RETURN_INSPECTED','RETURN_CANCELLED','REPLACEMENT_LINKED',
  'PRODUCTION_REQUESTED','PRODUCTION_RECEIVED','REFUNDED','HELD_KEPT'));
