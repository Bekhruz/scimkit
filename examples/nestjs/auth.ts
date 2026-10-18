import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

const IS_PUBLIC = 'isPublic';

/** Marks routes that skip the application's session authentication. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * The application's own global guard. SCIM routes are marked public with the
 * module's `decorators` option because SCIM clients authenticate with their
 * own bearer tokens, which scimkit checks.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    return request.headers['x-session'] !== undefined;
  }
}
