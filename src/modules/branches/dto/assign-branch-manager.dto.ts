import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class AssignBranchManagerDto {
  @IsString()
  @IsNotEmpty({ message: 'Thiếu nhân viên được bổ nhiệm' })
  @IsUUID()
  staffId: string;
}
