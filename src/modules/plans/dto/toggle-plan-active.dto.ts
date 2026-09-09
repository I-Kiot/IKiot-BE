import { IsBoolean } from 'class-validator';

export class TogglePlanActiveDto {
  @IsBoolean()
  isActive: boolean;
}
