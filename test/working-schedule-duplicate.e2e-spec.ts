import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { WorkingScheduleService } from './../src/modules/working-schedules/working-schedules.service';
import { ShiftTemplateService } from './../src/modules/shift-templates/shift-templates.service';
import { NotificationService } from './../src/modules/notifications/notifications.service';
import { toShiftTime } from './../src/modules/shift-templates/shift-time';
import { ErrorCode } from './../src/common/errors/error-codes';
import { SystemRole } from './../src/common/constants/system-role';
import { UserStatus } from './../src/common/constants/user-status';

/**
 * Bug DEF-ST-08 trên Postgres thật: phân lại một nhân viên vào đúng ca, đúng ngày họ đã có thì bị từ chối và không ghi gì;
 * thêm người mới vào ca đã có vẫn được. Tự tạo tenant riêng và dọn sạch.
 */
describe('Working schedules – assigning the same person to the same shift twice', () => {
  let prisma: PrismaService;
  let schedules: WorkingScheduleService;

  const tenantId = randomUUID();
  const actorId = randomUUID();
  const binhId = randomUUID();
  const anId = randomUUID();
  let templateId = '';
  const workDate = '2026-11-20';

  const assign = (userIds: string[]) =>
    schedules.createBulk(tenantId, actorId, {
      schedules: [{ userId: userIds, shiftTemplateId: templateId, workDate }],
    });

  const assignmentCount = () =>
    prisma.workingScheduleUser.count({ where: { schedule: { tenantId } } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        WorkingScheduleService,
        ShiftTemplateService,
        {
          provide: NotificationService,
          useValue: { notify: () => Promise.resolve() },
        },
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    schedules = moduleRef.get(WorkingScheduleService);

    await prisma.tenant.create({
      data: { id: tenantId, name: 'schedule-duplicate-e2e' },
    });
    await prisma.user.createMany({
      data: [
        { id: actorId, systemRole: SystemRole.TENANT_OWNER },
        { id: binhId, systemRole: SystemRole.STAFF },
        { id: anId, systemRole: SystemRole.STAFF },
      ].map(({ id, systemRole }) => ({
        id,
        tenantId,
        systemRole,
        status: UserStatus.ACTIVE,
        phoneNumber: `wsd-${id}`,
      })),
    });
    templateId = (
      await prisma.shiftTemplate.create({
        data: {
          tenantId,
          name: 'Ca sáng',
          startTime: toShiftTime('08:00'),
          endTime: toShiftTime('12:00'),
        },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.workingScheduleUser.deleteMany({
      where: { schedule: { tenantId } },
    });
    await prisma.workingSchedule.deleteMany({ where: { tenantId } });
    await prisma.shiftTemplate.deleteMany({ where: { tenantId } });
    await prisma.notification.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it('refuses the same person on the same shift and day, writing nothing', async () => {
    await assign([binhId]);
    const before = await assignmentCount();

    await expect(assign([binhId])).rejects.toMatchObject({
      response: {
        code: ErrorCode.SCHEDULE_ALREADY_ASSIGNED,
        errors: [{ userId: binhId, shiftName: 'Ca sáng' }],
      },
    });
    expect(await assignmentCount()).toBe(before);
    expect(await prisma.workingSchedule.count({ where: { tenantId } })).toBe(1);
  });

  it('refuses the whole batch when one person in it is already on the shift', async () => {
    const before = await assignmentCount();
    await expect(assign([anId, binhId])).rejects.toMatchObject({
      response: { code: ErrorCode.SCHEDULE_ALREADY_ASSIGNED },
    });
    expect(await assignmentCount()).toBe(before);
  });

  it('still adds a new person to the shift that already exists', async () => {
    await assign([anId]);
    const rows = await prisma.workingSchedule.findMany({
      where: { tenantId },
      include: { assignedUsers: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].assignedUsers.map((a) => a.userId).sort()).toEqual(
      [anId, binhId].sort(),
    );
  });
});
