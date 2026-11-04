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

// Port từ socketService.js của iKiotMS-BE, có một sửa lỗi: room được join ở server từ JWT, không còn event `join` do client điều khiển để nghe trộm.
@Injectable()
// Cùng danh sách origin với HTTP. Trước đây đọc FRONTEND_URL trong khi main.ts đọc CORS_ORIGIN, nên khoá API rồi socket vẫn mở.
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
      // Access token còn sống sau khi bị vô hiệu, nên tài khoản cũng được kiểm tra lúc handshake - nếu không, nhân viên đã nghỉ vẫn giữ feed trực tiếp của shop.
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

  /** Ngắt mọi socket đang mở của user này: tài khoản chỉ được kiểm tra lúc handshake, nên socket đang sống sẽ sống qua việc vô hiệu mà HTTP đã áp dụng. */
  disconnectUser(userId: string): void {
    this.server?.in(`user:${userId}`).disconnectSockets(true);
  }

  /** Primitive emit duy nhất mà service khác nên dùng - không bao giờ đụng trực tiếp `server`. */
  emitToRoom(room: string, event: string, payload: unknown): void {
    this.server?.to(room).emit(event, payload);
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
