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

/** Mô tả audit cho từng route, được implement trong module domain sở hữu route, để AuditInterceptor không bao giờ biết tới module tính năng. */
export interface AuditDescriptor {
  matches(path: string): boolean;
  describe(ctx: AuditDescribeContext): AuditDescribed | Promise<AuditDescribed>;
}

/** Đánh dấu provider là AuditDescriptor; AuditInterceptor tự dò lúc khởi động, nên không có danh sách trung tâm phải cập nhật. */
export const AuditTemplate = DiscoveryService.createDecorator<void>();
