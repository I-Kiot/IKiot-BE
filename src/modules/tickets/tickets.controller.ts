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

/** Phần của shop trong support, giữ đường dẫn cũ. `GET :id` và `DELETE :id` dùng chung với operator như router cũ, nên link tới ticket mở ra giống nhau với mọi người. */
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

  /** Khai báo trước `:id`: Nest khớp route theo thứ tự khai báo, nên segment cố định phải đứng trước. */
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
