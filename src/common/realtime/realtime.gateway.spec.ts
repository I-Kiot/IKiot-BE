import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../../prisma/prisma.service';
import { RealtimeGateway } from './realtime.gateway';

function setup() {
  const emit = jest.fn();
  const except = jest.fn(() => ({ emit }));
  const to = jest.fn(() => ({ emit, except }));
  const gateway = new RealtimeGateway({} as JwtService, {} as PrismaService);
  Object.assign(gateway, { server: { to } });
  return { gateway, to, emit, except };
}

describe('RealtimeGateway.emitToRoomExcept', () => {
  it('excludes the socket only when an id is given', () => {
    const { gateway, to, except, emit } = setup();
    gateway.emitToRoomExcept('tenant:T1', 'abc', 'entity:changed', { a: 1 });
    expect(to).toHaveBeenCalledWith('tenant:T1');
    expect(except).toHaveBeenCalledWith('abc');
    expect(emit).toHaveBeenCalledWith('entity:changed', { a: 1 });
  });

  it('emits to the whole room when there is nothing to exclude', () => {
    const { gateway, except, emit } = setup();
    gateway.emitToRoomExcept('tenant:T1', null, 'entity:changed', { a: 1 });
    expect(except).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('entity:changed', { a: 1 });
  });

  it('does not touch emitToRoom', () => {
    const { gateway, except, emit } = setup();
    gateway.emitToRoom('tenant:T1', 'order:paid', { b: 2 });
    expect(except).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('order:paid', { b: 2 });
  });
});
