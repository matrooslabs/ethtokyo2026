import {
  BRIDGE_FILTER, GET_INFO, GET_STATUS, SET_HEADER, START, STOP, ABORT, GET_RESULT, GET_TRACE,
  ResponseAssembler, parseInfo, parseStatus, requestReport, decodeHex, encodeHex,
  type Command, type BridgeInfo, type BridgeStatus,
} from './protocol';

// Structural interfaces keep WebHID's still-experimental browser API isolated.
export type VendorDevice = {
  vendorId: number;
  productId: number;
  opened: boolean;
  collections: ReadonlyArray<{
    usagePage: number;
    usage: number;
    inputReports: ReadonlyArray<{ reportId: number }>;
    outputReports: ReadonlyArray<{ reportId: number }>;
  }>;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: Uint8Array): Promise<void>;
  addEventListener(type: 'inputreport', callback: (event: { reportId: number; data: DataView }) => void): void;
  removeEventListener(type: 'inputreport', callback: (event: { reportId: number; data: DataView }) => void): void;
};

type VendorHid = {
  getDevices(): Promise<VendorDevice[]>;
  requestDevice(options: { filters: Array<typeof BRIDGE_FILTER> }): Promise<VendorDevice[]>;
  addEventListener(type: 'disconnect', callback: (event: { device: VendorDevice }) => void): void;
  removeEventListener(type: 'disconnect', callback: (event: { device: VendorDevice }) => void): void;
};

export function bridgeHid(): VendorHid | null {
  if (typeof navigator === 'undefined' || typeof window === 'undefined' ||
      !window.isSecureContext || !('hid' in navigator)) return null;
  return (navigator as Navigator & { hid: VendorHid }).hid;
}

export function isVendorDevice(device: VendorDevice): boolean {
  return device.vendorId === BRIDGE_FILTER.vendorId && device.productId === BRIDGE_FILTER.productId &&
    device.collections.some((collection) =>
      collection.usagePage === BRIDGE_FILTER.usagePage && collection.usage === BRIDGE_FILTER.usage &&
      collection.inputReports.some((report) => report.reportId === 0) &&
      collection.outputReports.some((report) => report.reportId === 0));
}

// sendReport(0, payload) is WebHID's no-Report-ID convention; unlike hidapi,
// the 64-byte payload must NOT be prefixed with a zero byte.
export class BridgeClient {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly device: VendorDevice, private readonly disconnectSignal: AbortSignal) {}

  async open(): Promise<void> {
    if (!isVendorDevice(this.device)) throw new Error('Not the BridgeOS Vendor HID collection');
    if (this.disconnectSignal.aborted) throw new Error('BridgeOS disconnected');
    if (!this.device.opened) await this.device.open();
    if (this.disconnectSignal.aborted) throw new Error('BridgeOS disconnected');
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  async probe(): Promise<{ info: BridgeInfo; status: BridgeStatus; infoHex: string; statusHex: string }> {
    const rawInfo = await this.exchange(GET_INFO);
    const info = parseInfo(rawInfo);
    const rawStatus = await this.exchange(GET_STATUS);
    const status = parseStatus(rawStatus);
    if (this.disconnectSignal.aborted) throw new Error('BridgeOS disconnected');
    return { info, status, infoHex: `0x${encodeHex(rawInfo)}`, statusHex: `0x${encodeHex(rawStatus)}` };
  }

  async setHeader(headerHex: string): Promise<void> {
    await this.exchange(SET_HEADER, decodeHex(headerHex, 292));
  }

  async startRecording(): Promise<void> {
    await this.exchange(START);
  }

  async stopRecording(): Promise<{ resultHex: string; traceHex: string }> {
    await this.exchange(STOP);
    const result = await this.exchange(GET_RESULT);
    if (result.length !== 465) throw new Error('Invalid BridgeOS signed result length');
    const trace = await this.exchange(GET_TRACE);
    const status = parseStatus(await this.exchange(GET_STATUS));
    if (status.state !== 'finalized' || trace.length !== status.eventCount * 14) {
      throw new Error('BridgeOS finalized trace does not match event count');
    }
    return { resultHex: `0x${encodeHex(result)}`, traceHex: `0x${encodeHex(trace)}` };
  }

  async abortRecording(): Promise<void> {
    await this.exchange(ABORT);
  }

  private exchange(type: Command, payload: Uint8Array = new Uint8Array()): Promise<Uint8Array> {
    const run = this.tail.then(() => this.performExchange(type, payload));
    this.tail = run.then(() => {}, () => {});
    return run;
  }
 
  private async performExchange(type: Command, payload: Uint8Array): Promise<Uint8Array> {

    if (this.disconnectSignal.aborted || !this.device.opened) throw new Error('BridgeOS disconnected');
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const transferId = random[0] || 1;
    const assembler = new ResponseAssembler(type, transferId);
    return new Promise<Uint8Array>((resolve, reject) => {
      let finished = false;
      const cleanup = () => {
        this.device.removeEventListener('inputreport', onReport);
        this.disconnectSignal.removeEventListener('abort', onAbort);
        clearTimeout(timeout);
      };
      const finish = (result: Uint8Array | Error) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const onAbort = () => finish(new Error('BridgeOS disconnected'));
      const onReport = (event: { reportId: number; data: DataView }) => {
        if (event.reportId !== 0) return;
        try {
          const fragment = assembler.push(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
          if (fragment) finish(fragment);
        } catch (error) {
          finish(error instanceof Error ? error : new Error('Malformed BridgeOS response'));
        }
      };
      const timeout = setTimeout(() => finish(new Error('BridgeOS did not respond in time')), type === GET_TRACE ? 120000 : 5000);
      this.device.addEventListener('inputreport', onReport);
      this.disconnectSignal.addEventListener('abort', onAbort, { once: true });
      if (this.disconnectSignal.aborted) {
        onAbort();
        return;
      }
      const send = async () => {
        if (payload.length === 0) {
          await this.device.sendReport(0, requestReport(type, transferId));
        } else {
          for (let offset = 0; offset < payload.length; offset += 48) {
            if (this.disconnectSignal.aborted) throw new Error('BridgeOS disconnected');
            await this.device.sendReport(0, requestReport(type, transferId, payload, offset));
          }
        }
      };
      void send().catch((error: unknown) => {
        finish(error instanceof Error ? error : new Error('BridgeOS HID write failed'));
      });
    });
  }
}
