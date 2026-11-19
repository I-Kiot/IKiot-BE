import type {
  ChangeAction,
  ChangeResource,
  ChangeSource,
} from '../constants/change-feed';
import type { PrismaService } from '../../prisma/prisma.service';

/** Payload của event `entity:changed`. FE phản chiếu ở `src/types/change-feed.ts` (`EntityChangedEvent`). */
export interface EntityChangedPayload {
  /** Một cho mỗi request HTTP / mỗi lần phát tường minh; FE dùng để không hiện hai toast cho cùng một sự kiện. */
  eventId: string;
  action: ChangeAction;
  /** Chủ thể đứng đầu. `ids: []` nghĩa là "có dòng đổi nhưng không biết dòng nào". */
  changes: { resource: ChangeResource; ids: string[] }[];
  /** Null chỉ với sự kiện gộp (nhiều đơn một lúc, ví dụ cron hết hạn QR). */
  subject: {
    resource: ChangeResource;
    id: string;
    code: string | null;
  } | null;
  actor: { id: string | null; name: string };
  source: ChangeSource;
  /** Câu tiếng Việt hoàn chỉnh, FE hiện nguyên văn. Chỉ gồm tên người làm, động từ và mã chứng từ - không bao giờ có tiền / tên khách / số điện thoại, vì cả room tenant nhận được. */
  summary: string;
  /** True = chỉ tải lại dữ liệu, không hiện toast. */
  quiet: boolean;
  at: string;
}

/** Thứ mà một route (hoặc nơi phát tường minh) đã chạm tới. */
export interface ChangeTarget {
  subjectId: string | null;
  code: string | null;
  /** Id của các bảng khác bị chạm cùng lúc (đơn liên quan của một phiếu giao, v.v.). */
  related?: Partial<
    Record<ChangeResource, readonly (string | null | undefined)[]>
  >;
}

export interface ChangeExtractContext {
  /** Giá trị handler trả về, trước khi bọc envelope. */
  body: unknown;
  params: Readonly<Record<string, string | undefined>>;
  tenantId: string;
  /** Chỉ cho spec phải tra thêm (đóng gói lấy mã đơn); đa số spec không đụng tới. */
  prisma: PrismaService;
}

export interface ChangeSpec {
  action: ChangeAction;
  subject: ChangeResource;
  /** Luôn được liệt kê trong `changes`, id lấy từ `target.related` hoặc `[]`. */
  also?: readonly ChangeResource[];
  quiet?: boolean;
  extract?: (
    ctx: ChangeExtractContext,
  ) => ChangeTarget | null | Promise<ChangeTarget | null>;
  summary: (s: { actor: string; code: string | null }) => string;
}

export type ChangeActor =
  | { source: 'USER'; id: string; name: string }
  | { source: 'SYSTEM' }
  | { source: 'WEBHOOK' };

export interface PublishChangeInput {
  tenantId: string;
  spec: ChangeSpec;
  target: ChangeTarget;
  actor: ChangeActor;
  /** Socket của tab gây ra thay đổi: không phát lại cho nó. */
  exceptSocketId?: string | null;
}
