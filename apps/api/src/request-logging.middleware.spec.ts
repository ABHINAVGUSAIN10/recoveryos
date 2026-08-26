import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';
import { RequestLoggingMiddleware } from './request-logging.middleware';

describe('RequestLoggingMiddleware', () => {
  it('emits a correlation id and a body-free structured completion log', () => {
    const request = { headers: { authorization: 'Bearer private-token' }, method: 'POST', path: '/api/v1/example', body: { password: 'secret' } } as never;
    const response = new EventEmitter() as EventEmitter & { statusCode: number; setHeader: jest.Mock };
    response.statusCode = 202; response.setHeader = jest.fn();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();

    new RequestLoggingMiddleware().use(request, response as never, jest.fn());
    response.emit('finish');

    expect(response.setHeader).toHaveBeenCalledWith('x-request-id', expect.any(String));
    const rendered = String(log.mock.calls.at(-1)?.[0]);
    expect(JSON.parse(rendered)).toMatchObject({ event: 'http_request', method: 'POST', path: '/api/v1/example', statusCode: 202 });
    expect(rendered).not.toContain('private-token');
    expect(rendered).not.toContain('secret');
    log.mockRestore();
  });
});
