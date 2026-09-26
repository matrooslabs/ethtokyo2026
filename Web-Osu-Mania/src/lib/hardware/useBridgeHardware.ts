import { useCallback, useEffect, useRef, useState } from 'react';
import { BridgeClient, bridgeHid, isVendorDevice, type VendorDevice } from './client';
import { BRIDGE_FILTER, type BridgeInfo, type BridgeStatus, type BridgeLiveEvent } from './protocol';

export type HardwarePhase = 'unsupported' | 'disconnected' | 'connecting' | 'ready' | 'not-ready' | 'denied' | 'error';
export type BridgeHardware = {
  phase: HardwarePhase;
  ready: boolean;
  info: BridgeInfo | null;
  status: BridgeStatus | null;
  error: string | null;
  /** Aborts immediately on physical disconnect, failed probe or hook teardown. */
  disconnectSignal: AbortSignal;
  /** Local Vendor HID sideband; the signed result/trace remain authoritative for paid scoring. */
  subscribeLiveEvents(callback: (event: BridgeLiveEvent) => void): () => void;
  /** Must be invoked directly by a user gesture (WebHID permission picker). */
  connect(): Promise<boolean>;
  /** Repeat immediately before paid actions; never use a cached ready value alone. */
  refresh(): Promise<boolean>;
  /** Fresh raw GET_INFO and idle GET_STATUS bytes for /v1/sessions/start. */
  getPreflight(): Promise<{ infoHex: string; statusHex: string; deviceAddress: `0x${string}` }>;
  setHeader(headerHex: string): Promise<void>;
  startRecording(): Promise<void>;
  /** Returns raw signed result and original HID trace; never a browser replay. */
  stopRecording(): Promise<{ resultHex: string; traceHex: string }>;
  abortRecording(): Promise<void>;
};

type Snapshot = Pick<BridgeHardware, 'phase' | 'info' | 'status' | 'error'>;
const disconnected: Snapshot = { phase: 'disconnected', info: null, status: null, error: null };

export function useBridgeHardware(): BridgeHardware {
  const [snapshot, setSnapshot] = useState<Snapshot>(() =>
    bridgeHid() ? disconnected : { ...disconnected, phase: 'unsupported' });
  const [controller, setController] = useState(() => new AbortController());
  const controllerRef = useRef(controller);
  const deviceRef = useRef<VendorDevice | null>(null);
  const clientRef = useRef<BridgeClient | null>(null);
  const pendingRef = useRef<Promise<boolean> | null>(null);
  const rawRef = useRef<{ infoHex: string; statusHex: string; deviceAddress: `0x${string}` } | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const liveSubscribers = useRef(new Set<(event: BridgeLiveEvent) => void>());

  const invalidate = useCallback((next: Snapshot) => {
    rawRef.current = null;
    generation.current++;
    controllerRef.current.abort();
    const old = clientRef.current;
    clientRef.current = null;
    deviceRef.current = null;
    pendingRef.current = null;
    if (old) void old.close().catch(() => {});
    if (mounted.current) setSnapshot(next);
  }, []);

  const probe = useCallback((client: BridgeClient, epoch: number): Promise<boolean> => {
    if (pendingRef.current) return pendingRef.current;
    const pending = (async () => {
      try {
        await client.open();
        const { info, status, infoHex, statusHex } = await client.probe();
        if (epoch !== generation.current || !mounted.current) return false;
        const ready = status.state === 'idle' && status.lastError === 0 && status.eventCount === 0 && status.elapsedUs === 0n;
        rawRef.current = ready ? { infoHex, statusHex, deviceAddress: info.deviceAddress } : null;
        setSnapshot({ phase: ready ? 'ready' : 'not-ready', info, status,
          error: ready ? null : `Device session is ${status.state} or has an error. Reset it before starting a paid run.` });
        return ready;
      } catch (error) {
        if (epoch === generation.current) {
          invalidate({ phase: 'error', info: null, status: null,
            error: error instanceof Error ? error.message : 'BridgeOS did not respond.' });
        }
        return false;
      }
    })();
    pendingRef.current = pending;
    void pending.finally(() => {
      if (pendingRef.current === pending) pendingRef.current = null;
    });
    return pending;
  }, [invalidate]);

  const refresh = useCallback(async (): Promise<boolean> => {
    if (pendingRef.current) return pendingRef.current;
    const client = clientRef.current;
    if (!client || !mounted.current) return false;
    return probe(client, generation.current);
  }, [probe]);
  const getPreflight = useCallback(async () => {
    if (!await refresh() || !rawRef.current || controllerRef.current.signal.aborted) {
      throw new Error('BridgeOS must respond with an idle, error-free status before payment.');
    }
    return rawRef.current;
  }, [refresh]);
  const subscribeLiveEvents = useCallback((callback: (event: BridgeLiveEvent) => void): (() => void) => {
    liveSubscribers.current.add(callback);
    return () => { liveSubscribers.current.delete(callback); };
  }, []);

  const setHeader = useCallback(async (headerHex: string) => {
    const client = clientRef.current;
    if (!client || controllerRef.current.signal.aborted) throw new Error('BridgeOS disconnected');
    await client.setHeader(headerHex);
    rawRef.current = null;
    setSnapshot((current) => ({ ...current, phase: 'not-ready', error: null }));
  }, []);

  const startRecording = useCallback(async () => {
    const client = clientRef.current;
    if (!client || controllerRef.current.signal.aborted) throw new Error('BridgeOS disconnected');
    await client.startRecording();
  }, []);

  const stopRecording = useCallback(async () => {
    const client = clientRef.current;
    if (!client || controllerRef.current.signal.aborted) throw new Error('BridgeOS disconnected');
    return client.stopRecording();
  }, []);

  const abortRecording = useCallback(async () => {
    const client = clientRef.current;
    if (!client || controllerRef.current.signal.aborted) throw new Error('BridgeOS disconnected');
    await client.abortRecording();
    void refresh();
  }, [refresh]);

  const select = useCallback(async (device: VendorDevice): Promise<boolean> => {
    if (!isVendorDevice(device)) return false;
    if (deviceRef.current === device && clientRef.current) return refresh();
    invalidate(disconnected);
    const nextController = new AbortController();
    controllerRef.current = nextController;
    setController(nextController);
    deviceRef.current = device;
    const client = new BridgeClient(device, nextController.signal, (error) => {
      if (clientRef.current === client) invalidate({ phase: 'error', info: null, status: null, error: error.message });
    });
    client.subscribeLiveEvents((event) => {
      for (const callback of liveSubscribers.current) callback(event);
    });
    clientRef.current = client;
    setSnapshot({ ...disconnected, phase: 'connecting' });
    return probe(client, generation.current);
  }, [invalidate, probe, refresh]);

  const connect = useCallback(async (): Promise<boolean> => {
    const hid = bridgeHid();
    if (!hid) {
      setSnapshot({ ...disconnected, phase: 'unsupported' });
      return false;
    }
    // requestDevice must begin in the click handler's transient user activation.
    let request: Promise<VendorDevice[]>;
    try {
      request = hid.requestDevice({ filters: [BRIDGE_FILTER] });
    } catch (error) {
      setSnapshot({ ...disconnected, phase: 'error', error: error instanceof Error ? error.message : 'WebHID request failed.' });
      return false;
    }
    try {
      const devices = await request;
      const device = devices.find(isVendorDevice);
      if (!device) {
        setSnapshot({ ...disconnected, phase: devices.length ? 'error' : 'denied',
          error: devices.length ? 'Selected device has no BridgeOS Vendor HID interface.' : 'No device was selected or permission was declined.' });
        return false;
      }
      return select(device);
    } catch (error) {
      setSnapshot({ ...disconnected, phase: error instanceof Error && error.name === 'NotAllowedError' ? 'denied' : 'error',
        error: error instanceof Error ? error.message : 'WebHID permission failed.' });
      return false;
    }
  }, [select]);

  useEffect(() => {
    mounted.current = true;
    const hid = bridgeHid();
    if (!hid) return () => { mounted.current = false; invalidate(disconnected); };
    const onDisconnect = (event: { device: VendorDevice }) => {
      if (event.device === deviceRef.current) invalidate({ ...disconnected, error: 'BridgeOS was disconnected. An interrupted paid run cannot resume.' });
    };
    hid.addEventListener('disconnect', onDisconnect);
    let active = true;
    void hid.getDevices().then(async (devices) => {
      if (!active || deviceRef.current) return;
      const device = devices.find(isVendorDevice);
      if (device) await select(device);
    }).catch((error: unknown) => {
      if (active) setSnapshot({ ...disconnected, phase: 'error', error: error instanceof Error ? error.message : 'Cannot list permitted HID devices.' });
    });
    const poll = setInterval(() => { if (clientRef.current) void refresh(); }, 4000);
    return () => {
      active = false;
      mounted.current = false;
      clearInterval(poll);
      hid.removeEventListener('disconnect', onDisconnect);
      invalidate(disconnected);
    };
  }, [invalidate, refresh, select]);

  // Readiness represents the last successful live probe, never mere VID/PID presence.
  // This is NOT cryptographic proof of device authenticity, a signed trace, or a paid score.
  return { ...snapshot, ready: snapshot.phase === 'ready' && !controller.signal.aborted,
    disconnectSignal: controller.signal, connect, refresh, getPreflight, subscribeLiveEvents, setHeader,
    startRecording, stopRecording, abortRecording };
}

