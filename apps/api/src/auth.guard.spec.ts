import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { TokenAuthGuard } from './auth.guard';

const context = (authorization?: string) => {
  const request = { headers: { authorization } } as any;
  return { request, value: { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => 'handler', getClass: () => 'controller' } as any };
};

describe('TokenAuthGuard', () => {
  const original = { ...process.env };
  afterEach(() => { process.env = { ...original }; });

  it('grants an admin actor in explicitly disabled simulation mode', () => {
    process.env.AUTH_MODE = 'disabled';
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    const target = context();
    expect(new TokenAuthGuard(reflector as never).canActivate(target.value)).toBe(true);
    expect(target.request.recoveryActor).toEqual({ id: 'simulation-admin', role: 'ADMIN' });
  });

  it('accepts a configured operator token for operator routes', () => {
    process.env.AUTH_MODE = 'token'; process.env.OPERATOR_API_TOKEN = 'operator-secret';
    const reflector = { getAllAndOverride: jest.fn().mockReturnValueOnce(false).mockReturnValueOnce(['OPERATOR']) };
    const target = context('Bearer operator-secret');
    expect(new TokenAuthGuard(reflector as never).canActivate(target.value)).toBe(true);
    expect(target.request.recoveryActor?.role).toBe('OPERATOR');
  });

  it('rejects an operator token on admin routes', () => {
    process.env.AUTH_MODE = 'token'; process.env.OPERATOR_API_TOKEN = 'operator-secret';
    const reflector = { getAllAndOverride: jest.fn().mockReturnValueOnce(false).mockReturnValueOnce(['ADMIN']) };
    expect(() => new TokenAuthGuard(reflector as never).canActivate(context('Bearer operator-secret').value)).toThrow(ForbiddenException);
  });

  it('rejects missing or invalid credentials in token mode', () => {
    process.env.AUTH_MODE = 'token'; process.env.VIEWER_API_TOKEN = 'viewer-secret';
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
    expect(() => new TokenAuthGuard(reflector as never).canActivate(context().value)).toThrow(UnauthorizedException);
  });
});
