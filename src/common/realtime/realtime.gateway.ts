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

// Ported from iKiotMS-BE's socketService.js with a fix: rooms are joined server-side from the JWT, so there is no client-driven `join` to eavesdrop with.
@Injectable()
// Same origin list the HTTP side uses - it used to read FRONTEND_URL while main.ts read CORS_ORIGIN, so locking down the API left the socket open.
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
      // An access token outlives a deactivation, so the account is checked at handshake too - otherwise a dismissed employee keeps the shop's live feed.
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
    // socket.io leaves every room automatically on disconnect - nothing to do here.
  }

  /** Drops every socket this user has open: the account is only checked at handshake, so a live socket would otherwise outlive the deactivation the HTTP side already enforces. */
  disconnectUser(userId: string): void {
    this.server?.in(`user:${userId}`).disconnectSockets(true);
  }

  /** The one emit primitive every other service should use - never touch `server` directly. */
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
