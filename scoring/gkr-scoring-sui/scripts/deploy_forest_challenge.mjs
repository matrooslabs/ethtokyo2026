// Two-phase real Sui testnet deployment. `--prepare` publishes the native package,
// creates a Registry and validates BOTH Forest charts; NO Challenge clock starts.
// `--activate` registers a device and schedules ONE Challenge<Circle USDC>.
// `--insecure-demo` permits only explicitly labeled, unsafe testnet activation.
//
// node deploy_forest_challenge.mjs --prepare --srs /approved/bls12-381-srs.bin --out ./forest-deployment
// node deploy_forest_challenge.mjs --resume --srs /approved/bls12-381-srs.bin --out ./forest-deployment
// node deploy_forest_challenge.mjs --activate --out ./forest-deployment \
//   --start-at 2026-09-27T12:00:00Z --device-pubkey 0x<33-byte-compressed-secp256k1> \
//   --bitstream-hash 0x<32-byte-real-image-hash> --identity-attestor 0x<Sui-wallet>
// Optional SUI_ORGANIZER_PRIVATE_KEY overrides the active `sui client` keystore key.
// Development SRS/software signers NEVER imply mainnet eligibility or real hardware.
import { execFileSync } from 'node:child_process';
import { createHash, ECDH } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bcs } from '@mysten/sui/bcs';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { isValidSuiAddress } from '@mysten/sui/utils';
import { extractForest, prepareForest, publicManifest } from './forest_charts.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packagePath = resolve(scriptDir, '../move');
const USDC = '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC';
const CHAIN_ID = 0x5ec7n; // registry's SP1 V1 header domain; not Sui's chain identifier
const PTB_ARG_BYTES = 15_000;
const CHART_NOTES_PER_TX = 3_000;
const GAS_BUDGET = 3_000_000_000n;
const KNOWN_INSECURE_SRS_ID = '0xcd199354a4ea127f32c21fc6f56863a42af6df3133bef40702f8d9d0a1326a84';
const byteItems = bcs.vector(bcs.vector(bcs.u8()));
const chartRegistered = bcs.struct('ChartRegistered', {
  chart_hash: bcs.vector(bcs.u8()), notes: bcs.u64(), components: bcs.u64(),
});
const challengeCreated = bcs.struct('ChallengeCreated', {
  challenge: bcs.Address, registry: bcs.Address,
  round_date: bcs.vector(bcs.u8()), round_id: bcs.vector(bcs.u8()),
  easy_chart_hash: bcs.vector(bcs.u8()), hard_chart_hash: bcs.vector(bcs.u8()),
  started_at_ms: bcs.u64(), score_deadline_ms: bcs.u64(),
  claim_window_ms: bcs.u64(), claim_deadline_ms: bcs.u64(),
});
const emitted = (res, suffix) => {
  const found = res.events?.filter((event) => event.eventType.endsWith(suffix)) ?? [];
  if (found.length !== 1) throw new Error(`Expected one ${suffix} event in confirmed ${res.digest}`);
  return found[0].bcs;
};
const required = (name) => {
  const at = process.argv.indexOf(name);
  const value = process.argv[at + 1];
  if (at === -1 || !value || value.startsWith('--')) throw new Error(`Required ${name} is missing`);
  return value;
};
const optional = (name, fallback) => {
  const at = process.argv.indexOf(name);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
};
const bytes = (hex, size, label) => {
  if (typeof hex !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${size * 2}}$`).test(hex)) {
    throw new Error(`${label} must be exactly ${size} hex bytes`);
  }
  return Buffer.from(hex.slice(2), 'hex');
};
const hex = (buffer) => `0x${Buffer.from(buffer).toString('hex')}`;
const sha256 = (text) => createHash('sha256').update(text).digest();
const created = (res, suffix) => {
  const ids = res.effects.changedObjects.filter((obj) => obj.idOperation === 'Created' &&
    (res.objectTypes?.[obj.objectId] ?? '').endsWith(suffix));
  if (ids.length !== 1) throw new Error(`Expected exactly one ${suffix} in transaction ${res.digest}; found ${ids.length}`);
  return ids[0].objectId;
};
function itemGroups(tx, items) {
  const groups = [[]];
  let size = 3;
  for (const item of items) {
    if (item.length + 2 > PTB_ARG_BYTES) throw new Error('Single proof item exceeds transaction pure argument limit');
    if (size + item.length + 2 > PTB_ARG_BYTES) {
      groups.push([]);
      size = 3;
    }
    groups.at(-1).push(item);
    size += item.length + 2;
  }
  return tx.makeMoveVec({ type: 'vector<vector<u8>>', elements: groups.map((group) => tx.pure(byteItems.serialize(group))) });
}
function cliKeypair() {
  const active = execFileSync('sui', ['client', 'active-address'], { encoding: 'utf8' }).trim();
  const entries = JSON.parse(readFileSync(join(process.env.HOME, '.sui/sui_config/sui.keystore'), 'utf8'));
  for (const entry of entries) {
    const raw = Buffer.from(entry, 'base64');
    if (raw[0] !== 0) continue;
    const key = Ed25519Keypair.fromSecretKey(raw.subarray(1));
    if (key.toSuiAddress() === active) return key;
  }
  throw new Error(`No Ed25519 key for ${active} in Sui keystore`);
}

const preparing = process.argv.includes('--prepare');
const resuming = process.argv.includes('--resume');
const activating = process.argv.includes('--activate');
const insecureDemo = process.argv.includes('--insecure-demo');
if (insecureDemo && !activating) throw new Error('--insecure-demo is only valid with --activate');
if (Number(preparing) + Number(resuming) + Number(activating) !== 1) {
  throw new Error('Choose exactly one of --prepare, --resume or --activate');
}
const startAt = activating ? required('--start-at') : null;
if (activating && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(startAt)) {
  throw new Error('--start-at must be an ISO 8601 UTC timestamp, e.g. 2026-09-27T12:00:00Z');
}
const startAtMs = activating ? Date.parse(startAt) : null;
if (activating && (!Number.isFinite(startAtMs) || new Date(startAtMs).toISOString().slice(0, 19) !== startAt.slice(0, 19))) {
  throw new Error('--start-at must be an actual UTC date and time');
}
const ensureScheduledStart = () => {
  if (startAtMs <= Date.now()) throw new Error('--start-at must still be in the future before activation writes');
};
if (activating) ensureScheduledStart();
const outDir = resolve(required('--out'));
const manifestPath = join(outDir, 'deployment.json');
if (preparing && existsSync(manifestPath)) {
  throw new Error('Preparation manifest already exists; use --resume for an interrupted deployment');
}
if (!preparing && !existsSync(manifestPath)) {
  throw new Error('Resume/activate requires a confirmed --prepare deployment.json');
}
const charts = extractForest();
let manifest = preparing ? null : JSON.parse(readFileSync(manifestPath, 'utf8'));
const resumingDevice = activating && manifest.phase === 'device-registered';
const rpc = optional('--rpc', preparing ? 'https://fullnode.testnet.sui.io:443' : manifest.rpc);
const signer = process.env.SUI_ORGANIZER_PRIVATE_KEY
  ? Ed25519Keypair.fromSecretKey(process.env.SUI_ORGANIZER_PRIVATE_KEY)
  : cliKeypair();
const owner = signer.toSuiAddress();
const client = new SuiGrpcClient({ network: 'testnet', baseUrl: rpc });
let preparations;
if (preparing) {
  const srs = resolve(required('--srs'));
  const prepared = prepareForest(charts, srs, outDir);
  preparations = Object.fromEntries(['easy', 'hard'].map((key) => [key,
    JSON.parse(readFileSync(prepared.artifacts[key].registration, 'utf8'))]));
  const srsSecurity = /(^|\/)dev-srs-24\.bin$/.test(srs) || prepared.srsId.toLowerCase() === KNOWN_INSECURE_SRS_ID
    ? 'INSECURE DEVELOPMENT SRS: NOT MAINNET ELIGIBLE'
    : 'OPERATOR-SUPPLIED SRS: setup provenance must be independently verified';
  manifest = {
    network: 'testnet', rpc, organizer: owner, challengeDurationMs: 21_600_000,
    asset: USDC, srsId: prepared.srsId, srsSecurity,
    charts: publicManifest(charts), chartArtifacts: prepared.artifacts,
    transactions: [], phase: 'preparing',
  };
} else {
  if (!(resumingDevice || manifest.phase === (resuming ? 'preparing' : 'prepared')) || manifest.challengeId ||
      manifest.network !== 'testnet' || manifest.organizer !== owner || manifest.rpc !== rpc ||
      manifest.asset !== USDC || manifest.challengeDurationMs !== 21_600_000 ||
      !manifest.packageId || !manifest.registryId || !manifest.organizerCapId ||
      !manifest.srsId || !manifest.chartArtifacts || !manifest.packagePublishTx || !manifest.registryCreationTx) {
    throw new Error('Preparation manifest is incomplete, already activated, or belongs to another organizer/network');
  }
  const fresh = publicManifest(charts);
  for (const key of ['easy', 'hard']) {
    const old = manifest.charts?.[key];
    if (!old || (!resuming && !old.registrationTx) || old.sourceHash !== fresh[key].sourceHash ||
        old.chartHash !== fresh[key].chartHash || old.noteCount !== fresh[key].noteCount ||
        old.canonicalChartBytes !== fresh[key].canonicalChartBytes || old.osuEntry !== fresh[key].osuEntry ||
        !readFileSync(manifest.chartArtifacts[key].chartBytes).equals(charts[key].chartBytes)) {
      throw new Error(`${key} chart artifact or source hash differs from confirmed preparation`);
    }
  }
  preparations = Object.fromEntries(['easy', 'hard'].map((key) => [key,
    JSON.parse(readFileSync(manifest.chartArtifacts[key].registration, 'utf8'))]));
  if (preparations.easy.vk.srsId !== manifest.srsId || preparations.hard.vk.srsId !== manifest.srsId) {
    throw new Error('Prepared GKR opening does not match deployed SRS');
  }
}
if (resuming) {
  const srs = resolve(required('--srs'));
  const temp = mkdtempSync(join(tmpdir(), 'forest-resume-'));
  try {
    const fresh = prepareForest(charts, srs, temp);
    if (fresh.srsId !== manifest.srsId) throw new Error('Resume SRS verifier key differs from published registry');
    for (const key of ['easy', 'hard']) {
      const generated = readFileSync(fresh.artifacts[key].registration);
      const original = readFileSync(manifest.chartArtifacts[key].registration);
      if (!generated.equals(original)) throw new Error(`${key} original registration opening does not match resume SRS`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
mkdirSync(outDir, { recursive: true });
const checkpoint = () => writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
if (preparing) checkpoint();

async function confirmed(digest) {
  const result = await client.waitForTransaction({ digest, include: { effects: true, objectTypes: true, events: true } });
  const tx = result.Transaction;
  if (!tx?.effects?.status?.success || tx.digest !== digest) throw new Error(`Deployment tx ${digest} not confirmed`);
  return tx;
}

async function execute(step, tx, beforeSubmit) {
  tx.setSender(owner);
  const held = BigInt((await client.getBalance({ owner })).balance.balance);
  const reserve = 300_000_000n;
  if (step.includes('chart validated') && held < GAS_BUDGET + reserve) {
    throw new Error(`Top up ${owner} to at least 3.3 SUI before ${step}; currently ${(Number(held) / 1e9).toFixed(3)} SUI. Chart validation requires a 3 SUI gas budget plus 0.3 SUI reserve.`);
  }
  if (held < reserve + 200_000_000n) {
    throw new Error(`Top up ${owner} before ${step}; current balance ${(Number(held) / 1e9).toFixed(3)} SUI leaves insufficient gas after reserve`);
  }
  const available = held - reserve;
  tx.setGasBudget(available < GAS_BUDGET ? available : GAS_BUDGET);
  let signed;
  try {
    signed = await tx.build({ client });
  } catch (error) {
    if (error.executionError && /InsufficientGas/i.test(error.executionError.message)) {
      throw new Error(`${step} simulated InsufficientGas with ${(Number(held) / 1e9).toFixed(3)} SUI; top up organizer to at least 3.3 SUI and resume`, { cause: error });
    }
    throw error;
  }
  const { signature } = await signer.signTransaction(signed);
  beforeSubmit?.();
  const sent = await client.executeTransaction({ transaction: signed, signatures: [signature],
    include: { effects: true, objectTypes: true, events: true } });
  const digest = sent.Transaction?.digest ?? sent.FailedTransaction?.digest;
  if (!digest) throw new Error(`No transaction digest returned for ${step}`);
  // Inspect the final confirmed transaction, not the optimistic submit response.
  const confirmed = await client.waitForTransaction({ digest, include: { effects: true, objectTypes: true, events: true } });
  const res = confirmed.Transaction ?? confirmed.FailedTransaction;
  if (!res?.effects?.status?.success) throw new Error(`${step} transaction ${digest} failed: ${JSON.stringify(res?.effects?.status?.error)}`);
  manifest.transactions.push({ step, digest });
  checkpoint();
  console.log(JSON.stringify({ step, digest, status: 'confirmed' }));
  return res;
}
async function verifyRegistryObjects() {
  const reg = (await client.getObject({ objectId: manifest.registryId })).object;
  const cap = (await client.getObject({ objectId: manifest.organizerCapId, include: { content: true } })).object;
  if (reg?.type !== `${manifest.packageId}::registry::Registry` || reg.owner?.$kind !== 'Shared' ||
      cap?.type !== `${manifest.packageId}::registry::OrganizerCap` || cap.owner?.AddressOwner !== owner ||
      !cap.content) {
    throw new Error('Registry or organizer capability missing, changed package, or not owned by active signer');
  }
  const parsed = bcs.struct('OrganizerCap', { id: bcs.Address, registry: bcs.Address }).parse(cap.content);
  if (parsed.id !== manifest.organizerCapId || parsed.registry !== manifest.registryId) {
    throw new Error('Organizer capability belongs to a different native Registry');
  }
  return reg;
}


let tx;
let res;
const fn = (module, name) => `${manifest.packageId}::${module}::${name}`;
if (preparing) {
// Publish the current native Move sources, not a previously deployed synthetic token package.
const build = JSON.parse(execFileSync('sui', ['move', 'build', '--dump-bytecode-as-base64', '--path', packagePath],
  { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'inherit'] }));
tx = new Transaction();
tx.transferObjects([tx.publish({ modules: build.modules, dependencies: build.dependencies })], owner);
res = await execute('publish native GKR package', tx);
const packages = res.effects.changedObjects.filter((obj) => obj.outputState === 'PackageWrite');
if (packages.length !== 1) throw new Error(`Expected one package in publish ${res.digest}`);
manifest.packageId = packages[0].objectId;
manifest.packagePublishTx = res.digest;
checkpoint();

const easyPrep = preparations.easy;
tx = new Transaction();
const cap = tx.moveCall({ target: fn('registry', 'create'), arguments: [
  tx.pure.vector('u8', bytes(easyPrep.vk.g2Tau, 96, 'g2Tau')),
  tx.pure(byteItems.serialize(easyPrep.vk.g2Shift.map((item) => bytes(item, 96, 'g2Shift')))),
  tx.pure.u64(CHAIN_ID),
] });
tx.transferObjects([cap], owner);
res = await execute('create shared native registry', tx);
manifest.registryId = created(res, '::registry::Registry');
manifest.organizerCapId = created(res, '::registry::OrganizerCap');
manifest.registryCreationTx = res.digest;
checkpoint();
} else if (resuming) {
  const records = new Map();
  for (const row of manifest.transactions ?? []) {
    if (!row?.step || !row.digest || records.has(row.step)) {
      throw new Error('Resume manifest contains missing or duplicate transaction steps');
    }
    records.set(row.step, await confirmed(row.digest));
  }
  const published = records.get('publish native GKR package');
  const registry = records.get('create shared native registry');
  if (published?.digest !== manifest.packagePublishTx ||
      !published.effects.changedObjects.some((obj) => obj.outputState === 'PackageWrite' && obj.objectId === manifest.packageId) ||
      registry?.digest !== manifest.registryCreationTx ||
      created(registry, '::registry::Registry') !== manifest.registryId ||
      created(registry, '::registry::OrganizerCap') !== manifest.organizerCapId) {
    throw new Error('Confirmed package/registry IDs do not match the checkpoint');
  }
  await verifyRegistryObjects();
  for (const difficulty of ['easy', 'hard']) {
    const label = `${difficulty} chart registered with GKR opening`;
    const registration = records.get(label);
    if (Boolean(registration) !== Boolean(manifest.charts[difficulty].registrationTx)) {
      // A confirmed transaction may have landed between the receipt checkpoint and
      // metadata checkpoint; inspect it rather than signing another register call.
      if (!registration || manifest.charts[difficulty].registrationTx) {
        throw new Error(`${difficulty} registration checkpoint disagrees with confirmed transactions`);
      }
    }
    if (registration) {
      const data = chartRegistered.parse(emitted(registration, '::registry::ChartRegistered'));
      if (hex(data.chart_hash) !== charts[difficulty].chartHash ||
          BigInt(data.notes) !== BigInt(charts[difficulty].noteCount) ||
          !registration.effects.changedObjects.some((obj) => obj.objectId === manifest.registryId)) {
        throw new Error(`${difficulty} on-chain registration does not match this Registry/Forest chart`);
      }
      manifest.charts[difficulty].registrationTx = registration.digest;
      checkpoint();
    }
  }
}

if (preparing || resuming) {
for (const difficulty of ['easy', 'hard']) {
  if (manifest.charts[difficulty].registrationTx) continue;
  const prep = preparations[difficulty];
  const chart = charts[difficulty].chartBytes;
  const noteCount = charts[difficulty].noteCount;
  let upload;
  const uploads = (manifest.transactions ?? []).filter((row) => row.step.startsWith(`${difficulty} chart upload `));
  if (resuming && uploads.length) {
    if (uploads.length !== 1 || uploads[0].step !== `${difficulty} chart upload 0`) {
      throw new Error(`${difficulty} upload has unsupported partial transaction sequence`);
    }
    const receipt = await confirmed(uploads[0].digest);
    upload = created(receipt, '::registry::ChartUpload');
    const onchain = (await client.getObject({ objectId: upload, include: { content: true } })).object;
    if (!onchain?.content || onchain.type !== `${manifest.packageId}::registry::ChartUpload`) {
      throw new Error(`${difficulty} chart upload object is missing or belongs to another package`);
    }
    const expected = Buffer.concat([bytes(upload, 32, 'ChartUpload ID'),
      Buffer.from(bcs.vector(bcs.u8()).serialize([...chart]).toBytes())]);
    const contents = Buffer.from(onchain.content);
    const validated = manifest.transactions.some((row) => row.step.startsWith(`${difficulty} chart validated `));
    if (!contents.subarray(0, expected.length).equals(expected) ||
        contents[expected.length] !== (validated ? 1 : 0) ||
        (!validated && contents.length !== expected.length + 1)) {
      throw new Error(`${difficulty} on-chain ChartUpload bytes/state differ from checkpoint`);
    }
  }
  for (let offset = upload ? chart.length : 0, part = 0; offset < chart.length; part++) {
    tx = new Transaction();
    const staging = upload ? tx.object(upload) : tx.moveCall({ target: fn('registry', 'new_chart_upload') });
    // Keep payload below 100 KB, each pure argument below 16 KiB.
    for (let chunks = 0; chunks < 6 && offset < chart.length; chunks++) {
      tx.moveCall({ target: fn('registry', 'append_chart'), arguments: [staging,
        tx.pure.vector('u8', chart.subarray(offset, offset + PTB_ARG_BYTES))] });
      offset += PTB_ARG_BYTES;
    }
    if (!upload) tx.transferObjects([staging], owner);
    res = await execute(`${difficulty} chart upload ${part}`, tx);
    upload ??= created(res, '::registry::ChartUpload');
  }
  const validationRows = manifest.transactions.filter((row) => row.step.startsWith(`${difficulty} chart validated `));
  let alreadyChecked = 0;
  for (const [index, row] of validationRows.entries()) {
    const expected = Math.min(noteCount, (index + 1) * CHART_NOTES_PER_TX);
    if (row.step !== `${difficulty} chart validated ${expected}/${noteCount}`) {
      throw new Error(`${difficulty} validated chart transaction sequence differs from expected progress`);
    }
    alreadyChecked = expected;
  }
  if (validationRows.length && !upload) throw new Error(`${difficulty} validation exists without its upload`);
  for (let checked = alreadyChecked, first = alreadyChecked === 0; first || checked < noteCount; first = false) {
    tx = new Transaction();
    if (first) tx.moveCall({ target: fn('registry', 'begin_chart'), arguments: [
      tx.object(manifest.registryId), tx.object(upload),
      tx.pure.vector('u8', bytes(prep.commitment, 48, 'chart commitment'))] });
    tx.moveCall({ target: fn('registry', 'process_chart'), arguments: [
      tx.object(upload), tx.pure.u64(CHART_NOTES_PER_TX)] });
    checked = Math.min(noteCount, checked + CHART_NOTES_PER_TX);
    await execute(`${difficulty} chart validated ${checked}/${noteCount}`, tx);
  }
  tx = new Transaction();
  tx.moveCall({ target: fn('registry', 'register_chart'), arguments: [
    tx.object(manifest.registryId), tx.object(manifest.organizerCapId), tx.object(upload),
    itemGroups(tx, prep.proof.map((item) => bytes(item, (item.length - 2) / 2, 'chart proof item'))),
  ] });
  res = await execute(`${difficulty} chart registered with GKR opening`, tx);
  const registered = chartRegistered.parse(emitted(res, '::registry::ChartRegistered'));
  if (hex(registered.chart_hash) !== charts[difficulty].chartHash ||
      BigInt(registered.notes) !== BigInt(noteCount)) {
    throw new Error(`${difficulty} on-chain chart event does not match the prepared Forest notes/hash`);
  }
  manifest.charts[difficulty].registrationTx = res.digest;
  checkpoint();
}
manifest.phase = 'prepared';
checkpoint();
console.log(JSON.stringify(manifest, null, 2));
} else {
const insecureSrs = manifest.srsId.toLowerCase() === KNOWN_INSECURE_SRS_ID || !manifest.srsSecurity || manifest.srsSecurity.startsWith('INSECURE DEVELOPMENT SRS');
if (insecureSrs && !insecureDemo) {
  throw new Error('Secure paid activation requires a reviewed ceremony Sui GKR SRS. This Registry uses dev-srs-24.bin with a known toxic secret; prepare a new Registry and both charts from an approved SRS. Use --insecure-demo only for an explicitly unsafe testnet demonstration.');
}
const roundDate = new Date(startAtMs).toISOString().slice(0, 10);
const devicePubkey = bytes(required('--device-pubkey'), 33, 'device pubkey');
const bitstreamHash = bytes(required('--bitstream-hash'), 32, 'bitstream hash');
const attestor = required('--identity-attestor');
const claimWindowMs = BigInt(optional('--claim-window-ms', '86400000'));
if (BigInt(startAtMs) + 21_600_000n + claimWindowMs > 2n ** 64n - 1n) {
  throw new Error('--claim-window-ms must leave room for scheduled scoring and claiming deadlines');
}
if (!isValidSuiAddress(attestor)) throw new Error('--identity-attestor must be a Sui wallet address');
if (claimWindowMs <= 0n) {
  throw new Error('--claim-window-ms must be a positive u64');
}
if (![2, 3].includes(devicePubkey[0])) throw new Error('Device key must be compressed secp256k1');
if (bitstreamHash.every((value) => value === bitstreamHash[0])) {
  throw new Error('Refusing a synthetic repeated-byte device bitstream hash');
}
if (bytes(preparations.easy.devicePubkey, 33, 'Rust demo device key').equals(devicePubkey)) {
  throw new Error('Rust development software signer is not a provisioned hardware device');
}
const fullPubkey = ECDH.convertKey(devicePubkey, 'secp256k1', undefined, undefined, 'uncompressed');
const deviceAddress = hex(keccak_256(fullPubkey.subarray(1)).subarray(12));
const { coinMetadata } = await client.getCoinMetadata({ coinType: USDC });
if (!coinMetadata || coinMetadata.decimals !== 6 || coinMetadata.symbol !== 'USDC') {
  throw new Error('No six-decimal Circle-issued native testnet USDC metadata at RPC');
}
const { function: createAbi } = await client.getMoveFunction({ packageId: manifest.packageId, moduleName: 'competition', name: 'create' });
const { function: buyAbi } = await client.getMoveFunction({ packageId: manifest.packageId, moduleName: 'competition', name: 'buy_plays' });
if (createAbi.parameters.length !== 11 || createAbi.parameters[8].body.$kind !== 'u64' ||
    buyAbi.parameters.length !== 5 || buyAbi.parameters[2].body.$kind !== 'u8') {
  throw new Error('Published competition package has the old shared-pot ABI; prepare and activate a new difficulty-isolated package. No device or Challenge was created by this invocation.');
}

const published = await confirmed(manifest.packagePublishTx);
if (!published.effects.changedObjects.some((obj) => obj.outputState === 'PackageWrite' && obj.objectId === manifest.packageId)) {
  throw new Error('Package ID does not match published transaction');
}
const registry = await confirmed(manifest.registryCreationTx);
if (created(registry, '::registry::Registry') !== manifest.registryId ||
    created(registry, '::registry::OrganizerCap') !== manifest.organizerCapId) {
  throw new Error('Registry/cap IDs do not match registry creation transaction');
}
const verifiedRegistry = await verifyRegistryObjects();
for (const key of ['easy', 'hard']) {
  const registration = await confirmed(manifest.charts[key].registrationTx);
  const data = chartRegistered.parse(emitted(registration, '::registry::ChartRegistered'));
  if (hex(data.chart_hash) !== charts[key].chartHash || BigInt(data.notes) !== BigInt(charts[key].noteCount)) {
    throw new Error(`${key} chart commitment has not been confirmed on this registry`);
  }
  if (Buffer.from(preparations[key].chartBytes.slice(2), 'hex').compare(charts[key].chartBytes) !== 0 ||
      preparations[key].chartHash !== charts[key].chartHash) {
    throw new Error(`${key} prepared Rust opening differs from confirmed Forest chart`);
  }
}
if (resumingDevice) {
  if (!manifest.deviceRegistrationTx || manifest.scheduledStartAtMs !== String(startAtMs) ||
      manifest.deviceAddress !== deviceAddress || manifest.devicePubkey !== hex(devicePubkey) ||
      manifest.bitstreamHash !== hex(bitstreamHash) || manifest.identityAttestor !== attestor ||
      manifest.insecureDemo !== insecureDemo) {
    throw new Error('Registered device checkpoint differs from the requested activation; do not create a second round');
  }
  const registeredDevice = await confirmed(manifest.deviceRegistrationTx);
  if (!registeredDevice.effects.changedObjects.some((obj) => obj.objectId === manifest.registryId)) {
    throw new Error('Device registration receipt did not update the expected Registry');
  }
}
ensureScheduledStart();
manifest.roundDate = roundDate;
manifest.scheduledStartAtMs = startAtMs.toString();
manifest.roundId = hex(sha256(`versu:${roundDate}`));
manifest.claimWindowMs = claimWindowMs.toString();
manifest.deviceAddress = deviceAddress;
manifest.devicePubkey = hex(devicePubkey);
manifest.bitstreamHash = hex(bitstreamHash);
manifest.deviceProvisioning = insecureDemo
  ? 'INSECURE DEMO: extractable SD-image signing key; bitstream hash is a build marker, not FPGA attestation; signature-only test did not verify commitment'
  : 'OPERATOR-SUPPLIED PUBLIC KEY ONLY; no board attestation or hardware score is implied';
manifest.insecureDemo = insecureDemo;
manifest.identityAttestor = attestor;
// Register the device with &mut Registry, then use &Registry immutably for
// Challenge creation in a separate transaction. Checkpoint each confirmed digest.
if (!resumingDevice) {
  manifest.phase = 'activating';
  checkpoint();
  tx = new Transaction();
  tx.moveCall({ target: fn('registry', 'set_device'), arguments: [tx.object(manifest.registryId),
    tx.object(manifest.organizerCapId), tx.pure.vector('u8', devicePubkey),
    tx.pure.vector('u8', bitstreamHash), tx.pure.bool(true)] });
  res = await execute('register device for Forest Challenge', tx, ensureScheduledStart);
  manifest.deviceRegistrationTx = res.digest;
  manifest.phase = 'device-registered';
  checkpoint();
}
tx = new Transaction();

// Schedule scoring from the immutable requested UTC start, not the creation transaction time.
const identityCap = tx.moveCall({ target: fn('competition', 'create'), typeArguments: [USDC], arguments: [
  tx.sharedObjectRef({ objectId: manifest.registryId, initialSharedVersion: verifiedRegistry.owner.Shared.initialSharedVersion, mutable: false }), tx.object(manifest.organizerCapId),
  tx.pure.vector('u8', new TextEncoder().encode(roundDate)),
  tx.pure.vector('u8', sha256(`versu:${roundDate}`)),
  tx.pure.vector('u8', bytes(charts.easy.chartHash, 32, 'Easy chart hash')),
  tx.pure.vector('u8', bytes(charts.hard.chartHash, 32, 'Hard chart hash')),
  tx.pure.vector('u8', bytes(deviceAddress, 20, 'device address')),
  tx.pure.u64(startAtMs), tx.pure.u64(claimWindowMs), tx.object.clock(),
] });
tx.transferObjects([identityCap], attestor);
res = await execute('schedule Forest Challenge<CircleUSDC>', tx, ensureScheduledStart);
manifest.challengeId = created(res, '::competition::Challenge<'+USDC+'>');
manifest.identityCapId = created(res, '::competition::IdentityCap');
const event = challengeCreated.parse(emitted(res, '::competition::ChallengeCreated'));
if (event.challenge !== manifest.challengeId || event.registry !== manifest.registryId ||
    Buffer.from(event.round_date).toString('utf8') !== roundDate ||
    hex(event.round_id) !== manifest.roundId ||
    hex(event.easy_chart_hash) !== charts.easy.chartHash ||
    hex(event.hard_chart_hash) !== charts.hard.chartHash ||
    BigInt(event.started_at_ms) !== BigInt(startAtMs) ||
    BigInt(event.score_deadline_ms) !== BigInt(startAtMs) + 21_600_000n ||
    BigInt(event.claim_window_ms) !== claimWindowMs ||
    BigInt(event.claim_deadline_ms) !== BigInt(startAtMs) + 21_600_000n + claimWindowMs) {
  throw new Error(`Challenge creation event in ${res.digest} does not match configured charts/timing`);
}
manifest.startedAtMs = event.started_at_ms;
manifest.scoreDeadlineMs = event.score_deadline_ms;
manifest.claimDeadlineMs = event.claim_deadline_ms;
manifest.challengeCreationTx = res.digest;
manifest.worldIdentityConfiguration = { [manifest.challengeId]: { identityCapId: manifest.identityCapId } };
manifest.browserConfiguration = {
  VITE_SUI_PACKAGE_ID: manifest.packageId,
  VITE_SUI_REGISTRY_ID: manifest.registryId,
  VITE_SUI_CHALLENGE_ID: manifest.challengeId,
  VITE_SUI_EASY_CHART_HASH: charts.easy.chartHash,
  VITE_SUI_HARD_CHART_HASH: charts.hard.chartHash,
  VITE_SUI_USDC_TYPE: USDC,
  VITE_SUI_INSECURE_DEMO: insecureDemo ? 'true' : 'false',
  VITE_BEATMAP_URL: '/beatmaps/forest.osz',
};
manifest.phase = 'active';
checkpoint();
console.log(JSON.stringify(manifest, null, 2));
}
