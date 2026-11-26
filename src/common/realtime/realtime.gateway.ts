import { Injectable, Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../../prisma/prisma.service';
import { INACTIVE_USER_STATUSES } from '../constants/user-status';
import { SystemRole } from '../constants/system-role';
import { socketCorsOrigins } from '../config/env';

// Gateway Socket.IO; room được join ở server theo JWT.
@Injectable()
// Dùng chung danh sách origin với HTTP.
@WebSocketGateway({ cors: { origin: socketCorsOrigins() } })
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() private server: Server;
  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = this.extractToken(client);
      const payload = this.jwt.verify<{ sub: string }>(token);
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, tenantId: true, systemRole: true, status: true },
      });
      if (!user) throw new Error('User not found');
      // Kiểm tra tài khoản lúc handshake để chặn người đã bị vô hiệu.
      if (INACTIVE_USER_STATUSES.has(user.status)) {
        throw new Error('Account is not active');
      }

      await client.join(`user:${user.id}`);
      if (user.tenantId) await client.join(`tenant:${user.tenantId}`);
      if (user.systemRole === SystemRole.ADMIN) await client.join('admin');
    } catch (error) {
      this.logger.warn(
        `Rejected socket connection: ${error instanceof Error ? error.message : String(error)}`,
      );
      client.disconnect(true);
    }
  }

  handleDisconnect() {
    // socket.io tự rời mọi room khi ngắt kết nối - không cần làm gì ở đây.
  }

  /** Ngắt mọi socket đang mở của user. */
  disconnectUser(userId: string): void {
    this.server?.in(`user:${userId}`).disconnectSockets(true);
  }

  /** Primitive emit duy nhất mà service khác nên dùng - không bao giờ đụng trực tiếp `server`. */
  emitToRoom(room: string, event: string, payload: unknown): void {
    this.server?.to(room).emit(event, payload);
  }

  /** Phát tới room nhưng bỏ qua một socket (tab gây thay đổi). */
  emitToRoomExcept(
    room: string,
    exceptSocketId: string | null,
    event: string,
    payload: unknown,
  ): void {
    const target = this.server?.to(room);
    (exceptSocketId ? target?.except(exceptSocketId) : target)?.emit(
      event,
      payload,
    );
  }

  private extractToken(client: Socket): string {
    const authToken = client.handshake.auth?.token as string | undefined;
    const header = client.handshake.headers.authorization;
    const bearer =
      typeof header === 'string' ? header.split(' ')[1] : undefined;
    const token = authToken ?? bearer;
    if (!token) throw new Error('No token provided');
    return token;
  }
}
