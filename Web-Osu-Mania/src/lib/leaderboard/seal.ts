import {
  bytesToHex,
  hexToBytes,
  concat,
  toHex,
  sha256,
  stringToHex,
  recoverAddress,
  type Hex,
} from "viem";
import type { Capture, Saved } from "./capture";
export const policy = sha256(stringToHex("OSUMANIA_INPUT_POLICY_V2_KZG"));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
export type Header = {
  chainId: bigint;
  verifier: Hex;
  matchId: Hex;
  sessionId: Hex;
  challenge: Hex;
  player: Hex;
  device: Hex;
  chartHash: Hex;
  rulesetId: Hex;
  bitstreamHash: Hex;
  inputPolicyHash: Hex;
};
export function packHeader(h: Header): Hex {
  return concat([
    toHex(h.chainId, { size: 8 }),
    h.verifier,
    h.matchId,
    h.sessionId,
    h.challenge,
    h.player,
    h.device,
    h.chartHash,
    h.rulesetId,
    h.bitstreamHash,
    h.inputPolicyHash,
  ]).toLowerCase() as Hex;
}
export async function validateCapture(c: Capture, r: Saved) {
  assert(r.header && r.setup, "Missing original session metadata");
  const b = hexToBytes(c.result),
    trace = hexToBytes(c.trace),
    v = new DataView(b.buffer);
  assert(
    b.length === 465 && bytesToHex(b.slice(0, 292)) === r.header,
    "Original header mismatch",
  );
  const n = v.getUint32(292),
    duration = v.getBigUint64(296);
  assert(
    n <= r.setup.hardwareSrs.maxEvents && n <= 50000 && trace.length === n * 14,
    "Trace count/capacity mismatch",
  );
  assert(
    duration <= 1800000000n && duration >= BigInt(r.setup.maxEnd + 136500),
    "Invalid signed duration",
  );
  const tv = new DataView(trace.buffer),
    keys = [false, false, false, false];
  let last = 0n;
  for (let i = 0; i < n; i++) {
    const offset = i * 14,
      t = tv.getBigUint64(offset + 4),
      lane = trace[offset + 12],
      action = trace[offset + 13];
    assert(
      tv.getUint32(offset) === i &&
        t >= last &&
        t <= duration &&
        lane < 4 &&
        action < 2 &&
        keys[lane] !== (action === 0),
      "Invalid event sequence, transition or timestamp",
    );
    last = t;
    keys[lane] = action === 0;
  }
  let root = sha256(
    concat([stringToHex("OSUMANIA_TRACE_V1"), r.attempt.sessionId]),
  );
  for (let i = 0; i < n; i += 32)
    root = sha256(
      concat([
        root,
        toHex(i / 32, { size: 4 }),
        toHex(Math.min(32, n - i), { size: 2 }),
        bytesToHex(trace.slice(i * 14, Math.min(i + 32, n) * 14)),
      ]),
    );
  assert(root === bytesToHex(b.slice(304, 336)), "Trace root mismatch");
  const digest = sha256(
    concat([
      stringToHex("OSUMANIA_HARDWARE_SESSION_V2"),
      toHex(2, { size: 2 }),
      bytesToHex(b.slice(0, 400)),
    ]),
  );
  const signature = bytesToHex(b.slice(400));
  const s = BigInt(bytesToHex(b.slice(432, 464)));
  assert(
    [27, 28].includes(b[464]) &&
      s > 0n &&
      s <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n,
    "Noncanonical signature",
  );
  assert(
    same(
      await recoverAddress({ hash: digest, signature }),
      bytesToHex(b.slice(144, 164)),
    ),
    "Raw-digest device signature mismatch",
  );
  return {
    n,
    duration,
    root,
    digest,
    signature,
    commitment: [
      bytesToHex(b.slice(336, 368)),
      bytesToHex(b.slice(368, 400)),
    ] as const,
  };
}
