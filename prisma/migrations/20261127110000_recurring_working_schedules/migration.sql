-- Lịch lặp lại + bỏ loại ca (NORMAL / OVERTIME).
--
-- `schedule_type` chỉ có nghĩa với bảng lương (tăng ca tính khác ca thường); bảng lương đã
-- ra khỏi phạm vi từ 2026-10-01 nên cột bị bỏ. Nó nằm trong unique một-phần
-- `working_schedules_one_per_slot`, nên hai ca sống cùng ca mẫu / ngày / giờ mà chỉ khác loại
-- sẽ làm hỏng index mới: gộp chúng trước (giữ dòng NORMAL, cũ nhất; chuyển người sang; dòng
-- còn lại thành DELETED).

CREATE TEMP TABLE "_ws_merge" AS
SELECT "id",
       first_value("id") OVER (
         PARTITION BY "tenant_id", "shift_template_id", "work_date", "start_at", "end_at"
         ORDER BY ("schedule_type" = 'NORMAL') DESC, "created_at", "id"
       ) AS "keeper"
FROM "working_schedules"
WHERE "status" IN ('SCHEDULED', 'COMPLETED');

INSERT INTO "working_schedule_users" ("schedule_id", "user_id")
SELECT m."keeper", u."user_id"
FROM "working_schedule_users" u
JOIN "_ws_merge" m ON m."id" = u."schedule_id"
WHERE m."id" <> m."keeper"
ON CONFLICT DO NOTHING;

UPDATE "working_schedules" s
SET "status" = 'DELETED', "updated_at" = now()
FROM "_ws_merge" m
WHERE s."id" = m."id" AND m."id" <> m."keeper";

DROP TABLE "_ws_merge";

-- Bỏ cột kéo theo index cũ; dựng lại index không có loại ca.
DROP INDEX IF EXISTS "working_schedules_one_per_slot";
ALTER TABLE "working_schedules" DROP COLUMN "schedule_type";

CREATE UNIQUE INDEX "working_schedules_one_per_slot"
  ON "working_schedules"("tenant_id", "shift_template_id", "work_date", "start_at", "end_at")
  WHERE "status" IN ('SCHEDULED', 'COMPLETED');

-- Lịch lặp lại: một ca mẫu, từ ngày đến ngày, các thứ trong tuần (0 = CN ... 6 = T7).
CREATE TABLE "working_schedule_series" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "shift_template_id" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "weekdays" INTEGER[],
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "working_schedule_series_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "working_schedule_series_range" CHECK ("end_date" >= "start_date"),
    CONSTRAINT "working_schedule_series_weekdays" CHECK (
      cardinality("weekdays") BETWEEN 1 AND 7 AND "weekdays" <@ ARRAY[0,1,2,3,4,5,6]
    ),
    CONSTRAINT "working_schedule_series_status" CHECK ("status" IN ('ACTIVE', 'DELETED'))
);

CREATE TABLE "working_schedule_series_users" (
    "series_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "working_schedule_series_users_pkey" PRIMARY KEY ("series_id","user_id")
);

-- Lượt phân công nào sinh ra từ lịch lặp (null = xếp tay từng ngày).
ALTER TABLE "working_schedule_users" ADD COLUMN "series_id" TEXT;

CREATE INDEX "working_schedule_series_tenant_id_start_date_idx" ON "working_schedule_series"("tenant_id", "start_date");
CREATE INDEX "working_schedule_users_series_id_idx" ON "working_schedule_users"("series_id");

ALTER TABLE "working_schedule_users" ADD CONSTRAINT "working_schedule_users_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "working_schedule_series"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "working_schedule_series" ADD CONSTRAINT "working_schedule_series_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "working_schedule_series" ADD CONSTRAINT "working_schedule_series_shift_template_id_fkey" FOREIGN KEY ("shift_template_id") REFERENCES "shift_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "working_schedule_series" ADD CONSTRAINT "working_schedule_series_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "working_schedule_series_users" ADD CONSTRAINT "working_schedule_series_users_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "working_schedule_series"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "working_schedule_series_users" ADD CONSTRAINT "working_schedule_series_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
