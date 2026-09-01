import { RevenueRecoveryProcessor } from './revenue-recovery.processor';

describe('RevenueRecoveryProcessor', () => {
  it('dispatches only the dedicated revenue action job', async () => {
    const revenue = { executeAction: jest.fn().mockResolvedValue({ executed: true }) };
    const processor = new RevenueRecoveryProcessor(revenue as never);
    await processor.process({ name: 'execute-revenue-action', data: { actionId: 'action-1' } } as never);
    expect(revenue.executeAction).toHaveBeenCalledWith('action-1');
    await processor.process({ name: 'other', data: { actionId: 'action-2' } } as never);
    expect(revenue.executeAction).toHaveBeenCalledTimes(1);
  });
});
