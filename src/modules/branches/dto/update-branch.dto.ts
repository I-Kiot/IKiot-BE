import { PartialType } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { CreateBranchDto } from './create-branch.dto';
import {
  LocationStatus,
  SETTABLE_LOCATION_STATUSES,
} from '../../../common/constants/location-status';

export class UpdateBranchDto extends PartialType(CreateBranchDto) {
  // Không nhận DELETED ở đây: xoá mềm đi qua DELETE /branches/:id để `branches:delete` thực sự kiểm soát.
  @IsOptional()
  @IsIn(SETTABLE_LOCATION_STATUSES, {
    message: `status phải là ${SETTABLE_LOCATION_STATUSES.join(' hoặc ')}`,
  })
  status?: typeof LocationStatus.ACTIVE | typeof LocationStatus.INACTIVE;
}
