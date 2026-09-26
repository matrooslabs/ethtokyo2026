// End-to-end run on a Sui network (default: localnet from `sui start --with-faucet`).
//
//   node sui_e2e.mjs --srs ../artifacts/dev-srs-24.bin --case bench3000 [--modes a,b]
//   node sui_e2e.mjs --network testnet --case bench500 ...   # signs with the active `sui client` key
//
// Publishes the Move package, creates a registry, registers the demo device and the chart
// (on-chain validation + commitment check), opens sessions, lets the Rust sidecar prove
// against the contract-issued header, and submits. Prints gas per transaction.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bcs } from '@mysten/sui/bcs';
import { getFaucetHost, requestSuiFromFaucetV2 } from '@mysten/sui/faucet';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'target/release/mania-gkr-sui');
const SRS = resolve(arg('--srs', join(ROOT, 'artifacts/dev-srs-24.bin')));
const CASE = arg('--case', 'bench3000');
const MODES = arg('--modes', 'a,b').split(',');
const NETWORK = arg('--network', 'localnet');
const RPC = arg('--rpc', NETWORK === 'localnet' ? 'http://127.0.0.1:9000' : `https://fullnode.${NETWORK}.sui.io:443`);
// Per-tx budget (must not exceed the gas coin): the largest step is ~1.8M units + storage.
const GAS_BUDGET = BigInt(arg('--gas-budget', NETWORK === 'localnet' ? '8000000000' : '3000000000'));
const CHAIN_ID = 0x5ec7n; // Sui has no numeric chain id; the registry carries one for the V1 header
const PTB_ARG_BYTES = 15_000; // pure arguments are capped at 16 KiB
const TX_PAYLOAD_BYTES = 100_000; // transactions are capped at 128 KiB
const CHART_NOTES_PER_TX = 3_000;

/// localnet: a fresh key funded by the faucet; other networks: the active `sui client` key.
function cliKeypair() {
  const active = execFileSync('sui', ['client', 'active-address'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  const keystore = JSON.parse(readFileSync(join(process.env.HOME, '.sui/sui_config/sui.keystore'), 'utf8'));
  for (const entry of keystore) {
    const raw = Buffer.from(entry, 'base64');
    if (raw[0] !== 0) continue; // ed25519 only
    const kp = Ed25519Keypair.fromSecretKey(raw.subarray(1));
    if (kp.toSuiAddress() === active) return kp;
  }
  throw new Error(`no ed25519 key for ${active} in the sui keystore`);
}
const client = new SuiGrpcClient({ baseUrl: RPC, network: NETWORK });
const signer = NETWORK === 'localnet' ? new Ed25519Keypair() : cliKeypair();
const me = signer.toSuiAddress();
const work = mkdtempSync(join(tmpdir(), 'mgkr-sui-'));
const rows = [];

const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => Uint8Array.from(Buffer.from(s.replace(/^0x/, ''), 'hex'));
const sidecar = (...a) => JSON.parse(execFileSync(BIN, a, { maxBuffer: 1 << 28 }).toString());

/// Splits byte items into lists whose BCS fits one pure argument.
function groups(items, max = PTB_ARG_BYTES) {
  const out = [[]];
  let size = 3;
  for (const it of items) {
    if (size + it.length + 2 > max && out.at(-1).length) {
      out.push([]);
      size = 3;
    }
    out.at(-1).push(it);
    size += it.length + 2;
  }
  return out;
}

const itemList = bcs.vector(bcs.vector(bcs.u8()));
/// vector<vector<vector<u8>>> argument from byte items, one pure argument per group.
const itemGroups = (tx, items) =>
  tx.makeMoveVec({
    type: 'vector<vector<u8>>',
    elements: groups(items).map((g) => tx.pure(itemList.serialize(g))),
  });

async function exec(label, tx, { expectFailure = false } = {}) {
  tx.setSender(me);
  // Never exceed what the account holds (small testnet balances).
  const held = BigInt((await client.getBalance({ owner: me })).balance.balance);
  tx.setGasBudget(GAS_BUDGET < (held * 9n) / 10n ? GAS_BUDGET : (held * 9n) / 10n);
  let bytes;
  try {
    bytes = await tx.build({ client });
  } catch (e) {
    // Building simulates the transaction; an abort there means the network would reject it.
    if (!expectFailure || !e.executionError) throw e;
    const row = { step: label, ok: false, rejectedBy: 'simulation', error: e.executionError.message };
    rows.push(row);
    console.log(JSON.stringify(row));
    return null;
  }
  const { signature } = await signer.signTransaction(bytes);
  const out = await client.executeTransaction({
    transaction: bytes,
    signatures: [signature],
    include: { effects: true, objectTypes: true },
  });
  const res = out.Transaction ?? out.FailedTransaction;
  await client.waitForTransaction({ digest: res.digest });
  const ok = res.effects.status.success;
  const g = res.effects.gasUsed;
  const price = await gasPrice();
  const row = {
    step: label,
    digest: res.digest,
    ok,
    txBytes: bytes.length,
    computationUnits: Number(BigInt(g.computationCost) / price),
    computationSui: Number(g.computationCost) / 1e9,
    storageSui: (Number(g.storageCost) - Number(g.storageRebate)) / 1e9,
    error: ok ? undefined : JSON.stringify(res.effects.status.error),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
  if (ok === expectFailure) throw new Error(`${label}: unexpected ${ok ? 'success' : 'failure'}`);
  return res;
}

let rgp;
const gasPrice = async () => (rgp ??= BigInt((await client.getReferenceGasPrice()).referenceGasPrice));
const created = (res, suffix) =>
  res.effects.changedObjects.find((c) => c.idOperation === 'Created' && (res.objectTypes[c.objectId] ?? '').endsWith(suffix)).objectId;

// BCS layout of registry::Session (read back from chain).
const bytesT = bcs.vector(bcs.u8());
const Header = bcs.struct('Header', {
  chain_id: bcs.u64(), verifier: bytesT, match_id: bytesT, session_id: bytesT, challenge: bytesT, player: bytesT,
  device: bytesT, chart_hash: bytesT, ruleset_id: bytesT, bitstream_hash: bytesT, input_policy_hash: bytesT,
});
const Session = bcs.struct('Session', {
  id: bcs.Address, registry: bcs.Address, header: Header, player: bcs.Address, mode: bcs.u8(),
  expires_at_ms: bcs.u64(), consumed: bcs.bool(), score: bcs.u64(), judgements: bcs.vector(bcs.u64()),
});
const readSession = async (id) => Session.parse((await client.getObject({ objectId: id, include: { content: true } })).object.content);

async function main() {
  if (NETWORK === 'localnet') {
    for (let i = 0; i < 3; i++) await requestSuiFromFaucetV2({ host: getFaucetHost('localnet'), recipient: me });
  }
  const bal = await client.getBalance({ owner: me });
  console.log(JSON.stringify({ network: NETWORK, signer: me, balanceSui: Number(bal.balance.balance) / 1e9 }));

  // Publish.
  const build = JSON.parse(
    execFileSync('sui', ['move', 'build', '--dump-bytecode-as-base64', '--path', join(ROOT, 'move')], {
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1 << 26,
    }).toString(),
  );
  let tx = new Transaction();
  tx.transferObjects([tx.publish({ modules: build.modules, dependencies: build.dependencies })], me);
  let res = await exec('publish', tx);
  const pkg = res.effects.changedObjects.find((c) => c.outputState === 'PackageWrite').objectId;
  console.log(JSON.stringify({ step: 'published', packageId: pkg, digest: res.digest }));
  const fn = (m, f) => `${pkg}::${m}::${f}`;

  // Sidecar: chart commitment/opening, verifier key and the demo device.
  const playPath = join(work, 'play.json');
  execFileSync(BIN, ['play', '--case', CASE, '--out', playPath]);
  const prep = sidecar('prepare-chart', '--srs', SRS, '--input', playPath);

  // Registry + device.
  tx = new Transaction();
  const cap = tx.moveCall({
    target: fn('registry', 'create'),
    arguments: [
      tx.pure.vector('u8', unhex(prep.vk.g2Tau)),
      tx.pure(itemList.serialize(prep.vk.g2Shift.map(unhex))),
      tx.pure.u64(CHAIN_ID),
    ],
  });
  tx.transferObjects([cap], me);
  res = await exec('create registry', tx);
  const registry = created(res, '::registry::Registry');
  const capId = created(res, '::registry::OrganizerCap');
  console.log(JSON.stringify({ step: 'registry', registry, organizerCap: capId, srsId: prep.vk.srsId }));
  tx = new Transaction();
  tx.moveCall({
    target: fn('registry', 'set_device'),
    arguments: [tx.object(registry), tx.object(capId), tx.pure.vector('u8', unhex(prep.devicePubkey)), tx.pure.vector('u8', new Uint8Array(32).fill(4)), tx.pure.bool(true)],
  });
  await exec('set device', tx);

  // Chart registration: upload bytes (≤100 KB per tx), validate notes (≤3,000 per tx), finish.
  const chart = unhex(prep.chartBytes);
  const notes = (chart.length - 24) / 17;
  let upload;
  for (let off = 0, part = 0; off < chart.length; part++) {
    tx = new Transaction();
    const up = upload ? tx.object(upload) : tx.moveCall({ target: fn('registry', 'new_chart_upload') });
    for (let budget = TX_PAYLOAD_BYTES; off < chart.length && budget > 0; budget -= PTB_ARG_BYTES) {
      tx.moveCall({ target: fn('registry', 'append_chart'), arguments: [up, tx.pure.vector('u8', chart.slice(off, off + PTB_ARG_BYTES))] });
      off += PTB_ARG_BYTES;
    }
    if (!upload) tx.transferObjects([up], me);
    res = await exec(`chart upload ${part}`, tx);
    upload ??= created(res, '::registry::ChartUpload');
  }
  for (let done = 0, first = true; first || done < notes; first = false) {
    tx = new Transaction();
    if (first) tx.moveCall({ target: fn('registry', 'begin_chart'), arguments: [tx.object(registry), tx.object(upload), tx.pure.vector('u8', unhex(prep.commitment))] });
    tx.moveCall({ target: fn('registry', 'process_chart'), arguments: [tx.object(upload), tx.pure.u64(CHART_NOTES_PER_TX)] });
    done = Math.min(notes, done + CHART_NOTES_PER_TX);
    await exec(`chart check ${done}/${notes}`, tx);
  }
  tx = new Transaction();
  tx.moveCall({ target: fn('registry', 'register_chart'), arguments: [tx.object(registry), tx.object(capId), tx.object(upload), itemGroups(tx, prep.proof.map(unhex))] });
  await exec('chart register (opening)', tx);

  for (const mode of MODES) {
    // Session: the contract issues the header the device records against.
    tx = new Transaction();
    tx.moveCall({
      target: fn('registry', 'open_session'),
      arguments: [
        tx.object(registry), tx.object(capId), tx.pure.vector('u8', new Uint8Array(32).fill(mode === 'a' ? 0xa : 0xb)),
        tx.pure.vector('u8', unhex(prep.chartHash)), tx.pure.address(me), tx.pure.vector('u8', unhex(prep.deviceAddress)),
        tx.pure.u64(BigInt(Date.now() + 3_600_000)), tx.pure.u8(mode === 'a' ? 1 : 2), tx.object.clock(),
      ],
    });
    res = await exec(`open session (${mode})`, tx);
    const session = created(res, '::registry::Session');
    const h = (await readSession(session)).header;
    const header = {
      chainId: h.chain_id, verifier: hex(h.verifier), matchId: hex(h.match_id), sessionId: hex(h.session_id),
      challenge: hex(h.challenge), player: hex(h.player), device: hex(h.device), chartHash: hex(h.chart_hash),
      rulesetId: hex(h.ruleset_id), bitstreamHash: hex(h.bitstream_hash), inputPolicyHash: hex(h.input_policy_hash),
    };
    const headerPath = join(work, `header-${mode}.json`);
    writeFileSync(headerPath, JSON.stringify(header));
    const t0 = Date.now();
    const sub = sidecar('prove-session', '--srs', SRS, '--input', playPath, '--mode', mode, '--header', headerPath);
    console.log(JSON.stringify({ step: `prove (${mode})`, proveMs: sub.proveMs, wallMs: Date.now() - t0, proofBytes: sub.proofBytes, events: sub.n }));

    const common = (tx) => [
      tx.pure.u64(sub.duration), tx.pure.vector('u64', sub.laneBits), tx.pure.vector('u64', sub.counts),
      itemGroups(tx, sub.proof.map(unhex)), tx.pure.vector('u8', unhex(sub.sig)), tx.object.clock(),
    ];
    const submit = (tx, counts) => {
      const args = common(tx);
      if (counts) args[2] = tx.pure.vector('u64', counts);
      if (mode === 'a') {
        return tx.moveCall({ target: fn('registry', 'submit_calldata'), arguments: [tx.object(registry), tx.object(session), tx.object(trace), ...args] });
      }
      return tx.moveCall({
        target: fn('registry', 'submit_committed'),
        arguments: [tx.object(registry), tx.object(session), tx.pure.u64(sub.n), tx.pure.vector('u8', unhex(sub.traceRoot)), tx.pure.vector('u8', unhex(sub.traceCommitment)), ...args],
      });
    };

    let trace;
    if (mode === 'a') {
      // Mode A: stage the device chunks (SHA-256 chain recomputed on-chain), ≤100 KB per tx.
      const chunks = sub.eventChunks.map(unhex);
      for (let i = 0, part = 0; i < chunks.length; part++) {
        tx = new Transaction();
        const up = trace ? tx.object(trace) : tx.moveCall({ target: fn('registry', 'new_trace_upload'), arguments: [tx.object(session)] });
        let size = 0;
        const batch = [];
        while (i < chunks.length && size + chunks[i].length <= TX_PAYLOAD_BYTES) size += chunks[(batch.push(chunks[i]), i++)].length;
        for (const g of groups(batch)) tx.moveCall({ target: fn('registry', 'append_trace'), arguments: [up, tx.pure(itemList.serialize(g))] });
        if (!trace) tx.transferObjects([up], me);
        res = await exec(`trace upload ${part} (a)`, tx);
        trace ??= created(res, '::registry::TraceUpload');
      }
    }
    // Relabelling one judgement (same total) must fail inside the proof check; a failed
    // transaction consumes nothing, so the trace upload stays usable.
    const forged = [...sub.counts];
    const from = forged.findIndex((c) => c > 0);
    forged[from] -= 1;
    forged[(from + 1) % 5] += 1;
    tx = new Transaction();
    submit(tx, forged);
    await exec(`submit forged counts (${mode})`, tx, { expectFailure: true });

    tx = new Transaction();
    submit(tx);
    await exec(`submit (${mode})`, tx);
    const done = await readSession(session);
    console.log(JSON.stringify({ step: `recorded (${mode})`, score: done.score, expected: sub.expectedScore, judgements: done.judgements, consumed: done.consumed }));
    if (Number(done.score) !== sub.expectedScore || !done.consumed) throw new Error('score mismatch');
  }
  const out = arg('--out');
  if (out) writeFileSync(out, JSON.stringify({ network: NETWORK, case: CASE, rows }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
