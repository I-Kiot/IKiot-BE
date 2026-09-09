-- CreateTable
CREATE TABLE "payslip_bonus_lines" (
    "id" TEXT NOT NULL,
    "payslip_id" TEXT NOT NULL,
    "bonus_type" TEXT NOT NULL,
    "calculation_type" TEXT NOT NULL,
    "revenue" DECIMAL(14,2) NOT NULL,
    "tier_name" TEXT,
    "from_value" DECIMAL(14,2),
    "reward_type" TEXT,
    "reward_value" DECIMAL(14,2),
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "payslip_bonus_lines_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "payslip_bonus_lines" ADD CONSTRAINT "payslip_bonus_lines_payslip_id_fkey" FOREIGN KEY ("payslip_id") REFERENCES "payslips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
