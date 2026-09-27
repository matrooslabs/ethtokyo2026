// Organizer-only on-chain entry switch for a Challenge published with set_entry_open.
// Closing stops new buys/starts; existing score proofs, claims and refunds remain valid.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bcs } from '@mysten/sui/bcs';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';

const opening = process.argv.includes('--open');
const closing = process.argv.includes('--close');
if (opening === closing) throw new Error('Pass exactly one of --open or --close');
const at = process.argv.indexOf('--manifest');
if (at < 0 || !process.argv[at + 1] || process.argv[at + 1].startsWith('--')) {
  throw new Error('Pass --manifest PATH for the active pause-enabled Challenge');
}
const manifest = JSON.parse(readFileSync(resolve(process.argv[at + 1]), 'utf8'));
if (manifest.phase !== 'active' || manifest.entryControl !== true || manifest.network !== 'testnet' ||
    !manifest.packageId || !manifest.registryId || !manifest.organizerCapId ||
    !manifest.challengeId || !manifest.asset || !manifest.rpc) {
  throw new Error('Manifest does not describe a confirmed pause-enabled testnet Challenge');
}
const active = execFileSync('sui', ['client', 'active-address'], { encoding: 'utf8' }).trim();
const entries = JSON.parse(readFileSync(join(process.env.HOME, '.sui/sui_config/sui.keystore'), 'utf8'));
const signer = entries.map((value) => Buffer.from(value, 'base64'))
  .filter((raw) => raw[0] === 0).map((raw) => Ed25519Keypair.fromSecretKey(raw.subarray(1)))
  .find((key) => key.toSuiAddress() === active);
if (!signer || active !== manifest.organizer) throw new Error('Active Ed25519 key is not the Challenge organizer');
const client = new SuiGrpcClient({ network: 'testnet', baseUrl: manifest.rpc });
const [challenge, registry, cap, clock, functionInfo] = await Promise.all([
  client.getObject({ objectId: manifest.challengeId, include: { json: true } }),
  client.getObject({ objectId: manifest.registryId }),
  client.getObject({ objectId: manifest.organizerCapId, include: { json: true } }),
  client.getObject({ objectId: '0x6', include: { json: true } }),
  client.getMoveFunction({ packageId: manifest.packageId, moduleName: 'competition', name: 'set_entry_open' }),
]);
const state = challenge.object?.json;
if (challenge.object?.type !== `${manifest.packageId}::competition::Challenge<${manifest.asset}>` ||
    state?.registry !== manifest.registryId || typeof state.entry_open !== 'boolean' ||
    registry.object?.owner?.$kind !== 'Shared' ||
    cap.object?.owner?.AddressOwner !== active || cap.object?.json?.registry !== manifest.registryId ||
    functionInfo.function.parameters.length !== 5 || functionInfo.function.parameters[3].body.$kind !== 'bool') {
  throw new Error('Challenge, Registry, organizer cap or pause ABI does not match the manifest');
}
if (state.entry_open === opening) {
  console.log(JSON.stringify({ challengeId: manifest.challengeId, open: opening, unchanged: true }));
  process.exit(0);
}
const now = BigInt(clock.object?.json?.timestamp_ms ?? -1);
if (now >= BigInt(state.score_deadline_ms)) {
  throw new Error('This six-hour score window ended; create another Challenge instead of reopening it');
}
const tx = new Transaction();
tx.setSender(active);
tx.setGasBudget(100_000_000);
tx.moveCall({ target: `${manifest.packageId}::competition::set_entry_open`, typeArguments: [manifest.asset],
  arguments: [tx.object(manifest.challengeId),
    tx.sharedObjectRef({ objectId: manifest.registryId,
      initialSharedVersion: registry.object.owner.Shared.initialSharedVersion, mutable: false }),
    tx.object(manifest.organizerCapId), tx.pure.bool(opening), tx.object.clock()] });
const built = await tx.build({ client });
const { signature } = await signer.signTransaction(built);
const submitted = await client.executeTransaction({ transaction: built, signatures: [signature],
  include: { effects: true, events: true } });
const digest = submitted.Transaction?.digest ?? submitted.FailedTransaction?.digest;
if (!digest) throw new Error('No Sui digest returned; inspect chain before retrying');
const confirmed = await client.waitForTransaction({ digest, include: { effects: true, events: true } });
const result = confirmed.Transaction ?? confirmed.FailedTransaction;
if (!result?.effects?.status?.success) throw new Error(`Challenge entry change failed: ${digest}`);
const events = result.events?.filter((event) => event.eventType.endsWith('::competition::ChallengeEntryChanged')) ?? [];
if (events.length !== 1) throw new Error(`Missing ChallengeEntryChanged in ${digest}`);
const event = bcs.struct('ChallengeEntryChanged', { challenge: bcs.Address, open: bcs.bool() }).parse(events[0].bcs);
if (event.challenge !== manifest.challengeId || event.open !== opening) {
  throw new Error(`Challenge entry event mismatched confirmed ${digest}`);
}
const updated = await client.getObject({ objectId: manifest.challengeId, include: { json: true } });
if (updated.object?.json?.entry_open !== opening) throw new Error(`Confirmed ${digest} but Challenge state differs`);
console.log(JSON.stringify({ challengeId: manifest.challengeId, open: opening, digest, scoreDeadlineMs: state.score_deadline_ms }));
