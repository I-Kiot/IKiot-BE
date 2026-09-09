import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionService } from '../subscriptions/subscriptions.service';
import { LocationStatus } from '../../common/constants/location-status';
import { UserStatus } from '../../common/constants/user-status';
import {
  toAttendanceColumns,
  withNestedAttendanceLocation,
} from '../../common/dto/attendance-location.dto';
import type { AttendanceLocationDto } from '../../common/dto/attendance-location.dto';
import { paginate, skipFor } from '../../common/utils/pagination';
import { LOCATION_INCLUDE } from './location.types';
import type {
  LocationConfig,
  LocationDelegate,
  LocationRow,
  LocationWhere,
} from './location.types';
import { ErrorCode } from '../../common/errors/error-codes';

/** What both list endpoints accept - the DTOs extend PaginationQueryDto, so page/limit always arrive defaulted. */
export interface LocationQuery {
  search?: string;
  status?: string;
  page: number;
  limit: number;
}

/** The client-settable fields shared by CreateBranchDto and CreateWarehouseDto. */
export interface LocationInput {
  name?: string;
  phoneNumber?: string[];
  address?: string;
  email?: string;
  status?: string;
  attendanceTakingLocation?: AttendanceLocationDto;
}

/** Everything a branch and a warehouse do identically. They used to be two ~220-line services that were 90% the same text, and that symmetry had already broken once: BranchService refused to move a staff member out of their current location and WarehouseService silently did it. What actually differs is passed in as a `LocationConfig`. */
export abstract class LocationService<TRow extends LocationRow> {
  protected constructor(
    protected readonly prisma: PrismaService,
    protected readonly subscriptions: SubscriptionService,
    private readonly delegate: LocationDelegate<TRow>,
    private readonly config: LocationConfig,
  ) {}

  /** Re-nests the flattened geofence columns into the `attendanceTakingLocation` object the old API returned. */
  protected toResponse(row: TRow) {
    return withNestedAttendanceLocation(row);
  }

  async findAll(tenantId: string, query: LocationQuery) {
    const where: LocationWhere = {
      tenantId,
      // Without an explicit filter the recycle bin stays hidden.
      status: query.status ?? { not: LocationStatus.DELETED },
    };
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }

    const [rows, total] = await Promise.all([
      this.delegate.findMany({
        where,
        include: LOCATION_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.delegate.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toResponse(row)),
      total,
      query.page,
      query.limit,
    );
  }

  /** Always scoped by tenant, and a miss is a 404 rather than a 403: another tenant's location must be indistinguishable from one that does not exist. */
  protected async findRow(tenantId: string, id: string): Promise<TRow> {
    const row = await this.delegate.findFirst({
      where: { id, tenantId },
      include: LOCATION_INCLUDE,
    });
    if (!row)
      throw new NotFoundException({
        code: ErrorCode.LOCATION_NOT_FOUND,
        message: this.config.messages.notFound,
      });
    return row;
  }

  async findOne(tenantId: string, id: string) {
    return this.toResponse(await this.findRow(tenantId, id));
  }

  async create(tenantId: string, dto: LocationInput & { name: string }) {
    // Old behaviour: POST /branches sat behind requireActiveSubscription and then checked the plan quota, both of which live in SubscriptionService now (maxWarehouses is new in the port).
    await this.subscriptions.assertQuota(
      tenantId,
      this.config.quotaField,
      () =>
        this.delegate.count({
          where: { tenantId, status: { not: LocationStatus.DELETED } },
        }),
      this.config.messages.quotaLabel,
    );

    const row = await this.delegate.create({
      data: {
        tenantId,
        name: dto.name,
        phoneNumber: dto.phoneNumber ?? [],
        address: dto.address,
        email: dto.email,
        ...toAttendanceColumns(dto.attendanceTakingLocation),
      },
      include: LOCATION_INCLUDE,
    });

    // A new location opens holding nothing, and writes no stock rows: it lists the whole
    // catalogue anyway (the product list is not scoped by location) and a row appears here
    // the first time a stock movement actually delivers something.
    return this.toResponse(row);
  }

  async update(tenantId: string, id: string, dto: LocationInput) {
    // Prisma's update({ where: { id } }) can't take a non-unique tenant filter, so scope has to be re-checked first or any tenant could write any row by id.
    await this.findRow(tenantId, id);

    const row = await this.delegate.update({
      where: { id },
      data: {
        name: dto.name,
        phoneNumber: dto.phoneNumber,
        address: dto.address,
        email: dto.email,
        status: dto.status,
        ...toAttendanceColumns(dto.attendanceTakingLocation),
      },
      include: LOCATION_INCLUDE,
    });
    return this.toResponse(row);
  }

  /** Soft delete, as the old system did - a hard delete is not an option anyway, since users, orders, inventory, stock movements and cash flows all hold a foreign key here. */
  async remove(tenantId: string, id: string) {
    const existing = await this.findRow(tenantId, id);
    if (existing.status === LocationStatus.DELETED) {
      throw new BadRequestException({
        code: ErrorCode.LOCATION_ALREADY_DELETED,
        message: this.config.messages.alreadyDeleted,
      });
    }

    // Added during the port: soft-deleting a location out from under its staff left them assigned to somewhere that appears in no list.
    const staffCount = await this.prisma.user.count({
      where: {
        tenantId,
        ...this.postedAt(id),
        status: { not: UserStatus.DELETED },
      },
    });
    if (staffCount > 0) {
      throw new BadRequestException({
        code: ErrorCode.LOCATION_STAFF_STILL_ATTACHED,
        message: this.config.messages.staffStillAttached(staffCount),
      });
    }

    const row = await this.delegate.update({
      where: { id },
      data: { status: LocationStatus.DELETED, managerId: null },
      include: LOCATION_INCLUDE,
    });
    return this.toResponse(row);
  }

  /** Appoint a manager, returning the appointee. The old role flip is gone with the roles themselves, so the appointment is recorded in `managerId`; the outgoing manager is unlinked and their Role left alone, since the tenant now decides what a manager may do. */
  protected async appointManager(
    tenantId: string,
    locationId: string,
    staffId: string,
  ) {
    const location = await this.delegate.findFirst({
      where: {
        id: locationId,
        tenantId,
        status: { not: LocationStatus.DELETED },
      },
      include: LOCATION_INCLUDE,
    });
    if (!location)
      throw new NotFoundException({
        code: ErrorCode.LOCATION_NOT_FOUND,
        message: this.config.messages.notFound,
      });

    const staff = await this.prisma.user.findFirst({
      where: { id: staffId, tenantId, status: UserStatus.ACTIVE },
    });
    if (!staff) {
      throw new BadRequestException({
        code: ErrorCode.LOCATION_STAFF_NOT_ELIGIBLE,
        message: this.config.messages.staffNotEligible,
      });
    }

    // Appointing someone must not quietly relocate them, so a posting at another location is cleared first rather than silently overwritten.
    const currentPosting = staff[this.config.postingField];
    const otherPosting = staff[this.config.otherPostingField];
    if (
      (currentPosting !== null && currentPosting !== locationId) ||
      otherPosting !== null
    ) {
      throw new BadRequestException({
        code: ErrorCode.LOCATION_STAFF_POSTED_ELSEWHERE,
        message: this.config.messages.staffPostedElsewhere,
      });
    }

    const [, updated] = await this.prisma.$transaction([
      // A user works at exactly one location, so taking this one releases the other.
      this.prisma.user.update({
        where: { id: staffId },
        data: this.postedAt(locationId, { exclusively: true }),
      }),
      this.delegate.update({
        where: { id: locationId },
        data: { managerId: staffId },
        include: LOCATION_INCLUDE,
      }),
    ]);

    return updated.manager;
  }

  /** `{ branchId: id }` or `{ warehouseId: id }`, written out per case rather than with a computed key so Prisma still type-checks the column name. */
  private postedAt(locationId: string, options?: { exclusively: boolean }) {
    const clearOther = options?.exclusively === true;
    return this.config.postingField === 'branchId'
      ? { branchId: locationId, ...(clearOther ? { warehouseId: null } : {}) }
      : { warehouseId: locationId, ...(clearOther ? { branchId: null } : {}) };
  }
}
