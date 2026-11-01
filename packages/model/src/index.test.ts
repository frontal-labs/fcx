import { describe, it, expect } from 'vitest';
import { createMockModelHost } from './index';
describe('model', () => {
  it('creates mock host', () => {
    const host = createMockModelHost();
    expect(host.countTokens('hello')).toBeGreaterThan(0);
  });
});
