import { PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
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

/** One line of a production request: a SKU and how many to have made. `orderItemId` ties the line to the order line it is made for - required in practice for a custom piece (the production list hands it over), optional for standard stock. */
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
}

/** `code`, `status`, `sentAt`, `createdBy` and every received figure are the server's (coding rule 4). */
export class CreateProductionRequestDto {
  /** The workshop - a supplier whose `type` is WORKSHOP. */
  @IsUUID()
  supplierId: string;

  /** Where the workshop delivers: a branch or a warehouse, sellable. */
  @IsUUID()
  locationId: string;

  /** The day the workshop promised, `YYYY-MM-DD`. */
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

/** DRAFT only. `items`, when sent, replaces the whole line set. */
export class UpdateProductionRequestDto extends PartialType(
  CreateProductionRequestDto,
) {}

export class UpdateProductionRequestStatusDto {
  @IsIn(MANUAL_PRODUCTION_REQUEST_STATUSES, {
    message: `Trạng thái chỉ được là ${MANUAL_PRODUCTION_REQUEST_STATUSES.join(' hoặc ')}`,
  })
  status: string;

  /** Appended to the request's note. Required when closing short (`COMPLETED`): why the rest will never come. */
  @IsOptional()
  @IsString()
  note?: string;
}

export class QueryProductionRequestDto extends PaginationQueryDto {
  /** Partial match on the YCSX code. */
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

  /** Requests with a line for this SKU - the production list's expanded row. */
  @IsOptional()
  @IsUUID()
  productItemId?: string;
}

export class ReceiveProductionLineDto {
  @IsUUID()
  productionRequestItemId: string;

  /** How many arrived this time, defects included. */
  @Type(() => Number)
  @IsInt({ message: 'Số lượng nhận phải là số nguyên' })
  @Min(0, { message: 'Số lượng nhận không được âm' })
  receivedQuantity: number;

  /** Of those, how many are defective - they go to the damaged-goods location, not on sale. */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Số lượng lỗi phải là số nguyên' })
  @Min(0, { message: 'Số lượng lỗi không được âm' })
  defectQuantity?: number;

  /** The workshop's price per unit; blank = the SKU's cost price. */
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

  /** Where defective units go; defaults to the receiving location's damaged-goods location. */
  @IsOptional()
  @IsUUID()
  defectLocationId?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

/** The catalogue at each location, paged. `onlyShort` narrows it to what still has to be ordered. */
export class QueryProductionListDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  /** Partial match on SKU or product name. */
  @IsOptional()
  @IsString()
  @Transform(trim)
  search?: string;

  /** One SKU only - where a shortage notification links to (`production-request.templates.ts`). Narrows `search` further when both are sent. */
  @IsOptional()
  @IsUUID()
  productItemId?: string;

  /** Only rows still short after stock and every open request. Defaults to false: anything can be ordered, short rows are sorted first. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === undefined ? undefined : value === true || value === 'true',
  )
  @IsBoolean()
  onlyShort?: boolean;

  /** Only rows with a production request still open (draft, sent, partly received) - what is waiting to be sent or received. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === undefined ? undefined : value === true || value === 'true',
  )
  @IsBoolean()
  hasOpenRequest?: boolean;
}

// ─── Workshop staff & delivery notes (2026-10-09) ─────────────────────────────

export class ProductionDeliveryLineDto {
  @IsUUID()
  productionRequestItemId: string;

  /** How many the workshop is delivering on this line this time. A short delivery is fine - the rest can follow on another note. */
  @Type(() => Number)
  @IsInt({ message: 'Số lượng giao phải là số nguyên' })
  @Min(1, { message: 'Số lượng giao phải lớn hơn 0' })
  quantity: number;
}

/** Written by workshop staff. Touches no stock: the receiving location counts the goods and confirms (`POST /production-deliveries/:id/receive`). `code`, `status` and the people are the server's. */
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
  /** Why the note is withdrawn (workshop) or refused (location) - the only record of it. */
  @IsString()
  @Transform(trim)
  @Matches(/\S/, { message: 'Phải nhập lý do hủy phiếu giao' })
  reason: string;
}

/** The workshop's view of the requests sent to it, at every location. */
export class QueryWorkshopProductionRequestDto extends PaginationQueryDto {
  /** Partial match on the YCSX code. */
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
  /** Partial match on the delivery code or the YCSX code. */
  @IsOptional()
  @IsString()
  @Transform(trim)
  search?: string;

  @IsOptional()
  @IsIn(PRODUCTION_DELIVERY_STATUSES)
  status?: string;

  /** The receiving location. */
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsUUID()
  productionRequestId?: string;
}
