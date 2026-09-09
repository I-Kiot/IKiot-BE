import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CustomerService } from './customers.service';
import {
  CreateCustomerDto,
  DeleteManyCustomersDto,
  QueryCustomerDto,
  UpdateCustomerDto,
} from './dto/customer.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Real port of CustomerController. Every route here is newly permission-gated: the old module registered all six on bare `verifyJwt`, so any logged-in account could read and delete the tenant's whole customer list. */
@ApiTags('customers')
@ApiBearerAuth('bearer')
@Controller('customers')
export class CustomerController {
  constructor(private readonly service: CustomerService) {}

  @Permissions('customers', 'create')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCustomerDto) {
    return this.service.create(requireTenantId(user), dto);
  }

  @Permissions('customers', 'read')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryCustomerDto) {
    return this.service.findAll(requireTenantId(user), query);
  }

  /** Bulk soft delete. Declared above `:id` so `DELETE /customers` isn't read as an id. */
  @Permissions('customers', 'delete')
  @Delete()
  removeMany(
    @CurrentUser() user: AuthUser,
    @Body() dto: DeleteManyCustomersDto,
  ) {
    return this.service.removeMany(requireTenantId(user), dto.ids);
  }

  @Permissions('customers', 'read')
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(requireTenantId(user), id);
  }

  @Permissions('customers', 'update')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.service.update(requireTenantId(user), id, dto);
  }

  @Permissions('customers', 'delete')
  @Delete(':id')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.remove(requireTenantId(user), id);
  }
}
