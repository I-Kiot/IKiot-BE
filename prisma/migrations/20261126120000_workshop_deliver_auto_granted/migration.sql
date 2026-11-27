-- `production:deliver` giờ tự cấp cho nhân viên xưởng (STAFF có `users.workshop_id`), xem WORKSHOP_STAFF_PERMISSIONS
-- trong src/common/constants/system-role.ts. Màn Vai trò không còn ô này và role không lưu được nó nữa, nên gỡ các dòng
-- đã cấp qua role. Dòng danh mục `permission_catalog` giữ nguyên (`@Permissions('production', 'deliver')` vẫn trỏ vào nó).
DELETE FROM "role_permissions"
WHERE "resource" = 'production' AND "action" = 'deliver';
