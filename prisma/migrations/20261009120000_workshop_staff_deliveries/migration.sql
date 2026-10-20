-- Nhân viên xưởng + phiếu giao của xưởng (2026-10-09).
-- users.workshop_id: tài khoản STAFF thuộc một xưởng (supplier type WORKSHOP - kiểm ở service, SQL
-- không so được loại của bảng khác). production_deliveries: xưởng ghi số giao theo một YCSX; tồn kho
-- và công nợ chỉ tăng khi nơi nhận xác nhận, lúc đó mới có stock_movement_id.


-- AlterTable
ALTER TABLE "users" ADD COLUMN     "workshop_id" TEXT;

-- CreateTable
CREATE TABLE "production_deliveries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "production_request_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "received_by" TEXT,
    "received_at" TIMESTAMPTZ(6),
    "cancelled_by" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" TEXT,
    "stock_movement_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "production_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_delivery_items" (
    "id" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "production_request_item_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "received_quantity" INTEGER,
    "defect_quantity" INTEGER,

    CONSTRAINT "production_delivery_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "production_deliveries_stock_movement_id_key" ON "production_deliveries"("stock_movement_id");

-- CreateIndex
CREATE INDEX "production_deliveries_tenant_id_status_idx" ON "production_deliveries"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "production_deliveries_production_request_id_status_idx" ON "production_deliveries"("production_request_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "production_deliveries_tenant_id_code_key" ON "production_deliveries"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "production_delivery_items_production_request_item_id_idx" ON "production_delivery_items"("production_request_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "production_delivery_items_delivery_id_production_request_it_key" ON "production_delivery_items"("delivery_id", "production_request_item_id");

-- CreateIndex
CREATE INDEX "users_tenant_id_workshop_id_idx" ON "users"("tenant_id", "workshop_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_workshop_id_fkey" FOREIGN KEY ("workshop_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_deliveries" ADD CONSTRAINT "production_deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_deliveries" ADD CONSTRAINT "production_deliveries_production_request_id_fkey" FOREIGN KEY ("production_request_id") REFERENCES "production_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_deliveries" ADD CONSTRAINT "production_deliveries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_deliveries" ADD CONSTRAINT "production_deliveries_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_deliveries" ADD CONSTRAINT "production_deliveries_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_deliveries" ADD CONSTRAINT "production_deliveries_stock_movement_id_fkey" FOREIGN KEY ("stock_movement_id") REFERENCES "stock_movement_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_delivery_items" ADD CONSTRAINT "production_delivery_items_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "production_deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_delivery_items" ADD CONSTRAINT "production_delivery_items_production_request_item_id_fkey" FOREIGN KEY ("production_request_item_id") REFERENCES "production_request_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- SQL-only rules (Prisma cannot express CHECK constraints).
ALTER TABLE "production_deliveries" ADD CONSTRAINT "production_deliveries_status_known"
  CHECK ("status" IN ('PENDING', 'RECEIVED', 'CANCELLED'));
-- Received ⇔ the import it wrote is recorded; cancelled ⇔ who cancelled it.
ALTER TABLE "production_deliveries" ADD CONSTRAINT "production_deliveries_received_has_receipt"
  CHECK (("status" = 'RECEIVED') = ("stock_movement_id" IS NOT NULL AND "received_at" IS NOT NULL));
ALTER TABLE "production_deliveries" ADD CONSTRAINT "production_deliveries_cancelled_has_actor"
  CHECK (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL));
ALTER TABLE "production_delivery_items" ADD CONSTRAINT "production_delivery_items_quantity_positive"
  CHECK ("quantity" > 0);
ALTER TABLE "production_delivery_items" ADD CONSTRAINT "production_delivery_items_received_valid"
  CHECK ("received_quantity" IS NULL
         OR ("received_quantity" >= 0 AND "received_quantity" <= "quantity"
             AND COALESCE("defect_quantity", 0) BETWEEN 0 AND "received_quantity"));
