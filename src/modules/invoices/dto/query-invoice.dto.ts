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

/** COUNTER = rung up at the till (order `fulfillmentType` TAKEAWAY); ORDERED = an order taken to be fulfilled later. */
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

  /** The order's way of reaching the customer: TAKEAWAY (till) | STORE_PICKUP | HOME_DELIVERY. */
  @IsOptional()
  @IsIn(FULFILLMENT_TYPES)
  fulfillmentType?: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  /** Invoice number, order code, customer name or phone. */
  @IsOptional()
  @IsString()
  search?: string;

  /** Creation-date window. */
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;
}
