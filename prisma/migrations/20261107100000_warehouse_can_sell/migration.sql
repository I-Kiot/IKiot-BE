-- Kho cũng tạo được đơn. Đơn trỏ tới `branches`, và Branch.id = Location.id, nên chỉ cần mỗi kho có một dòng ở đó:
-- không đổi cột nào, đơn cũ không bị đụng tới. Danh sách và hạn mức chi nhánh lọc theo `locations.location_type`,
-- nên kho không lẫn vào màn chi nhánh. Kho hàng hỏng cũng có dòng (cờ bán được đổi được về sau), việc bán do ManualOrderService chặn.
INSERT INTO "branches" ("id", "tenant_id", "location_id")
SELECT w."id", w."tenant_id", w."location_id"
FROM "warehouses" w
ON CONFLICT DO NOTHING;
