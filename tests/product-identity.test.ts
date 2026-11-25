import test from 'node:test';
import assert from 'node:assert/strict';
import { attributedEntryId, attributedEntryIdFor, PRODUCT_ID, PRODUCT_UTM_SOURCE } from '../shared/product-identity.ts';

const uuid = '7d1c6f4e-6a1f-4c55-9a43-0c7a4a0a8f11';

test('the build product decides the payment entry ID and UTM source', () => {
  // OpenMotion and OpenGame share this test; only shared/product-identity.ts differs between the repositories.
  assert.ok(PRODUCT_ID === 'openmotion' || PRODUCT_ID === 'opengame');
  assert.equal(PRODUCT_UTM_SOURCE, PRODUCT_ID);
  assert.equal(attributedEntryId(uuid), attributedEntryIdFor(PRODUCT_ID, uuid));
});

for (const [product, expected] of [
  ['openmotion', uuid],
  ['opengame', `opengame-${uuid}`],
] as const) {
  test(`${product} formats the payment entry ID without changing the original UUID`, () => {
    assert.equal(attributedEntryIdFor(product, uuid), expected);
  });
}
