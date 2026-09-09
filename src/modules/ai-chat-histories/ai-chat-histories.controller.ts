import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AIChatHistoryService } from './ai-chat-histories.service';
import { ChatDto, RenameConversationDto } from './dto/ai-chat.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Five routes at the old `/ai` paths, gated on the `ai_chat` catalog resource instead of the fixed roles the old router named. */
@ApiTags('ai')
@ApiBearerAuth('bearer')
@Controller('ai')
export class AIChatHistoryController {
  constructor(private readonly service: AIChatHistoryService) {}

  /** `create` rather than `read`: it writes a conversation, calls a paid API and reaches into the shop's data. */
  @Permissions('ai_chat', 'create')
  @HttpCode(HttpStatus.OK)
  @Post('chat')
  chat(@CurrentUser() user: AuthUser, @Body() dto: ChatDto) {
    return this.service.chat(user, dto);
  }

  @Permissions('ai_chat', 'read')
  @Get('conversations')
  findAll(@CurrentUser() user: AuthUser, @Query() query: PaginationQueryDto) {
    return this.service.findAll(user, query);
  }

  @Permissions('ai_chat', 'read')
  @Get('conversations/:id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.findOne(user, id);
  }

  @Permissions('ai_chat', 'update')
  @Put('conversations/:id')
  rename(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: RenameConversationDto,
  ) {
    return this.service.rename(user, id, dto);
  }

  @Permissions('ai_chat', 'delete')
  @Delete('conversations/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(user, id);
  }
}
