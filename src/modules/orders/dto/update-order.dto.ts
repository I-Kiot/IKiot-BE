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

/** Một dòng trong `PATCH /orders/:id`. Có `id` thì sửa đúng dòng đó tại chỗ (không đổi sản phẩm; muốn đổi thì xoá và thêm dòng mới); không có thì là dòng mới. Dòng cũ bị bỏ khỏi danh sách sẽ bị xoá. Thông số đơn may chỉ đi qua `PUT …/customization` (A-4). */
export class UpdateOrderItemDto extends OmitType(CreateOrderItemDto, [
  'customization',
] as const) {
  @IsOptional()
  @IsUUID()
  id?: string;
}

/**
 * `PATCH /orders/:id`: các trường như lúc tạo, đều không bắt buộc. Không đổi chi nhánh vì đó là cửa hàng đã bán đơn. `items`, nếu gửi, thay toàn bộ dòng và chỉ khi đơn còn CONFIRMED (sau khi đóng gói hàng đã khoá, quyết định 2026-10-06). `discountType: null` / `appliedPromotions: []` để xoá giảm giá.
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

  /** Đổi nơi lấy hàng của cả đơn. Chỉ khi còn CONFIRMED: đóng gói xong hàng đã khoá tại nơi cũ. Cả đơn một nơi vì `pack` chỉ nhận đơn xuất từ một nơi. */
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
