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

/** Per-route audit description, implemented in the owning domain module so AuditInterceptor never learns about feature modules. */
export interface AuditDescriptor {
  matches(path: string): boolean;
  describe(ctx: AuditDescribeContext): AuditDescribed | Promise<AuditDescribed>;
}

/** Marks a provider as an AuditDescriptor; AuditInterceptor discovers them at startup, so there is no central list to update. */
export const AuditTemplate = DiscoveryService.createDecorator<void>();
