import { ChangeAction, ChangeResource } from '../constants/change-feed';
import { actorOf, buildEntityChanged, publishChange } from './change-feed';
import type { ChangeSpec, PublishChangeInput } from './change-feed.types';
import type { AuthUser } from '../types/auth-user.type';

const spec: ChangeSpec = {
  action: ChangeAction.ORDER_PACKED,
  subject: ChangeResource.ORDERS,
  also: [ChangeResource.INVENTORIES],
  summary: ({ actor, code }) => `${actor} vừa đóng gói ${code}`,
};

const input = (over: Partial<PublishChangeInput> = {}): PublishChangeInput => ({
  tenantId: 'T1',
  spec,
  target: { subjectId: 'o1', code: 'DH0012' },
  actor: { source: 'USER', id: 'u1', name: 'Nguyễn Văn A' },
  ...over,
});

describe('buildEntityChanged', () => {
  const now = new Date('2026-11-19T03:00:00.000Z');

  it('puts the subject first and lists `also` with empty ids', () => {
    const payload = buildEntityChanged(input(), now);
    expect(payload.changes).toEqual([
      { resource: 'orders', ids: ['o1'] },
      { resource: 'inventories', ids: [] },
    ]);
    expect(payload.subject).toEqual({
      resource: 'orders',
      id: 'o1',
      code: 'DH0012',
    });
    expect(payload.summary).toBe('Nguyễn Văn A vừa đóng gói DH0012');
    expect(payload.at).toBe(now.toISOString());
    expect(payload.quiet).toBe(false);
  });

  it('merges related ids, de-duplicates and drops nulls', () => {
    const payload = buildEntityChanged(
      input({
        target: {
          subjectId: 'o1',
          code: 'DH0012',
          related: {
            orders: ['o1', 'o2', null, undefined, 'o2'],
            fulfillments: ['f1'],
          },
        },
      }),
      now,
    );
    expect(payload.changes).toEqual([
      { resource: 'orders', ids: ['o1', 'o2'] },
      { resource: 'inventories', ids: [] },
      { resource: 'fulfillments', ids: ['f1'] },
    ]);
  });

  it('names SYSTEM and WEBHOOK actors and leaves their id null', () => {
    const system = buildEntityChanged(input({ actor: { source: 'SYSTEM' } }));
    expect(system.actor).toEqual({ id: null, name: 'Hệ thống' });
    expect(system.source).toBe('SYSTEM');
    const webhook = buildEntityChanged(input({ actor: { source: 'WEBHOOK' } }));
    expect(webhook.actor).toEqual({ id: null, name: 'SePay' });
    expect(webhook.summary).toBe('SePay vừa đóng gói DH0012');
  });

  it('carries quiet and allows a batch event without a subject', () => {
    const payload = buildEntityChanged(
      input({
        spec: { ...spec, quiet: true },
        target: { subjectId: null, code: null, related: { orders: ['o1'] } },
      }),
    );
    expect(payload.quiet).toBe(true);
    expect(payload.subject).toBeNull();
    expect(payload.changes[0]).toEqual({ resource: 'orders', ids: ['o1'] });
  });

  it('gives every event its own id', () => {
    const a = buildEntityChanged(input());
    const b = buildEntityChanged(input());
    expect(a.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.eventId).not.toBe(b.eventId);
  });
});

describe('publishChange', () => {
  it('emits to the tenant room except the originating socket', () => {
    const gateway = { emitToRoomExcept: jest.fn() };
    publishChange(gateway, input({ exceptSocketId: 'abc' }));
    expect(gateway.emitToRoomExcept).toHaveBeenCalledWith(
      'tenant:T1',
      'abc',
      'entity:changed',
      expect.objectContaining({ action: 'ORDER_PACKED' }),
    );
  });

  it('passes null when no socket is excluded', () => {
    const gateway = {
      emitToRoomExcept: jest.fn<
        void,
        [string, string | null, string, unknown]
      >(),
    };
    publishChange(gateway, input());
    expect(gateway.emitToRoomExcept.mock.calls[0][1]).toBeNull();
  });

  it('swallows a throwing gateway', () => {
    const gateway = {
      emitToRoomExcept: jest.fn(() => {
        throw new Error('boom');
      }),
    };
    const logger = { error: jest.fn() };
    expect(() => publishChange(gateway, input(), logger)).not.toThrow();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('actorOf', () => {
  const base = { userId: 'u1', phoneNumber: '0900000000' } as AuthUser;
  it('prefers fullName, then displayName, then the phone number', () => {
    expect(
      actorOf({
        ...base,
        fullName: 'Nguyễn Văn A',
        displayName: 'Văn A Nguyễn',
      }),
    ).toEqual({ source: 'USER', id: 'u1', name: 'Nguyễn Văn A' });
    expect(actorOf({ ...base, fullName: null, displayName: 'X' }).source).toBe(
      'USER',
    );
    expect(actorOf({ ...base, displayName: null })).toMatchObject({
      name: '0900000000',
    });
  });
});
