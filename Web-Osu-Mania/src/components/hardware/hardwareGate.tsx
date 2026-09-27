import { useState } from 'react';
import type { BridgeHardware } from '@/lib/hardware/useBridgeHardware';

/** Render instead of paid-play controls whenever hardware.ready is false. */
export default function HardwareGate({ hardware }: { hardware: BridgeHardware }) {
  const { phase, info, status, error, connect, refresh, abortRecording } = hardware;
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState('');
  return (
    <section aria-label="Controller required" className="arena-hardware-gate" role="status">
      <h2>Controller</h2>
      {phase === 'unsupported' && (
        <p>Use a desktop browser with WebHID over HTTPS.</p>
      )}
      {phase === 'connecting' && <p>Checking device…</p>}
      {phase === 'ready' && info && (
        <p>Device connected.</p>
      )}
      {phase === 'not-ready' && status && (
        <p>Device connected. Session is {status.state}; reset it before playing.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {resetError && <p role="alert">{resetError}</p>}
      <div className="arena-hardware-actions">
        {phase === 'not-ready' && status && <button type="button" className="arena-secondary" disabled={resetting} onClick={() => {
          setResetting(true);
          setResetError('');
          void abortRecording().catch((cause: unknown) => setResetError(cause instanceof Error ? cause.message : 'Device reset failed.'))
            .finally(() => setResetting(false));
        }}>{resetting ? 'Resetting…' : 'Reset device (discards capture)'}</button>}
        {phase !== 'unsupported' && (
          <button type="button" className="arena-secondary" onClick={() => { void connect(); }}>
            {phase === 'ready' || phase === 'not-ready' ? 'Change device' : 'Connect device'}
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
