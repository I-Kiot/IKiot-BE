-- The furniture order journey (P0-1, docs/order-flow.md): every table and column the schema at
-- 63f20b3 declares beyond 20261002090000. Generated with `prisma migrate diff`, then edited by
-- hand in four places, each marked "HAND-WRITTEN":
--   0. preconditions - refuse to start on data the new CHECKs would reject, before any change;
--   1. order_items.list_unit_price / line_total are added nullable, backfilled, then set NOT NULL;
--   2. backfill - old orders/lines into the new vocabulary, import_source, OPENING lots + ledger;
--   3. the SQL-only constraints listed in the schema header (Prisma cannot express them, and a
--      later `migrate diff` will NOT propose dropping them).

-- ─── 0. HAND-WRITTEN: preconditions ──────────────────────────────────────────
-- Quantities become INTEGER and stock gets CHECK (stock >= 0). A fractional quantity or a
-- negative stock would otherwise be rounded silently or fail halfway through the script.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "order_items" WHERE "quantity" <> trunc("quantity") OR "quantity" <= 0) THEN
    RAISE EXCEPTION 'order_items has a fractional or non-positive quantity - fix the rows before migrating';
  END IF;
  IF EXISTS (SELECT 1 FROM "stock_movement_request_items"
             WHERE "quantity" <> trunc("quantity")
                OR ("received_quantity" IS NOT NULL AND "received_quantity" <> trunc("received_quantity"))) THEN
    RAISE EXCEPTION 'stock_movement_request_items has a fractional quantity - fix the rows before migrating';
  END IF;
  IF EXISTS (SELECT 1 FROM "inventories" WHERE "stock" < 0) THEN
    RAISE EXCEPTION 'inventories has negative stock - correct it with an ADJUST before migrating';
  END IF;
END $$;

-- DropForeignKey
ALTER TABLE "orders" DROP CONSTRAINT "orders_user_id_fkey";

-- DropIndex
DROP INDEX "cash_flows_order_id_flow_type_key";

-- AlterTable
ALTER TABLE "cash_flows" ADD COLUMN     "payment_id" TEXT;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "email" TEXT,
ADD COLUMN     "marketing_consent_email" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "marketing_consent_messenger" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "marketing_consent_zalo" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "region" TEXT;

-- AlterTable
ALTER TABLE "inventories" ADD COLUMN     "reserved" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "damaged_location_id" TEXT,
ADD COLUMN     "default_fulfillment_location_id" TEXT,
ADD COLUMN     "is_sellable" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
-- HAND-WRITTEN (1): line_total / list_unit_price start nullable; section 2 fills them and sets NOT NULL.
ALTER TABLE "order_items" ADD COLUMN     "channel_item_ref" TEXT,
ADD COLUMN     "is_custom" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "line_total" DECIMAL(14,2),
ADD COLUMN     "line_type" TEXT NOT NULL DEFAULT 'PRODUCT',
ADD COLUMN     "list_unit_price" DECIMAL(12,2),
ADD COLUMN     "parent_item_id" TEXT,
ADD COLUMN     "returned_quantity" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sku" TEXT,
ADD COLUMN     "source_location_id" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "unit_cost_price" DECIMAL(12,2),
ADD COLUMN     "variant_label" TEXT,
ADD COLUMN     "vat_rate" DECIMAL(5,2),
ALTER COLUMN "quantity" SET DATA TYPE INTEGER;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "assignee_id" TEXT,
ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "channel_fee" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "channel_id" TEXT,
ADD COLUMN     "channel_order_ref" TEXT,
ADD COLUMN     "channel_payload" JSONB,
ADD COLUMN     "channel_status" TEXT,
ADD COLUMN     "channel_synced_at" TIMESTAMPTZ(6),
ADD COLUMN     "confirmed_at" TIMESTAMPTZ(6),
ADD COLUMN     "confirmed_by" TEXT,
ADD COLUMN     "delivery_address" TEXT,
ADD COLUMN     "deposit_required" DECIMAL(14,2),
ADD COLUMN     "fulfillment_type" TEXT NOT NULL DEFAULT 'HOME_DELIVERY',
ADD COLUMN     "payment_status" TEXT NOT NULL DEFAULT 'UNPAID',
ADD COLUMN     "recipient_name" TEXT,
ADD COLUMN     "recipient_phone" TEXT,
ADD COLUMN     "requested_delivery_date" DATE,
ADD COLUMN     "ship_by_date" TIMESTAMPTZ(6),
ADD COLUMN     "shipping_fee" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "vat_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
ALTER COLUMN "status" DROP DEFAULT,
ALTER COLUMN "user_id" DROP NOT NULL,
ALTER COLUMN "payment_method" DROP NOT NULL;

-- AlterTable
ALTER TABLE "product_item_suppliers" ADD COLUMN     "lead_time_days" INTEGER;

-- AlterTable
ALTER TABLE "product_items" ADD COLUMN     "allow_customization" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "custom_lead_time_days" INTEGER,
ADD COLUMN     "height_cm" DECIMAL(10,2),
ADD COLUMN     "item_type" TEXT NOT NULL DEFAULT 'PRODUCT',
ADD COLUMN     "length_cm" DECIMAL(10,2),
ADD COLUMN     "volume_m3" DECIMAL(10,4),
ADD COLUMN     "weight_kg" DECIMAL(10,3),
ADD COLUMN     "width_cm" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "stock_movement_request_items" ADD COLUMN     "defect_location_id" TEXT,
ADD COLUMN     "defect_quantity" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "production_request_item_id" TEXT,
ALTER COLUMN "quantity" SET DATA TYPE INTEGER,
ALTER COLUMN "received_quantity" SET DATA TYPE INTEGER;

-- AlterTable
ALTER TABLE "stock_movement_requests" ADD COLUMN     "approved_at" TIMESTAMPTZ(6),
ADD COLUMN     "approved_by" TEXT,
ADD COLUMN     "cancelled_at" TIMESTAMPTZ(6),
ADD COLUMN     "import_source" TEXT,
ADD COLUMN     "received_at" TIMESTAMPTZ(6),
ADD COLUMN     "received_by" TEXT,
ADD COLUMN     "shipped_at" TIMESTAMPTZ(6),
ADD COLUMN     "shipped_by" TEXT;

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'GOODS';

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "invoice_auto_issue_on" TEXT;

-- AlterTable
ALTER TABLE "working_schedules" ADD COLUMN     "location_id" TEXT;

-- CreateTable
CREATE TABLE "product_packages" (
    "id" TEXT NOT NULL,
    "product_item_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT,
    "barcode" TEXT,
    "length_cm" DECIMAL(10,2),
    "width_cm" DECIMAL(10,2),
    "height_cm" DECIMAL(10,2),
    "weight_kg" DECIMAL(10,3),

    CONSTRAINT "product_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "combo_components" (
    "combo_item_id" TEXT NOT NULL,
    "component_item_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "combo_components_pkey" PRIMARY KEY ("combo_item_id","component_item_id")
);

-- CreateTable
CREATE TABLE "inventory_transactions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "product_item_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "unit_cost" DECIMAL(12,2),
    "reference_type" TEXT NOT NULL,
    "reference_id" TEXT NOT NULL,
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lot_id" TEXT NOT NULL,
    "order_item_id" TEXT,

    CONSTRAINT "inventory_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_lots" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "product_item_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "supplier_id" TEXT,
    "import_item_id" TEXT,
    "production_request_item_id" TEXT,
    "order_item_id" TEXT,
    "parent_lot_id" TEXT,
    "unit_cost" DECIMAL(12,2) NOT NULL,
    "received_quantity" INTEGER NOT NULL,
    "remaining_quantity" INTEGER NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_nodes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "type" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "pick_sequence" INTEGER,
    "pos_x" DOUBLE PRECISION,
    "pos_y" DOUBLE PRECISION,
    "width" DOUBLE PRECISION,
    "height" DOUBLE PRECISION,
    "rotation" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "storage_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sku_placements" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "storage_node_id" TEXT NOT NULL,
    "product_item_id" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "quantity" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sku_placements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_channels" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "access_token" TEXT,
    "refresh_token" TEXT,
    "token_expires_at" TIMESTAMPTZ(6),
    "branch_id" TEXT NOT NULL,
    "location_id" TEXT,
    "last_order_sync_at" TIMESTAMPTZ(6),
    "last_sync_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sales_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_product_mappings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "external_item_id" TEXT NOT NULL,
    "external_model_id" TEXT NOT NULL DEFAULT '0',
    "external_sku" TEXT,
    "product_item_id" TEXT NOT NULL,
    "sync_stock" BOOLEAN NOT NULL DEFAULT true,
    "last_stock_push_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_product_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_reservations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "expected_ready_date" DATE,
    "sent_at" TIMESTAMPTZ(6),
    "note" TEXT,
    "created_by" TEXT,
    "status_updated_by" TEXT,
    "status_updated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "production_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_request_items" (
    "id" TEXT NOT NULL,
    "production_request_id" TEXT NOT NULL,
    "product_item_id" TEXT NOT NULL,
    "order_item_id" TEXT,
    "quantity" INTEGER NOT NULL,
    "received_quantity" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,

    CONSTRAINT "production_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_customizations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "length_cm" DECIMAL(10,2),
    "width_cm" DECIMAL(10,2),
    "height_cm" DECIMAL(10,2),
    "material" TEXT,
    "color" TEXT,
    "fabric_code" TEXT,
    "note" TEXT,
    "attachment_urls" TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "order_item_customizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_specs" (
    "id" TEXT NOT NULL,
    "customization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "unit" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_item_specs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_returns" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "shipment_id" TEXT,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "created_by" TEXT,
    "inspected_by" TEXT,
    "inspected_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "order_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_return_items" (
    "id" TEXT NOT NULL,
    "return_id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "condition" TEXT,
    "location_id" TEXT,
    "note" TEXT,

    CONSTRAINT "order_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "refund_of_payment_id" TEXT,
    "payment_reference" TEXT,
    "sepay_transaction_id" TEXT,
    "paid_at" TIMESTAMPTZ(6),
    "location_id" TEXT,
    "collected_by" TEXT,
    "created_by" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfillments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "exception_note" TEXT,
    "assignee_id" TEXT,
    "verified_by" TEXT,
    "due_date" DATE,
    "pick_started_at" TIMESTAMPTZ(6),
    "picked_at" TIMESTAMPTZ(6),
    "pack_started_at" TIMESTAMPTZ(6),
    "packed_at" TIMESTAMPTZ(6),
    "verified_at" TIMESTAMPTZ(6),
    "handed_over_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fulfillments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfillment_items" (
    "id" TEXT NOT NULL,
    "fulfillment_id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "qty_picked" INTEGER NOT NULL DEFAULT 0,
    "qty_packed" INTEGER NOT NULL DEFAULT 0,
    "picked_from_id" TEXT,

    CONSTRAINT "fulfillment_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfillment_packages" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "fulfillment_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "product_package_id" TEXT,
    "weight_kg" DECIMAL(10,3),
    "photo_urls" TEXT[],
    "packed_by" TEXT,
    "packed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handed_over_at" TIMESTAMPTZ(6),

    CONSTRAINT "fulfillment_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "fulfillment_id" TEXT NOT NULL,
    "carrier_type" TEXT NOT NULL DEFAULT 'INTERNAL',
    "carrier_name" TEXT,
    "tracking_code" TEXT,
    "driver_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "recipient_name" TEXT,
    "recipient_phone" TEXT,
    "delivery_address" TEXT,
    "scheduled_date" DATE,
    "scheduled_slot" TEXT,
    "expected_delivery_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "requires_installation" BOOLEAN NOT NULL DEFAULT false,
    "installed_at" TIMESTAMPTZ(6),
    "proof_photo_urls" TEXT[],
    "shipping_cost" DECIMAL(14,2),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_events" (
    "id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "note" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "created_by" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "location_id" TEXT,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "metadata" JSONB,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vouchers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "promotion_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code_prefix" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voucher_codes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "voucher_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "customer_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "order_id" TEXT,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voucher_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'SALE',
    "original_invoice_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "buyer_name" TEXT,
    "buyer_tax_code" TEXT,
    "buyer_address" TEXT,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "vat_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "reason" TEXT,
    "issued_at" TIMESTAMPTZ(6),
    "einvoice_provider" TEXT,
    "einvoice_ref" TEXT,
    "einvoice_lookup_code" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "order_item_id" TEXT,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "vat_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(14,2) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_packages_product_item_id_position_key" ON "product_packages"("product_item_id", "position");

-- CreateIndex
CREATE INDEX "inventory_transactions_tenant_id_location_id_product_item_i_idx" ON "inventory_transactions"("tenant_id", "location_id", "product_item_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_transactions_reference_type_reference_id_idx" ON "inventory_transactions"("reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "inventory_lots_tenant_id_location_id_product_item_id_receiv_idx" ON "inventory_lots"("tenant_id", "location_id", "product_item_id", "received_at");

-- CreateIndex
CREATE INDEX "inventory_lots_tenant_id_source_type_supplier_id_idx" ON "inventory_lots"("tenant_id", "source_type", "supplier_id");

-- CreateIndex
CREATE INDEX "inventory_lots_order_item_id_idx" ON "inventory_lots"("order_item_id");

-- CreateIndex
CREATE INDEX "storage_nodes_tenant_id_location_id_type_idx" ON "storage_nodes"("tenant_id", "location_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "storage_nodes_location_id_code_key" ON "storage_nodes"("location_id", "code");

-- CreateIndex
CREATE INDEX "sku_placements_tenant_id_product_item_id_idx" ON "sku_placements"("tenant_id", "product_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "sku_placements_storage_node_id_product_item_id_key" ON "sku_placements"("storage_node_id", "product_item_id");

-- CreateIndex
CREATE INDEX "sales_channels_tenant_id_idx" ON "sales_channels"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_channels_platform_shop_id_key" ON "sales_channels"("platform", "shop_id");

-- CreateIndex
CREATE INDEX "channel_product_mappings_tenant_id_product_item_id_idx" ON "channel_product_mappings"("tenant_id", "product_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_product_mappings_channel_id_external_item_id_extern_key" ON "channel_product_mappings"("channel_id", "external_item_id", "external_model_id");

-- CreateIndex
CREATE INDEX "stock_reservations_tenant_id_location_id_status_idx" ON "stock_reservations"("tenant_id", "location_id", "status");

-- CreateIndex
CREATE INDEX "stock_reservations_order_item_id_idx" ON "stock_reservations"("order_item_id");

-- CreateIndex
CREATE INDEX "production_requests_tenant_id_status_expected_ready_date_idx" ON "production_requests"("tenant_id", "status", "expected_ready_date");

-- CreateIndex
CREATE INDEX "production_requests_tenant_id_location_id_status_idx" ON "production_requests"("tenant_id", "location_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "production_requests_tenant_id_code_key" ON "production_requests"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "production_request_items_production_request_id_idx" ON "production_request_items"("production_request_id");

-- CreateIndex
CREATE INDEX "production_request_items_product_item_id_idx" ON "production_request_items"("product_item_id");

-- CreateIndex
CREATE INDEX "production_request_items_order_item_id_idx" ON "production_request_items"("order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_item_customizations_order_item_id_key" ON "order_item_customizations"("order_item_id");

-- CreateIndex
CREATE INDEX "order_returns_tenant_id_order_id_idx" ON "order_returns"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "order_returns_tenant_id_status_idx" ON "order_returns"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "order_returns_tenant_id_code_key" ON "order_returns"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "order_return_items_return_id_order_item_id_key" ON "order_return_items"("return_id", "order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_payment_reference_key" ON "payments"("payment_reference");

-- CreateIndex
CREATE INDEX "payments_tenant_id_order_id_idx" ON "payments"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "payments_tenant_id_status_created_at_idx" ON "payments"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "fulfillments_tenant_id_location_id_status_idx" ON "fulfillments"("tenant_id", "location_id", "status");

-- CreateIndex
CREATE INDEX "fulfillments_tenant_id_order_id_idx" ON "fulfillments"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "fulfillments_tenant_id_assignee_id_status_idx" ON "fulfillments"("tenant_id", "assignee_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "fulfillment_items_fulfillment_id_order_item_id_key" ON "fulfillment_items"("fulfillment_id", "order_item_id");

-- CreateIndex
CREATE INDEX "fulfillment_packages_fulfillment_id_idx" ON "fulfillment_packages"("fulfillment_id");

-- CreateIndex
CREATE UNIQUE INDEX "fulfillment_packages_tenant_id_code_key" ON "fulfillment_packages"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "shipments_tenant_id_status_expected_delivery_at_idx" ON "shipments"("tenant_id", "status", "expected_delivery_at");

-- CreateIndex
CREATE INDEX "shipments_tenant_id_carrier_name_idx" ON "shipments"("tenant_id", "carrier_name");

-- CreateIndex
CREATE INDEX "shipments_tenant_id_order_id_idx" ON "shipments"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "shipments_fulfillment_id_idx" ON "shipments"("fulfillment_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_carrier_name_tracking_code_key" ON "shipments"("carrier_name", "tracking_code");

-- CreateIndex
CREATE INDEX "shipment_events_shipment_id_occurred_at_idx" ON "shipment_events"("shipment_id", "occurred_at");

-- CreateIndex
CREATE INDEX "operation_events_tenant_id_user_id_occurred_at_idx" ON "operation_events"("tenant_id", "user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "operation_events_tenant_id_location_id_occurred_at_idx" ON "operation_events"("tenant_id", "location_id", "occurred_at");

-- CreateIndex
CREATE INDEX "operation_events_reference_type_reference_id_idx" ON "operation_events"("reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "voucher_codes_tenant_id_customer_id_status_idx" ON "voucher_codes"("tenant_id", "customer_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "voucher_codes_tenant_id_code_key" ON "voucher_codes"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "invoices_tenant_id_order_id_idx" ON "invoices"("tenant_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_tenant_id_invoice_number_key" ON "invoices"("tenant_id", "invoice_number");

-- CreateIndex
CREATE INDEX "invoice_lines_invoice_id_idx" ON "invoice_lines"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_flows_payment_id_key" ON "cash_flows"("payment_id");

-- CreateIndex
CREATE INDEX "cash_flows_tenant_id_order_id_idx" ON "cash_flows"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "customers_tenant_id_phone_idx" ON "customers"("tenant_id", "phone");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_items_product_item_id_idx" ON "order_items"("product_item_id");

-- CreateIndex
CREATE INDEX "order_items_source_location_id_status_idx" ON "order_items"("source_location_id", "status");

-- CreateIndex
CREATE INDEX "orders_tenant_id_status_idx" ON "orders"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "orders_tenant_id_assignee_id_status_idx" ON "orders"("tenant_id", "assignee_id", "status");

-- CreateIndex
CREATE INDEX "orders_tenant_id_branch_id_created_at_idx" ON "orders"("tenant_id", "branch_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_tenant_id_customer_id_created_at_idx" ON "orders"("tenant_id", "customer_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_tenant_id_channel_created_at_idx" ON "orders"("tenant_id", "channel", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_channel_id_channel_order_ref_key" ON "orders"("channel_id", "channel_order_ref");

-- CreateIndex
CREATE INDEX "product_items_tenant_id_product_id_idx" ON "product_items"("tenant_id", "product_id");

-- CreateIndex
CREATE INDEX "stock_movement_request_items_request_id_idx" ON "stock_movement_request_items"("request_id");

-- CreateIndex
CREATE INDEX "stock_movement_request_items_production_request_item_id_idx" ON "stock_movement_request_items"("production_request_item_id");

-- CreateIndex
CREATE INDEX "stock_movement_requests_tenant_id_status_idx" ON "stock_movement_requests"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "stock_movement_requests_tenant_id_movement_type_import_sour_idx" ON "stock_movement_requests"("tenant_id", "movement_type", "import_source", "from_supplier_id");

-- CreateIndex
CREATE INDEX "working_schedules_tenant_id_location_id_work_date_idx" ON "working_schedules"("tenant_id", "location_id", "work_date");

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_default_fulfillment_location_id_fkey" FOREIGN KEY ("default_fulfillment_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_damaged_location_id_fkey" FOREIGN KEY ("damaged_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_packages" ADD CONSTRAINT "product_packages_product_item_id_fkey" FOREIGN KEY ("product_item_id") REFERENCES "product_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_components" ADD CONSTRAINT "combo_components_combo_item_id_fkey" FOREIGN KEY ("combo_item_id") REFERENCES "product_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_components" ADD CONSTRAINT "combo_components_component_item_id_fkey" FOREIGN KEY ("component_item_id") REFERENCES "product_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_product_item_id_fkey" FOREIGN KEY ("product_item_id") REFERENCES "product_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "inventory_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_product_item_id_fkey" FOREIGN KEY ("product_item_id") REFERENCES "product_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_import_item_id_fkey" FOREIGN KEY ("import_item_id") REFERENCES "stock_movement_request_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_production_request_item_id_fkey" FOREIGN KEY ("production_request_item_id") REFERENCES "production_request_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_parent_lot_id_fkey" FOREIGN KEY ("parent_lot_id") REFERENCES "inventory_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_nodes" ADD CONSTRAINT "storage_nodes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_nodes" ADD CONSTRAINT "storage_nodes_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_nodes" ADD CONSTRAINT "storage_nodes_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "storage_nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku_placements" ADD CONSTRAINT "sku_placements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku_placements" ADD CONSTRAINT "sku_placements_storage_node_id_fkey" FOREIGN KEY ("storage_node_id") REFERENCES "storage_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku_placements" ADD CONSTRAINT "sku_placements_product_item_id_fkey" FOREIGN KEY ("product_item_id") REFERENCES "product_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement_requests" ADD CONSTRAINT "stock_movement_requests_shipped_by_fkey" FOREIGN KEY ("shipped_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement_requests" ADD CONSTRAINT "stock_movement_requests_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement_requests" ADD CONSTRAINT "stock_movement_requests_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement_request_items" ADD CONSTRAINT "stock_movement_request_items_production_request_item_id_fkey" FOREIGN KEY ("production_request_item_id") REFERENCES "production_request_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement_request_items" ADD CONSTRAINT "stock_movement_request_items_defect_location_id_fkey" FOREIGN KEY ("defect_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "working_schedules" ADD CONSTRAINT "working_schedules_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_product_mappings" ADD CONSTRAINT "channel_product_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_product_mappings" ADD CONSTRAINT "channel_product_mappings_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "sales_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_product_mappings" ADD CONSTRAINT "channel_product_mappings_product_item_id_fkey" FOREIGN KEY ("product_item_id") REFERENCES "product_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "sales_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_source_location_id_fkey" FOREIGN KEY ("source_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_parent_item_id_fkey" FOREIGN KEY ("parent_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_requests" ADD CONSTRAINT "production_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_requests" ADD CONSTRAINT "production_requests_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_requests" ADD CONSTRAINT "production_requests_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_requests" ADD CONSTRAINT "production_requests_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_requests" ADD CONSTRAINT "production_requests_status_updated_by_fkey" FOREIGN KEY ("status_updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_request_items" ADD CONSTRAINT "production_request_items_production_request_id_fkey" FOREIGN KEY ("production_request_id") REFERENCES "production_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_request_items" ADD CONSTRAINT "production_request_items_product_item_id_fkey" FOREIGN KEY ("product_item_id") REFERENCES "product_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_request_items" ADD CONSTRAINT "production_request_items_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_customizations" ADD CONSTRAINT "order_item_customizations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_customizations" ADD CONSTRAINT "order_item_customizations_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_specs" ADD CONSTRAINT "order_item_specs_customization_id_fkey" FOREIGN KEY ("customization_id") REFERENCES "order_item_customizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_inspected_by_fkey" FOREIGN KEY ("inspected_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_return_items" ADD CONSTRAINT "order_return_items_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "order_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_return_items" ADD CONSTRAINT "order_return_items_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_return_items" ADD CONSTRAINT "order_return_items_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_flows" ADD CONSTRAINT "cash_flows_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_of_payment_id_fkey" FOREIGN KEY ("refund_of_payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_collected_by_fkey" FOREIGN KEY ("collected_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_items" ADD CONSTRAINT "fulfillment_items_fulfillment_id_fkey" FOREIGN KEY ("fulfillment_id") REFERENCES "fulfillments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_items" ADD CONSTRAINT "fulfillment_items_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_items" ADD CONSTRAINT "fulfillment_items_picked_from_id_fkey" FOREIGN KEY ("picked_from_id") REFERENCES "storage_nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_packages" ADD CONSTRAINT "fulfillment_packages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_packages" ADD CONSTRAINT "fulfillment_packages_fulfillment_id_fkey" FOREIGN KEY ("fulfillment_id") REFERENCES "fulfillments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_packages" ADD CONSTRAINT "fulfillment_packages_product_package_id_fkey" FOREIGN KEY ("product_package_id") REFERENCES "product_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_packages" ADD CONSTRAINT "fulfillment_packages_packed_by_fkey" FOREIGN KEY ("packed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_fulfillment_id_fkey" FOREIGN KEY ("fulfillment_id") REFERENCES "fulfillments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_events" ADD CONSTRAINT "operation_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_events" ADD CONSTRAINT "operation_events_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_events" ADD CONSTRAINT "operation_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_codes" ADD CONSTRAINT "voucher_codes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_codes" ADD CONSTRAINT "voucher_codes_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_codes" ADD CONSTRAINT "voucher_codes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_codes" ADD CONSTRAINT "voucher_codes_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_original_invoice_id_fkey" FOREIGN KEY ("original_invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 2. HAND-WRITTEN: backfill ───────────────────────────────────────────────
-- Every order before this migration is a till sale: rung up and handed over at the counter by
-- the account that created it. Their statuses (PENDING / COMPLETED / CANCELLED / RETURNED) are
-- left as they are - the till code still writes them until track A (A-2) moves it over.

-- Order lines: the till always sold at the catalogue price, so the list price is the unit price.
UPDATE "order_items" oi SET
  "list_unit_price" = oi."unit_price",
  "line_total"      = GREATEST(0, round(oi."unit_price" * oi."quantity") - oi."discount_amount"),
  "sku"             = pi."sku",
  "status"          = CASE o."status"
                        WHEN 'COMPLETED' THEN 'DELIVERED'
                        WHEN 'CANCELLED' THEN 'CANCELLED'
                        WHEN 'RETURNED'  THEN 'RETURNED'
                        ELSE 'PENDING'
                      END,
  "returned_quantity" = CASE WHEN o."status" = 'RETURNED' THEN oi."quantity" ELSE 0 END
FROM "orders" o, "product_items" pi
WHERE o."id" = oi."order_id" AND pi."id" = oi."product_item_id";

ALTER TABLE "order_items" ALTER COLUMN "list_unit_price" SET NOT NULL,
ALTER COLUMN "line_total" SET NOT NULL;

-- Orders: whoever rang the sale up is its person in charge and confirmed it - the
-- orders_assignee_required CHECK below needs the first for every non-draft order. A till sale
-- is TAKEAWAY. A RETURNED sale had its money paid back (the old flow booked an EXPENSE).
UPDATE "orders" o SET
  "assignee_id"      = o."user_id",
  "confirmed_by"     = o."user_id",
  "confirmed_at"     = o."created_at",
  "fulfillment_type" = 'TAKEAWAY',
  "subtotal"         = COALESCE((SELECT SUM(oi."line_total") FROM "order_items" oi WHERE oi."order_id" = o."id"), 0),
  "payment_status"   = CASE o."status"
                         WHEN 'COMPLETED' THEN 'PAID'
                         WHEN 'RETURNED'  THEN 'REFUNDED'
                         ELSE 'UNPAID'
                       END;

-- Every import so far bought finished goods from a supplier.
UPDATE "stock_movement_requests" SET "import_source" = 'SUPPLIER' WHERE "movement_type" = 'IMPORT';

-- Stock that predates lots: one OPENING lot per inventory row holding stock, costed at the
-- variant's current cost price and dated by the inventory row (the FIFO key), plus the inbound
-- ledger row that opens it - so Σ lot.remaining = stock holds from the first deploy on.
CREATE TEMP TABLE "_opening_lots" AS
SELECT gen_random_uuid()::text AS "lot_id", i."id" AS "inventory_id", i."tenant_id", i."location_id",
       i."product_item_id", i."stock", i."created_at", pi."cost_price"
FROM "inventories" i
JOIN "product_items" pi ON pi."id" = i."product_item_id"
WHERE i."stock" > 0;

INSERT INTO "inventory_lots" ("id", "tenant_id", "location_id", "product_item_id", "source_type",
  "unit_cost", "received_quantity", "remaining_quantity", "received_at", "created_at", "updated_at")
SELECT "lot_id", "tenant_id", "location_id", "product_item_id", 'OPENING',
  "cost_price", "stock", "stock", "created_at", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "_opening_lots";

INSERT INTO "inventory_transactions" ("id", "tenant_id", "location_id", "product_item_id", "type",
  "quantity", "balance_after", "unit_cost", "reference_type", "reference_id", "note", "lot_id", "created_at")
SELECT gen_random_uuid()::text, "tenant_id", "location_id", "product_item_id", 'OPENING',
  "stock", "stock", "cost_price", 'INVENTORY', "inventory_id", 'Tồn đầu kỳ khi chuyển sang quản lý theo lô', "lot_id", CURRENT_TIMESTAMP
FROM "_opening_lots";

DROP TABLE "_opening_lots";

-- ─── 3. HAND-WRITTEN: SQL-only constraints (schema header) ───────────────────
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_stock_reserved_valid"
  CHECK ("stock" >= 0 AND "reserved" >= 0 AND "reserved" <= "stock");

ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantities_valid"
  CHECK ("quantity" > 0 AND "returned_quantity" BETWEEN 0 AND "quantity");

ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "production_request_items" ADD CONSTRAINT "production_request_items_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "production_request_items" ADD CONSTRAINT "production_request_items_received_non_negative" CHECK ("received_quantity" >= 0);
ALTER TABLE "order_return_items" ADD CONSTRAINT "order_return_items_quantity_positive" CHECK ("quantity" > 0);

ALTER TABLE "stock_movement_request_items" ADD CONSTRAINT "stock_movement_request_items_defect_valid"
  CHECK ("defect_quantity" BETWEEN 0 AND COALESCE("received_quantity", 0));

ALTER TABLE "stock_movement_requests" ADD CONSTRAINT "stock_movement_requests_import_source_iff_import"
  CHECK (("movement_type" = 'IMPORT') = ("import_source" IS NOT NULL));

ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_quantities_valid"
  CHECK ("received_quantity" > 0 AND "remaining_quantity" BETWEEN 0 AND "received_quantity");

ALTER TABLE "orders" ADD CONSTRAINT "orders_assignee_required"
  CHECK ("status" IN ('DRAFT', 'PENDING_CONFIRMATION') OR "assignee_id" IS NOT NULL);

ALTER TABLE "fulfillment_items" ADD CONSTRAINT "fulfillment_items_quantities_valid"
  CHECK ("qty_packed" <= "qty_picked" AND "qty_picked" <= "quantity");

ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0);

CREATE UNIQUE INDEX "invoices_one_live_sale_per_order" ON "invoices" ("order_id")
  WHERE "type" = 'SALE' AND "status" <> 'CANCELLED';

