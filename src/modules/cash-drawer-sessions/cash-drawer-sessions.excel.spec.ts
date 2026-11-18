import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { CashDrawerSessionService } from './cash-drawer-sessions.service';

const bodyOf = (error: unknown) =>
  (error as ConflictException).getResponse() as {
    code: string;
    message: string;
  };

async function expectRejects(
  run: Promise<unknown>,
  type: new (...args: never[]) => Error,
  code: string,
  message?: string,
) {
  let caught: unknown;
  try {
    await run;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(type);
  expect(bodyOf(caught).code).toBe(code);
  if (message) expect(bodyOf(caught).message).toBe(message);
}

// Excel sheet "CashDrawer" - open, submitShiftLog, finalize (UTC017-UTC031).
describe('Excel sheet CashDrawer - CashDrawerSessionService', () => {
  let prisma: any;
  let tx: any;
  let service: CashDrawerSessionService;

  const owner = {
    userId: 'U9',
    tenantId: 'T1',
    systemRole: 'TENANT_OWNER',
    branchId: null,
    permissions: new Set(),
  } as never;
  const cashier = {
    userId: 'S1',
    tenantId: 'T1',
    systemRole: 'STAFF',
    branchId: 'BR-01',
    permissions: new Set(),
    shiftSupervision: null,
  } as never;

  const session = (over: Record<string, unknown> = {}) => ({
    id: 'D1',
    tenantId: 'T1',
    branchId: 'BR-01',
    status: 'OPEN',
    businessDate: '2026-11-10',
    openingAmount: 500000,
    finalLogAmount: null,
    finalLogManagerId: null,
    finalLogNote: null,
    finalLogManager: null,
    openedBy: null,
    currentStaff: null,
    currentStaffId: 'S1',
    updatedAt: new Date('2026-11-10T01:00:00Z'),
    shiftLogs: [],
    ...over,
  });
  const log = (
    type: string,
    staffId: string,
    nextStaffId: string | null = null,
  ) => ({
    type,
    staffId,
    nextStaffId,
    amount: 1,
    staff: null,
    nextStaff: null,
  });

  beforeEach(() => {
    tx = {
      cashDrawerSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      cashDrawerShiftLog: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      branch: { findFirst: jest.fn().mockResolvedValue({ id: 'BR-01' }) },
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'S1' }) },
      cashDrawerSession: {
        create: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn().mockImplementation((fn) => fn(tx)),
    };
    service = new CashDrawerSessionService(prisma);
  });

  describe('open', () => {
    const dto = {
      branchId: 'BR-01',
      staffId: 'S1',
      openingAmount: 500000,
    } as never;
    it('UTC017: opens an OPEN session held by the chosen cashier', async () => {
      prisma.cashDrawerSession.create.mockResolvedValue(session());
      const res = await service.open(owner, dto);
      expect(prisma.cashDrawerSession.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({
          tenantId: 'T1',
          branchId: 'BR-01',
          openingAmount: 500000,
          openedById: 'U9',
          currentStaffId: 'S1',
          status: 'OPEN',
        }),
      );
      expect(res.openingAmount).toBe(500000);
      expect(res.status).toBe('OPEN');
    });
    it('UTC018: a branch that already has its drawer session is refused', async () => {
      prisma.cashDrawerSession.create.mockRejectedValue({ code: 'P2002' });
      await expectRejects(
        service.open(owner, dto),
        ConflictException,
        'CASH_DRAWER_ALREADY_OPEN',
        'This branch already has a drawer session for today, or one is still open',
      );
    });
    it('UTC019: any other database error is rethrown unchanged', async () => {
      const failure = new Error('connection lost');
      prisma.cashDrawerSession.create.mockRejectedValue(failure);
      await expect(service.open(owner, dto)).rejects.toBe(failure);
    });
  });

  describe('submitShiftLog', () => {
    const given = (over: Record<string, unknown>) =>
      prisma.cashDrawerSession.findFirst.mockResolvedValue(session(over));
    const submit = (dto: Record<string, unknown>) =>
      service.submitShiftLog(cashier, 'D1', dto as never);

    it('UTC020: the first START log of a session is recorded', async () => {
      given({ shiftLogs: [] });
      await submit({ type: 'START', amount: 500000 });
      expect(tx.cashDrawerSession.updateMany.mock.calls[0][0].data).toEqual({
        currentStaffId: 'S1',
      });
      expect(tx.cashDrawerShiftLog.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({
          sessionId: 'D1',
          type: 'START',
          staffId: 'S1',
          amount: 500000,
        }),
      );
    });
    it('UTC021: a closed session takes no log', async () => {
      given({ status: 'CLOSED' });
      await expectRejects(
        submit({ type: 'END' }),
        ConflictException,
        'CASH_DRAWER_CLOSED',
        'This drawer session is closed',
      );
    });
    it('UTC022: only the cashier holding the drawer may file a log', async () => {
      given({ currentStaffId: 'S2' });
      await expectRejects(
        submit({ type: 'END' }),
        ForbiddenException,
        'CASH_DRAWER_NOT_HOLDER',
        'Only the cashier currently holding the drawer can file a shift log',
      );
    });
    it('UTC023: nextStaffId is only allowed on an END log', async () => {
      given({});
      await expectRejects(
        submit({ type: 'START', nextStaffId: 'S2' }),
        BadRequestException,
        'SHIFT_LOG_NEXT_STAFF_INVALID',
        'nextStaffId is only valid on an END shift log',
      );
    });
    it('UTC024: a second START without a handover is refused', async () => {
      given({ shiftLogs: [log('START', 'S1')] });
      await expectRejects(
        submit({ type: 'START' }),
        ConflictException,
        'SHIFT_LOG_HANDOVER_INVALID',
        'This shift has already started, or the drawer was not handed over to you',
      );
    });
    it('UTC025: an END log needs a START log of the same cashier first', async () => {
      given({ shiftLogs: [] });
      await expectRejects(
        submit({ type: 'END' }),
        ConflictException,
        'SHIFT_LOG_START_REQUIRED',
        'A START shift log is required first',
      );
    });
    it('UTC026: the next cashier cannot be the cashier themself', async () => {
      given({ shiftLogs: [log('START', 'S1')] });
      await expectRejects(
        submit({ type: 'END', nextStaffId: 'S1' }),
        BadRequestException,
        'SHIFT_LOG_NEXT_STAFF_SELF',
        'The next cashier must be somebody else',
      );
    });
    it('UTC027: a concurrent change to the session is refused and no log is written', async () => {
      given({ shiftLogs: [log('START', 'S1')] });
      tx.cashDrawerSession.updateMany.mockResolvedValue({ count: 0 });
      await expectRejects(
        submit({ type: 'END', amount: 800000 }),
        ConflictException,
        'CASH_DRAWER_CONFLICT',
        'The drawer session has just changed, please reload and try again',
      );
      expect(tx.cashDrawerShiftLog.create).not.toHaveBeenCalled();
    });
  });

  describe('finalize', () => {
    const given = (over: Record<string, unknown>) =>
      prisma.cashDrawerSession.findFirst.mockResolvedValue(session(over));
    const finalize = () =>
      service.finalize(owner, 'D1', {
        finalAmount: 900000,
        note: 'ok',
      } as never);

    it('UTC028: a closed session cannot be finalized again', async () => {
      given({ status: 'CLOSED' });
      await expectRejects(
        finalize(),
        ConflictException,
        'CASH_DRAWER_CLOSED',
        'This drawer session is closed',
      );
    });
    it('UTC029: the holder must have filed the final END log first', async () => {
      given({ shiftLogs: [log('START', 'S1')] });
      await expectRejects(
        finalize(),
        ConflictException,
        'CASH_DRAWER_END_LOG_REQUIRED',
        'The cashier holding the drawer must file the final END log before it can be closed',
      );
      expect(prisma.cashDrawerSession.updateMany).not.toHaveBeenCalled();
    });
    it('UTC030: a session closed by another request meanwhile is refused', async () => {
      given({ shiftLogs: [log('START', 'S1'), log('END', 'S1', null)] });
      prisma.cashDrawerSession.updateMany.mockResolvedValue({ count: 0 });
      await expectRejects(
        finalize(),
        ConflictException,
        'CASH_DRAWER_CONFLICT',
        'The drawer session has just changed, please reload and try again',
      );
    });
    it('UTC031: a session ended by its holder is closed with the counted amount', async () => {
      prisma.cashDrawerSession.findFirst
        .mockResolvedValueOnce(
          session({ shiftLogs: [log('START', 'S1'), log('END', 'S1', null)] }),
        )
        .mockResolvedValueOnce(
          session({
            status: 'CLOSED',
            finalLogAmount: 900000,
            finalLogManagerId: 'U9',
            finalLogNote: 'ok',
            shiftLogs: [log('START', 'S1'), log('END', 'S1', null)],
          }),
        );
      const res = await finalize();
      expect(prisma.cashDrawerSession.updateMany.mock.calls[0][0].data).toEqual(
        {
          status: 'CLOSED',
          finalLogAmount: 900000,
          finalLogManagerId: 'U9',
          finalLogNote: 'ok',
        },
      );
      expect(res.status).toBe('CLOSED');
    });
  });
});
