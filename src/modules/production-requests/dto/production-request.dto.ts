import { BooleanQuery } from '../../../common/decorators/boolean-query.decorator';
import { PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsUrl,
  ArrayMaxSize,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import {
  MANUAL_PRODUCTION_REQUEST_STATUSES,
  PRODUCTION_DELIVERY_STATUSES,
  PRODUCTION_REQUEST_STATUSES,
  WORKSHOP_VISIBLE_PRODUCTION_REQUEST_STATUSES,
} from '../../../common/constants/production-request-status';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ProductionLineAttributeDto {
  @IsUUID()
  attributeId: string;

  @IsString()
  value: string;
}

/** Một dòng: SKU và số lượng cần làm. `orderItemId` gắn dòng với dòng đơn nó làm cho: thực tế bắt buộc với hàng tuỳ chỉnh (danh sách sản xuất truyền vào), không bắt buộc với hàng chuẩn. */
export class ProductionRequestLineDto {
  @IsUUID()
  productItemId: string;

  @Type(() => Number)
  @IsInt({ message: 'Số lượng đặt phải là số nguyên' })
  @Min(1, { message: 'Số lượng đặt phải lớn hơn 0' })
  quantity: number;

  @IsOptional()
  @IsUUID()
  orderItemId?: string;

  @IsOptional()
  @IsString()
  note?: string;

  /** Thuộc tính khác với SKU gốc (2026-10-16). Dòng khi đó dành cho SKU có đúng các giá trị này: SKU anh em có sẵn, hoặc SKU mới sao từ SKU gốc. Không dùng cho dòng làm cho đơn. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductionLineAttributeDto)
  attributeValues?: ProductionLineAttributeDto[];

  /** Ảnh cho xưởng (bản vẽ, ảnh mẫu) đã tải qua `POST /uploads` (2026-10-16). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUrl({ require_tld: false }, { each: true })
  attachmentUrls?: string[];

  /** Chỉ gửi khi người dùng tick "cập nhật giá": giá bán lẻ của SKU thành giá này. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Giá bán không được âm' })
  retailPrice?: number;
}

/** `code`, `status`, `sentAt`, `createdBy` và mọi số đã nhận do server quyết (coding rule 4). */
export class CreateProductionRequestDto {
  /** Xưởng – NCC có `type` là WORKSHOP. */
  @IsUUID()
  supplierId: string;

  /** Xưởng giao tới: chi nhánh hoặc kho, bán được. */
  @IsUUID()
  locationId: string;

  /** Ngày xưởng hứa giao, `YYYY-MM-DD`. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Ngày hẹn xong phải có dạng YYYY-MM-DD',
  })
  @IsISO8601({ strict: true }, { message: 'Ngày hẹn xong không hợp lệ' })
  expectedReadyDate?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'Yêu cầu sản xuất phải có ít nhất một mặt hàng' })
  @ValidateNested({ each: true })
  @Type(() => ProductionRequestLineDto)
  items: ProductionRequestLineDto[];
}

/** Chỉ DRAFT. `items` nếu gửi thì thay toàn bộ tập dòng. */
export class UpdateProductionRequestDto extends PartialType(
  CreateProductionRequestDto,
) {}

export class UpdateProductionRequestStatusDto {
  @IsIn(MANUAL_PRODUCTION_REQUEST_STATUSES, {
    message: `Trạng thái chỉ được là ${MANUAL_PRODUCTION_REQUEST_STATUSES.join(' hoặc ')}`,
  })
  status: string;

  /** Nối vào ghi chú yêu cầu. Bắt buộc khi đóng thiếu (`COMPLETED`): vì sao phần còn lại sẽ không về. */
  @IsOptional()
  @IsString()
  note?: string;
}

export class QueryProductionRequestDto extends PaginationQueryDto {
  /** Khớp một phần mã YCSX. */
  @IsOptional()
  @IsString()
  @Transform(trim)
  search?: string;

  @IsOptional()
  @IsIn(PRODUCTION_REQUEST_STATUSES)
  status?: string;

  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  /** Yêu cầu có dòng cho SKU này – dòng mở rộng của danh sách sản xuất. */
  @IsOptional()
  @IsUUID()
  productItemId?: string;
}

export class ReceiveProductionLineDto {
  @IsUUID()
  productionRequestItemId: string;

  /** Số về lần này, kể cả hàng lỗi. */
  @Type(() => Number)
  @IsInt({ message: 'Số lượng nhận phải là số nguyên' })
  @Min(0, { message: 'Số lượng nhận không được âm' })
  receivedQuantity: number;

  /** Trong đó bao nhiêu lỗi – chuyển về kho hàng hỏng, không bán. */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Số lượng lỗi phải là số nguyên' })
  @Min(0, { message: 'Số lượng lỗi không được âm' })
  defectQuantity?: number;

  /** Giá xưởng cho mỗi đơn vị; để trống = giá vốn của SKU. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Giá xưởng không được âm' })
  unitCost?: number;
}

export class ReceiveProductionDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'Phải nhập ít nhất một dòng' })
  @ValidateNested({ each: true })
  @Type(() => ReceiveProductionLineDto)
  items: ReceiveProductionLineDto[];

  /** Hàng lỗi về đâu; mặc định là kho hàng hỏng của địa điểm nhận. */
  @IsOptional()
  @IsUUID()
  defectLocationId?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

/** Danh mục ở mỗi địa điểm, phân trang. `onlyShort` lọc về những gì còn phải đặt. */
export class QueryProductionListDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  /** Khớp một phần theo SKU hoặc tên sản phẩm. */
  @IsOptional()
  @IsString()
  @Transform(trim)
  search?: string;

  /** Chỉ một SKU – thông báo thiếu hàng dẫn tới đây (`production-request.templates.ts`). Thu hẹp thêm `search` khi gửi cả hai. */
  @IsOptional()
  @IsUUID()
  productItemId?: string;

  /** Chỉ dòng còn thiếu sau tồn và mọi yêu cầu đang mở. Mặc định false: đặt được mọi thứ, dòng thiếu lên trước. */
  @BooleanQuery()
  onlyShort?: boolean;

  /** Chỉ dòng có yêu cầu sản xuất còn mở (nháp, đã gửi, nhận một phần) – thứ đang chờ gửi hoặc nhận. */
  @BooleanQuery()
  hasOpenRequest?: boolean;
}

export class ProductionDeliveryLineDto {
  @IsUUID()
  productionRequestItemId: string;

  /** Số xưởng giao trên dòng này lần này. Giao thiếu được – phần còn lại theo phiếu khác. */
  @Type(() => Number)
  @IsInt({ message: 'Số lượng giao phải là số nguyên' })
  @Min(1, { message: 'Số lượng giao phải lớn hơn 0' })
  quantity: number;
}

/** Nhân viên xưởng viết. Không đụng tồn: địa điểm nhận đếm hàng và xác nhận (`POST /production-deliveries/:id/receive`). `code`, `status` và người do server quyết. */
export class CreateProductionDeliveryDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'Phiếu giao phải có ít nhất một mặt hàng' })
  @ValidateNested({ each: true })
  @Type(() => ProductionDeliveryLineDto)
  items: ProductionDeliveryLineDto[];

  @IsOptional()
  @IsString()
  note?: string;
}

export class CancelProductionDeliveryDto {
  /** Lý do phiếu bị rút (xưởng) hoặc từ chối (địa điểm) – là dấu vết duy nhất của nó. */
  @IsString()
  @Transform(trim)
  @Matches(/\S/, { message: 'Phải nhập lý do hủy phiếu giao' })
  reason: string;
}

/** Góc nhìn của xưởng về các yêu cầu gửi tới mình, ở mọi địa điểm. */
export class QueryWorkshopProductionRequestDto extends PaginationQueryDto {
  /** Khớp một phần mã YCSX. */
  @IsOptional()
  @IsString()
  @Transform(trim)
  search?: string;

  @IsOptional()
  @IsIn(WORKSHOP_VISIBLE_PRODUCTION_REQUEST_STATUSES)
  status?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;
}

export class QueryProductionDeliveryDto extends PaginationQueryDto {
  /** Khớp một phần mã phiếu giao hoặc mã YCSX. */
  @IsOptional()
  @IsString()
  @Transform(trim)
  search?: string;

  @IsOptional()
  @IsIn(PRODUCTION_DELIVERY_STATUSES)
  status?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsUUID()
  productionRequestId?: string;
}
