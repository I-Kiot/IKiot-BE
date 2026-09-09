import { IsString, MinLength } from 'class-validator';

export class UpgradeSubscriptionDto {
  @IsString()
  @MinLength(1)
  planCode: string;
}
