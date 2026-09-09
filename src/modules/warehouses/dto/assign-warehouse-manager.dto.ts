import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class AssignWarehouseManagerDto {
  @IsString()
  @IsNotEmpty({ message: 'Thiếu nhân viên được bổ nhiệm' })
  @IsUUID()
  staffId: string;
}
