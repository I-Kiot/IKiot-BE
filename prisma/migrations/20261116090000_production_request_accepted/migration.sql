-- Xưởng xác nhận đang làm YCSX (2026-11-16): có accepted_at thì shop không huỷ được, chỉ xưởng huỷ được.
ALTER TABLE "production_requests" ADD COLUMN "accepted_at" TIMESTAMPTZ(6),
ADD COLUMN "accepted_by" TEXT;

ALTER TABLE "production_requests" ADD CONSTRAINT "production_requests_accepted_by_fkey" FOREIGN KEY ("accepted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tạo lại order_events_type_check thêm 'PRODUCTION_STARTED' (xưởng nhận làm; order-event-type.spec.ts đọc migration cuối cùng định nghĩa CHECK này).
ALTER TABLE "order_events" DROP CONSTRAINT "order_events_type_check";
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_type_check" CHECK ("type" IN (
  'CREATED','EDITED','CUSTOMIZATION_SET','ASSIGNEE_CHANGED','PRIORITY_CHANGED','PACKED',
  'SHIPMENT_CREATED','PICKED_UP','DRIVER_CHANGED','SHIPPED','OUT_FOR_DELIVERY','DELIVERED','DELIVERY_FAILED',
  'DEPOSIT_RECORDED','CASH_COLLECTED','QR_PAID','REMITTANCE_CONFIRMED','PAID_OFFLINE',
  'PICKUP_COLLECTED','PICKUP_HANDED_OVER','CANCELLED','STATUS_CHANGED',
  'RETURN_CREATED','RETURN_RECEIVED','RETURN_INSPECTED','RETURN_CANCELLED','REPLACEMENT_LINKED',
  'PRODUCTION_REQUESTED','PRODUCTION_STARTED','PRODUCTION_RECEIVED','REFUNDED','HELD_KEPT'));
