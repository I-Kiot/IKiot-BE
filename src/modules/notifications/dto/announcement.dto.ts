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

/** `POST /admin/notifications` - an operator writing to shop owners by email. `category` stays free text, as in the old model, because it is printed into the subject line and the admin console is the only client. */
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

  /** Read and stored only when `targetType` is `SELECTION`, so an `ALL` announcement can't keep a row claiming a narrower audience than it had. An empty selection is allowed, as before: it saves, mails nobody, and says so. */
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
