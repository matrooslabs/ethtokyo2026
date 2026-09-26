import type { BridgeHardware } from '@/lib/hardware/useBridgeHardware';

/** Render instead of paid-play controls whenever hardware.ready is false. */
export default function HardwareGate({ hardware }: { hardware: BridgeHardware }) {
  const { phase, info, status, error, connect, refresh } = hardware;
  return (
    <section aria-label="Controller required" className="arena-hardware-gate" role="status">
      <h2>Connect the controller</h2>
      <p>Play requires the approved four-key device.</p>
      {phase === 'unsupported' && (
        <p>Use a desktop browser with WebHID over HTTPS.</p>
      )}
      {phase === 'connecting' && <p>Checking device…</p>}
      {phase === 'ready' && info && (
        <p>Device connected.</p>
      )}
      {phase === 'not-ready' && status && (
        <p>Device is {status.state}. Reset it before playing.</p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="arena-hardware-actions">
        {phase !== 'unsupported' && (
          <button type="button" className="arena-secondary" onClick={() => { void connect(); }}>
            {phase === 'ready' ? 'Change device' : 'Connect device'}
          </button>
        )}
        {phase !== 'unsupported' && info && (
          <button type="button" className="arena-text-button" onClick={() => { void refresh(); }}>
            Check connection
          </button>
        )}
      </div>
    </section>
  );
}
