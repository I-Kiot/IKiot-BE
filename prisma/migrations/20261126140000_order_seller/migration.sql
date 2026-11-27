-- Người ăn doanh thu của đơn: chọn lúc tạo đơn, không sửa được; đơn cũ để trống.
ALTER TABLE "orders" ADD COLUMN "seller_id" TEXT;
ALTER TABLE "orders" ADD CONSTRAINT "orders_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Sổ doanh thu chụp người ăn doanh thu lúc ghi, không khoá ngoại như assignee_id / creator_id.
ALTER TABLE "sales_journal_entries" ADD COLUMN "seller_id" TEXT;

-- Chặn đổi người ăn doanh thu đã đặt (vẫn cho đặt lần đầu từ NULL).
CREATE FUNCTION orders_seller_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.seller_id IS NOT NULL AND NEW.seller_id IS DISTINCT FROM OLD.seller_id THEN
    RAISE EXCEPTION 'orders.seller_id cannot be changed';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "orders_seller_immutable" BEFORE UPDATE OF "seller_id" ON "orders" FOR EACH ROW EXECUTE FUNCTION orders_seller_immutable();
