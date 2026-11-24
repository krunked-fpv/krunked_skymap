import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, Check, Copy, Radio, Wifi, WifiOff, X } from 'lucide-react';
import { useSkyStore } from '../../store/useSkyStore';

const ASTM_F3411_SAMPLE = `{
  "drones": [
    {
      "uasId": "1581F45TB234100A92",
      "uaType": "multirotor",
      "lat": 38.8542,
      "lon": -77.0431,
      "altAglM": 92,
      "altMslM": 104,
      "speedMs": 14.2,
      "headingDeg": 128,
      "vertRateMs": 0.4,
      "operatorLat": 38.8529,
      "operatorLon": -77.0445,
      "missionDesc": "Bridge structural inspection",
      "timestampMs": 1763601746000
    }
  ]
}`;

export function OpenDroneIdModal() {
  const odidModalOpen = useSkyStore((s) => s.odidModalOpen);
  const setOdidModalOpen = useSkyStore((s) => s.setOdidModalOpen);
  const odidConfig = useSkyStore((s) => s.odidConfig);
  const droneSublayers = useSkyStore((s) => s.droneSublayers);
  const updateOdidConfig = useSkyStore((s) => s.updateOdidConfig);
  const droneFeed = useSkyStore((s) => s.feeds.drones);

  const [urlInput, setUrlInput] = useState(odidConfig.endpointUrl);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [schemaCopied, setSchemaCopied] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (odidModalOpen) {
      setUrlInput(odidConfig.endpointUrl);
      setValidationError(null);
      setSchemaCopied(false);
    }
  }, [odidModalOpen, odidConfig.endpointUrl]);

  if (!odidModalOpen) {
    return null;
  }

  const simEnabled = odidConfig.simulatorEnabled || droneSublayers.simOdid;

  const handleConnect = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = urlInput.trim();
    if (!trimmed) {
      setValidationError('Enter a ws://, wss://, http://, or https:// OpenDroneID endpoint URL.');
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      setValidationError('Invalid URL format. Example: ws://127.0.0.1:8765/odid');
      return;
    }

    let transport: 'ws' | 'http' | null = null;
    if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
      transport = 'ws';
    } else if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      transport = 'http';
    }

    if (!transport) {
      setValidationError('Unsupported protocol. Use ws://, wss://, http://, or https://.');
      return;
    }

    setValidationError(null);
    updateOdidConfig({
      endpointUrl: trimmed,
      transport,
      connected: false,
      lastError: undefined,
    });
  };

  const handleDisconnect = () => {
    setValidationError(null);
    updateOdidConfig({
      transport: 'off',
      connected: false,
      lastError: undefined,
    });
  };

  const handleCopySchema = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(ASTM_F3411_SAMPLE);
        setSchemaCopied(true);
        if (copyTimeoutRef.current !== null) {
          window.clearTimeout(copyTimeoutRef.current);
        }
        copyTimeoutRef.current = window.setTimeout(() => {
          setSchemaCopied(false);
          copyTimeoutRef.current = null;
        }, 1800);
      }
    } catch {
      // Ignore clipboard failures in restricted frames
    }
  };

  const activeError = validationError ?? odidConfig.lastError ?? droneFeed.errorMsg ?? null;

  const statusText =
    odidConfig.transport !== 'off'
      ? odidConfig.connected
        ? `CONNECTED (${odidConfig.transport.toUpperCase()})`
        : `CONNECTING (${odidConfig.transport.toUpperCase()})`
      : simEnabled
        ? 'SIM-ODID ACTIVE (4 LOCAL UAS)'
        : 'OFFLINE';

  return (
    <div
      className="cockpit-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          setOdidModalOpen(false);
        }
      }}
    >
      <div
        className="cockpit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="odid-modal-title"
      >
        <div className="cockpit-modal__header">
          <h2 id="odid-modal-title" className="cockpit-modal__title">
            <Radio size={15} color="#A3E635" aria-hidden="true" />
            <span>OPEN DRONE ID // ASTM F3411 STREAM</span>
          </h2>

          <button
            type="button"
            className="inspector-close-btn"
            onClick={() => setOdidModalOpen(false)}
            aria-label="Close OpenDroneID configuration modal"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>

        <div className="cockpit-modal__body cockpit-scroll">
          {/* Status Overview */}
          <div className="modal-card">
            <div className="modal-switch-row">
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                {odidConfig.connected || simEnabled ? (
                  <Wifi size={14} color="#A3E635" aria-hidden="true" />
                ) : (
                  <WifiOff size={14} color="#94A3B8" aria-hidden="true" />
                )}
                <span className="tabular" style={{ fontSize: 11, fontWeight: 700 }}>
                  {statusText}
                </span>
              </div>
              <span className="tabular" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                {droneFeed.count} UAS TRACKED
              </span>
            </div>

            {activeError && (
              <div className="dock-notice dock-notice--error" role="alert">
                <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
                <span>{activeError}</span>
              </div>
            )}
          </div>

          {/* Local Simulator Toggle */}
          <div className="modal-card">
            <div className="modal-switch-row">
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-bright)' }}>
                  SIM-ODID Local 4-Drone Simulator
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                  Synthesizes 4 local ASTM F3411 vehicles (including 1 FAA UASFM ceiling breach test
                  profile at 480 ft AGL).
                </div>
              </div>

              <button
                type="button"
                className={`modal-switch-btn${simEnabled ? ' is-on' : ''}`}
                aria-pressed={simEnabled}
                onClick={() => updateOdidConfig({ simulatorEnabled: !simEnabled })}
              >
                {simEnabled ? 'SIM ON' : 'SIM OFF'}
              </button>
            </div>
          </div>

          {/* External WebSocket / HTTP Endpoint */}
          <form className="modal-card" onSubmit={handleConnect}>
            <div className="inspector-section-title" style={{ marginBottom: 0 }}>
              LIVE TELEMETRY ENDPOINT (WS / HTTP JSON)
            </div>

            <div className="modal-url-row">
              <input
                type="text"
                className="dock-input"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="ws://127.0.0.1:8765/odid or https://..."
                aria-label="OpenDroneID telemetry endpoint URL"
              />
              <button type="submit" className="modal-btn">
                Connect
              </button>
              {odidConfig.transport !== 'off' && (
                <button
                  type="button"
                  className="modal-btn modal-btn--secondary"
                  onClick={handleDisconnect}
                >
                  Disconnect
                </button>
              )}
            </div>
          </form>

          {/* ASTM F3411 Expected JSON Schema */}
          <div className="modal-card">
            <div className="modal-switch-row">
              <span className="inspector-section-title" style={{ marginBottom: 0 }}>
                EXPECTED ASTM F3411 JSON PAYLOAD
              </span>
              <button
                type="button"
                className="modal-copy-btn"
                onClick={() => void handleCopySchema()}
              >
                {schemaCopied ? (
                  <Check size={12} color="#34D399" aria-hidden="true" />
                ) : (
                  <Copy size={12} aria-hidden="true" />
                )}
                <span>{schemaCopied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>

            <pre className="modal-code-block">
              <code>{ASTM_F3411_SAMPLE}</code>
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

export default OpenDroneIdModal;
