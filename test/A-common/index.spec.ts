import assert from 'node:assert';
import { ADAPTER_NAME } from '../../src/index.js';

describe('package', () => {
  it('exposes the adapter name', () => {
    assert.strictEqual(ADAPTER_NAME, 'prisma-postgrejs');
  });
});
