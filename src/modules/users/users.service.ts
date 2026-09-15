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
import { StaffNotificationTemplates } from '../notifications/templates/staff.templates';
import { UserStatus } from '../../common/constants/user-status';
import { SystemRole } from '../../common/constants/system-role';
import { paginate, skipFor } from '../../common/utils/pagination';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUserDto } from './dto/query-user.dto';
import type { AuthUser } from '../../common/types/auth-user.type';
import {
  DeleteStaffDto,
  LeaveBalanceDto,
  StaffAccountPasswordDto,
} from './dto/staff-account.dto';
// `grants()` is static - this is a plain type/constant reference, not an injected dependency.
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
  branchId: true,
  warehouseId: true,
  // Names alongside the ids: the staff list has a "Chi nhánh" column and an id there is unreadable.
  branch: { select: { id: true, name: true } },
  warehouse: { select: { id: true, name: true } },
  profileFirstName: true,
  profileLastName: true,
  profileAvatarUrl: true,
  profileDob: true,
  profileTaxNumber: true,
  profileIdentificationId: true,
  profileAddress: true,
  profileGender: true,
  hireDate: true,
  paysheetId: true,
  // The name as well as the id: the staff list shows which pay scheme somebody is on, and an id alone means fetching every paysheet to render one column.
  paysheet: { select: { id: true, name: true } },
  accountNote: true,
  lastLogin: true,
  createdAt: true,
  leaveBalanceAnnualDays: true,
  leaveBalanceRemainingDays: true,
} as const;

/** A leave request still "in force": it hasn't been rejected and hasn't finished yet. */
const LIVE_LEAVE_STATUSES = ['PENDING', 'APPROVED'];

/** Staff accounts, covering iKiotMS-BE's whole `/staff` module. A large part of the old service was role-hierarchy plumbing - who may edit whom given BRANCH_MANAGER vs WAREHOUSE_MANAGER vs STAFF - and none of it survives: "who may edit staff" is now one permission, `users:update`. */
@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly subscriptions: SubscriptionService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  /** The staff list, paginated and filtered - a port of `getStaffList`, which the first NestJS pass had reduced to every user in the tenant, unbounded. Two rules carry over: only STAFF accounts appear, and the caller is excluded, since this screen is for managing other people. */
  async findAll(tenantId: string, requesterId: string, query: QueryUserDto) {
    const where: Prisma.UserWhereInput = {
      tenantId,
      systemRole: SystemRole.STAFF,
      status: query.status ?? { not: UserStatus.DELETED },
      id: { not: requesterId },
    };

    if (query.roleId) where.roleId = query.roleId;
    if (query.branchId) where.branchId = query.branchId;
    if (query.warehouseId) where.warehouseId = query.warehouseId;

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
      data.map((row) => withNestedProfile(row)),
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
    return withNestedProfile(user);
  }

  /** Hire someone, INACTIVE and without a password - giving them a login is `POST /users/:id/account`, a separate call. See `CreateUserDto`. */
  async create(actor: AuthUser, tenantId: string, dto: CreateUserDto) {
    await this.assertRoleBelongsToTenant(tenantId, dto.roleId);
    // The same subset rule `update` applies: without it, someone could hire a colleague straight into the shop's most privileged role and then switch the login on.
    await this.assertRoleIsWithinGrant(actor, tenantId, dto.roleId);
    await this.assertWorkplaceBelongsToTenant(
      tenantId,
      dto.branchId,
      dto.warehouseId,
    );

    // Seats are what a plan sells, so this is checked before the row is written rather than when the login is switched on - and it counts the same population the list screen shows.
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
    // Not tenant-scoped: the phone number is the login handle for the whole platform.
    const existingPhone = await this.prisma.user.findFirst({
      where: { phoneNumber },
    });
    if (existingPhone) {
      throw new ConflictException({
        code: ErrorCode.PHONE_ALREADY_REGISTERED,
        message: 'This phone number already exists',
      });
    }

    if (dto.paysheetId) {
      await this.assertPaysheetIsUsable(tenantId, dto.paysheetId);
    }

    // Same trio rule `update` enforces: the citizen ID encodes a century, birth year and sex, and on a create there is no existing row to merge against.
    const identificationId = dto.profile?.identificationId
      ? validateVietnamIdentificationId(dto.profile.identificationId, {
          dob: dto.profile.dob ?? null,
          gender: dto.profile.gender ?? null,
        })
      : undefined;

    // The same check `update` runs. It used to run only there, so two colleagues could be created on one email address and the clash surfaced only when somebody later edited one of them.
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
        branchId: dto.branchId,
        warehouseId: dto.warehouseId,
        hireDate: dto.hireDate ? new Date(dto.hireDate) : undefined,
        paysheetId: dto.paysheetId,
        // Flat wins over nested when both are sent - the old `StaffDTO` spelled the name flat and the form still does, while everything else about a person is nested.
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
    return withNestedProfile(user);
  }

  /** Edit a staff record, ported from `updateStaff` - the first NestJS pass had cut it to four fields, leaving the profile, hire date, pay scheme and account note with no way in. Account lifecycle stays out of here; see UpdateUserDto. */
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
      posting.branchId ?? undefined,
      posting.warehouseId ?? undefined,
    );
    if (dto.paysheetId) {
      await this.assertPaysheetIsUsable(tenantId, dto.paysheetId);
    }

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
        hireDate: dto.hireDate ? new Date(dto.hireDate) : undefined,
        paysheetId: dto.paysheetId,
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
    return withNestedProfile(updated);
  }

  /** A staff member is posted at exactly one location, so naming one clears the other: without this, sending only `branchId` leaves a stale `warehouseId` and the row claims two workplaces, which the next edit then rejects, blaming whoever touched it last. */
  private resolvePosting(dto: UpdateUserDto): {
    branchId?: string | null;
    warehouseId?: string | null;
  } {
    if (dto.branchId !== undefined && dto.warehouseId !== undefined) {
      throw new BadRequestException({
        code: ErrorCode.STAFF_SINGLE_LOCATION_REQUIRED,
        message: 'An employee belongs to exactly one branch or one warehouse',
      });
    }
    if (dto.branchId !== undefined) {
      return { branchId: dto.branchId, warehouseId: null };
    }
    if (dto.warehouseId !== undefined) {
      return { warehouseId: dto.warehouseId, branchId: null };
    }
    return {};
  }

  /** The citizen ID has to agree with the birth date and sex on the same record, and either side of that trio may be the one being edited - so the check runs against the merged result rather than the request alone. */
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

  /** A pay scheme has to exist, be in this tenant, and not be deleted. */
  private async assertPaysheetIsUsable(tenantId: string, paysheetId: string) {
    const paysheet = await this.prisma.paysheet.findFirst({
      where: { id: paysheetId, tenantId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!paysheet) {
      throw new BadRequestException({
        code: ErrorCode.PAYSHEET_NOT_FOUND,
        message: 'The paysheet does not exist or has been deleted',
      });
    }
  }

  /** Email and citizen ID may not collide with another staff member's, both scoped to the tenant - the old check left `identificationId` global, which let one shop discover that another employs a particular person. */
  private async assertContactDetailsAreFree(
    tenantId: string,
    /** The row being edited, excluded from the search. `null` when creating. */
    id: string | null,
    values: { email?: string; identificationId?: string },
  ) {
    // Spread rather than `id: { not: id }`: with a null id that would read as "id is not null", which is every row - right here only by accident.
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

  /** Soft delete, and an anonymising one: the row has to stay because orders, attendances, payslips and audit logs hold a foreign key, but the personal data does not, and the phone number is replaced with a unique placeholder so the person can be re-hired under the same number. */
  async remove(
    actor: AuthUser,
    tenantId: string,
    id: string,
    actorId: string,
    dto: DeleteStaffDto = {},
  ) {
    const target = await this.requireStaff(tenantId, id);
    await this.assertCanActOnStaff(actor, tenantId, target, 'delete');
    await this.assertNotHoldingHandover(tenantId, id);
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
          // Freed for reuse, and no longer a working login.
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

    // The row is gone as a login, but the sessions it opened are not - a refresh token still in Redis, and a socket authenticated once at connect. Ending them is the same call everywhere.
    await this.refreshTokens.revokeAllFor(id);

    return { success: true };
  }

  // ─── Account lifecycle ─────────────────────────────────────────────────────

  /** Switch on the login for an employee created without one - the second half of hiring, and the only way a staff account ever gets a password. Reached again after `deactivateAccount` has cleared it. */
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

    return withNestedProfile(user);
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
    // Same rule `AuthService.resetPassword` follows: a password someone else had to reset may have leaked, so every session it could still reach ends.
    await this.refreshTokens.revokeAllFor(id);
    return withNestedProfile(updated);
  }

  /** Turn the login off without deleting the person: the password is cleared as well as the status, so any token already in the wild is rejected on the next request and reactivation has to set a fresh one. The old `replacementManagerId` swap is gone - managing a location is `Branch.managerId` now, so this points at `PATCH /branches/:id/manager` instead. */
  async deactivateAccount(actor: AuthUser, tenantId: string, id: string) {
    const staff = await this.requireStaff(tenantId, id);
    await this.assertCanActOnStaff(actor, tenantId, staff, 'deactivate');
    if (staff.status === UserStatus.INACTIVE) {
      throw new ConflictException({
        code: ErrorCode.STAFF_ACCOUNT_ALREADY_DEACTIVATED,
        message: 'This employee account is already deactivated',
      });
    }

    await this.assertNotHoldingHandover(tenantId, id);
    await this.assertNotAppointedManager(tenantId, id);

    const updated = await this.prisma.user.update({
      where: { id },
      data: { status: UserStatus.INACTIVE, password: null },
      select: SELECT_SAFE,
    });
    // INACTIVE is enough for HTTP, since JwtStrategy re-reads the account every request, but a socket is authenticated once at connect - without this a dismissed employee kept the shop's live feed until they closed the tab.
    await this.refreshTokens.revokeAllFor(id);
    return withNestedProfile(updated);
  }

  // ─── Leave balance ─────────────────────────────────────────────────────────

  /** Change the yearly allowance, keeping days already taken: `remainingDays` is recomputed as `new allowance - days used` rather than overwritten, so the new allowance can't be lower than what they have used. */
  async updateLeaveBalance(tenantId: string, id: string, dto: LeaveBalanceDto) {
    const staff = await this.requireStaff(tenantId, id);
    const usedDays =
      staff.leaveBalanceAnnualDays - staff.leaveBalanceRemainingDays;

    if (usedDays < 0) {
      throw new ConflictException({
        code: ErrorCode.LEAVE_BALANCE_INCONSISTENT,
        message:
          'The current leave balance is inconsistent: remaining days exceed the annual allowance',
      });
    }
    if (dto.annualLeaveDays < usedDays) {
      throw new BadRequestException({
        code: ErrorCode.LEAVE_BALANCE_BELOW_USED,
        message: `The annual leave allowance cannot be lower than the ${usedDays} day(s) already used`,
      });
    }

    return this.writeLeaveBalance(
      tenantId,
      id,
      staff,
      {
        annualLeaveDays: dto.annualLeaveDays,
        remainingDays: dto.annualLeaveDays - usedDays,
        usedDays,
      },
      'Cập nhật số ngày nghỉ phép năm thành công',
    );
  }

  /** Set the opening balance, allowance and remaining together - valid only while nothing has been taken, since otherwise it would erase the history of days already used. */
  async createLeaveBalance(tenantId: string, id: string, dto: LeaveBalanceDto) {
    const staff = await this.requireStaff(tenantId, id);
    const usedDays =
      staff.leaveBalanceAnnualDays - staff.leaveBalanceRemainingDays;

    if (usedDays !== 0) {
      throw new ConflictException({
        code: ErrorCode.LEAVE_BALANCE_ALREADY_USED,
        message:
          'This employee has already taken leave; use PATCH to change the allowance without losing the history',
      });
    }

    return this.writeLeaveBalance(
      tenantId,
      id,
      staff,
      {
        annualLeaveDays: dto.annualLeaveDays,
        remainingDays: dto.annualLeaveDays,
        usedDays: 0,
      },
      'Khởi tạo số dư ngày nghỉ phép thành công',
    );
  }

  /** Writes the new balance only if it still matches what we just read: the numbers are computed from the current values, so two managers editing at once (or an edit racing an approved request) would produce a wrong result rather than a lost one. */
  private async writeLeaveBalance(
    tenantId: string,
    id: string,
    seen: { leaveBalanceAnnualDays: number; leaveBalanceRemainingDays: number },
    next: { annualLeaveDays: number; remainingDays: number; usedDays: number },
    message: string,
  ) {
    const written = await this.prisma.user.updateMany({
      where: {
        id,
        leaveBalanceAnnualDays: seen.leaveBalanceAnnualDays,
        leaveBalanceRemainingDays: seen.leaveBalanceRemainingDays,
      },
      data: {
        leaveBalanceAnnualDays: next.annualLeaveDays,
        leaveBalanceRemainingDays: next.remainingDays,
      },
    });

    if (written.count === 0) {
      throw new ConflictException({
        code: ErrorCode.LEAVE_BALANCE_CONFLICT,
        message:
          'The leave balance has just changed; please reload and try again',
      });
    }

    // `{ message, data, leaveBalance }` is the shape iKiotMS-BE answered with.
    return {
      message,
      data: await this.findOne(tenantId, id),
      leaveBalance: next,
    };
  }

  // ─── Shared guards ─────────────────────────────────────────────────────────

  /** The target has to be a STAFF account in this tenant that hasn't been deleted. */
  /** This endpoint manages other people. `GET /users` already excludes the caller, but the update path did not, so an account holding `users:update` could PATCH its own `roleId` and posting; self-service is `PATCH /auth/me`, which accepts neither. */
  private assertNotSelf(actor: AuthUser, id: string) {
    if (actor.userId === id) {
      throw new ForbiddenException({
        code: ErrorCode.STAFF_SELF_EDIT_DENIED,
        message: 'You cannot edit your own profile here - use /auth/me',
      });
    }
  }

  /** You cannot hand out a permission you do not hold. Without this, `users:update` was a path to every other permission in the shop: assign a colleague the most privileged role, set their password through the route the same permission gates, and sign in as them. The old `validateRoleHierarchy` compared two fixed roles; with tenant-defined roles the comparison is "is this role's grant set inside mine". Owners and platform admins are exempt. */
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

  /** The actor's own grants, with a live shift's temporary ones removed: those are right for `PermissionsGuard` but wrong here, since this decides what a person may make permanent on somebody else - counting them would let a supervisor hand a colleague `stock_movement:approve` for good during the one shift they hold it. */
  private ownGrantsOf(actor: AuthUser): Set<string> {
    const held = new Set(actor.permissions);
    for (const key of held) {
      const [resource, action] = key.split(':');
      if (ShiftSupervisorService.grants(resource, action)) held.delete(key);
    }
    return held;
  }

  /** May the actor act on this employee's account at all? The role-subset rule only closed the front door: taking over an account that already holds a stronger role needs no assignment, since `PATCH /users/:id/account/password` overwrites anybody's hash. So every lifecycle path requires the target's current role to be within the actor's grant; owners and admins are exempt, and a fresh hire with no role is within everybody's. */
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

  /** Someone named as the handover contact on an unfinished leave request is holding a colleague's work - switching their account off would leave it with nobody. */
  private async assertNotHoldingHandover(tenantId: string, id: string) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const holding = await this.prisma.leaveRequest.count({
      where: {
        tenantId,
        handoverToUserId: id,
        status: { in: LIVE_LEAVE_STATUSES },
        endDate: { gte: today },
      },
    });
    if (holding > 0) {
      throw new ConflictException({
        code: ErrorCode.STAFF_HOLDS_LEAVE_HANDOVER,
        message:
          'An employee named as the handover recipient on a live leave request cannot be deactivated or deleted',
      });
    }
  }

  /** A location must never be left pointing at a disabled manager; the replacement goes through PATCH /branches/:id/manager, which is the one place that knows the appointment rules. */
  private async assertNotAppointedManager(tenantId: string, id: string) {
    const [branches, warehouses] = await Promise.all([
      this.prisma.branch.count({ where: { tenantId, managerId: id } }),
      this.prisma.warehouse.count({ where: { tenantId, managerId: id } }),
    ]);
    if (branches + warehouses > 0) {
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

  private async assertWorkplaceBelongsToTenant(
    tenantId: string,
    branchId?: string,
    warehouseId?: string,
  ) {
    if (branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: { id: branchId, tenantId },
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
