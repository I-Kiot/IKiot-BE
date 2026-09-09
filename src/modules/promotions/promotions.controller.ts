import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PromotionService } from './promotions.service';
import {
  CreatePromotionDto,
  PriceCartDto,
  QueryPromotionDto,
  UpdatePromotionDto,
} from './dto/promotion.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Real port of PromotionController - the same nine routes and permissions. `/candidates`, `/calculate` and `/apply` are POSTs because they carry a cart; only `/apply` writes. */
@ApiTags('promotions')
@ApiBearerAuth('bearer')
@Controller('promotions')
export class PromotionController {
  constructor(private readonly service: PromotionService) {}

  @Permissions('promotions', 'create')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePromotionDto) {
    return this.service.create(requireTenantId(user), dto);
  }

  @Permissions('promotions', 'read')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryPromotionDto) {
    return this.service.findAll(user, requireTenantId(user), query);
  }

  // The three cart endpoints are declared above `:id`: being POST they cannot actually collide with it, but keeping them together reads better.

  /** Browse: every candidate for this cart, eligible or not, with the reason. */
  @Permissions('promotions', 'calculate')
  @HttpCode(HttpStatus.OK)
  @Post('candidates')
  candidates(@CurrentUser() user: AuthUser, @Body() dto: PriceCartDto) {
    return this.service.listCandidates(requireTenantId(user), dto);
  }

  /** Preview only - nothing is written. */
  @Permissions('promotions', 'calculate')
  @HttpCode(HttpStatus.OK)
  @Post('calculate')
  calculate(@CurrentUser() user: AuthUser, @Body() dto: PriceCartDto) {
    return this.service.calculate(requireTenantId(user), dto);
  }

  /** Commits the discount against an order: usage counts move, logs are written. */
  @Permissions('promotions', 'apply')
  @HttpCode(HttpStatus.OK)
  @Post('apply')
  apply(@CurrentUser() user: AuthUser, @Body() dto: PriceCartDto) {
    return this.service.apply(requireTenantId(user), user.userId, dto);
  }

  @Permissions('promotions', 'read')
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(user, requireTenantId(user), id);
  }

  /** Where this promotion has actually been used, and for how much. */
  @Permissions('promotions', 'read')
  @Get(':id/logs')
  findLogs(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: QueryPromotionDto,
  ) {
    return this.service.findLogs(user, requireTenantId(user), id, query);
  }

  @Permissions('promotions', 'update')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePromotionDto,
  ) {
    return this.service.update(user, requireTenantId(user), id, dto);
  }

  /** Soft delete - sets status to INACTIVE. See PromotionService.deactivate. */
  @Permissions('promotions', 'delete')
  @Delete(':id')
  deactivate(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.deactivate(user, requireTenantId(user), id);
  }
}
