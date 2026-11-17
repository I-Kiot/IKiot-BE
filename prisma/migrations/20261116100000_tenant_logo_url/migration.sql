-- Logo cửa hàng: URL ảnh đã tải lên qua POST /uploads (Cloudinary). NULL = chưa đặt logo.
ALTER TABLE "tenants" ADD COLUMN "logo_url" TEXT;
