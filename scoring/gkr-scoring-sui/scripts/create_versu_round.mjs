// Creates one World-ID-gated versu! vault on an already deployed native Sui GKR registry.
// Requires organizer-owned capability, registered chart/device and a six-decimal coin.
import { createHash } from 'node:crypto';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { isValidSuiAddress } from '@mysten/sui/utils';

// Circle's published coin types, not display symbols supplied by arbitrary packages.
const circleUsdc = {
  mainnet: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  testnet: '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC',
};

const names = ['SUI_NETWORK', 'SUI_RPC_URL', 'SUI_PACKAGE_ID', 'SUI_REGISTRY_ID',
  'SUI_ORGANIZER_CAP_ID', 'SUI_CHART_HASH', 'SUI_DEVICE_ADDRESS', 'SUI_USDC_TYPE',
  'SUI_IDENTITY_ATTESTOR_ADDRESS', 'SUI_ORGANIZER_PRIVATE_KEY', 'VERSU_ROUND_DATE',
  'VERSU_SALES_DEADLINE_MS', 'VERSU_STARTS_DEADLINE_MS', 'VERSU_SCORE_DEADLINE_MS',
  'VERSU_CLAIM_DEADLINE_MS'];
for (const name of names) {
  if (!process.env[name]) throw new Error(`Required server-only setting ${name} is missing`);
}
const v = process.env;
if (!['testnet', 'mainnet', 'localnet'].includes(v.SUI_NETWORK)) throw new Error('Use an explicit Sui network');
if (v.SUI_NETWORK === 'mainnet' && !process.argv.includes('--confirm-mainnet')) {
  throw new Error('Mainnet gas/asset writes require --confirm-mainnet');
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(v.VERSU_ROUND_DATE) ||
    new Date(`${v.VERSU_ROUND_DATE}T00:00:00Z`).toISOString().slice(0, 10) !== v.VERSU_ROUND_DATE) {
  throw new Error('VERSU_ROUND_DATE must be a real YYYY-MM-DD UTC date');
}
for (const name of ['SUI_PACKAGE_ID', 'SUI_REGISTRY_ID', 'SUI_ORGANIZER_CAP_ID', 'SUI_IDENTITY_ATTESTOR_ADDRESS']) {
  if (!isValidSuiAddress(v[name])) throw new Error(`${name} is not a Sui address`);
}
for (const [name, bytes] of [['SUI_CHART_HASH', 32], ['SUI_DEVICE_ADDRESS', 20]]) {
  if (!new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v[name])) throw new Error(`${name} must have ${bytes} bytes`);
}
const limits = ['VERSU_SALES_DEADLINE_MS', 'VERSU_STARTS_DEADLINE_MS', 'VERSU_SCORE_DEADLINE_MS', 'VERSU_CLAIM_DEADLINE_MS']
  .map(name => BigInt(v[name]));
const [sales, starts, scores, claims] = limits;
if (!(sales > BigInt(Date.now()) && sales <= starts && starts < scores && scores < claims)) {
  throw new Error('Round deadlines must be future, ordered millisecond timestamps');
}
const client = new SuiGrpcClient({ network: v.SUI_NETWORK, baseUrl: v.SUI_RPC_URL });
if (v.SUI_NETWORK !== 'localnet' && v.SUI_USDC_TYPE !== circleUsdc[v.SUI_NETWORK]) {
  throw new Error('SUI_USDC_TYPE must be Circle-issued native USDC for this network');
}
const { coinMetadata } = await client.getCoinMetadata({ coinType: v.SUI_USDC_TYPE });
if (!coinMetadata || coinMetadata.decimals !== 6 || (v.SUI_NETWORK !== 'localnet' && coinMetadata.symbol !== 'USDC')) {
  throw new Error('Coin must have six decimals and the expected Circle USDC metadata');
}
const signer = Ed25519Keypair.fromSecretKey(v.SUI_ORGANIZER_PRIVATE_KEY);
const round = createHash('sha256').update(`versu:${v.VERSU_ROUND_DATE}`).digest();
const bytes = (hex) => Uint8Array.from(Buffer.from(hex.slice(2), 'hex'));
const tx = new Transaction();
const identityCap = tx.moveCall({
  target: `${v.SUI_PACKAGE_ID}::competition::create`,
  typeArguments: [v.SUI_USDC_TYPE],
  arguments: [
    tx.object(v.SUI_REGISTRY_ID), tx.object(v.SUI_ORGANIZER_CAP_ID),
    tx.pure.vector('u8', round), tx.pure.vector('u8', bytes(v.SUI_CHART_HASH)),
    tx.pure.vector('u8', bytes(v.SUI_DEVICE_ADDRESS)),
    ...limits.map(limit => tx.pure.u64(limit)), tx.object.clock(),
  ],
});
tx.transferObjects([identityCap], v.SUI_IDENTITY_ATTESTOR_ADDRESS);
tx.setSender(signer.toSuiAddress());
const result = await client.signAndExecuteTransaction({ transaction: tx, signer,
  include: { effects: true, objectTypes: true, events: true } });
if (!result.Transaction?.status.success) throw new Error('Sui competition creation transaction failed');
const confirmed = await client.waitForTransaction({ digest: result.Transaction.digest,
  include: { effects: true, objectTypes: true, events: true } });
if (!confirmed.Transaction?.status.success) throw new Error('Competition creation not confirmed');
const changed = confirmed.Transaction.effects.changedObjects;
const typeOf = (item) => confirmed.Transaction.objectTypes?.[item.objectId] || '';
const competition = changed.find(item => item.idOperation === 'Created' &&
  typeOf(item).includes('::competition::Competition<'))?.objectId;
const cap = changed.find(item => item.idOperation === 'Created' &&
  typeOf(item).endsWith('::competition::IdentityCap'))?.objectId;
if (!competition || !cap) throw new Error(`Round transaction ${result.Transaction.digest} did not emit both objects`);
console.log(JSON.stringify({ network: v.SUI_NETWORK, date: v.VERSU_ROUND_DATE, competitionId: competition,
  identityCapId: cap, roundId: `0x${round.toString('hex')}`, transaction: result.Transaction.digest }, null, 2));
