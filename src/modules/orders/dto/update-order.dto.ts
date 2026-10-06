import { OmitType, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { ORDER_PRIORITIES } from '../../../common/constants/order-status';
import { CreateOrderDto, CreateOrderItemDto } from './create-order.dto';

/** A line on `PATCH /orders/:id`. With `id` it is that existing line, changed in place (its product cannot change - drop it and add another); without, a new line. An existing line left out of the list is removed. */
export class UpdateOrderItemDto extends CreateOrderItemDto {
  @IsOptional()
  @IsUUID()
  id?: string;
}

/**
 * `PATCH /orders/:id` (A-8, contract §2): the create's fields, every one optional - a field left out
 * is left as it is. The branch is not among them: it is the store that made the sale. `items`, when
 * sent, is the whole new list of lines and only while the order is CONFIRMED - once packed, its goods
 * are locked and the lines stay as packed (decided 2026-10-06; cancel and re-create to change them).
 * `discountType: null` / `appliedPromotions: []` clear a discount.
 */
export class UpdateOrderDto extends PartialType(
  OmitType(CreateOrderDto, ['branchId', 'items'] as const),
) {
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty({ message: 'Đơn hàng phải có ít nhất một mặt hàng' })
  @ValidateNested({ each: true })
  @Type(() => UpdateOrderItemDto)
  items?: UpdateOrderItemDto[];
}

/** `PATCH /orders/:id/assignee`. */
export class SetOrderAssigneeDto {
  @IsUUID()
  assigneeId: string;
}

/** `PATCH /orders/:id/priority`. */
export class SetOrderPriorityDto {
  @IsIn(ORDER_PRIORITIES, {
    message: `priority phải là ${ORDER_PRIORITIES.join(', ')}`,
  })
  priority: string;
}
