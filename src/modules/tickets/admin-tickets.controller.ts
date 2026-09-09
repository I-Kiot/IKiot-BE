import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TicketService } from './tickets.service';
import { ReplyTicketDto } from './dto/ticket.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminOnlyGuard } from '../../common/guards/admin-only.guard';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import type { AuthUser } from '../../common/types/auth-user.type';

/** The operators' half. The old controller re-checked `role === 'SUPER_ADMIN'` in each handler; that is the guard now, which is also why these routes carry no `@Permissions`. */
@ApiTags('tickets')
@ApiBearerAuth('bearer')
@UseGuards(AdminOnlyGuard)
@Controller('admin/tickets')
export class AdminTicketController {
  constructor(private readonly service: TicketService) {}

  @Get()
  findAll(@Query() query: PaginationQueryDto) {
    return this.service.findAllAdmin(query);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/reply')
  reply(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReplyTicketDto,
  ) {
    return this.service.replyAdmin(user, id, dto);
  }

  @Patch(':id/close')
  close(@Param('id') id: string) {
    return this.service.closeAdmin(id);
  }
}
