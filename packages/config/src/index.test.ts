import { describe, it, expect } from 'vitest';
import { resolveConfig } from './index';
describe('config', () => {
  it('resolves config', () => {
    const cfg = resolveConfig(process.cwd());
    expect(cfg.permissionMode).toBe('prompt');
  });
});
