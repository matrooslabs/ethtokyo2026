import { bytesToHex, hexToBytes, type Hex, type PublicClient } from "viem";
import { Board, command, selectBoard } from "./hid";
import { registryAbi, registryAddress } from "./contracts";
import { competitionChain } from "@/lib/walletConfig";
import {
  getChartSetup,
  scoringRequest,
  type ChartSetup,
  type PaidAttempt,
} from "./scoring";
import { save, saved, type Saved } from "./captureStore";
export {
  save,
  saved,
  allSaved,
  type Saved,
  type Capture,
} from "./captureStore";
const key = (a: PaidAttempt) =>
  `${a.chainId}:${a.registry.toLowerCase()}:${a.sessionId.toLowerCase()}`;
import { policy, packHeader, validateCapture } from "./seal";
export { policy, packHeader, validateCapture } from "./seal";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
let board: Board | undefined;
const recording = new Set<string>();
export async function connectHardware() {
  const optionalId = (value: string | undefined) => {
    if (!value) return undefined;
    const id = Number(value);
    assert(
      Number.isInteger(id) && id >= 0 && id <= 65535,
      "Invalid optional HID VID/PID",
    );
    return id;
  };
  board = await selectBoard({
    vendorId: optionalId(import.meta.env.VITE_HID_VENDOR_ID),
    productId: optionalId(import.meta.env.VITE_HID_PRODUCT_ID),
  });
  return board.status();
}
export async function preflight(setup: ChartSetup, client: PublicClient) {
  assert(board, "Connect the capture board before paying.");
  assert(setup.ready, setup.reason || "Prover not ready");
  assert(
    setup.mode === 2 &&
      registryAddress &&
      same(setup.registry, registryAddress) &&
      setup.captureMode === "hardware",
    "Mode B registry configuration required",
  );
  assert(
    (await client.readContract({
      address: setup.registry,
      abi: registryAbi,
      functionName: "PAID_SESSION_MODE",
    })) === 2,
    "Registry does not open Mode B paid sessions",
  );
  const b = await board.request(command.info, undefined, 128),
    v = new DataView(b.buffer);
  const h = setup.hardwareSrs;
  assert(
    v.getUint16(0) === 1 && v.getUint16(2) === 64 && v.getUint32(4) === 0,
    "Unsupported board protocol",
  );
  assert(
    same(bytesToHex(b.slice(8, 28)), setup.device) &&
      bytesToHex(b.slice(60, 92)) === policy,
    "Device signer/policy mismatch",
  );
  const registered = await client.readContract({
    address: setup.registry,
    abi: registryAbi,
    functionName: "devices",
    args: [setup.device],
  });
  assert(
    registered[1] && same(registered[0], bytesToHex(b.slice(28, 60))),
    "Device inactive or bitstream mismatch",
  );
  assert(
    h &&
      same(h.bankHash, bytesToHex(b.slice(92, 124))) &&
      h.maxEvents === v.getUint32(124) &&
      h.bankLength === h.maxEvents * 4,
    "Unapproved hardware SRS bank/capacity",
  );
  assert(
    (await board.status()).state === 0,
    "Board is not IDLE. Recover finalized data or explicitly discard before payment.",
  );
  return { bitstreamHash: registered[0], capacity: h.maxEvents };
}
export async function prepare(a: PaidAttempt, client: PublicClient) {
  const existing = await saved(a);
  assert(
    !existing?.started && !existing?.capture && !existing?.interrupted,
    "This attempt has already started. Recover its capture; it cannot restart.",
  );
  const setup = await getChartSetup(a.webBeatmapHash);
  assert(setup.ready, "Prover not ready");
  const info = await preflight(setup, client);
  const session = await client.readContract({
    address: a.registry,
    abi: registryAbi,
    functionName: "getSession",
    args: [a.sessionId],
  });
  const h = session.header;
  assert(
    session.mode === 2 &&
      !session.consumed &&
      Number(session.expiresAt) >
        Date.now() / 1000 + setup.durationSeconds + setup.provingBufferSeconds,
    "Session expired, consumed or wrong mode",
  );
  assert(
    h.chainId === BigInt(competitionChain.id) &&
      same(h.verifier, a.registry) &&
      same(h.player, a.player) &&
      same(h.device, setup.device) &&
      same(h.sessionId, a.sessionId) &&
      same(h.chartHash, a.chartHash) &&
      same(h.bitstreamHash, info.bitstreamHash) &&
      h.inputPolicyHash === policy,
    "Paid header mismatch",
  );
  const header = packHeader(h);
  const response = await scoringRequest<{ header: Hex }>(
    `/sessions/${a.sessionId}/start`,
    a,
  );
  assert(
    same(response.header, header),
    "Canonical server header differs from registry",
  );
  await save({ attempt: a, header, setup });
}
export async function startCapture(a: PaidAttempt) {
  const r = await saved(a);
  assert(
    board && r?.header && !r.started && !r.interrupted,
    "Capture not prepared or already attempted",
  );
  r.started = true;
  await save(r); // Persist before any state-changing command.
  await board.request(command.header, hexToBytes(r.header), 0);
  await board.request(command.start, undefined, 0);
  recording.add(key(a));
}
export async function interruptCapture(a: PaidAttempt) {
  recording.delete(key(a));
  const r = await saved(a);
  if (r && !r.capture) {
    r.interrupted = true;
    await save(r);
  }
}
const finishing = new Map<string, Promise<Saved>>();
export function finishCapture(a: PaidAttempt): Promise<Saved> {
  const id = key(a);
  const pending = finishing.get(id);
  if (pending) return pending;
  const p = collect(a);
  finishing.set(id, p);
  void p.finally(() => finishing.delete(id)).catch(() => {});
  return p;
}
async function collect(a: PaidAttempt) {
  const r = await saved(a);
  assert(r && board, "Reconnect the board to recover this attempt");
  if (r.capture) return r;
  const status = await board.status();
  if (status.state === 2) {
    assert(
      recording.has(key(a)) && !r.interrupted,
      "Interrupted recording cannot be submitted. Explicitly discard it.",
    );
    const remaining = BigInt(r.setup!.maxEnd + 136500) - status.duration;
    if (remaining > 0n)
      await new Promise((resolve) =>
        setTimeout(resolve, Number(remaining / 1000n) + 1),
      );
    await board.request(command.stop, undefined, 0);
  } else
    assert(
      status.state === 3,
      "No finalized capture. A disconnected recording cannot resume. ERROR requires explicit discard.",
    );
  assert(
    !r.interrupted,
    "Interrupted attempts cannot be submitted. Explicitly discard the board capture.",
  );
  recording.delete(key(a));
  const result = await board.request(command.result, undefined, 465);
  const n = new DataView(result.buffer).getUint32(292);
  assert(
    n <= 50000 && n <= r.setup!.hardwareSrs.maxEvents,
    "Invalid result capacity",
  );
  const trace = await board.request(command.trace, undefined, n * 14);
  const c = {
    result: bytesToHex(result),
    trace: bytesToHex(trace),
    webBeatmapHash: a.webBeatmapHash,
  };
  await validateCapture(c, r);
  r.capture = c;
  await save(r); // ABORT only after the immutable bytes are durably committed.
  await board.request(command.abort, undefined, 0);
  return r;
}
export async function discardHardware() {
  assert(board, "Connect board first");
  await board.request(command.abort, undefined, 0);
}
