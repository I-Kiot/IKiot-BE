import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AdminNotificationService } from './admin-notifications.service';
import {
  ComposeAnnouncementDto,
  ListSystemNotificationsDto,
} from './dto/announcement.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminOnlyGuard } from '../../common/guards/admin-only.guard';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Seven routes at the old paths: `/admin/notifications` is the announcement outbox, `/admin/system-notifications` the event feed. `AdminOnlyGuard` replaces the seven hand-copied `role === 'SUPER_ADMIN'` checks, so the eighth route cannot forget it. */
@ApiTags('admin-notifications')
@ApiBearerAuth('bearer')
@UseGuards(AdminOnlyGuard)
@Controller()
export class AdminNotificationController {
  constructor(private readonly service: AdminNotificationService) {}

  // ─── Announcements ─────────────────────────────────────────────────────────

  @Post('admin/notifications')
  compose(@CurrentUser() user: AuthUser, @Body() dto: ComposeAnnouncementDto) {
    return this.service.compose(user.userId, dto);
  }

  @Get('admin/notifications')
  listAnnouncements(@Query() query: ListSystemNotificationsDto) {
    return this.service.listAnnouncements(query);
  }

  // ─── System event feed ─────────────────────────────────────────────────────

  @Get('admin/system-notifications')
  listSystem(@Query() query: ListSystemNotificationsDto) {
    return this.service.listSystem(query);
  }

  /** One segment deep against `:id/read`'s two, so these two never compete for a match. */
  @Patch('admin/system-notifications/mark-all-read')
  markAllRead() {
    return this.service.markAllSystemRead();
  }

  @Patch('admin/system-notifications/:id/read')
  markRead(@Param('id') id: string) {
    return this.service.markSystemRead(id);
  }

  @Delete('admin/system-notifications')
  removeAll() {
    return this.service.removeAllSystem();
  }

  @Delete('admin/system-notifications/:id')
  remove(@Param('id') id: string) {
    return this.service.removeSystem(id);
  }
}
