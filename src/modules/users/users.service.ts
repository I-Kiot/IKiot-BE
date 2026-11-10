import { LocationType } from '../../common/constants/location-type';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../notifications/notifications.service';
import { SubscriptionService } from '../subscriptions/subscriptions.service';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { withNestedProfile } from '../../common/utils/user-profile';
import type { FlatUserProfile } from '../../common/utils/user-profile';
import { withNamedPosting } from '../../common/dto/location-ref.dto';
import { StaffNotificationTemplates } from '../notifications/templates/staff.templates';
import { UserStatus } from '../../common/constants/user-status';
import { SystemRole } from '../../common/constants/system-role';
import { SupplierType } from '../../common/constants/inventory-ledger';
import { paginate, skipFor } from '../../common/utils/pagination';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUserDto } from './dto/query-user.dto';
import type { AuthUser } from '../../common/types/auth-user.type';
import {
  DeleteStaffDto,
  StaffAccountPasswordDto,
} from './dto/staff-account.dto';
// grants() là static nên chỉ import kiểu và hằng, không inject.
import { ShiftSupervisorService } from '../working-schedules/shift-supervisor.service';
import { validateVietnamIdentificationId } from './vietnam-identification';
import { validateVietnamPhoneNumber } from './vietnam-phone';
import type { Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

const BCRYPT_COST = 10;
const SELECT_SAFE = {
  id: true,
  tenantId: true,
  email: true,
  phoneNumber: true,
  systemRole: true,
  roleId: true,
  role: { select: { id: true, name: true } },
  status: true,
  // Được đổi thành branchId/warehouseId trong toUserResponse.
  location: { select: { id: true, type: true, name: true } },
  workshopId: true,
  workshop: { select: { id: true, supplierName: true } },
  profileFirstName: true,
  profileLastName: true,
  profileAvatarUrl: true,
  profileDob: true,
  profileTaxNumber: true,
  profileIdentificationId: true,
  profileAddress: true,
  profileGender: true,
  hireDate: true,
  accountNote: true,
  lastLogin: true,
  createdAt: true,
} as const;

/** Dựng lại vị trí làm việc từ quan hệ `location` duy nhất thành `branchId`/`warehouseId`, kèm tên bên cạnh id vì cột "Chi nhánh" ở danh sách cần hiển thị tên. */
function toUserResponse<
  T extends FlatUserProfile & {
    location: { id: string; type: string; name: string } | null;
  },
>(row: T) {
  return withNestedProfile(withNamedPosting(row));
}

/** Quản lý nhân viên, thay cho toàn bộ module `/staff` của iKiotMS-BE. Phân cấp vai trò cũ (ai được sửa ai theo BRANCH_MANAGER/WAREHOUSE_MANAGER/STAFF) đã bỏ: nay chỉ cần quyền `users:update`. */
@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly subscriptions: SubscriptionService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  /** Danh sách nhân viên có phân trang và lọc, port từ `getStaffList` (bản NestJS đầu trả toàn bộ user, không giới hạn). Giữ hai quy tắc: chỉ STAFF, và loại người gọi vì màn này dùng để quản lý người khác. */
  async findAll(tenantId: string, requesterId: string, query: QueryUserDto) {
    const where: Prisma.UserWhereInput = {
      tenantId,
      systemRole: SystemRole.STAFF,
      status: query.status ?? { not: UserStatus.DELETED },
      id: { not: requesterId },
    };

    if (query.roleId) where.roleId = query.roleId;
    // Giờ chỉ có một cột `location_id`; lọc cả chi nhánh lẫn kho sẽ không khớp ai, như phép AND hai cột cũ.
    const postings = [query.branchId, query.warehouseId].filter(
      (id): id is string => Boolean(id),
    );
    if (postings.length > 0) {
      where.AND = postings.map((locationId) => ({ locationId }));
    }

    if (query.search) {
      const match = { contains: query.search, mode: 'insensitive' } as const;
      where.OR = [
        { email: match },
        { phoneNumber: match },
        { profileFirstName: match },
        { profileLastName: match },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: SELECT_SAFE,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return paginate(
      data.map((row) => toUserResponse(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(tenantId: string, id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, tenantId },
      select: SELECT_SAFE,
    });
    if (!user)
      throw new NotFoundException({
        code: ErrorCode.USER_NOT_FOUND,
        message: 'User not found',
      });
    return toUserResponse(user);
  }

  /** Tuyển người ở trạng thái INACTIVE, chưa có mật khẩu. Cấp login là `POST /users/:id/account`, gọi riêng. */
  async create(actor: AuthUser, tenantId: string, dto: CreateUserDto) {
    await this.assertRoleBelongsToTenant(tenantId, dto.roleId);
    // Cùng quy tắc tập quyền như update: nếu không, có thể tuyển thẳng đồng nghiệp vào role đặc quyền nhất rồi bật login.
    await this.assertRoleIsWithinGrant(actor, tenantId, dto.roleId);
    const posting = this.resolvePosting(dto);
    // Nhân viên xưởng làm cho một nhà cung cấp xưởng nên không có địa điểm; mọi người khác phải thuộc một chi nhánh hoặc kho.
    if (!dto.branchId && !dto.warehouseId && !dto.workshopId)
      throw new BadRequestException({
        code: ErrorCode.STAFF_WORKPLACE_REQUIRED,
        message: 'An employee must belong to a branch or a warehouse',
      });
    await this.assertWorkplaceBelongsToTenant(
      tenantId,
      dto.branchId,
      dto.warehouseId,
    );
    await this.assertWorkshopBelongsToTenant(tenantId, dto.workshopId);

    // Seat là thứ gói cước bán, nên kiểm tra trước khi ghi row (không đợi lúc bật login), và đếm cùng tập người mà màn danh sách hiển thị.
    await this.subscriptions.assertQuota(
      tenantId,
      'quotaSnapshotMaxUsers',
      () =>
        this.prisma.user.count({
          where: {
            tenantId,
            systemRole: SystemRole.STAFF,
            status: { not: UserStatus.DELETED },
          },
        }),
      'users',
    );

    const phoneNumber = validateVietnamPhoneNumber(dto.phoneNumber);
    // Không lọc theo tenant: số điện thoại là login chung cho cả nền tảng.
    const existingPhone = await this.prisma.user.findFirst({
      where: { phoneNumber },
    });
    if (existingPhone) {
      throw new ConflictException({
        code: ErrorCode.PHONE_ALREADY_REGISTERED,
        message: 'This phone number already exists',
      });
    }

    // Cùng quy tắc bộ ba như update: số CCCD mã hoá thế kỷ, năm sinh và giới tính; lúc tạo chưa có row để đối chiếu.
    const identificationId = dto.profile?.identificationId
      ? validateVietnamIdentificationId(dto.profile.identificationId, {
          dob: dto.profile.dob ?? null,
          gender: dto.profile.gender ?? null,
        })
      : undefined;

    // Kiểm tra giống update. Trước đây chỉ update có, nên hai nhân viên có thể tạo trùng email và lỗi chỉ lộ ra khi sửa.
    await this.assertContactDetailsAreFree(tenantId, null, {
      email: dto.email,
      identificationId,
    });

    const user = await this.prisma.user.create({
      data: {
        tenantId,
        phoneNumber,
        email: dto.email,
        password: null,
        systemRole: SystemRole.STAFF,
        roleId: dto.roleId,
        ...posting,
        workshopId: dto.workshopId,
        hireDate: dto.hireDate ? new Date(dto.hireDate) : undefined,
        // Khi gửi cả hai, trường phẳng được ưu tiên: StaffDTO cũ và form hiện tại dùng tên phẳng, còn phần khác lồng trong profile.
        profileFirstName: dto.firstName ?? dto.profile?.firstName,
        profileLastName: dto.lastName ?? dto.profile?.lastName,
        profileAvatarUrl: dto.profile?.avatarUrl,
        profileDob: dto.profile?.dob ? new Date(dto.profile.dob) : undefined,
        profileTaxNumber: dto.profile?.taxNumber,
        profileIdentificationId: identificationId,
        profileAddress: dto.profile?.address,
        profileGender: dto.profile?.gender,
        status: UserStatus.INACTIVE,
      },
      select: SELECT_SAFE,
    });
    return toUserResponse(user);
  }

  /** Sửa hồ sơ nhân viên. Bản NestJS đầu chỉ còn 4 trường nên không sửa được hồ sơ, ngày vào làm, hình thức lương, ghi chú. Vòng đời tài khoản không nằm ở đây; xem UpdateUserDto. */
  async update(
    actor: AuthUser,
    tenantId: string,
    id: string,
    dto: UpdateUserDto,
  ) {
    const current = await this.requireStaff(tenantId, id);
    this.assertNotSelf(actor, id);

    if (dto.roleId) {
      await this.assertRoleBelongsToTenant(tenantId, dto.roleId);
      await this.assertRoleIsWithinGrant(actor, tenantId, dto.roleId);
    }
    const posting = this.resolvePosting(dto);
    await this.assertWorkplaceBelongsToTenant(
      tenantId,
      dto.branchId ?? undefined,
      dto.warehouseId ?? undefined,
    );
    await this.assertWorkshopBelongsToTenant(tenantId, dto.workshopId);

    const identificationId = this.resolveIdentificationId(current, dto);
    await this.assertContactDetailsAreFree(tenantId, id, {
      email: dto.email,
      identificationId: dto.profile?.identificationId
        ? identificationId
        : undefined,
    });

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        email: dto.email,
        roleId: dto.roleId,
        ...posting,
        workshopId: dto.workshopId,
        hireDate: dto.hireDate ? new Date(dto.hireDate) : undefined,
        accountNote: dto.accountNote,
        profileFirstName: dto.profile?.firstName,
        profileLastName: dto.profile?.lastName,
        profileAvatarUrl: dto.profile?.avatarUrl,
        profileDob: dto.profile?.dob ? new Date(dto.profile.dob) : undefined,
        profileTaxNumber: dto.profile?.taxNumber,
        profileIdentificationId: dto.profile?.identificationId
          ? identificationId
          : undefined,
        profileAddress: dto.profile?.address,
        profileGender: dto.profile?.gender,
      },
      select: SELECT_SAFE,
    });
    return toUserResponse(updated);
  }

  /** Nhân viên chỉ thuộc đúng một địa điểm, do cột `location_id` duy nhất đảm bảo: chọn chi nhánh sẽ thay thế kho và ngược lại. Gửi cả hai vẫn bị từ chối thay vì âm thầm chọn một. */
  private resolvePosting(dto: {
    branchId?: string | null;
    warehouseId?: string | null;
  }): { locationId?: string | null } {
    if (dto.branchId !== undefined && dto.warehouseId !== undefined) {
      throw new BadRequestException({
        code: ErrorCode.STAFF_SINGLE_LOCATION_REQUIRED,
        message: 'An employee belongs to exactly one branch or one warehouse',
      });
    }
    if (dto.branchId !== undefined) return { locationId: dto.branchId };
    if (dto.warehouseId !== undefined) return { locationId: dto.warehouseId };
    return {};
  }

  /** CCCD phải khớp ngày sinh và giới tính của cùng bản ghi, và vế nào trong bộ ba cũng có thể là thứ đang sửa, nên kiểm tra trên kết quả đã gộp chứ không chỉ trên request. */
  private resolveIdentificationId(
    current: {
      profileIdentificationId: string | null;
      profileDob: Date | null;
      profileGender: string | null;
    },
    dto: UpdateUserDto,
  ): string | undefined {
    const next =
      dto.profile?.identificationId ?? current.profileIdentificationId;
    if (!next) return undefined;

    const touched =
      dto.profile !== undefined &&
      ('identificationId' in dto.profile ||
        'dob' in dto.profile ||
        'gender' in dto.profile);
    if (!touched) return undefined;

    return validateVietnamIdentificationId(next, {
      dob: dto.profile?.dob ?? current.profileDob,
      gender: dto.profile?.gender ?? current.profileGender,
    });
  }

  /** Email và CCCD không được trùng với nhân viên khác trong cùng tenant. Bản cũ để `identificationId` toàn cục, khiến shop này dò được ai đang làm ở shop khác. */
  private async assertContactDetailsAreFree(
    tenantId: string,
    id: string | null,
    values: { email?: string; identificationId?: string },
  ) {
    // Dùng spread thay vì `id: { not: id }`: với id null, điều kiện đó thành "id is not null", khớp mọi row.
    const others = id ? { id: { not: id } } : {};

    if (values.email) {
      const taken = await this.prisma.user.findFirst({
        where: {
          tenantId,
          email: values.email.toLowerCase().trim(),
          ...others,
          status: { not: UserStatus.DELETED },
        },
        select: { id: true },
      });
      if (taken)
        throw new ConflictException({
          code: ErrorCode.EMAIL_ALREADY_IN_USE,
          message: 'This email already exists',
        });
    }

    if (values.identificationId) {
      const taken = await this.prisma.user.findFirst({
        where: {
          tenantId,
          profileIdentificationId: values.identificationId,
          ...others,
          status: { not: UserStatus.DELETED },
        },
        select: { id: true },
      });
      if (taken)
        throw new ConflictException({
          code: ErrorCode.IDENTIFICATION_ALREADY_IN_USE,
          message: 'This citizen ID already exists',
        });
    }
  }

  /** Xoá mềm kèm ẩn danh: row phải giữ vì đơn hàng, phiếu kho và audit log có FK tới nó, còn dữ liệu cá nhân bị xoá. Số điện thoại thay bằng giá trị duy nhất để tuyển lại được cùng số. */
  async remove(
    actor: AuthUser,
    tenantId: string,
    id: string,
    actorId: string,
    dto: DeleteStaffDto = {},
  ) {
    const target = await this.requireStaff(tenantId, id);
    await this.assertCanActOnStaff(actor, tenantId, target, 'delete');
    await this.assertNotAppointedManager(tenantId, id);

    await this.prisma.$transaction(async (tx) => {
      await tx.userFcmToken.deleteMany({ where: { userId: id } });
      await tx.user.update({
        where: { id },
        data: {
          status: UserStatus.DELETED,
          deletedAt: new Date(),
          deletedById: actorId,
          deletionReason: dto.deletionReason?.trim() || null,
          // Giải phóng để dùng lại, và không còn là login hoạt động.
          phoneNumber: `deleted_${target.id}`,
          email: null,
          password: null,
          profileIdentificationId: null,
          profileTaxNumber: null,
          profileAddress: null,
          profileAvatarUrl: null,
        },
      });
    });

    // Row không còn là login nhưng các phiên đã mở thì chưa: refresh token còn trong Redis, và socket đã xác thực lúc kết nối. Phải kết thúc chúng.
    await this.refreshTokens.revokeAllFor(id);

    return { success: true };
  }

  /** Bật login cho nhân viên chưa có login: nửa sau của tuyển dụng, và là cách duy nhất để tài khoản nhân viên có mật khẩu. Cũng dùng lại sau khi `deactivateAccount` đã xoá mật khẩu. */
  async createAccount(
    actor: AuthUser,
    tenantId: string,
    id: string,
    dto: StaffAccountPasswordDto,
  ) {
    const staff = await this.requireStaff(tenantId, id);
    await this.assertCanActOnStaff(
      actor,
      tenantId,
      staff,
      'create an account for',
    );
    this.assertPasswordsMatch(dto);

    if (staff.status === UserStatus.ACTIVE && staff.password) {
      throw new ConflictException({
        code: ErrorCode.STAFF_ACCOUNT_EXISTS,
        message: 'This employee already has a login',
      });
    }

    const user = await this.prisma.user.update({
      where: { id },
      data: {
        password: await bcrypt.hash(dto.newPassword, BCRYPT_COST),
        status: UserStatus.ACTIVE,
      },
      select: SELECT_SAFE,
    });

    await this.notifications.notify({
      tenantId,
      recipientIds: [id],
      referenceId: id,
      ...StaffNotificationTemplates.accountActivated(),
    });

    return toUserResponse(user);
  }

  async updateAccountPassword(
    actor: AuthUser,
    tenantId: string,
    id: string,
    dto: StaffAccountPasswordDto,
  ) {
    const staff = await this.requireStaff(tenantId, id);
    await this.assertCanActOnStaff(
      actor,
      tenantId,
      staff,
      'change the password of',
    );
    this.assertPasswordsMatch(dto);

    if (staff.status !== UserStatus.ACTIVE || !staff.password) {
      throw new BadRequestException({
        code: ErrorCode.STAFF_ACCOUNT_NOT_ACTIVATED,
        message: 'This employee account has not been activated',
      });
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: { password: await bcrypt.hash(dto.newPassword, BCRYPT_COST) },
      select: SELECT_SAFE,
    });
    // Cùng quy tắc `AuthService.resetPassword`: mật khẩu do người khác đặt lại có thể đã bị lộ, nên mọi phiên còn dùng được phải kết thúc.
    await this.refreshTokens.revokeAllFor(id);
    return toUserResponse(updated);
  }

  /** Tắt login mà không xoá người: xoá cả mật khẩu lẫn status, nên token đã phát ra bị từ chối ở request kế tiếp; kích hoạt lại phải đặt mật khẩu mới. Việc hoán đổi `replacementManagerId` cũ đã bỏ: quản lý địa điểm là `Branch.managerId`, dùng `PATCH /branches/:id/manager`. */
  async deactivateAccount(actor: AuthUser, tenantId: string, id: string) {
    const staff = await this.requireStaff(tenantId, id);
    await this.assertCanActOnStaff(actor, tenantId, staff, 'deactivate');
    if (staff.status === UserStatus.INACTIVE) {
      throw new ConflictException({
        code: ErrorCode.STAFF_ACCOUNT_ALREADY_DEACTIVATED,
        message: 'This employee account is already deactivated',
      });
    }

    await this.assertNotAppointedManager(tenantId, id);

    const updated = await this.prisma.user.update({
      where: { id },
      data: { status: UserStatus.INACTIVE, password: null },
      select: SELECT_SAFE,
    });
    // INACTIVE đủ cho HTTP vì JwtStrategy đọc lại tài khoản mỗi request, nhưng socket chỉ xác thực một lần lúc kết nối. Thiếu bước này, nhân viên đã nghỉ vẫn nhận live feed của shop tới khi đóng tab.
    await this.refreshTokens.revokeAllFor(id);
    return toUserResponse(updated);
  }

  /** Không cho tự sửa mình ở endpoint này: `GET /users` đã loại người gọi, nhưng đường update thì không, nên tài khoản có `users:update` có thể PATCH `roleId` và vị trí của chính mình. Tự sửa hồ sơ đi qua `PATCH /auth/me`, nơi không nhận hai trường này. */
  private assertNotSelf(actor: AuthUser, id: string) {
    if (actor.userId === id) {
      throw new ForbiddenException({
        code: ErrorCode.STAFF_SELF_EDIT_DENIED,
        message: 'You cannot edit your own profile here - use /auth/me',
      });
    }
  }

  /** Không được trao quyền mình không có. Thiếu bước này, `users:update` là đường tới mọi quyền khác trong shop: gán đồng nghiệp role đặc quyền nhất, đặt mật khẩu họ qua route cùng quyền, rồi đăng nhập thay. Bản cũ so hai role cố định; nay so tập quyền của role với quyền của mình. Owner và admin nền tảng được miễn. */
  private async assertRoleIsWithinGrant(
    actor: AuthUser,
    tenantId: string,
    roleId: string,
    verb = 'assign',
  ) {
    if (
      actor.systemRole === SystemRole.TENANT_OWNER ||
      actor.systemRole === SystemRole.ADMIN
    ) {
      return;
    }

    const role = await this.prisma.role.findFirst({
      where: { id: roleId, tenantId },
      select: {
        name: true,
        permissions: { select: { resource: true, action: true } },
      },
    });
    if (!role)
      throw new NotFoundException({
        code: ErrorCode.ROLE_NOT_FOUND,
        message: 'Role not found',
      });

    const held = this.ownGrantsOf(actor);
    const beyond = role.permissions.filter(
      (grant) => !held.has(`${grant.resource}:${grant.action}`),
    );
    if (beyond.length > 0) {
      throw new ForbiddenException({
        code: ErrorCode.ROLE_BEYOND_GRANT,
        message: `Cannot ${verb} role "${role.name}": it holds permissions you do not have (${beyond.map((grant) => `${grant.resource}:${grant.action}`).join(', ')})`,
      });
    }
  }

  /** Quyền của người thao tác, đã bỏ quyền tạm của ca đang chạy. Quyền tạm đúng cho `PermissionsGuard` nhưng sai ở đây, vì đây quyết định cấp vĩnh viễn gì cho người khác: tính cả nó thì trưởng ca có thể cấp `stock_movement:approve` vĩnh viễn ngay trong ca. */
  private ownGrantsOf(actor: AuthUser): Set<string> {
    const held = new Set(actor.permissions);
    for (const key of held) {
      const [resource, action] = key.split(':');
      if (ShiftSupervisorService.grants(resource, action)) held.delete(key);
    }
    return held;
  }

  /** Người thao tác có được động vào tài khoản này không? Kiểm tra tập quyền chỉ chặn cửa trước: chiếm tài khoản đã có role mạnh hơn không cần gán gì, vì `PATCH /users/:id/account/password` ghi đè mật khẩu của bất kỳ ai. Nên mọi thao tác vòng đời yêu cầu role hiện tại của đích nằm trong quyền người thao tác; owner/admin được miễn, người chưa có role thì ai cũng được. */
  private async assertCanActOnStaff(
    actor: AuthUser,
    tenantId: string,
    target: { id: string; roleId: string | null },
    verb: string,
  ) {
    if (
      actor.systemRole === SystemRole.TENANT_OWNER ||
      actor.systemRole === SystemRole.ADMIN
    ) {
      return;
    }
    if (actor.userId === target.id) return;
    if (!target.roleId) return;
    await this.assertRoleIsWithinGrant(actor, tenantId, target.roleId, verb);
  }

  private async requireStaff(tenantId: string, id: string) {
    const staff = await this.prisma.user.findFirst({
      where: { id, tenantId, status: { not: UserStatus.DELETED } },
    });
    if (!staff)
      throw new NotFoundException({
        code: ErrorCode.STAFF_NOT_FOUND,
        message: 'Employee not found',
      });
    if (staff.systemRole !== SystemRole.STAFF) {
      throw new BadRequestException({
        code: ErrorCode.STAFF_ACCOUNT_ONLY,
        message:
          'Only an employee account can be managed through this endpoint',
      });
    }
    return staff;
  }

  private assertPasswordsMatch(dto: StaffAccountPasswordDto) {
    if (dto.newPassword !== dto.reEnterPassword) {
      throw new BadRequestException({
        code: ErrorCode.PASSWORD_CONFIRMATION_MISMATCH,
        message: 'The password confirmation does not match',
      });
    }
  }

  /** Địa điểm không được trỏ tới quản lý đã bị vô hiệu; thay người phải qua PATCH /branches/:id/manager, nơi duy nhất biết quy tắc bổ nhiệm. */
  private async assertNotAppointedManager(tenantId: string, id: string) {
    const managed = await this.prisma.location.count({
      where: { tenantId, managerId: id },
    });
    if (managed > 0) {
      throw new ConflictException({
        code: ErrorCode.STAFF_IS_LOCATION_MANAGER,
        message:
          'This employee manages a branch or a warehouse. Appoint somebody else first.',
      });
    }
  }

  private async assertRoleBelongsToTenant(tenantId: string, roleId: string) {
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, tenantId },
    });
    if (!role)
      throw new BadRequestException({
        code: ErrorCode.ROLE_NOT_IN_TENANT,
        message: 'roleId does not belong to this tenant',
      });
  }

  /** Nhân viên xưởng phải chọn một nhà cung cấp loại WORKSHOP của chính shop. `users.workshop_id` là FK thường, DB không kiểm tra tenant hay loại supplier. */
  private async assertWorkshopBelongsToTenant(
    tenantId: string,
    workshopId: string | null | undefined,
  ) {
    if (!workshopId) return;
    const workshop = await this.prisma.supplier.findFirst({
      where: { id: workshopId, tenantId, type: SupplierType.WORKSHOP },
      select: { id: true },
    });
    if (!workshop)
      throw new BadRequestException({
        code: ErrorCode.USER_WORKSHOP_INVALID,
        message: 'workshopId is not a workshop supplier of this tenant',
      });
  }

  private async assertWorkplaceBelongsToTenant(
    tenantId: string,
    branchId?: string,
    warehouseId?: string,
  ) {
    if (branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: {
          id: branchId,
          tenantId,
          location: { type: LocationType.BRANCH },
        },
      });
      if (!branch)
        throw new BadRequestException({
          code: ErrorCode.BRANCH_NOT_IN_TENANT,
          message: 'branchId does not belong to this tenant',
        });
    }
    if (warehouseId) {
      const warehouse = await this.prisma.warehouse.findFirst({
        where: { id: warehouseId, tenantId },
      });
      if (!warehouse)
        throw new BadRequestException({
          code: ErrorCode.WAREHOUSE_NOT_IN_TENANT,
          message: 'warehouseId does not belong to this tenant',
        });
    }
  }
}
