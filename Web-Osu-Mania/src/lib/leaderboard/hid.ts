// bridgeos wire protocol: hid.md. Keyboard HID is never selected or opened.
export type Report = {
  reportId: number;
  items: { reportSize: number; reportCount: number }[];
};
export type Collection = {
  usagePage: number;
  usage: number;
  inputReports: Report[];
  outputReports: Report[];
  children?: Collection[];
};
export interface VendorDevice extends EventTarget {
  collections: Collection[];
  opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(id: number, data: Uint8Array<ArrayBuffer>): Promise<void>;
}
interface Hid extends EventTarget {
  requestDevice(options: {
    filters: {
      usagePage: number;
      usage: number;
      vendorId?: number;
      productId?: number;
    }[];
  }): Promise<VendorDevice[]>;
}
export function hidApi(): Hid {
  const hid = (navigator as unknown as { hid?: Hid }).hid;
  if (!hid)
    throw new Error(
      "WebHID requires a supported desktop browser and secure context.",
    );
  return hid;
}
export function checkDescriptor(device: VendorDevice) {
  const collections = device.collections;
  const vendor = collections.find(
    (c) => c.usagePage === 0xff60 && c.usage === 1,
  );
  const valid = (r: Report[]) =>
    r.length === 1 &&
    r[0].reportId === 0 &&
    r[0].items.reduce((n, i) => n + i.reportSize * i.reportCount, 0) === 512;
  if (
    !vendor ||
    !valid(vendor.inputReports) ||
    !valid(vendor.outputReports) ||
    collections.some((c) => c.usagePage === 1 && c.usage === 6)
  )
    throw new Error(
      "Expected a separate vendor collection with 64-byte reports and no report ID.",
    );
}
export const command = {
  info: 1,
  status: 2,
  header: 0x10,
  start: 0x11,
  stop: 0x12,
  abort: 0x13,
  result: 0x20,
  trace: 0x21,
} as const;
export const MAX_PAYLOAD = 700000;
export function packets(type: number, id: number, payload: Uint8Array) {
  if (!id || payload.length > MAX_PAYLOAD)
    throw new Error("Invalid request size/ID");
  const out: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset < Math.max(payload.length, 1); offset += 48) {
    const b = new Uint8Array(64),
      v = new DataView(b.buffer);
    b.set([0x4d, 1, type, 0]);
    v.setUint32(4, id);
    v.setUint32(8, offset);
    v.setUint32(12, payload.length);
    b.set(payload.subarray(offset, offset + 48), 16);
    out.push(b);
  }
  return out;
}
export class ResponseBuffer {
  private bytes?: Uint8Array<ArrayBuffer>;
  private offset = 0;
  private flags?: number;
  private type: number;
  private id: number;
  constructor(type: number, id: number) {
    this.type = type;
    this.id = id;
  }
  accept(reportId: number, v: DataView): Uint8Array<ArrayBuffer> | undefined {
    if (reportId !== 0 || v.byteLength !== 64)
      throw new Error("Invalid HID report size/ID");
    const flags = v.getUint8(3),
      total = v.getUint32(12),
      offset = v.getUint32(8);
    if (
      v.getUint8(0) !== 0x4d ||
      v.getUint8(1) !== 1 ||
      v.getUint8(2) !== this.type ||
      v.getUint32(4) !== this.id ||
      ![1, 3].includes(flags) ||
      total > MAX_PAYLOAD ||
      offset !== this.offset ||
      (total > 0 && offset >= total) ||
      (this.bytes && (total !== this.bytes.length || flags !== this.flags))
    )
      throw new Error("Malformed or out-of-order HID fragment");
    if (!this.bytes) {
      this.bytes = new Uint8Array(total);
      this.flags = flags;
    }
    const length = Math.min(48, total - offset);
    for (let i = 16 + length; i < 64; i++)
      if (v.getUint8(i)) throw new Error("Nonzero HID padding");
    this.bytes.set(new Uint8Array(v.buffer, v.byteOffset + 16, length), offset);
    this.offset += length;
    if (this.offset !== total) return;
    if (flags === 3) {
      if (total < 4) throw new Error("Truncated device error");
      const e = new DataView(this.bytes.buffer);
      const names: Record<number, string> = {
        1: "BAD_PROTOCOL_VERSION",
        2: "BAD_STATE",
        3: "BAD_LENGTH",
        4: "BAD_FRAGMENT_OFFSET",
        5: "HEADER_MISMATCH",
        6: "EVENT_OVERFLOW",
        7: "SIGN_FAILED",
        8: "NOT_READY",
        9: "INVALID_EVENT",
        10: "CLOCK_FAULT",
        255: "INTERNAL_ERROR",
      };
      throw new Error(
        `Device ${names[e.getUint16(0)] || e.getUint16(0)}; state ${e.getUint8(2)}, detail ${e.getUint8(3)}: ${new TextDecoder().decode(this.bytes.subarray(4))}`,
      );
    }
    return this.bytes;
  }
}
export class Board {
  private id = 0;
  private busy = false;
  private uncertain = false;
  readonly device: VendorDevice;
  private hid: EventTarget;
  constructor(device: VendorDevice, hid: EventTarget) {
    checkDescriptor(device);
    this.device = device;
    this.hid = hid;
  }
  async request(
    type: number,
    payload: Uint8Array = new Uint8Array(0),
    expected?: number,
  ) {
    if (this.busy || this.uncertain || this.id === 0xffffffff)
      throw new Error(
        "Reconnect and inspect board status before another command.",
      );
    this.busy = true;
    const id = ++this.id,
      buffer = new ResponseBuffer(type, id);
    const timeout =
      type === command.stop ? 180000 : type === command.trace ? 300000 : 10000;
    try {
      return await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          this.device.removeEventListener("inputreport", receive);
          this.hid.removeEventListener("disconnect", disconnect);
        };
        const fail = (e: unknown) => {
          this.uncertain = true;
          cleanup();
          reject(e);
        };
        const receive = (event: Event) => {
          try {
            const e = event as Event & { reportId: number; data: DataView };
            const bytes = buffer.accept(e.reportId, e.data);
            if (bytes) {
              if (expected !== undefined && bytes.length !== expected)
                throw new Error("Unexpected response length");
              cleanup();
              resolve(bytes);
            }
          } catch (e) {
            fail(e);
          }
        };
        const disconnect = (e: Event) => {
          if ((e as Event & { device: VendorDevice }).device === this.device)
            fail(
              new Error(
                "Board disconnected; recordings cannot resume. Reconnect to inspect status.",
              ),
            );
        };
        const timer = setTimeout(
          () =>
            fail(
              new Error(
                "HID response lost or truncated. Reconnect and inspect status; do not repeat state-changing commands.",
              ),
            ),
          timeout,
        );
        this.device.addEventListener("inputreport", receive);
        this.hid.addEventListener("disconnect", disconnect);
        void (async () => {
          for (const p of packets(type, id, payload))
            await this.device.sendReport(0, p);
        })().catch(fail);
      });
    } finally {
      this.busy = false;
    }
  }
  async status() {
    const b = await this.request(command.status, undefined, 16),
      v = new DataView(b.buffer);
    if (b[1] !== 0 || ![0, 1, 2, 3, 255].includes(b[0]))
      throw new Error("Invalid board status");
    return {
      state: b[0],
      error: v.getUint16(2),
      count: v.getUint32(4),
      duration: v.getBigUint64(8),
    };
  }
}
export async function selectBoard(
  identity: { vendorId?: number; productId?: number } = {},
): Promise<Board> {
  const hid = hidApi();
  const [device] = await hid.requestDevice({
    filters: [{ ...identity, usagePage: 0xff60, usage: 1 }],
  });
  if (!device) throw new Error("No vendor HID selected");
  checkDescriptor(device);
  if (device.opened) await device.close();
  await device.open();
  return new Board(device, hid);
}
