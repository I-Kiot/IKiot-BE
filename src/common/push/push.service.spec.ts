import { PushService, chunk, deadTokensIn } from './push.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { FirebaseService } from '../firebase/firebase.service';

/** The multicast half of firebase-admin's overloaded argument - the only shape we send. */
interface SendArgs {
  tokens: string[];
  notification: { title: string; body: string };
  data: Record<string, string>;
  webpush?: { fcmOptions: { link: string } };
}

const NOT_REGISTERED = 'messaging/registration-token-not-registered';
const INVALID = 'messaging/invalid-registration-token';

/** A batch response where every token succeeded. */
const allOk = (n: number) => ({
  successCount: n,
  failureCount: 0,
  responses: Array.from({ length: n }, () => ({ success: true })),
});

/** The message handed to FCM on the nth call, typed - `mock.calls` is `any[][]`. */
function sentMessage(send: jest.Mock, index = 0): SendArgs {
  const calls = send.mock.calls as unknown as [SendArgs][];
  return calls[index][0];
}

function makeService(options: {
  configured?: boolean;
  tokens?: string[];
  send?: jest.Mock;
}) {
  const { configured = true, tokens = [], send = jest.fn() } = options;

  const findMany = jest
    .fn()
    .mockResolvedValue(tokens.map((token) => ({ token })));
  const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
  const prisma = {
    userFcmToken: { findMany, deleteMany },
  } as unknown as PrismaService;

  const firebase = {
    messaging: () => (configured ? { sendEachForMulticast: send } : null),
  } as unknown as FirebaseService;

  return {
    service: new PushService(prisma, firebase),
    findMany,
    deleteMany,
    send,
  };
}

describe('chunk', () => {
  it('splits into runs of at most the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('leaves a short list as one batch, and an empty one as none', () => {
    expect(chunk([1, 2], 500)).toEqual([[1, 2]]);
    expect(chunk([], 500)).toEqual([]);
  });
});

// Which failures delete a row is the one decision here that loses data if it is wrong.
describe('deadTokensIn', () => {
  it('picks out only the two permanent-failure codes', () => {
    const tokens = ['ok', 'gone', 'malformed', 'ratelimited'];
    const responses = [
      { success: true },
      { success: false, error: { code: NOT_REGISTERED } },
      { success: false, error: { code: INVALID } },
      { success: false, error: { code: 'messaging/internal-error' } },
    ] as Parameters<typeof deadTokensIn>[1];

    expect(deadTokensIn(tokens, responses)).toEqual(['gone', 'malformed']);
  });

  it('keeps a token whose response is missing entirely', () => {
    expect(deadTokensIn(['a'], [])).toEqual([]);
  });

  // What FCM v1 actually returns for a junk token - the legacy codes never fire for this case.
  it('treats invalid-argument as dead when the message blames the token', () => {
    const responses = [
      {
        success: false,
        error: {
          code: 'messaging/invalid-argument',
          message:
            'The registration token is not a valid FCM registration token',
        },
      },
    ] as Parameters<typeof deadTokensIn>[1];

    expect(deadTokensIn(['junk'], responses)).toEqual(['junk']);
  });

  // One bad payload goes to the whole batch, so blanket-pruning on invalid-argument would unregister every device at once.
  it('keeps tokens when invalid-argument is about the payload', () => {
    const responses = [
      {
        success: false,
        error: {
          code: 'messaging/invalid-argument',
          message: 'Invalid value at "message.data" (TYPE_STRING), 42',
        },
      },
      {
        success: false,
        error: {
          code: 'messaging/invalid-argument',
          message: 'Invalid value at "message.data" (TYPE_STRING), 42',
        },
      },
    ] as Parameters<typeof deadTokensIn>[1];

    expect(deadTokensIn(['good1', 'good2'], responses)).toEqual([]);
  });

  it('keeps a token when invalid-argument carries no message at all', () => {
    const responses = [
      { success: false, error: { code: 'messaging/invalid-argument' } },
    ] as Parameters<typeof deadTokensIn>[1];

    expect(deadTokensIn(['unknown'], responses)).toEqual([]);
  });
});

describe('PushService.sendToUsers', () => {
  it('does nothing when Firebase has no credentials', async () => {
    const { service, findMany } = makeService({ configured: false });

    await expect(
      service.sendToUsers(['u1'], { title: 'T', body: 'B' }),
    ).resolves.toEqual({ sent: 0, failed: 0 });
    // Not even a query - a deployment with no Firebase should cost nothing per notification.
    expect(findMany).not.toHaveBeenCalled();
  });

  it('does nothing when the recipient list is empty or all null', async () => {
    const { service, findMany } = makeService({});

    await expect(
      service.sendToUsers([null, undefined], { title: 'T', body: 'B' }),
    ).resolves.toEqual({ sent: 0, failed: 0 });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('deduplicates recipients before looking up devices', async () => {
    const { service, findMany } = makeService({});
    await service.sendToUsers(['u1', 'u1', 'u2'], { title: 'T', body: 'B' });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: { in: ['u1', 'u2'] } } }),
    );
  });

  it('does not call FCM when nobody has a registered device', async () => {
    const { service, send } = makeService({ tokens: [] });

    await expect(
      service.sendToUsers(['u1'], { title: 'T', body: 'B' }),
    ).resolves.toEqual({ sent: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends the notification, data and web link in one call', async () => {
    const send = jest.fn().mockResolvedValue(allOk(1));
    const { service } = makeService({ tokens: ['t1'], send });

    await service.sendToUsers(['u1'], {
      title: 'Phiếu chuyển kho',
      body: 'Đã được duyệt',
      link: '/stock-movements/abc',
      data: { type: 'STOCK_MOVEMENT', referenceId: 'abc' },
    });

    expect(send).toHaveBeenCalledWith({
      tokens: ['t1'],
      notification: { title: 'Phiếu chuyển kho', body: 'Đã được duyệt' },
      data: { type: 'STOCK_MOVEMENT', referenceId: 'abc' },
      webpush: { fcmOptions: { link: '/stock-movements/abc' } },
    });
  });

  it('omits webpush entirely when there is no link', async () => {
    const send = jest.fn().mockResolvedValue(allOk(1));
    const { service } = makeService({ tokens: ['t1'], send });

    await service.sendToUsers(['u1'], { title: 'T', body: 'B' });

    expect(sentMessage(send).webpush).toBeUndefined();
  });

  // FCM rejects a non-string data value, and the literal "null" would have the client try to open it.
  it('drops null/undefined data values and stringifies the rest', async () => {
    const send = jest.fn().mockResolvedValue(allOk(1));
    const { service } = makeService({ tokens: ['t1'], send });

    await service.sendToUsers(['u1'], {
      title: 'T',
      body: 'B',
      data: { type: 'ORDER', referenceId: undefined, extra: null },
    });

    expect(sentMessage(send).data).toEqual({ type: 'ORDER' });
  });

  it('splits more than 500 tokens across batches and sums the counts', async () => {
    const tokens = Array.from({ length: 501 }, (_, i) => `t${i}`);
    const send = jest
      .fn()
      .mockResolvedValueOnce(allOk(500))
      .mockResolvedValueOnce(allOk(1));
    const { service } = makeService({ tokens, send });

    await expect(
      service.sendToUsers(['u1'], { title: 'T', body: 'B' }),
    ).resolves.toEqual({ sent: 501, failed: 0 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(sentMessage(send, 0).tokens).toHaveLength(500);
    expect(sentMessage(send, 1).tokens).toEqual(['t500']);
  });

  it('deletes the tokens FCM reports dead, and only those', async () => {
    const send = jest.fn().mockResolvedValue({
      successCount: 1,
      failureCount: 2,
      responses: [
        { success: true },
        { success: false, error: { code: NOT_REGISTERED } },
        { success: false, error: { code: 'messaging/server-unavailable' } },
      ],
    });
    const { service, deleteMany } = makeService({
      tokens: ['live', 'gone', 'flaky'],
      send,
    });

    await expect(
      service.sendToUsers(['u1'], { title: 'T', body: 'B' }),
    ).resolves.toEqual({ sent: 1, failed: 2 });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { token: { in: ['gone'] } },
    });
  });

  it('does not touch the table when nothing died', async () => {
    const send = jest.fn().mockResolvedValue(allOk(1));
    const { service, deleteMany } = makeService({ tokens: ['t1'], send });

    await service.sendToUsers(['u1'], { title: 'T', body: 'B' });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  // notify() runs after the business transaction has committed, so a throw here would error an operation that already succeeded.
  it('never throws when FCM rejects', async () => {
    const send = jest.fn().mockRejectedValue(new Error('FCM is down'));
    const { service } = makeService({ tokens: ['t1'], send });

    await expect(
      service.sendToUsers(['u1'], { title: 'T', body: 'B' }),
    ).resolves.toEqual({ sent: 0, failed: 0 });
  });

  it('never throws when the token lookup itself fails', async () => {
    const { service, findMany } = makeService({});
    findMany.mockRejectedValue(new Error('db down'));

    await expect(
      service.sendToUsers(['u1'], { title: 'T', body: 'B' }),
    ).resolves.toEqual({ sent: 0, failed: 0 });
  });
});
