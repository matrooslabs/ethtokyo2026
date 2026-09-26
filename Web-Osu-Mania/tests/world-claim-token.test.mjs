import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorldToken, sealWorldToken } from '../src/server/worldClaimToken.ts';

const secret = 'ab'.repeat(32);
const otherSecret = 'cd'.repeat(32);
const challengeId = '0x' + '11'.repeat(32);
const wallet = '0x' + '22'.repeat(32);
const now = Math.floor(Date.now() / 1000);
const challenge = {
  kind: 'challenge', challengeId, wallet, difficulty: 'easy', nonce: '0x' + '33'.repeat(32),
  message: `versu prize claim\nchallenge: ${challengeId}\ndifficulty: easy\nwallet: ${wallet}\nnonce: 0x${'33'.repeat(32)}\n`,
  action: 'versu-prize-claim', environment: 'production', expiresAt: now + 120,
};
const attestation = {
  kind: 'attestation', challengeId, wallet, difficulty: 'hard',
  commitment: '0x' + '44'.repeat(32), action: 'versu-prize-claim',
  environment: 'production', expiresAt: now + 600,
};

function changeUnsignedPayload(token, patch) {
  const [encoded, signature] = token.split('.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  return `${Buffer.from(JSON.stringify({ ...payload, ...patch })).toString('base64url')}.${signature}`;
}

test('signed challenge and attestation roundtrip without disclosing a raw World nullifier', async () => {
  const challengeToken = await sealWorldToken(challenge, secret);
  const attestationToken = await sealWorldToken(attestation, '0x' + secret);
  assert.deepEqual(await openWorldToken(challengeToken, secret, 'challenge', now), challenge);
  assert.deepEqual(await openWorldToken(attestationToken, secret, 'attestation', now), attestation);
  const claims = JSON.parse(Buffer.from(attestationToken.split('.')[0], 'base64url').toString('utf8'));
  assert.deepEqual(claims, attestation);
  assert.equal(Object.hasOwn(claims, 'nullifier'), false);
  assert.equal(Object.hasOwn(claims, 'proof'), false);
  await assert.rejects(sealWorldToken({ ...attestation, nullifier: '0x' + '55'.repeat(32) }, secret), /payload/);
});

test('wallet, challenge, difficulty, message and on-chain commitment cannot be changed by a claimant', async () => {
  const challengeToken = await sealWorldToken(challenge, secret);
  const attestationToken = await sealWorldToken(attestation, secret);
  for (const patch of [
    { wallet: '0x' + '66'.repeat(32) },
    { challengeId: '0x' + '77'.repeat(32) },
    { difficulty: 'hard' },
    { message: 'approve a different claim' },
    { nonce: '0x' + '88'.repeat(32) },
    { action: 'other-action' },
    { environment: 'staging' },
  ]) {
    assert.equal(await openWorldToken(changeUnsignedPayload(challengeToken, patch), secret, 'challenge', now), null);
  }
  for (const patch of [
    { wallet: '0x' + '66'.repeat(32) },
    { challengeId: '0x' + '77'.repeat(32) },
    { difficulty: 'easy' },
    { commitment: '0x' + '99'.repeat(32) },
    { action: 'other-action' },
    { environment: 'staging' },
  ]) {
    assert.equal(await openWorldToken(changeUnsignedPayload(attestationToken, patch), secret, 'attestation', now), null);
  }
  assert.equal(await openWorldToken(challengeToken, otherSecret, 'challenge', now), null);
  assert.equal(await openWorldToken(attestationToken, otherSecret, 'attestation', now), null);
  assert.equal(await openWorldToken(challengeToken, secret, 'attestation', now), null);
  assert.equal(await openWorldToken(attestationToken, secret, 'challenge', now), null);
});

test('expiry and malformed inputs fail closed', async () => {
  const token = await sealWorldToken(challenge, secret);
  assert.deepEqual(await openWorldToken(token, secret, 'challenge', challenge.expiresAt - 1), challenge);
  assert.equal(await openWorldToken(token, secret, 'challenge', challenge.expiresAt), null);
  assert.equal(await openWorldToken(token, secret, 'challenge', challenge.expiresAt + 1), null);
  await assert.rejects(sealWorldToken({ ...challenge, expiresAt: now - 1 }, secret), /expiry/);
  await assert.rejects(sealWorldToken({ ...challenge, expiresAt: now + 100_000 }, secret), /expiry/);
  await assert.rejects(sealWorldToken({ ...challenge, expiresAt: Number.MAX_SAFE_INTEGER + 1 }, secret), /payload/);
  await assert.rejects(sealWorldToken({ ...attestation, commitment: '0x1234' }, secret), /payload/);
  await assert.rejects(sealWorldToken(challenge, 'weak'), /signing key/);
  for (const malformed of [
    '', '.', `${token}.extra`, token.replace('.', '..'), token + '!',
    token.replace(/^[^.]+/, '*'),
    token.replace(/\.$/, '') + '=',
    token.replace(/.$/, token.endsWith('A') ? 'B' : 'A'),
    'A'.repeat(4097),
  ]) {
    assert.equal(await openWorldToken(malformed, secret, 'challenge', now), null);
  }
  assert.equal(await openWorldToken(token, secret, 'challenge', Number.NaN), null);
  assert.equal(await openWorldToken(token, 'weak', 'challenge', now), null);
});
