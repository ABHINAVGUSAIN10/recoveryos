import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

export type RecoveryRole = 'VIEWER' | 'OPERATOR' | 'ADMIN';
export type RecoveryActor = { id: string; role: RecoveryRole };
export type AuthenticatedRequest = Request & { recoveryActor?: RecoveryActor };

const PUBLIC_ROUTE = 'recoveryos:public';
const REQUIRED_ROLES = 'recoveryos:roles';
const roleRank: Record<RecoveryRole, number> = { VIEWER: 1, OPERATOR: 2, ADMIN: 3 };

export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
export const Roles = (...roles: RecoveryRole[]) => SetMetadata(REQUIRED_ROLES, roles);

@Injectable()
export class TokenAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if ((process.env.AUTH_MODE || 'disabled') === 'disabled') {
      request.recoveryActor = { id: 'simulation-admin', role: 'ADMIN' };
      return true;
    }

    const token = this.bearerToken(request.headers.authorization);
    const actor = this.actorForToken(token);
    if (!actor) throw new UnauthorizedException('A valid RecoveryOS bearer token is required');

    const required = this.reflector.getAllAndOverride<RecoveryRole[]>(REQUIRED_ROLES, [context.getHandler(), context.getClass()]) ?? ['VIEWER'];
    const minimumRank = Math.min(...required.map(role => roleRank[role]));
    if (roleRank[actor.role] < minimumRank) throw new ForbiddenException(`Role ${actor.role} cannot perform this action`);
    request.recoveryActor = actor;
    return true;
  }

  private bearerToken(header?: string) {
    const [scheme, token] = header?.split(' ') ?? [];
    return scheme?.toLowerCase() === 'bearer' && token ? token : '';
  }

  private actorForToken(provided: string): RecoveryActor | null {
    const configured: Array<{ role: RecoveryRole; token?: string }> = [
      { role: 'ADMIN', token: process.env.ADMIN_API_TOKEN },
      { role: 'OPERATOR', token: process.env.OPERATOR_API_TOKEN },
      { role: 'VIEWER', token: process.env.VIEWER_API_TOKEN },
    ];
    for (const candidate of configured) if (candidate.token && this.matches(provided, candidate.token)) return { id: `token:${candidate.role.toLowerCase()}`, role: candidate.role };
    return null;
  }

  private matches(provided: string, expected: string) {
    const left = Buffer.from(provided); const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
