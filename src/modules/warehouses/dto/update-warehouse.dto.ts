import { PartialType } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { CreateWarehouseDto } from './create-warehouse.dto';
import {
  LocationStatus,
  SETTABLE_LOCATION_STATUSES,
} from '../../../common/constants/location-status';

export class UpdateWarehouseDto extends PartialType(CreateWarehouseDto) {
  // Không đổi sang DELETED ở đây, dùng DELETE.
  @IsOptional()
  @IsIn(SETTABLE_LOCATION_STATUSES, {
    message: `status phải là ${SETTABLE_LOCATION_STATUSES.join(' hoặc ')}`,
  })
  status?: typeof LocationStatus.ACTIVE | typeof LocationStatus.INACTIVE;
}
