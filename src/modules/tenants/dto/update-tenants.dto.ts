import { PartialType } from '@nestjs/swagger';
import { CreateTenantDto } from './create-tenants.dto';

export class UpdateTenantDto extends PartialType(CreateTenantDto) {}
