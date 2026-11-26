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

/** Một dòng khi sửa đơn: có `id` là sửa dòng đó, không có là dòng mới. */
export class UpdateOrderItemDto extends OmitType(CreateOrderItemDto, [
  'customization',
] as const) {
  @IsOptional()
  @IsUUID()
  id?: string;
}

/** Body `PATCH /orders/:id`: các trường như lúc tạo, đều không bắt buộc. */
export class UpdateOrderDto extends PartialType(
  OmitType(CreateOrderDto, ['branchId', 'items'] as const),
) {
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty({ message: 'Đơn hàng phải có ít nhất một mặt hàng' })
  @ValidateNested({ each: true })
  @Type(() => UpdateOrderItemDto)
  items?: UpdateOrderItemDto[];

  /** Đổi nơi lấy hàng cho cả đơn, chỉ khi còn CONFIRMED. */
  @IsOptional()
  @IsUUID()
  sourceLocationId?: string;
}

export class SetOrderAssigneeDto {
  @IsUUID()
  assigneeId: string;
}

export class SetOrderPriorityDto {
  @IsIn(ORDER_PRIORITIES, {
    message: `priority phải là ${ORDER_PRIORITIES.join(', ')}`,
  })
  priority: string;
}
