-- Đánh dấu sản phẩm đặt xưởng sản xuất được. Sản phẩm mới mặc định false (chỉ nhập từ NCC).
ALTER TABLE "products" ADD COLUMN "is_manufacturable" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: trước cột này mọi sản phẩm đều đặt xưởng được (2026-10-05), nên dữ liệu cũ giữ nguyên hành vi đó.
UPDATE "products" SET "is_manufacturable" = true;
