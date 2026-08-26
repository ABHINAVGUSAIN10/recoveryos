import { PrismaService } from './prisma.service';

describe('PrismaService startup resilience', () => {
  const savedAttempts = process.env.DATABASE_CONNECT_MAX_ATTEMPTS;
  const savedDelay = process.env.DATABASE_CONNECT_RETRY_MS;

  beforeEach(() => {
    process.env.DATABASE_CONNECT_MAX_ATTEMPTS = '2';
    process.env.DATABASE_CONNECT_RETRY_MS = '1';
  });

  afterAll(() => {
    if (savedAttempts === undefined) delete process.env.DATABASE_CONNECT_MAX_ATTEMPTS;
    else process.env.DATABASE_CONNECT_MAX_ATTEMPTS = savedAttempts;
    if (savedDelay === undefined) delete process.env.DATABASE_CONNECT_RETRY_MS;
    else process.env.DATABASE_CONNECT_RETRY_MS = savedDelay;
  });

  it('recovers from a transient initial connection failure', async () => {
    const service = new PrismaService();
    const connect = jest.spyOn(service, '$connect').mockRejectedValueOnce(new Error('temporary')).mockResolvedValue();

    await service.onModuleInit();

    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('fails startup after the bounded attempt limit', async () => {
    const service = new PrismaService();
    const connect = jest.spyOn(service, '$connect').mockRejectedValue(new Error('unavailable'));

    await expect(service.onModuleInit()).rejects.toThrow('unavailable');
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
