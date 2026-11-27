import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { FULFILLMENT_TYPES } from '../../../common/constants/order-status';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import {
  InvoiceStatus,
  InvoiceType,
} from '../../../common/constants/invoice-status';

/** COUNTER = bán tại quầy (fulfillmentType TAKEAWAY); ORDERED = đơn nhận để giao sau. */
export const INVOICE_KINDS = ['COUNTER', 'ORDERED'] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

export class QueryInvoiceDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(Object.values(InvoiceStatus))
  status?: string;

  @IsOptional()
  @IsIn(Object.values(InvoiceType))
  type?: string;

  @IsOptional()
  @IsIn(INVOICE_KINDS)
  kind?: InvoiceKind;

  @IsOptional()
  @IsIn(FULFILLMENT_TYPES)
  fulfillmentType?: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  /** Tìm theo số hoá đơn, mã đơn, tên hoặc SĐT khách. */
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;
}
