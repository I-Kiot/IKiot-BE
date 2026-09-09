import { IsString } from 'class-validator';

export class PermissionGrantDto {
  @IsString()
  resource: string;

  @IsString()
  action: string;
}
