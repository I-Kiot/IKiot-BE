-- Deploy chỉ chạy `prisma migrate deploy`, không chạy seed, nên quyền thêm vào CATALOG của seed sau lần seed đầu
-- không bao giờ tới DB đã triển khai: `role_permissions` có khoá ngoại vào đây nên role không gán được quyền đó
-- (tạo role với `production:deliver` trả 400 "not a recognized permission", nên tài khoản xưởng không có role dùng được).
-- Ba quyền dưới đây là phần đã sót; ON CONFLICT để DB đã seed rồi không bị đụng tới.
INSERT INTO "permission_catalog" ("resource", "action", "label") VALUES
  ('production', 'deliver', 'Nhập hàng sản xuất'),
  ('branches', 'read_own', 'Chi nhánh'),
  ('warehouses', 'read_own', 'Kho')
ON CONFLICT ("resource", "action") DO NOTHING;
