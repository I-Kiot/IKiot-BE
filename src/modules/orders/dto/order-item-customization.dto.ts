import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Min,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** One free-form measurement or option agreed with the customer ("Chiều cao lưng tựa: 95 cm"). */
export class OrderItemSpecDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên thông số không được để trống' })
  @Transform(trim)
  name: string;

  @IsString()
  @IsNotEmpty({ message: 'Giá trị thông số không được để trống' })
  @Transform(trim)
  value: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  unit?: string;
}

/**
 * The specs agreed with a customer for one line (contract §2 `OrderItemCustomization`): sent whole
 * on every `PUT …/customization`, so a field left out is cleared - it is the record of what the
 * workshop must make, not a patch on it.
 */
export class OrderItemCustomizationDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Kích thước không được âm' })
  lengthCm?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Kích thước không được âm' })
  widthCm?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Kích thước không được âm' })
  heightCm?: number;

  @IsOptional()
  @IsString()
  @Transform(trim)
  material?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  color?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  fabricCode?: string;

  @IsOptional()
  @IsString()
  note?: string;

  /** Photos of a sample or drawings, already uploaded through `POST /uploads`. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUrl({ require_tld: false }, { each: true })
  attachmentUrls?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => OrderItemSpecDto)
  specs?: OrderItemSpecDto[];
}
