import { redactSensitive, redactText, safeErrorMessage } from './redaction';

describe('log redaction', () => {
  it('redacts nested secrets and financial identifiers', () => {
    expect(redactSensitive({ authorization: 'Bearer abc', payload: { account_number: '1234', reason: 'safe' } })).toEqual({
      authorization: '[REDACTED]', payload: { account_number: '[REDACTED]', reason: 'safe' },
    });
  });

  it('redacts credentials embedded in text and connection URLs', () => {
    const value = redactText('Bearer abc.def postgresql://user:pass@host/db rediss://default:secret@redis:6379 api_key=hello');
    expect(value).not.toContain('abc.def');
    expect(value).not.toContain('user:pass');
    expect(value).not.toContain('default:secret');
    expect(value).not.toContain('hello');
  });

  it('returns a safe error message', () => {
    expect(safeErrorMessage(new Error('token=private failed'))).toBe('token=[REDACTED] failed');
  });
});
