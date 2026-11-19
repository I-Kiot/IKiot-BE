import { Reflector } from '@nestjs/core';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import { ChangeAction, ChangeResource } from '../constants/change-feed';
import { ChangeFeedInterceptor } from './change-feed.interceptor';
import type { ChangeFeedService } from './change-feed.service';
import type { ChangeSpec, PublishChangeInput } from './change-feed.types';
import { EMITS_CHANGE_KEY } from './emits-change.decorator';
import type { PrismaService } from '../../prisma/prisma.service';

const spec: ChangeSpec = {
  action: ChangeAction.ORDER_PACKED,
  subject: ChangeResource.ORDERS,
  summary: ({ actor, code }) => `${actor} vừa đóng gói ${code}`,
};

interface Setup {
  method?: string;
  user?: object | undefined;
  headers?: Record<string, unknown>;
  params?: Record<string, string>;
  metadata?: ChangeSpec | undefined;
}

function build(setup: Setup = {}) {
  const publish = jest.fn<void, [PublishChangeInput]>();
  const changeFeed = { publish } as unknown as ChangeFeedService;
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'get')
    .mockImplementation((key) =>
      key === EMITS_CHANGE_KEY
        ? 'metadata' in setup
          ? setup.metadata
          : spec
        : undefined,
    );
  const interceptor = new ChangeFeedInterceptor(
    reflector,
    changeFeed,
    {} as PrismaService,
  );
  const request = {
    method: setup.method ?? 'POST',
    user:
      'user' in setup
        ? setup.user
        : {
            userId: 'u1',
            tenantId: 'T1',
            fullName: 'Nguyễn Văn A',
            displayName: 'Văn A Nguyễn',
            phoneNumber: '0900000000',
          },
    headers: setup.headers ?? {},
    params: setup.params ?? { id: 'o1' },
  };
  const context = {
    getType: () => 'http',
    getHandler: () => () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const run = async (handler: CallHandler) => {
    const result = await firstValueFrom(
      interceptor.intercept(context, handler),
    );
    // `emit` is fire-and-forget: let the microtasks settle.
    await new Promise((resolve) => setImmediate(resolve));
    return result;
  };
  return { publish, run, interceptor, context };
}

const ok = (body: unknown): CallHandler => ({ handle: () => of(body) });

describe('ChangeFeedInterceptor', () => {
  it('does nothing without @EmitsChange metadata', async () => {
    const { publish, run } = build({ metadata: undefined });
    await run(ok({ id: 'o1' }));
    expect(publish).not.toHaveBeenCalled();
  });

  it('ignores GET handlers', async () => {
    const { publish, run } = build({ method: 'GET' });
    await run(ok({ id: 'o1' }));
    expect(publish).not.toHaveBeenCalled();
  });

  it('ignores a user without a tenant (ADMIN)', async () => {
    const { publish, run } = build({ user: { userId: 'a', tenantId: null } });
    await run(ok({ id: 'o1' }));
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes nothing and rethrows when the handler fails', async () => {
    const { publish, run } = build();
    await expect(
      run({ handle: () => throwError(() => new Error('conflict')) }),
    ).rejects.toThrow('conflict');
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes once on success with subject, code, actor and socket id', async () => {
    const { publish, run } = build({ headers: { 'x-socket-id': 'sock_1-A' } });
    const body = { id: 'o1', code: 'DH0012' };
    expect(await run(ok(body))).toBe(body);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      tenantId: 'T1',
      spec,
      target: { subjectId: 'o1', code: 'DH0012' },
      actor: { source: 'USER', id: 'u1', name: 'Nguyễn Văn A' },
      exceptSocketId: 'sock_1-A',
    });
  });

  it.each([[['a', 'b']], ['has space'], ['x'.repeat(65)], [undefined]])(
    'drops an invalid socket id header (%p)',
    async (header) => {
      const { publish, run } = build({ headers: { 'x-socket-id': header } });
      await run(ok({ id: 'o1' }));
      expect(publish.mock.calls[0][0].exceptSocketId).toBeNull();
    },
  );

  it('awaits an async extractor', async () => {
    const asyncSpec: ChangeSpec = {
      ...spec,
      extract: async () => {
        await Promise.resolve();
        return { subjectId: 'o9', code: 'DH0099' };
      },
    };
    const { publish, run } = build({ metadata: asyncSpec });
    await run(ok({}));
    expect(publish.mock.calls[0][0].target).toEqual({
      subjectId: 'o9',
      code: 'DH0099',
    });
  });

  it('warns and publishes nothing when the extractor finds no subject', async () => {
    const { publish, run, interceptor } = build({
      metadata: { ...spec, extract: () => null },
    });
    const warn = jest
      .spyOn(interceptor['logger'], 'warn')
      .mockImplementation(() => undefined);
    await run(ok({}));
    expect(publish).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('swallows extractor and publish failures and returns the identical body', async () => {
    const throwing = build({
      metadata: {
        ...spec,
        extract: () => {
          throw new Error('bad body');
        },
      },
    });
    jest
      .spyOn(throwing.interceptor['logger'], 'error')
      .mockImplementation(() => undefined);
    const body = { id: 'o1' };
    expect(await throwing.run(ok(body))).toBe(body);

    const failingPublish = build();
    failingPublish.publish.mockImplementation(() => {
      throw new Error('socket down');
    });
    jest
      .spyOn(failingPublish.interceptor['logger'], 'error')
      .mockImplementation(() => undefined);
    expect(await failingPublish.run(ok(body))).toBe(body);
  });
});
