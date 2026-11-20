import { randomUUID } from 'node:crypto';
import type { Logger } from '@nestjs/common';
import { ChangeResource, ENTITY_CHANGED_EVENT } from '../constants/change-feed';
import type { AuthUser } from '../types/auth-user.type';
import type { RealtimeGateway } from './realtime.gateway';
import type {
  ChangeActor,
  EntityChangedPayload,
  PublishChangeInput,
} from './change-feed.types';

const SYSTEM_NAME = 'Hệ thống';
const WEBHOOK_NAME = 'SePay';

/** Dựng payload từ spec + đối tượng bị chạm. Hàm thuần, không DI (như `order-events.ts`). */
export function buildEntityChanged(
  input: PublishChangeInput,
  now: Date = new Date(),
): EntityChangedPayload {
  const { spec, target, actor } = input;

  // Chủ thể đứng đầu, rồi `also`, rồi các bảng liên quan; trùng id và id rỗng bị bỏ.
  const byResource = new Map<ChangeResource, Set<string>>();
  const add = (
    resource: ChangeResource,
    ids: readonly (string | null | undefined)[] = [],
  ) => {
    const set = byResource.get(resource) ?? new Set<string>();
    for (const id of ids) if (id) set.add(id);
    byResource.set(resource, set);
  };
  add(spec.subject, [target.subjectId]);
  for (const resource of spec.also ?? []) add(resource);
  for (const resource of Object.values(ChangeResource)) {
    const related = target.related?.[resource];
    if (related) add(resource, related);
  }

  const actorName =
    actor.source === 'USER'
      ? actor.name
      : actor.source === 'SYSTEM'
        ? SYSTEM_NAME
        : WEBHOOK_NAME;

  return {
    eventId: randomUUID(),
    action: spec.action,
    changes: [...byResource].map(([resource, ids]) => ({
      resource,
      ids: [...ids],
    })),
    subject: target.subjectId
      ? { resource: spec.subject, id: target.subjectId, code: target.code }
      : null,
    actor: {
      id: actor.source === 'USER' ? actor.id : null,
      name: actorName,
    },
    source: actor.source,
    summary: spec.summary({ actor: actorName, code: target.code }),
    quiet: spec.quiet ?? false,
    at: now.toISOString(),
  };
}

/**
 * Phát một sự kiện thay đổi tới cả room tenant (trừ tab gây ra nó). Không bao giờ ném vào người gọi - cùng hợp đồng với thông báo: đây là kênh phụ, lỗi ở đây không được làm hỏng thao tác đã commit.
 * Nhận `Pick<RealtimeGateway, 'emitToRoomExcept'>` để service đã có sẵn `RealtimeGateway` (OrderService) gọi được mà không phải thêm phụ thuộc mới vào constructor.
 */
export function publishChange(
  gateway: Pick<RealtimeGateway, 'emitToRoomExcept'>,
  input: PublishChangeInput,
  logger?: Pick<Logger, 'error'>,
): void {
  try {
    gateway.emitToRoomExcept(
      `tenant:${input.tenantId}`,
      input.exceptSocketId ?? null,
      ENTITY_CHANGED_EVENT,
      buildEntityChanged(input),
    );
  } catch (error) {
    logger?.error(
      `Failed to publish ${input.spec.action}`,
      error instanceof Error ? error.stack : String(error),
    );
  }
}

/** Người làm là tên "họ tên" như `toUserRef` (`fullName`), không phải `displayName` ("tên họ"). */
export function actorOf(user: AuthUser): ChangeActor {
  return {
    source: 'USER',
    id: user.userId,
    name: user.fullName ?? user.displayName ?? user.phoneNumber,
  };
}
