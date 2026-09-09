import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { NotificationService } from './notifications.service';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import { DeviceTokenDto } from './dto/device-token.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/types/auth-user.type';

// Own inbox only: every method scopes to the caller. There is no cross-user listing here - use notify() from another service to write, this controller only reads and acknowledges.
@ApiTags('notifications')
@ApiBearerAuth('bearer')
@Controller('notifications')
export class NotificationController {
  constructor(private readonly service: NotificationService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListNotificationsDto) {
    return this.service.listInbox(user, query.page ?? 1, query.limit ?? 20);
  }

  @Get('unread-count')
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.service.unreadCount(user);
  }

  @Patch('read-all')
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.service.markAllRead(user);
  }

  @Patch(':id/read')
  markRead(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.markRead(user, id);
  }

  @Post('device-token')
  registerDeviceToken(
    @CurrentUser() user: AuthUser,
    @Body() dto: DeviceTokenDto,
  ) {
    return this.service.registerDeviceToken(
      user.userId,
      dto.token,
      dto.userAgent,
    );
  }

  @Delete('device-token')
  removeDeviceToken(
    @CurrentUser() user: AuthUser,
    @Body() dto: DeviceTokenDto,
  ) {
    return this.service.removeDeviceToken(user.userId, dto.token);
  }

  @Delete()
  deleteAll(@CurrentUser() user: AuthUser) {
    return this.service.deleteAll(user);
  }

  @Delete(':id')
  deleteOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.deleteOne(user, id);
  }
}
