-- Nhật ký thao tác trên đơn: chỉ ghi thêm, ghi trong cùng transaction với thay đổi (xem order-events.ts).
-- CreateTable
CREATE TABLE "order_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "source" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_name" TEXT,
    "actor_role" TEXT,
    "changes" JSONB,
    "metadata" JSONB,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_events_tenant_id_order_id_occurred_at_idx" ON "order_events"("tenant_id", "order_id", "occurred_at");

-- CreateIndex
CREATE INDEX "order_events_tenant_id_actor_id_occurred_at_idx" ON "order_events"("tenant_id", "actor_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Chỉ có trong SQL (Prisma không biểu diễn được CHECK). Thêm một loại sự kiện = migration mới tạo lại order_events_type_check
-- (order-event-type.spec.ts đọc migration này và so với ORDER_EVENT_TYPES).
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_source_check" CHECK ("source" IN ('USER','SYSTEM','WEBHOOK'));
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_check" CHECK ("source" = 'USER' OR "actor_id" IS NULL);
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_type_check" CHECK ("type" IN (
  'CREATED','EDITED','CUSTOMIZATION_SET','ASSIGNEE_CHANGED','PRIORITY_CHANGED','PACKED',
  'SHIPMENT_CREATED','PICKED_UP','DRIVER_CHANGED','SHIPPED','OUT_FOR_DELIVERY','DELIVERED','DELIVERY_FAILED',
  'DEPOSIT_RECORDED','CASH_COLLECTED','QR_PAID','REMITTANCE_CONFIRMED','PAID_OFFLINE',
  'PICKUP_COLLECTED','PICKUP_HANDED_OVER','CANCELLED','STATUS_CHANGED',
  'RETURN_CREATED','RETURN_RECEIVED','RETURN_INSPECTED','RETURN_CANCELLED','REPLACEMENT_LINKED',
  'PRODUCTION_REQUESTED','PRODUCTION_RECEIVED'));
