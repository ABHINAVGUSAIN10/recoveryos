import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedRequest } from './auth.guard';

type CorrelatedRequest = Request & { recoveryRequestId?: string };

@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HttpRequest');

  use(request: CorrelatedRequest, response: Response, next: NextFunction) {
    if (process.env.LOG_REQUESTS === 'false') return next();
    const supplied = request.headers['x-request-id'];
    const requestId = typeof supplied === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(supplied) ? supplied : randomUUID();
    const startedAt = Date.now();
    request.recoveryRequestId = requestId;
    response.setHeader('x-request-id', requestId);
    response.on('finish', () => {
      const actor = (request as AuthenticatedRequest).recoveryActor;
      this.logger.log(JSON.stringify({
        event: 'http_request', requestId, method: request.method, path: request.path,
        statusCode: response.statusCode, durationMs: Date.now() - startedAt,
        actorRole: actor?.role ?? 'PUBLIC', simulationMode: process.env.SIMULATION_MODE !== 'false',
      }));
    });
    next();
  }
}
