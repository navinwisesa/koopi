import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CARPET, parseCarpet, carpetFromMetadata } from '../lib/accountCarpet.ts';

test('account carpet validates and trims just the two editable values', () => {
  assert.deepEqual(parseCarpet({ headline: '  Our room ', caption: ' Make together ', userId: 'someone-else' }), { headline: 'Our room', caption: 'Make together' });
  assert.deepEqual(carpetFromMetadata({ koopi_carpet: DEFAULT_CARPET, role: 'irrelevant' }), DEFAULT_CARPET);
});
test('invalid or oversized account data cannot become carpet settings', () => {
  for (const value of [null, [], {}, { headline: false, caption: 'x' }, { headline: ' ', caption: 'x' }, { headline: 'x'.repeat(23), caption: 'x' }, { headline: 'x', caption: 'x'.repeat(47) }]) assert.equal(parseCarpet(value), null);
  assert.equal(carpetFromMetadata({}), null);
});
