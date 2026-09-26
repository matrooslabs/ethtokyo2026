// BridgeOS bridge-daemon/osumania_protocol.h and osumania_vendor.c, v1.
export const BRIDGE_FILTER = {
  vendorId: 0xd86a,
  productId: 0x1000,
  usagePage: 0xff60,
  usage: 0x01,
} as const; // bridge-gadget.conf and bridge-gadget Vendor HID descriptor

export const REPORT_SIZE = 64;
const HEADER_SIZE = 16;
const FRAGMENT_SIZE = REPORT_SIZE - HEADER_SIZE;
const MAGIC = 0x4d;
const VERSION = 1;
const RESPONSE = 1;
const ERROR = 2;
export const GET_INFO = 1;
export const GET_STATUS = 2;
export const SET_HEADER = 0x10;
export const START = 0x11;
export const STOP = 0x12;
export const ABORT = 0x13;
export const GET_RESULT = 0x20;
export const GET_TRACE = 0x21;
export const LIVE_EVENT = 0x30;
export type BridgeLiveEvent = { seq: number; timestampUs: bigint; lane: number; action: 0 | 1 };

// Unsolicited Vendor HID traffic is a local input sideband, not signed scoring evidence.
// Only frames identifying themselves as live events are validated here; other reports
// belong to the request/response assembler.
export function parseLiveEvent(report: Uint8Array): BridgeLiveEvent | null {
  if (report[2] !== LIVE_EVENT) return null;
  if (report.length !== REPORT_SIZE) throw new Error('Invalid BridgeOS live event report length');
  const data = view(report);
  if (report[0] !== MAGIC || report[1] !== VERSION || report[3] !== 0x04 ||
      data.getUint32(4) !== 0 || data.getUint32(8) !== 0 || data.getUint32(12) !== 14 ||
      report[28] > 3 || report[29] > 1 || report.subarray(30).some((byte) => byte !== 0)) {
    throw new Error('Malformed BridgeOS live event');
  }
  return { seq: data.getUint32(16), timestampUs: data.getBigUint64(20),
    lane: report[28], action: report[29] as 0 | 1 };
}
export type Command = typeof GET_INFO | typeof GET_STATUS | typeof SET_HEADER | typeof START |
  typeof STOP | typeof ABORT | typeof GET_RESULT | typeof GET_TRACE;

export type BridgeInfo = {
  protocolVersion: number;
  reportSize: number;
  capabilityFlags: number;
  deviceAddress: `0x${string}`;
  bitstreamHash: string;
  inputPolicyHash: string;
  srsHash: string;
  maxEvents: number;
};

export type BridgeStatus = {
  state: 'idle' | 'header-loaded' | 'recording' | 'finalized' | 'error';
  lastError: number;
  eventCount: number;
  elapsedUs: bigint;
};

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

const HEX_PAIRS = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));

export function encodeHex(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i++) result += HEX_PAIRS[bytes[i]];
  return result;
}

export function decodeHex(value: string, size: number): Uint8Array {
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  if (hex.length !== size * 2 || !/^[0-9a-fA-F]+$/.test(hex)) throw new Error(`Expected exactly ${size} bytes of hexadecimal data`);
  const result = new Uint8Array(size);
  for (let i = 0; i < size; i++) result[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return result;
}

export function requestReport(type: Command, transferId: number, payload: Uint8Array = new Uint8Array(), offset = 0): Uint8Array {
  if (!Number.isInteger(transferId) || transferId <= 0 || transferId > 0xffffffff ||
      (payload.length === 0 && offset !== 0) ||
      (payload.length !== 0 && (offset >= payload.length || offset % FRAGMENT_SIZE !== 0))) {
    throw new Error('Invalid Vendor HID transfer ID or fragment offset');
  }
  const report = new Uint8Array(REPORT_SIZE); // no Report ID in the descriptor
  report[0] = MAGIC;
  report[1] = VERSION;
  report[2] = type;
  const header = view(report);
  header.setUint32(4, transferId);
  header.setUint32(8, offset);
  header.setUint32(12, payload.length);
  report.set(payload.subarray(offset, offset + FRAGMENT_SIZE), HEADER_SIZE);
  return report;
}

// A new assembler must be used for each transfer. Stale transfer IDs are ignored;
// malformed matching fragments fail closed rather than being accepted as readiness.
export class ResponseAssembler {
  private flags: number | null = null;
  private total: number | null = null;
  private offset = 0;
  private payload: Uint8Array | null = null;

  constructor(private readonly type: Command, private readonly transferId: number) {}

  push(report: Uint8Array): Uint8Array | null {
    if (report.length !== REPORT_SIZE) throw new Error('Invalid Vendor HID report length');
    const header = view(report);
    if (header.getUint32(4) !== this.transferId || report[2] !== this.type) return null; // unrelated/stale traffic
    if (report[0] !== MAGIC || report[1] !== VERSION) throw new Error('Invalid Vendor HID magic or version');
    const flags = report[3];
    const offset = header.getUint32(8);
    const total = header.getUint32(12);
    const maximum = flags & ERROR ? FRAGMENT_SIZE : this.type === GET_INFO ? 128 :
      this.type === GET_STATUS ? 16 : this.type === GET_RESULT ? 465 :
      this.type === GET_TRACE ? 700000 : 0;
    if ((flags !== RESPONSE && flags !== (RESPONSE | ERROR)) ||
        total > maximum || (total === 0 && (flags !== RESPONSE || offset !== 0)) ||
        offset !== this.offset ||
        (this.total !== null && (total !== this.total || flags !== this.flags))) {
      throw new Error('Invalid Vendor HID response header or fragment order');
    }
    if (total === 0) {
      if (report.subarray(HEADER_SIZE).some((byte) => byte !== 0)) throw new Error('Invalid Vendor HID response padding');
      return new Uint8Array();
    }
    if (this.total === null) {
      this.total = total;
      this.flags = flags;
      this.payload = new Uint8Array(total);
    }
    const count = Math.min(FRAGMENT_SIZE, total - offset);
    if (count === 0 || report.subarray(HEADER_SIZE + count).some((byte) => byte !== 0)) {
      throw new Error('Invalid Vendor HID response padding');
    }
    this.payload!.set(report.subarray(HEADER_SIZE, HEADER_SIZE + count), offset);
    this.offset += count;
    if (this.offset !== total) return null;
    const payload = this.payload!;
    if (flags & ERROR) {
      if (payload.length < 4) throw new Error('Malformed Vendor HID error response');
      const code = view(payload).getUint16(0);
      const diagnostic = new TextDecoder().decode(payload.subarray(4)).replace(/\0.*$/s, '');
      throw new Error(`BridgeOS error 0x${code.toString(16).padStart(4, '0')} (state ${payload[2]}, detail ${payload[3]})${diagnostic ? `: ${diagnostic}` : ''}`);
    }
    return payload;
  }
}

export function parseInfo(payload: Uint8Array): BridgeInfo {
  if (payload.length !== 128) throw new Error('Invalid GET_INFO payload length');
  const data = view(payload);
  const protocolVersion = data.getUint16(0);
  const reportSize = data.getUint16(2);
  const maxEvents = data.getUint32(124);
  if (protocolVersion !== VERSION || reportSize !== REPORT_SIZE || maxEvents === 0 || maxEvents > 50000 ||
      payload.subarray(8, 28).every((byte) => byte === 0) ||
      payload.subarray(92, 124).every((byte) => byte === 0)) {
    throw new Error('BridgeOS reported an unsupported or unregistered device');
  }
  return {
    protocolVersion,
    reportSize,
    capabilityFlags: data.getUint32(4),
    deviceAddress: `0x${encodeHex(payload.subarray(8, 28))}`,
    bitstreamHash: encodeHex(payload.subarray(28, 60)),
    inputPolicyHash: encodeHex(payload.subarray(60, 92)),
    srsHash: encodeHex(payload.subarray(92, 124)),
    maxEvents,
  };
}

export function parseStatus(payload: Uint8Array): BridgeStatus {
  if (payload.length !== 16 || payload[1] !== 0) throw new Error('Invalid GET_STATUS payload');
  const state = ({ 0: 'idle', 1: 'header-loaded', 2: 'recording', 3: 'finalized', 255: 'error' } as const)[payload[0] as 0 | 1 | 2 | 3 | 255];
  if (!state) throw new Error('Unknown BridgeOS session state');
  const data = view(payload);
  return { state, lastError: data.getUint16(2), eventCount: data.getUint32(4), elapsedUs: data.getBigUint64(8) };
}
