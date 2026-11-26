import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { SubscriptionService } from './../src/modules/subscriptions/subscriptions.service';
import { BranchService } from './../src/modules/branches/branches.service';
import { CashDrawerSessionService } from './../src/modules/cash-drawer-sessions/cash-drawer-sessions.service';
import { StatsService } from './../src/modules/stats/stats.service';
import { CashflowQueryDto } from './../src/modules/stats/dto/stats-query.dto';
import { QueryCashVarianceDto } from './../src/modules/cash-drawer-sessions/dto/cash-drawer.dto';
import { SystemRole } from './../src/common/constants/system-role';
import { ErrorCode } from './../src/common/errors/error-codes';
import type { AuthUser } from './../src/common/types/auth-user.type';

/**
 * Két ghi sổ quỹ khi mở / chốt (2026-11-27), trên Postgres thật: kịch bản một ngày bán hàng.
 * Mở 1tr (chủ đưa) → thu 5tr, chi 500k → đếm 5,45tr (thiếu 50k) → chủ rút 4,45tr, để lại 1tr.
 * Hôm sau mở với 900k → thiếu két 100k qua đêm.
 */
describe('Cash drawer books the fund ledger on open / close', () => {
  let prisma: PrismaService;
  let drawers: CashDrawerSessionService;
  let stats: StatsService;

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const cashierId = randomUUID();
  let branchId = '';

  const owner = (): AuthUser => ({
    userId: ownerId,
    tenantId,
    systemRole: SystemRole.TENANT_OWNER,
    roleId: null,
    branchId: null,
    warehouseId: null,
    permissions: new Set(),
    shiftSupervision: null,
    email: null,
    displayName: null,
    phoneNumber: '0900000001',
  });
  const cashier = (): AuthUser => ({
    ...owner(),
    userId: cashierId,
    systemRole: SystemRole.STAFF,
    branchId,
    permissions: new Set(['cash_drawers:report', 'cash_drawers:read']),
  });

  const rowsOf = (sessionId: string) =>
    prisma.cashFlow
      .findMany({
        where: { cashDrawerSessionId: sessionId },
        select: { category: true, fund: true, flowType: true, amount: true },
        orderBy: [{ createdAt: 'asc' }, { category: 'asc' }],
      })
      .then((rows) =>
        rows.map((r) => [r.category, r.fund, r.flowType, Number(r.amount)]),
      );

  /** Thay cho bán hàng: dòng tiền mặt qua két mà không cần đơn. */
  const cash = (category: string, flowType: string, amount: number) =>
    prisma.cashFlow.create({
      data: {
        tenantId,
        flowType,
        amount,
        paymentMethod: 'CASH',
        locationId: branchId,
        fund: 'DRAWER',
        category,
      },
    });

  /** Thu ngân trả két (END không bàn giao), rồi chủ đếm chốt và rút tiền. */
  async function closeDay(sessionId: string, count: number, withdraw: number) {
    await drawers.submitShiftLog(cashier(), sessionId, {
      type: 'END',
      amount: count,
    });
    return drawers.finalize(owner(), sessionId, {
      finalAmount: count,
      withdrawAmount: withdraw,
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        BranchService,
        CashDrawerSessionService,
        StatsService,
        {
          provide: SubscriptionService,
          useValue: { assertQuota: () => Promise.resolve() },
        },
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    drawers = moduleRef.get(CashDrawerSessionService);
    stats = moduleRef.get(StatsService);

    await prisma.tenant.create({ data: { id: tenantId, name: 'drawer-e2e' } });
    branchId = (
      await moduleRef
        .get(BranchService)
        .create(tenantId, { name: 'CN Hà Nội', phoneNumber: ['0900000000'] })
    ).id;
    await prisma.user.create({
      data: {
        id: ownerId,
        tenantId,
        phoneNumber: `own-${tenantId}`,
        systemRole: SystemRole.TENANT_OWNER,
      },
    });
    await prisma.user.create({
      data: {
        id: cashierId,
        tenantId,
        phoneNumber: `csh-${tenantId}`,
        systemRole: SystemRole.STAFF,
        locationId: branchId,
      },
    });
  });

  afterAll(async () => {
    await prisma.cashFlow.deleteMany({ where: { tenantId } });
    await prisma.cashDrawerShiftLog.deleteMany({
      where: { session: { tenantId } },
    });
    await prisma.cashDrawerSession.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.branch.deleteMany({ where: { tenantId } });
    await prisma.location.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  let firstId = '';

  it('books the first float as an owner -> drawer transfer', async () => {
    const hint = await drawers.openingHint(owner(), branchId);
    expect(hint.keptAmount).toBe(0);
    expect((await drawers.today(owner(), branchId)).state).toBe('NOT_OPENED');
    const opened = await drawers.open(owner(), {
      branchId,
      staffId: cashierId,
      openingAmount: 1_000_000,
    });
    firstId = opened.id;
    const today = await drawers.today(owner(), branchId);
    expect(today).toMatchObject({
      state: 'OPEN',
      sessionId: firstId,
      overdue: false,
    });
    expect(today.state === 'OPEN' && today.holder.id).toBe(cashierId);
    // Nhân viên chi nhánh chưa từng giữ két: biết két đang mở và ai giữ, không thấy phiên (số tiền).
    const bystander = await drawers.today(
      {
        ...cashier(),
        userId: randomUUID(),
        permissions: new Set(['cash_drawers:read_own']),
      },
      branchId,
    );
    expect(bystander).toMatchObject({ state: 'OPEN', session: null });
    expect(await rowsOf(firstId)).toEqual([
      ['FUND_TRANSFER_IN', 'DRAWER', 'INCOME', 1_000_000],
      ['FUND_TRANSFER_OUT', 'OWNER', 'EXPENSE', 1_000_000],
    ]);
  });

  it('closes 50k short and books the shortage and the owner taking 4.45m', async () => {
    // Thu ngân nhận két với đúng tiền đầu ca, rồi bán trong ca của mình.
    await drawers.submitShiftLog(cashier(), firstId, {
      type: 'START',
      amount: 1_000_000,
    });
    await cash('UNALLOCATED_RECEIPT', 'INCOME', 5_000_000);
    await cash('SUPPLIER_PAYMENT', 'EXPENSE', 500_000);

    await expect(
      drawers.finalize(owner(), firstId, {
        finalAmount: 100,
        withdrawAmount: 101,
      }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.CASH_DRAWER_WITHDRAW_EXCEEDS_COUNT },
    });

    const closed = await closeDay(firstId, 5_450_000, 4_450_000);

    // Đã chốt hôm nay: màn Hôm nay phải biết, và mở lại bị từ chối bằng mã riêng.
    const today = await drawers.today(owner(), branchId);
    expect(today).toMatchObject({
      state: 'CLOSED_TODAY',
      sessionId: firstId,
    });
    expect(today.state === 'CLOSED_TODAY' && today.closedBy?.id).toBe(ownerId);
    expect(today.state === 'CLOSED_TODAY' && today.session?.id).toBe(firstId);
    await expect(
      drawers.open(owner(), {
        branchId,
        staffId: cashierId,
        openingAmount: 1_000_000,
      }),
    ).rejects.toMatchObject({
      response: {
        code: ErrorCode.CASH_DRAWER_CLOSED_TODAY,
        sessionId: firstId,
      },
    });
    expect(closed.finalLog).toMatchObject({
      amount: 5_450_000,
      withdrawnAmount: 4_450_000,
      keptAmount: 1_000_000,
    });
    expect(await rowsOf(firstId)).toEqual([
      ['FUND_TRANSFER_IN', 'DRAWER', 'INCOME', 1_000_000],
      ['FUND_TRANSFER_OUT', 'OWNER', 'EXPENSE', 1_000_000],
      ['DRAWER_SHORTAGE', 'DRAWER', 'EXPENSE', 50_000],
      ['FUND_TRANSFER_IN', 'OWNER', 'INCOME', 4_450_000],
      ['FUND_TRANSFER_OUT', 'DRAWER', 'EXPENSE', 4_450_000],
    ]);

    // Đối soát bỏ qua dòng két tự ghi: số sổ vẫn là 1tr + 5tr - 500k.
    const recon = await drawers.reconcile(owner(), firstId);
    expect(recon.expectedClosing).toBe(5_500_000);
    expect(recon.variance).toBe(-50_000);
  });

  it('reports the day: transfers out of the totals, fund balances right', async () => {
    const report = await stats.getCashflow(
      owner(),
      Object.assign(new CashflowQueryDto(), { branchId }),
    );
    expect(report.income).toBe(5_000_000);
    expect(report.expense).toBe(550_000);
    expect(report.net).toBe(4_450_000);
    expect(report.transferred).toBe(5_450_000);
    expect(report.byCategory.map((r) => r.category).sort()).toEqual(
      ['DRAWER_SHORTAGE', 'SUPPLIER_PAYMENT', 'UNALLOCATED_RECEIPT'].sort(),
    );
    const fund = (name: string) =>
      report.byFund.find((row) => row.fund === name);
    expect(fund('DRAWER')).toMatchObject({
      income: 5_000_000,
      expense: 550_000,
      transferIn: 1_000_000,
      transferOut: 4_450_000,
      net: 1_000_000,
    });
    expect(fund('OWNER')).toMatchObject({
      income: 0,
      expense: 0,
      transferIn: 4_450_000,
      transferOut: 1_000_000,
      net: 3_450_000,
    });
  });

  it('lists the day in the history report, with what the owner took and what stayed', async () => {
    const query = Object.assign(new QueryCashVarianceDto(), {
      branchId,
      page: 1,
      limit: 20,
    });
    const report = await drawers.report(owner(), query);
    expect(report.data).toHaveLength(1);
    expect(report.data[0]).toMatchObject({
      sessionId: firstId,
      expectedClosing: 5_500_000,
      countedClosing: 5_450_000,
      variance: -50_000,
      withdrawnAmount: 4_450_000,
      keptAmount: 1_000_000,
    });
    expect(report.totals).toMatchObject({
      sessions: 1,
      shortfall: -50_000,
      shortfallSessions: 1,
      withdrawn: 4_450_000,
      overdueSessions: 0,
    });

    const file = await drawers.exportReport(owner(), query);
    expect(file.filename).toMatch(
      /^lich-su-ket_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.xlsx$/,
    );
    // Một file xlsx là zip: bắt đầu bằng "PK".
    expect(file.buffer.subarray(0, 2).toString()).toBe('PK');
  });

  it('puts the shortage on the cashier who held the drawer', async () => {
    const query = Object.assign(new QueryCashVarianceDto(), { branchId });
    const report = await drawers.cashierReport(owner(), query);
    expect(report.data).toHaveLength(1);
    expect(report.data[0]).toMatchObject({
      staffId: cashierId,
      shifts: 1,
      sessions: 1,
      cashIn: 5_000_000,
      cashOut: 500_000,
      variance: -50_000,
      shortShifts: 1,
      shortfall: -50_000,
    });
    // Quản lý đếm chốt đúng bằng số thu ngân trả: không có lệch nào không gán được.
    expect(report.unattributed).toEqual([]);

    // Thu ngân chỉ có read_own: chỉ thấy dòng của mình, không thấy khoản lệch không gán.
    const own = await drawers.cashierReport(
      { ...cashier(), permissions: new Set(['cash_drawers:read_own']) },
      query,
    );
    expect(own.data.map((r) => r.staffId)).toEqual([cashierId]);
    expect(own.unattributed).toEqual([]);
  });

  it('books an overnight shortage when the next day opens with less than was left', async () => {
    // Chuyển phiên đầu sang hôm qua để hôm nay mở được phiên mới.
    await prisma.cashDrawerSession.update({
      where: { id: firstId },
      data: { businessDate: new Date(Date.now() - 2 * 86_400_000) },
    });
    const hint = await drawers.openingHint(owner(), branchId);
    expect(hint.keptAmount).toBe(1_000_000);
    expect(hint.previousSession?.id).toBe(firstId);

    const next = await drawers.open(owner(), {
      branchId,
      staffId: cashierId,
      openingAmount: 900_000,
    });
    expect(await rowsOf(next.id)).toEqual([
      ['DRAWER_SHORTAGE', 'DRAWER', 'EXPENSE', 100_000],
    ]);
    // Phiên đã chốt hôm trước không còn chặn: hôm nay là phiên mới đang mở.
    expect(await drawers.today(owner(), branchId)).toMatchObject({
      state: 'OPEN',
      sessionId: next.id,
    });

    // Số dư quỹ Két trên sổ từ đầu tới giờ = tiền đang nằm trong két.
    const drawer = await prisma.cashFlow.findMany({
      where: { tenantId, fund: 'DRAWER' },
      select: { flowType: true, amount: true },
    });
    const balance = drawer.reduce(
      (sum, r) => sum + (r.flowType === 'INCOME' ? 1 : -1) * Number(r.amount),
      0,
    );
    expect(balance).toBe(900_000);
  });

  it('reopens a drawer closed by mistake today and books the second close afresh', async () => {
    const today = await drawers.today(owner(), branchId);
    expect(today.state).toBe('OPEN');
    const nextId = today.state === 'OPEN' ? today.sessionId : '';

    // Ca đầu: nhận 900k, bán 100k, trả 1tr; quản lý đếm nhầm 950k và rút 500k.
    await drawers.submitShiftLog(cashier(), nextId, {
      type: 'START',
      amount: 900_000,
    });
    await cash('UNALLOCATED_RECEIPT', 'INCOME', 100_000);
    await closeDay(nextId, 1_000_000, 0);
    // closeDay chốt bằng số trả; chốt nhầm: mở lại ngay rồi chốt lần nữa với số sai để có dòng thiếu + rút.
    await drawers.reopen(owner(), nextId, {
      staffId: cashierId,
      reason: 'test',
    });
    await drawers.submitShiftLog(cashier(), nextId, {
      type: 'START',
      amount: 1_000_000,
    });
    await drawers.submitShiftLog(cashier(), nextId, {
      type: 'END',
      amount: 1_000_000,
    });
    await drawers.finalize(owner(), nextId, {
      finalAmount: 950_000,
      withdrawAmount: 500_000,
    });
    const closingCategories = async () =>
      (await rowsOf(nextId)).map((r) => r[0]);
    expect(await closingCategories()).toEqual([
      'DRAWER_SHORTAGE', // mở két: để lại 1tr, đếm 900k (bài trước)
      'DRAWER_SHORTAGE', // chốt nhầm: sổ 1tr, đếm 950k
      'FUND_TRANSFER_IN',
      'FUND_TRANSFER_OUT',
    ]);

    // Mở lại: phiên OPEN, kết quả chốt và dòng sổ lúc chốt biến mất, dòng lúc mở két còn.
    const reopened = await drawers.reopen(owner(), nextId, {
      staffId: cashierId,
      reason: 'Đếm nhầm, chưa hết ca',
    });
    expect(reopened).toMatchObject({
      status: 'OPEN',
      finalLog: null,
      closedAt: null,
      reopenCount: 2,
      lastReopenReason: 'Đếm nhầm, chưa hết ca',
    });
    expect(reopened.lastReopenedBy?.id).toBe(ownerId);
    expect(await rowsOf(nextId)).toEqual([
      ['DRAWER_SHORTAGE', 'DRAWER', 'EXPENSE', 100_000],
    ]);
    expect((await drawers.today(owner(), branchId)).state).toBe('OPEN');

    // Lần trả trước khi mở lại không còn tính: chốt ngay bị từ chối, phải nhận két rồi trả lại.
    await expect(
      drawers.finalize(owner(), nextId, { finalAmount: 1_000_000 }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.CASH_DRAWER_END_LOG_REQUIRED },
    });
    await drawers.submitShiftLog(cashier(), nextId, {
      type: 'START',
      amount: 1_000_000,
    });
    await cash('UNALLOCATED_RECEIPT', 'INCOME', 200_000);
    const closed = await closeDay(nextId, 1_200_000, 700_000);
    expect(closed.finalLog).toMatchObject({
      amount: 1_200_000,
      withdrawnAmount: 700_000,
      keptAmount: 500_000,
    });
    // Chốt lại khớp sổ (900k + 300k): không có dòng thừa / thiếu mới, chỉ chuyển quỹ 700k.
    expect(await rowsOf(nextId)).toEqual([
      ['DRAWER_SHORTAGE', 'DRAWER', 'EXPENSE', 100_000],
      ['FUND_TRANSFER_IN', 'OWNER', 'INCOME', 700_000],
      ['FUND_TRANSFER_OUT', 'DRAWER', 'EXPENSE', 700_000],
    ]);
    const recon = await drawers.reconcile(owner(), nextId);
    expect(recon.variance).toBe(0);

    // Số dư quỹ Két = tiền để lại.
    const drawer = await prisma.cashFlow.findMany({
      where: { tenantId, fund: 'DRAWER' },
      select: { flowType: true, amount: true },
    });
    expect(
      drawer.reduce(
        (sum, r) => sum + (r.flowType === 'INCOME' ? 1 : -1) * Number(r.amount),
        0,
      ),
    ).toBe(500_000);

    // Không mở lại được phiên của ngày đã qua, hay phiên đang mở.
    await expect(
      drawers.reopen(owner(), firstId, { staffId: cashierId, reason: 'x' }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.CASH_DRAWER_REOPEN_NOT_TODAY },
    });
    await drawers.reopen(owner(), nextId, { staffId: cashierId, reason: 'x' });
    await expect(
      drawers.reopen(owner(), nextId, { staffId: cashierId, reason: 'x' }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.CASH_DRAWER_NOT_CLOSED },
    });
  });
});
