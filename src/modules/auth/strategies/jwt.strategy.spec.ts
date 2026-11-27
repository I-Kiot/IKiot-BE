import { JwtStrategy } from './jwt.strategy';

/** Quyền tự cấp `production:deliver` cho nhân viên gắn xưởng. */
describe('JwtStrategy - workshop staff permissions', () => {
  const saved = process.env.ACCESS_TOKEN_SECRET;
  beforeAll(() => {
    process.env.ACCESS_TOKEN_SECRET = 'test-secret';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.ACCESS_TOKEN_SECRET;
    else process.env.ACCESS_TOKEN_SECRET = saved;
  });

  function strategyFor(user: Record<string, unknown>) {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
    };
    const shiftSupervisor = { resolve: jest.fn().mockResolvedValue(null) };
    return new JwtStrategy(prisma as never, shiftSupervisor as never);
  }

  const staff = (overrides: Record<string, unknown> = {}) => ({
    id: 'U1',
    tenantId: 'T1',
    systemRole: 'STAFF',
    status: 'ACTIVE',
    roleId: 'R1',
    role: { permissions: [{ resource: 'orders', action: 'read' }] },
    location: null,
    workshopId: null,
    profileFirstName: null,
    profileLastName: null,
    email: null,
    phoneNumber: '0900000000',
    ...overrides,
  });

  it('grants production:deliver to a staff account linked to a workshop', async () => {
    const user = await strategyFor(staff({ workshopId: 'W1' })).validate({
      sub: 'U1',
    });
    expect(user.permissions.has('production:deliver')).toBe(true);
    expect(user.permissions.has('orders:read')).toBe(true);
  });

  it('does not grant it to staff without a workshop', async () => {
    const user = await strategyFor(staff()).validate({ sub: 'U1' });
    expect(user.permissions.has('production:deliver')).toBe(false);
  });

  it('does not grant it to a non-staff account that somehow has a workshopId', async () => {
    const user = await strategyFor(
      staff({ systemRole: 'CUSTOMER', role: null, workshopId: 'W1' }),
    ).validate({ sub: 'U1' });
    expect(user.permissions.has('production:deliver')).toBe(false);
  });
});
