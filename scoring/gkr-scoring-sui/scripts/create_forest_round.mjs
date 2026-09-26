// Schedule a fresh round on an already confirmed Forest package/Registry.
// A prior Challenge is immutable: this creates another shared object, not a reset.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { bcs } from '@mysten/sui/bcs';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';

function required(name) {
  const at = process.argv.indexOf(name);
  const value = process.argv[at + 1];
  if (at < 0 || !value || value.startsWith('--')) throw new Error(`Pass ${name}`);
  return value;
}
const source = JSON.parse(readFileSync(resolve(required('--manifest')), 'utf8'));
const output = resolve(required('--out'));
if (existsSync(output)) throw new Error('Output manifest already exists; inspect chain before creating another round');
if (source.phase !== 'active' || !source.challengeId || !source.deviceRegistrationTx ||
    source.network !== 'testnet' || !source.packageId || !source.registryId ||
    !source.organizerCapId || !source.charts?.easy?.registrationTx ||
    !source.charts?.hard?.registrationTx || !source.deviceAddress || !source.devicePubkey) {
  throw new Error('Source must be a confirmed active Forest deployment');
}
if (source.insecureDemo && !process.argv.includes('--insecure-demo')) {
  throw new Error('This Registry has an insecure development SRS and extractable device key; pass --insecure-demo to make the risk explicit');
}
const active = execFileSync('sui', ['client', 'active-address'], { encoding: 'utf8' }).trim();
const entries = JSON.parse(readFileSync(`${process.env.HOME}/.sui/sui_config/sui.keystore`, 'utf8'));
const signer = entries.map((value) => Buffer.from(value, 'base64'))
  .filter((raw) => raw[0] === 0).map((raw) => Ed25519Keypair.fromSecretKey(raw.subarray(1)))
  .find((key) => key.toSuiAddress() === active);
if (!signer || active !== source.organizer) throw new Error('Active Ed25519 signer does not own this deployment');
const client = new SuiGrpcClient({ network: 'testnet', baseUrl: source.rpc });
const [registry, cap, previous, createAbi, buyAbi, clock] = await Promise.all([
  client.getObject({ objectId: source.registryId }),
  client.getObject({ objectId: source.organizerCapId }),
  client.getObject({ objectId: source.challengeId, include: { json: true } }),
  client.getMoveFunction({ packageId: source.packageId, moduleName: 'competition', name: 'create' }),
  client.getMoveFunction({ packageId: source.packageId, moduleName: 'competition', name: 'buy_plays' }),
  client.getObject({ objectId: '0x6', include: { json: true } }),
]);
if (registry.object?.owner?.$kind !== 'Shared' ||
    cap.object?.owner?.AddressOwner !== active ||
    previous.object?.type !== `${source.packageId}::competition::Challenge<${source.asset}>` ||
    previous.object?.json?.registry !== source.registryId ||
    createAbi.function.parameters.length !== 11 ||
    buyAbi.function.parameters.length !== 5 || buyAbi.function.parameters[2].body.$kind !== 'u8') {
  throw new Error('The Registry, organizer capability, previous Challenge or chart-specific purchase ABI does not match');
}
const clockMs = Number(clock.object?.json?.timestamp_ms);
if (!Number.isSafeInteger(clockMs)) throw new Error('Sui Clock is unavailable');
// Give the transaction one minute to confirm; the six-hour clock begins immediately afterward.
const startAtMs = Math.max(Date.now(), clockMs) + 60_000;
const roundDate = new Date(startAtMs).toISOString().slice(0, 10);
const roundId = createHash('sha256').update(`versu:${roundDate}`).digest();
const bytes = (value, size) => {
  if (!new RegExp(`^0x[0-9a-fA-F]{${2 * size}}$`).test(value)) throw new Error(`Invalid ${size}-byte hex field`);
  return Buffer.from(value.slice(2), 'hex');
};
const claimWindowMs = BigInt(source.claimWindowMs);
const tx = new Transaction();
tx.setSender(active);
tx.setGasBudget(500_000_000);
const identityCap = tx.moveCall({
  target: `${source.packageId}::competition::create`, typeArguments: [source.asset],
  arguments: [
    tx.sharedObjectRef({ objectId: source.registryId,
      initialSharedVersion: registry.object.owner.Shared.initialSharedVersion, mutable: false }),
    tx.object(source.organizerCapId),
    tx.pure.vector('u8', new TextEncoder().encode(roundDate)),
    tx.pure.vector('u8', roundId),
    tx.pure.vector('u8', bytes(source.charts.easy.chartHash, 32)),
    tx.pure.vector('u8', bytes(source.charts.hard.chartHash, 32)),
    tx.pure.vector('u8', bytes(source.deviceAddress, 20)),
    tx.pure.u64(startAtMs), tx.pure.u64(claimWindowMs), tx.object.clock(),
  ],
});
tx.transferObjects([identityCap], source.identityAttestor);
const manifest = {
  network: source.network, rpc: source.rpc, organizer: source.organizer,
  challengeDurationMs: source.challengeDurationMs, asset: source.asset,
  srsId: source.srsId, srsSecurity: source.srsSecurity, charts: source.charts,
  chartArtifacts: source.chartArtifacts, packageId: source.packageId,
  packagePublishTx: source.packagePublishTx, registryId: source.registryId,
  organizerCapId: source.organizerCapId, registryCreationTx: source.registryCreationTx,
  deviceAddress: source.deviceAddress, devicePubkey: source.devicePubkey,
  bitstreamHash: source.bitstreamHash, deviceRegistrationTx: source.deviceRegistrationTx,
  deviceProvisioning: source.deviceProvisioning, insecureDemo: source.insecureDemo,
  identityAttestor: source.identityAttestor, previousChallengeId: source.challengeId,
  roundDate, roundId: `0x${roundId.toString('hex')}`,
  scheduledStartAtMs: String(startAtMs), claimWindowMs: String(claimWindowMs),
  transactions: [], phase: 'creating',
};
mkdirSync(dirname(output), { recursive: true });
const checkpoint = () => writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
checkpoint();
const signed = await tx.build({ client });
const { signature } = await signer.signTransaction(signed);
if (Date.now() >= startAtMs) throw new Error('Start time passed before submission; inspect checkpoint and retry with a new output path');
const sent = await client.executeTransaction({ transaction: signed, signatures: [signature],
  include: { effects: true, objectTypes: true, events: true } });
const digest = sent.Transaction?.digest ?? sent.FailedTransaction?.digest;
if (!digest) throw new Error('No digest returned; inspect chain before retrying');
manifest.submittedTx = digest;
checkpoint();
const confirmed = await client.waitForTransaction({ digest, include: { effects: true, objectTypes: true, events: true } });
const result = confirmed.Transaction ?? confirmed.FailedTransaction;
if (!result?.effects?.status?.success) throw new Error(`Challenge creation failed in ${digest}`);
const created = (suffix) => {
  const found = result.effects.changedObjects.filter((obj) => obj.idOperation === 'Created' &&
    (result.objectTypes?.[obj.objectId] ?? '').endsWith(suffix));
  if (found.length !== 1) throw new Error(`Expected one ${suffix} in ${digest}`);
  return found[0].objectId;
};
manifest.challengeId = created(`::competition::Challenge<${source.asset}>`);
manifest.identityCapId = created('::competition::IdentityCap');
const eventBytes = result.events?.filter((event) => event.eventType.endsWith('::competition::ChallengeCreated')) ?? [];
if (eventBytes.length !== 1) throw new Error(`Missing ChallengeCreated in ${digest}`);
const event = bcs.struct('ChallengeCreated', {
  challenge: bcs.Address, registry: bcs.Address,
  round_date: bcs.vector(bcs.u8()), round_id: bcs.vector(bcs.u8()),
  easy_chart_hash: bcs.vector(bcs.u8()), hard_chart_hash: bcs.vector(bcs.u8()),
  started_at_ms: bcs.u64(), score_deadline_ms: bcs.u64(),
  claim_window_ms: bcs.u64(), claim_deadline_ms: bcs.u64(),
}).parse(eventBytes[0].bcs);
if (event.challenge !== manifest.challengeId || event.registry !== source.registryId ||
    Buffer.from(event.round_date).toString('utf8') !== roundDate ||
    Buffer.from(event.round_id).compare(roundId) !== 0 ||
    Buffer.from(event.easy_chart_hash).compare(bytes(source.charts.easy.chartHash, 32)) !== 0 ||
    Buffer.from(event.hard_chart_hash).compare(bytes(source.charts.hard.chartHash, 32)) !== 0 ||
    BigInt(event.started_at_ms) !== BigInt(startAtMs) ||
    BigInt(event.score_deadline_ms) !== BigInt(startAtMs) + 21_600_000n ||
    BigInt(event.claim_window_ms) !== claimWindowMs ||
    BigInt(event.claim_deadline_ms) !== BigInt(startAtMs) + 21_600_000n + claimWindowMs) {
  throw new Error(`ChallengeCreated fields do not match requested round in ${digest}`);
}
manifest.startedAtMs = event.started_at_ms;
manifest.scoreDeadlineMs = event.score_deadline_ms;
manifest.claimDeadlineMs = event.claim_deadline_ms;
manifest.challengeCreationTx = digest;
manifest.worldIdentityConfiguration = { [manifest.challengeId]: { identityCapId: manifest.identityCapId } };
manifest.browserConfiguration = {
  VITE_SUI_PACKAGE_ID: source.packageId, VITE_SUI_REGISTRY_ID: source.registryId,
  VITE_SUI_CHALLENGE_ID: manifest.challengeId,
  VITE_SUI_EASY_CHART_HASH: source.charts.easy.chartHash,
  VITE_SUI_HARD_CHART_HASH: source.charts.hard.chartHash,
  VITE_SUI_USDC_TYPE: source.asset, VITE_BEATMAP_URL: '/beatmaps/forest.osz',
};
manifest.phase = 'active';
manifest.transactions.push({ step: 'create immediately starting Forest round', digest });
checkpoint();
console.log(JSON.stringify({ digest, challengeId: manifest.challengeId,
  identityCapId: manifest.identityCapId, startedAtMs: manifest.startedAtMs,
  scoreDeadlineMs: manifest.scoreDeadlineMs, claimDeadlineMs: manifest.claimDeadlineMs }, null, 2));
