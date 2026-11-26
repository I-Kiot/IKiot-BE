import { DiscoveryService } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthUser } from '../types/auth-user.type';

export interface AuditDescribeContext {
  request: Request & { user?: AuthUser };
  path: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
}

export interface AuditDescribed {
  resource: string;
  details: string;
}

/** Mô tả audit cho từng route, khai báo ở module sở hữu route. */
export interface AuditDescriptor {
  matches(path: string): boolean;
  describe(ctx: AuditDescribeContext): AuditDescribed | Promise<AuditDescribed>;
}

/** Đánh dấu provider là AuditDescriptor để AuditInterceptor tự dò lúc khởi động. */
export const AuditTemplate = DiscoveryService.createDecorator<void>();
