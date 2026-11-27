-- AlterTable
ALTER TABLE "order_item_specs" ADD COLUMN     "attribute_id" TEXT,
ADD COLUMN     "base_value" TEXT;

-- AlterTable
ALTER TABLE "production_request_items" ADD COLUMN     "attachment_urls" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AddForeignKey
ALTER TABLE "order_item_specs" ADD CONSTRAINT "order_item_specs_attribute_id_fkey" FOREIGN KEY ("attribute_id") REFERENCES "product_attributes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
