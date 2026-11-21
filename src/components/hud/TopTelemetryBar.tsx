import type { CSSProperties } from 'react';
import { Download, MapPin, Radio, Volume2, VolumeX } from 'lucide-react';
import {
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  type LayoutMode,
  type SkyCategory,
  type UnitSystem,
} from '../../types/sky-contracts';
import { useSkyStore } from '../../store/useSkyStore';
import { formatClockTime } from '../inspector/unitFormatters';
import { STATUS_LABEL } from './ControlDock';

export interface TopTelemetryBarProps {
  onToggleAudio?: (enabled: boolean) => void;
  onInstallPwa?: () => void;
  onDismissPwa?: () => void;
}

const BADGE_ORDER: Array<{ category: SkyCategory; tag: string }> = [
  { category: 'flight', tag: 'CIVIL' },
  { category: 'military', tag: 'MIL' },
  { category: 'satellite', tag: 'ORBITAL' },
  { category: 'balloon', tag: 'SONDE' },
  { category: 'drone', tag: 'UAS' },
];

const LAYOUT_OPTIONS: Array<{ value: LayoutMode; label: string }> = [
  { value: 'split', label: 'SPLIT' },
  { value: 'map', label: 'MAP' },
  { value: 'dome', label: 'DOME' },
];

const UNIT_OPTIONS: Array<{ value: UnitSystem; label: string }> = [
  { value: 'aviation', label: 'AVIATION' },
  { value: 'metric', label: 'METRIC' },
];

function formatCompactObserverCoords(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}°${ns} ${Math.abs(lon).toFixed(2)}°${ew}`;
}

export function TopTelemetryBar({
  onToggleAudio,
  onInstallPwa,
  onDismissPwa,
}: TopTelemetryBarProps) {
  const observer = useSkyStore((s) => s.observer);
  const counts = useSkyStore((s) => s.counts);
  const layers = useSkyStore((s) => s.layers);
  const toggleLayer = useSkyStore((s) => s.toggleLayer);
  const fps = useSkyStore((s) => s.fps);
  const workerReady = useSkyStore((s) => s.workerReady);
  const units = useSkyStore((s) => s.units);
  const setUnits = useSkyStore((s) => s.setUnits);
  const layout = useSkyStore((s) => s.layout);
  const setLayout = useSkyStore((s) => s.setLayout);
  const audioEnabled = useSkyStore((s) => s.audioEnabled);
  const setAudioEnabled = useSkyStore((s) => s.setAudioEnabled);
  const audioVolume = useSkyStore((s) => s.audioVolume);
  const setAudioVolume = useSkyStore((s) => s.setAudioVolume);
  const setOdidModalOpen = useSkyStore((s) => s.setOdidModalOpen);
  const odidConfig = useSkyStore((s) => s.odidConfig);
  const flightsFeed = useSkyStore((s) => s.feeds.flights);
  const pwaInstallAvailable = useSkyStore((s) => s.pwaInstallAvailable);
  const pwaInstallDismissed = useSkyStore((s) => s.pwaInstallDismissed);
  const isStandalonePwa = useSkyStore((s) => s.isStandalonePwa);

  const handleAudioClick = () => {
    const next = !audioEnabled;
    setAudioEnabled(next);
    onToggleAudio?.(next);
  };

  const handleDismissPwa = () => {
    onDismissPwa?.();
    useSkyStore.getState().setPwaInstallState({ dismissed: true });
  };

  const odidDotClass = odidConfig.connected
    ? 'odid-trigger-dot is-live'
    : odidConfig.simulatorEnabled
      ? 'odid-trigger-dot is-sim'
      : 'odid-trigger-dot';

  const liveAircraftCount = counts.flight + counts.military;
  const flightStatusLabel = STATUS_LABEL[flightsFeed.status] ?? 'UNKNOWN';
  const flightUpdatedClock = formatClockTime(flightsFeed.lastUpdatedMs, '--:--:--');
  const feedTooltip = [
    `ADS-B Feed: ${flightStatusLabel}`,
    `Provider: ${flightsFeed.provider || 'adsb-cascade'}`,
    `Verified Live: ${liveAircraftCount} AC`,
    `Updated: ${flightUpdatedClock}`,
    flightsFeed.errorMsg ? `Diagnostics: ${flightsFeed.errorMsg}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const showPwaInstall = pwaInstallAvailable && !pwaInstallDismissed && !isStandalonePwa;

  return (
    <header className="top-telemetry-bar" aria-label="Telemetry status and cockpit controls">
      <div className="topbar-brand-group">
        <div className="topbar-crest" title="Krunked Sky-Map Aerospace Situational Awareness">
          <span className="topbar-crest-dot" aria-hidden="true" />
          <span className="topbar-crest-title">KRUNKED // SKY-MAP</span>
        </div>

        <div
          className="topbar-observer-pill"
          title={`Observer: ${observer.label} (${observer.lat.toFixed(4)}, ${observer.lon.toFixed(4)})`}
        >
          <MapPin size={12} color="#38BDF8" aria-hidden="true" />
          <span className="topbar-observer-label">{observer.label}</span>
          <span className="topbar-observer-coords tabular">
            {formatCompactObserverCoords(observer.lat, observer.lon)}
          </span>
        </div>
      </div>

      <div className="topbar-counters" role="group" aria-label="Live category telemetry counters">
        {BADGE_ORDER.map(({ category, tag }) => {
          const active = layers[category];
          const count = counts[category];
          const color = CATEGORY_COLORS[category];
          return (
            <button
              key={category}
              type="button"
              className={`counter-badge${active ? '' : ' is-muted'}`}
              style={{ '--badge-accent': color } as CSSProperties}
              onClick={() => toggleLayer(category)}
              aria-pressed={active}
              title={`Toggle ${CATEGORY_LABELS[category]} layer (${count} tracked)`}
            >
              <span className="counter-badge__dot" aria-hidden="true" />
              <span className="counter-badge__tag">{tag}</span>
              <span className="counter-badge__val tabular">{count}</span>
            </button>
          );
        })}

        <div
          className="zenith-badge"
          title="Active targets above 30° local horizon elevation"
        >
          <span className="tabular">ZENITH EL&gt;30°</span>
          <span className="zenith-badge__val tabular">{counts.overhead}</span>
        </div>

        <div
          className="topbar-perf-pill tabular"
          title={workerReady ? 'SGP4 Web Worker online' : 'Initializing SGP4 Web Worker'}
        >
          <span
            className={`worker-dot${workerReady ? ' is-ready' : ''}`}
            aria-hidden="true"
          />
          <span>{Math.round(fps)} FPS</span>
          <span aria-hidden="true">·</span>
          <span>{workerReady ? 'SGP4 OK' : 'SGP4 INIT'}</span>
        </div>

        <div
          className={`topbar-feed-pill feed-pill--${flightsFeed.status} tabular`}
          data-testid="hud-feed-diagnostics"
          title={feedTooltip}
          role="status"
        >
          <span className="topbar-feed-pill__status">{flightStatusLabel}</span>
          <span className="topbar-feed-pill__sep" aria-hidden="true">
            ·
          </span>
          <span className="topbar-feed-pill__count">{liveAircraftCount} AC</span>
          <span className="topbar-feed-pill__sep" aria-hidden="true">
            ·
          </span>
          <span className="topbar-feed-pill__time tabular">UPD {flightUpdatedClock}</span>
        </div>
      </div>

      <div className="topbar-controls">
        <div className="segmented-control" role="group" aria-label="Unit system">
          {UNIT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`segmented-btn${units === opt.value ? ' is-active' : ''}`}
              aria-pressed={units === opt.value}
              onClick={() => setUnits(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="segmented-control" role="group" aria-label="Viewport layout mode">
          {LAYOUT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`segmented-btn${layout === opt.value ? ' is-active' : ''}`}
              aria-pressed={layout === opt.value}
              onClick={() => setLayout(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="audio-control-group">
          <button
            type="button"
            className={`hud-icon-btn${audioEnabled ? ' is-active' : ''}`}
            onClick={handleAudioClick}
            aria-pressed={audioEnabled}
            aria-label={audioEnabled ? 'Mute cockpit audio' : 'Enable cockpit audio'}
            title={audioEnabled ? 'Cockpit acoustics enabled' : 'Cockpit acoustics muted'}
          >
            {audioEnabled ? (
              <Volume2 size={13} aria-hidden="true" />
            ) : (
              <VolumeX size={13} aria-hidden="true" />
            )}
            <span>AUDIO</span>
          </button>
          <input
            type="range"
            className="audio-slider"
            min={0}
            max={1}
            step={0.05}
            value={audioVolume}
            onChange={(e) => setAudioVolume(Number(e.target.value))}
            aria-label="Cockpit audio volume"
            title={`Volume: ${Math.round(audioVolume * 100)}%`}
          />
        </div>

        <button
          type="button"
          className="odid-trigger-btn"
          onClick={() => setOdidModalOpen(true)}
          title="Configure ASTM F3411 OpenDroneID stream and simulator"
        >
          <span className={odidDotClass} aria-hidden="true" />
          <Radio size={12} aria-hidden="true" />
          <span>ODID STREAM</span>
        </button>

        {showPwaInstall && (
          <div
            className="pwa-install-pill"
            data-testid="pwa-install-banner"
            role="region"
            aria-label="Install Sky-Map application"
          >
            <button
              type="button"
              className="pwa-install-btn"
              data-testid="pwa-install-btn"
              onClick={() => onInstallPwa?.()}
              title="Install Krunked Sky-Map as a standalone app"
            >
              <Download size={13} aria-hidden="true" />
              <span>Install App</span>
            </button>
            <button
              type="button"
              className="pwa-dismiss-btn"
              data-testid="pwa-install-dismiss"
              aria-label="Dismiss install app prompt"
              title="Dismiss install prompt"
              onClick={handleDismissPwa}
            >
              ×
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

export default TopTelemetryBar;
