import test from 'node:test';
import assert from 'node:assert/strict';
import { create } from 'cuer/QrCode';

test('RainbowKit QR renderer accepts a WalletConnect URI without crashing', () => {
  // The transitive qr 0.6+ encoder rejects cuer's border:0 option.
  const uri = `wc:${'a'.repeat(64)}@2?relay-protocol=irn&symKey=${'b'.repeat(64)}`;
  const qr = create(uri, { errorCorrection: 'medium' });
  assert.equal(qr.value, uri);
  assert.ok(qr.edgeLength > 21);
  assert.equal(qr.grid.length, qr.edgeLength);
  assert.ok(qr.grid.every(row => row.length === qr.edgeLength));
});
