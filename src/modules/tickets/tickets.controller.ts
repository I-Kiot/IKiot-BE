import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TicketService } from './tickets.service';
import { CreateTicketDto, ReplyTicketDto } from './dto/ticket.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/** The shop's half of support, at the old paths. `GET :id` and `DELETE :id` are shared with the operators, as the old router had them, so a link to a ticket resolves the same whoever opens it. */
@ApiTags('tickets')
@ApiBearerAuth('bearer')
@Controller('tickets')
export class TicketController {
  constructor(private readonly service: TicketService) {}

  @Permissions('tickets', 'create')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTicketDto) {
    return this.service.create(requireTenantId(user), user, dto);
  }

  /** Declared before `:id` - Nest matches routes in declaration order, so the literal segment has to come first. */
  @Permissions('tickets', 'read')
  @Get('my')
  findMine(@CurrentUser() user: AuthUser) {
    return this.service.findMine(requireTenantId(user));
  }

  @Permissions('tickets', 'create')
  @HttpCode(HttpStatus.OK)
  @Post(':id/my-reply')
  replyMine(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReplyTicketDto,
  ) {
    return this.service.replyMine(requireTenantId(user), user, id, dto);
  }

  @Permissions('tickets', 'read')
  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.findOne(user, id);
  }

  @Permissions('tickets', 'delete')
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(user, id);
  }
}
