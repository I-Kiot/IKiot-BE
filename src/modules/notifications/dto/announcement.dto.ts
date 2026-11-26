import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  ANNOUNCEMENT_TARGETS,
  AnnouncementTarget,
} from '../system-notification.constants';

const trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/** Body gửi email thông báo tới chủ shop. */
export class ComposeAnnouncementDto {
  @IsString()
  @trim()
  @IsNotEmpty({ message: 'Tiêu đề là bắt buộc' })
  @MaxLength(200)
  title: string;

  @IsString()
  @trim()
  @IsNotEmpty({ message: 'Nội dung là bắt buộc' })
  @MaxLength(5000)
  description: string;

  @IsString()
  @trim()
  @IsNotEmpty({ message: 'Danh mục là bắt buộc' })
  @MaxLength(100)
  category: string;

  @IsIn(ANNOUNCEMENT_TARGETS, {
    message: `targetType phải là ${ANNOUNCEMENT_TARGETS.join(' hoặc ')}`,
  })
  targetType: string;

  /** Danh sách tenant, chỉ dùng khi `targetType` là `SELECTION`. */
  @ValidateIf(
    (dto: ComposeAnnouncementDto) =>
      dto.targetType === AnnouncementTarget.SELECTION,
  )
  @IsArray()
  @IsUUID(undefined, { each: true })
  targetTenants?: string[];
}

export class ListSystemNotificationsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
