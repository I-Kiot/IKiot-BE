import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Một thông số đã thoả thuận; có `attributeId` thì đổi thuộc tính đó của sản phẩm. */
export class OrderItemSpecDto {
  @IsOptional()
  @IsUUID()
  attributeId?: string;

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

/** Thông số đã thoả thuận của một dòng, gửi nguyên khối mỗi lần. */
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

  /** Ảnh mẫu hoặc bản vẽ, phải upload trước qua `POST /uploads`. */
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
