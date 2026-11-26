// Sinh module CRUD NestJS từ prisma/schema.prisma; GHI ĐÈ file đã sinh, bỏ qua model trong PORTED_MODELS.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(ROOT, 'prisma', 'schema.prisma'), 'utf8');

const SCALAR_TYPES = new Set(['String', 'Int', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json']);

const CHILD_MODELS = new Set([
  'UserFcmToken', 'SubscriptionHistoryLog',
  'ProductImage', 'ProductItemSupplier', 'ProductItemDetail', 'ProductItemImage',
  'StockMovementRequestItem',
  'WorkingScheduleUser', 'WorkingScheduleSeriesUser',
  'OrderItem', 'OrderAppliedPromotion',
  'PromotionBranch', 'PromotionCategory', 'PromotionProductItem',
  'CashDrawerShiftLog',
  'NotificationTargetTenant', 'TicketMessage',
]);

function parseModels(src) {
  const modelRe = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  const models = [];
  let m;
  while ((m = modelRe.exec(src))) {
    const [, name, body] = m;
    models.push({ name, body });
  }
  return models;
}

function parseTableName(body) {
  const m = body.match(/@@map\("([^"]+)"\)/);
  return m ? m[1] : null;
}

function parseFields(body) {
  const fields = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('@@')) continue;
    const fm = line.match(/^(\w+)\s+([A-Za-z0-9_]+)(\[\])?(\?)?\s*(.*)$/);
    if (!fm) continue;
    const [, fieldName, baseType, isArray, isOptional] = fm;
    if (!SCALAR_TYPES.has(baseType)) continue; // field quan hệ, bỏ qua
    if (line.includes('@relation(')) continue;
    fields.push({ name: fieldName, type: baseType, array: !!isArray, optional: !!isOptional });
  }
  return fields;
}

function toKebab(tableName) {
  return tableName.replace(/_/g, '-');
}

function toClientProp(modelName) {
  return modelName[0].toLowerCase() + modelName.slice(1);
}

function toPascalFromKebab(kebab) {
  return kebab.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
}

const TS_TYPE = { String: 'string', Int: 'number', Float: 'number', Decimal: 'number', Boolean: 'boolean', DateTime: 'string', Json: 'any' };
const VALIDATOR = { String: 'IsString', Int: 'IsInt', Float: 'IsNumber', Decimal: 'IsNumber', Boolean: 'IsBoolean', DateTime: 'IsDateString', Json: 'IsObject' };

function buildDtoField(f) {
  const decorators = [];
  const importSet = new Set();
  if (f.optional) {
    decorators.push('@IsOptional()');
    importSet.add('IsOptional');
  }
  if (f.array) {
    decorators.push('@IsArray()');
    importSet.add('IsArray');
    const inner = VALIDATOR[f.type];
    if (inner && inner !== 'IsObject') {
      decorators.push(`@${inner}({ each: true })`);
      importSet.add(inner);
    }
  } else {
    const dec = VALIDATOR[f.type];
    if (dec) {
      decorators.push(`@${dec}()`);
      importSet.add(dec);
    }
  }
  const tsType = TS_TYPE[f.type] + (f.array ? '[]' : '');
  const qMark = f.optional ? '?' : '';
  const code = `  ${decorators.join('\n  ')}\n  ${f.name}${qMark}: ${tsType};`;
  return { code, imports: importSet };
}

// Các model đã viết tay, script không được đụng tới.
const PORTED_MODELS = new Set([
  'User', 'Role', 'RolePermission', 'PermissionCatalog',
  'Plan', 'Subscription', 'SubscriptionInvoice',
  'AuditLog', 'Notification',
  'Branch', 'Warehouse', 'Supplier', 'Brand', 'Category',
  'Product', 'ProductItem', 'Inventory', 'StockMovementRequest',
  'Order', 'Promotion', 'PromotionLog', 'Customer', 'CashDrawerSession',
  // Đã sửa tay thành chỉ đọc.
  'CashFlow',
  'Holiday', 'ShiftTemplate', 'WorkingSchedule', 'WorkingScheduleSeries',
  'Ticket', 'AIChatHistory',
  // Hành trình đơn, viết tay từ đầu.
  'ProductionRequest', 'Fulfillment', 'Shipment', 'OrderReturn', 'SalesChannel',
  // Sổ SePay (2026-11-11): đọc + xử lý tay, viết tay từ đầu (modules/sepay-transactions).
  'SepayTransaction',
]);

// Các trường server điền từ user đăng nhập, bỏ khỏi DTO tạo.
const ACTOR_FIELD = {
  CashFlow: 'createdById',
  PromotionLog: 'createdById',
  StockMovementRequest: 'createdById',
  WorkingSchedule: 'createdById',
  AIChatHistory: 'userId',
  Order: 'userId',
  Ticket: 'userId',
};

// Resource quyền của từng module; phải có trong CATALOG của seed.
const RESOURCE = {
  Tenant: 'tenants',
  Branch: 'branches',
  Warehouse: 'warehouses',
  Brand: 'brands',
  Category: 'categories',
  Supplier: 'suppliers',
  Customer: 'customers',
  Product: 'products',
  ProductItem: 'products',
  Inventory: 'inventory',
  StockMovementRequest: 'stock_movement',
  ShiftTemplate: 'schedules',
  WorkingSchedule: 'schedules',
  Holiday: 'holidays',
  Order: 'orders',
  Promotion: 'promotions',
  PromotionLog: 'promotions',
  CashDrawerSession: 'cash_drawers',
  CashFlow: 'cash_flows',
  Ticket: 'tickets',
  AIChatHistory: 'ai_chat',
};

const models = parseModels(schema).filter(
  (m) => !CHILD_MODELS.has(m.name) && !PORTED_MODELS.has(m.name),
);

const missingResource = models.filter((m) => !RESOURCE[m.name]);
if (missingResource.length) {
  console.error(
    'No RESOURCE mapping for: ' + missingResource.map((m) => m.name).join(', ') +
      '\nAdd one (and the matching CATALOG entry in prisma/seed.ts) before generating.',
  );
  process.exit(1);
}

for (const model of models) {
  const tableName = parseTableName(model.body);
  if (!tableName) continue;
  const kebab = toKebab(tableName);
  const pascal = toPascalFromKebab(kebab); // VD leave-requests -> LeaveRequests -> đổi số ít bên dưới
  const singularPascal = model.name; // tên số ít lấy từ schema
  const clientProp = toClientProp(model.name);
  const allFields = parseFields(model.body).filter((f) => !['id', 'createdAt', 'updatedAt'].includes(f.name));
  const hasTenant = allFields.some((f) => f.name === 'tenantId');
  const actorField = ACTOR_FIELD[model.name] && allFields.some((f) => f.name === ACTOR_FIELD[model.name])
    ? ACTOR_FIELD[model.name]
    : null;
  // tenantId và người thao tác lấy từ user đăng nhập.
  const fields = allFields.filter((f) => f.name !== 'tenantId' && f.name !== actorField);

  const dir = path.join(ROOT, 'src', 'modules', kebab);
  const dtoDir = path.join(dir, 'dto');
  fs.mkdirSync(dtoDir, { recursive: true });

  // ---- DTO tạo ----
  const allImports = new Set();
  const dtoFieldsCode = fields.map((f) => {
    const { code, imports } = buildDtoField(f);
    imports.forEach((i) => allImports.add(i));
    return code;
  }).join('\n\n');
  const createDtoName = `Create${singularPascal}Dto`;
  const createDtoContent = `import { ${[...allImports].sort().join(', ')} } from 'class-validator';

export class ${createDtoName} {
${dtoFieldsCode || '  // no client-settable scalar fields on this model'}
}
`;
  fs.writeFileSync(path.join(dtoDir, `create-${kebab}.dto.ts`), createDtoContent.replace(/^import \{ \} from 'class-validator';\n\n/, ''));

  // ---- DTO sửa ----
  const updateDtoName = `Update${singularPascal}Dto`;
  const updateDtoContent = `import { PartialType } from '@nestjs/swagger';
import { ${createDtoName} } from './create-${kebab}.dto';

export class ${updateDtoName} extends PartialType(${createDtoName}) {}
`;
  fs.writeFileSync(path.join(dtoDir, `update-${kebab}.dto.ts`), updateDtoContent);

  // ---- service ----
  const serviceName = `${singularPascal}Service`;
  // Đọc theo `tenantId`, undefined là mọi tenant (ADMIN); update/remove gọi findOne trước để kiểm tenant.
  const scopeArg = hasTenant ? 'tenantId: string | undefined, ' : '';
  const scopeWhere = hasTenant ? '...(tenantId ? { tenantId } : {}), ' : '';
  const createArgs = [
    hasTenant ? 'tenantId: string' : null,
    actorField ? 'actorId: string' : null,
    `data: ${createDtoName}`,
  ].filter(Boolean).join(', ');
  const createData = [
    '...data',
    hasTenant ? 'tenantId' : null,
    actorField ? `${actorField}: actorId` : null,
  ].filter(Boolean).join(', ');
  const serviceContent = `import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ${createDtoName} } from './dto/create-${kebab}.dto';
import { ${updateDtoName} } from './dto/update-${kebab}.dto';

@Injectable()
export class ${serviceName} {
  constructor(private readonly prisma: PrismaService) {}

  findAll(${hasTenant ? 'tenantId?: string' : ''}) {
    return this.prisma.${clientProp}.findMany({ where: { ${scopeWhere.trim().replace(/,$/, '')} } });
  }

  // findFirst + explicit throw rather than findFirstOrThrow: Prisma's own not-found error
  // isn't an HttpException, so Nest turns it into a 500. A row in another tenant must be
  // indistinguishable from one that doesn't exist - 404 either way, never 403.
  async findOne(${scopeArg}id: string) {
    const found = await this.prisma.${clientProp}.findFirst({ where: { id, ${scopeWhere.trim().replace(/,$/, '')} } });
    if (!found) throw new NotFoundException('${singularPascal} not found');
    return found;
  }

  create(${createArgs}) {
    return this.prisma.${clientProp}.create({ data: { ${createData} } });
  }

  async update(${scopeArg}id: string, data: ${updateDtoName}) {
    await this.findOne(${hasTenant ? 'tenantId, ' : ''}id);
    return this.prisma.${clientProp}.update({ where: { id }, data });
  }

  async remove(${scopeArg}id: string) {
    await this.findOne(${hasTenant ? 'tenantId, ' : ''}id);
    return this.prisma.${clientProp}.delete({ where: { id } });
  }
}
`;
  fs.writeFileSync(path.join(dir, `${kebab}.service.ts`), serviceContent);

  // ---- controller ----
  const controllerName = `${singularPascal}Controller`;
  // Tenant và người thao tác lấy từ user đăng nhập; `?tenantId=` chỉ cho ADMIN.
  const adminOverride = "@Query('tenantId') tenantId?: string";
  const userParam = '@CurrentUser() user: AuthUser';
  const resource = RESOURCE[model.name];
  const can = (action) => `  @Permissions('${resource}', '${action}')\n`;
  const controllerContent = hasTenant
    ? `import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ${serviceName} } from './${kebab}.service';
import { ${createDtoName} } from './dto/create-${kebab}.dto';
import { ${updateDtoName} } from './dto/update-${kebab}.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId, resolveTenantScope } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

// Generated CRUD, not a real port yet: gated by the global JwtAuthGuard, scoped to the
// caller's tenant and permission-checked against the '${resource}' catalog resource - but
// the service underneath is plain Prisma CRUD, not the real business logic.
@ApiTags('${kebab}')
@ApiBearerAuth('bearer')
@Controller('${kebab}')
export class ${controllerName} {
  constructor(private readonly service: ${serviceName}) {}

${can('read')}  @Get()
  findAll(${userParam}, ${adminOverride}) {
    return this.service.findAll(resolveTenantScope(user, tenantId));
  }

${can('read')}  @Get(':id')
  findOne(${userParam}, @Param('id') id: string, ${adminOverride}) {
    return this.service.findOne(resolveTenantScope(user, tenantId), id);
  }

${can('create')}  @Post()
  create(${userParam}, @Body() dto: ${createDtoName}, ${adminOverride}) {
    return this.service.create(requireTenantId(user, tenantId), ${actorField ? 'user.userId, ' : ''}dto);
  }

${can('update')}  @Patch(':id')
  update(${userParam}, @Param('id') id: string, @Body() dto: ${updateDtoName}, ${adminOverride}) {
    return this.service.update(resolveTenantScope(user, tenantId), id, dto);
  }

${can('delete')}  @Delete(':id')
  remove(${userParam}, @Param('id') id: string, ${adminOverride}) {
    return this.service.remove(resolveTenantScope(user, tenantId), id);
  }
}
`
    : `import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ${serviceName} } from './${kebab}.service';
import { ${createDtoName} } from './dto/create-${kebab}.dto';
import { ${updateDtoName} } from './dto/update-${kebab}.dto';
import { Permissions } from '../../common/decorators/permissions.decorator';

// Generated CRUD, not a real port yet: gated by the global JwtAuthGuard and
// permission-checked against the '${resource}' catalog resource, but the service
// underneath is plain Prisma CRUD. This model has no tenantId of its own, so there is
// nothing to scope by here - note that a TENANT_OWNER short-circuits PermissionsGuard
// entirely, so @Permissions alone does not keep one out of a platform-level resource.
@ApiTags('${kebab}')
@ApiBearerAuth('bearer')
@Controller('${kebab}')
export class ${controllerName} {
  constructor(private readonly service: ${serviceName}) {}

${can('read')}  @Get()
  findAll() {
    return this.service.findAll();
  }

${can('read')}  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

${can('create')}  @Post()
  create(@Body() dto: ${createDtoName}) {
    return this.service.create(dto);
  }

${can('update')}  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: ${updateDtoName}) {
    return this.service.update(id, dto);
  }

${can('delete')}  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
`;
  fs.writeFileSync(path.join(dir, `${kebab}.controller.ts`), controllerContent);

  // ---- module ----
  const moduleName = `${singularPascal}Module`;
  const moduleContent = `import { Module } from '@nestjs/common';
import { ${controllerName} } from './${kebab}.controller';
import { ${serviceName} } from './${kebab}.service';

@Module({
  controllers: [${controllerName}],
  providers: [${serviceName}],
  exports: [${serviceName}],
})
export class ${moduleName} {}
`;
  fs.writeFileSync(path.join(dir, `${kebab}.module.ts`), moduleContent);
}

console.log(`Generated ${models.length} modules.`);
console.log(models.map((m) => `  - ${m.name} -> src/modules/${toKebab(parseTableName(m.body))}`).join('\n'));
