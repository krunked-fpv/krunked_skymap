import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Crosshair,
  Download,
  MapPin,
  Radar,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  CATEGORY_COLORS,
  type FeedHealthStatus,
  type FeedKey,
  type LayoutMode,
  type OrbitalScope,
  type UnitSystem,
} from '../../types/sky-contracts';
import { useSkyStore } from '../../store/useSkyStore';
import {
  formatClockTime,
  formatCoords,
  formatCountdownShort,
} from '../inspector/unitFormatters';
import { STATUS_LABEL } from './ControlDock';

export interface TopTelemetryBarProps {
  onToggleAudio?: (enabled: boolean) => void;
  onManualSweep?: () => void;
  onLocateCurrent?: () => void;
  gpsBusy?: boolean;
  onInstallPwa?: () => void;
  onDismissPwa?: () => void;
}

const LAYOUT_OPTIONS: Array<{ value: LayoutMode; label: string }> = [
  { value: 'map', label: 'MAP' },
  { value: 'split', label: 'SPLIT' },
  { value: 'dome', label: 'DOME' },
];

const UNIT_OPTIONS: Array<{ value: UnitSystem; label: string }> = [
  { value: 'aviation', label: 'AVIATION' },
  { value: 'metric', label: 'METRIC' },
];

const ORBITAL_SCOPE_OPTIONS: Array<{ value: OrbitalScope; label: string }> = [
  { value: 'hemisphere', label: 'HEMISPHERE' },
  { value: 'cylinder', label: 'CYLINDER' },
];

const FEED_ORDER: Array<{ key: FeedKey; label: string; accent: string }> = [
  { key: 'flights', label: 'FLIGHTS', accent: CATEGORY_COLORS.flight },
  { key: 'military', label: 'MILITARY', accent: CATEGORY_COLORS.military },
  { key: 'balloons', label: 'BALLOONS', accent: CATEGORY_COLORS.balloon },
  { key: 'satellites', label: 'SATELLITES', accent: CATEGORY_COLORS.satellite },
  { key: 'airspace', label: 'AIRSPACE', accent: '#38BDF8' },
  { key: 'drones', label: 'DRONES', accent: CATEGORY_COLORS.drone },
];

export async function clearBrowserCachesAndReload(): Promise<void> {
  if (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof navigator.serviceWorker?.getRegistrations === 'function'
  ) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.allSettled(registrations.map((reg) => reg.unregister()));
    } catch {
      // Ignore restricted or unsupported Service Worker environments
    }
  }

  if (
    typeof window !== 'undefined' &&
    'caches' in window &&
    typeof window.caches?.keys === 'function'
  ) {
    try {
      const cacheNames = await window.caches.keys();
      await Promise.allSettled(cacheNames.map((name) => window.caches.delete(name)));
    } catch {
      // Ignore restricted Cache Storage environments
    }
  }

  if (typeof window !== 'undefined' && window.location) {
    try {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set('_cb', String(Date.now()));
      window.location.replace(nextUrl.toString());
      return;
    } catch {
      // Fall back to direct reload if URL manipulation fails
    }
    try {
      window.location.reload();
    } catch {
      // Ignore non-reloadable environments
    }
  }
}

function resolveSystemBeacon(
  flights: FeedHealthStatus,
  military: FeedHealthStatus,
  balloons: FeedHealthStatus,
): { status: FeedHealthStatus; label: string } {
  if (flights === 'offline' || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    return { status: 'offline', label: 'OFFLINE' };
  }
  if (flights === 'error' || military === 'error') {
    return { status: 'error', label: 'FEED ERROR' };
  }
  if (flights === 'rate-limited' || military === 'rate-limited') {
    return { status: 'rate-limited', label: 'RATE-LIMITED' };
  }
  if (flights === 'delayed' || military === 'delayed') {
    return { status: 'delayed', label: 'DELAYED' };
  }
  if (flights === 'live' || military === 'live' || balloons === 'live') {
    return { status: 'live', label: 'FEEDS LIVE' };
  }
  if (balloons === 'error') {
    return { status: 'error', label: 'FEED ERROR' };
  }
  if (flights === 'loading') {
    return { status: 'loading', label: 'SYNCING' };
  }
  if (flights === 'fallback' || balloons === 'fallback') {
    return { status: 'fallback', label: 'SEEDED' };
  }
  if (flights === 'cached' || balloons === 'cached') {
    return { status: 'cached', label: 'CACHED' };
  }
  return { status: 'idle', label: 'STANDBY' };
}

export function TopTelemetryBar({
  onToggleAudio,
  onManualSweep,
  onLocateCurrent,
  gpsBusy = false,
  onInstallPwa,
  onDismissPwa,
}: TopTelemetryBarProps) {
  const observer = useSkyStore((s) => s.observer);
  const locationStatus = useSkyStore((s) => s.locationStatus);
  const radiusKm = useSkyStore((s) => s.radiusKm);
  const counts = useSkyStore((s) => s.counts);
  const fps = useSkyStore((s) => s.fps);
  const workerReady = useSkyStore((s) => s.workerReady);
  const units = useSkyStore((s) => s.units);
  const setUnits = useSkyStore((s) => s.setUnits);
  const layout = useSkyStore((s) => s.layout);
  const setLayout = useSkyStore((s) => s.setLayout);
  const skyDomePip = useSkyStore((s) => s.skyDomePip);
  const skyDomeZoom = useSkyStore((s) => s.skyDomeZoom);
  const setSkyDomeZoom = useSkyStore((s) => s.setSkyDomeZoom);
  const setSkyDomePip = useSkyStore((s) => s.setSkyDomePip);
  const toggleSkyDomePip = useSkyStore((s) => s.toggleSkyDomePip);
  const atmosphericScope = useSkyStore((s) => s.atmosphericScope);
  const toggleAtmosphericScope = useSkyStore((s) => s.toggleAtmosphericScope);
  const orbitalScope = useSkyStore((s) => s.orbitalScope);
  const setOrbitalScope = useSkyStore((s) => s.setOrbitalScope);
  const audioEnabled = useSkyStore((s) => s.audioEnabled);
  const setAudioEnabled = useSkyStore((s) => s.setAudioEnabled);
  const audioVolume = useSkyStore((s) => s.audioVolume);
  const setAudioVolume = useSkyStore((s) => s.setAudioVolume);
  const mapLabelsEnabled = useSkyStore((s) => s.mapLabelsEnabled);
  const setMapLabelsEnabled = useSkyStore((s) => s.setMapLabelsEnabled);
  const domeLabelsEnabled = useSkyStore((s) => s.domeLabelsEnabled);
  const setDomeLabelsEnabled = useSkyStore((s) => s.setDomeLabelsEnabled);
  const sweepEnabled = useSkyStore((s) => s.sweepEnabled);
  const setSweepEnabled = useSkyStore((s) => s.setSweepEnabled);
  const setCommandPaletteOpen = useSkyStore((s) => s.setCommandPaletteOpen);
  const diagnosticsOpen = useSkyStore((s) => s.diagnosticsOpen);
  const setDiagnosticsOpen = useSkyStore((s) => s.setDiagnosticsOpen);
  const settingsOpen = useSkyStore((s) => s.settingsOpen);
  const setSettingsOpen = useSkyStore((s) => s.setSettingsOpen);
  const setOdidModalOpen = useSkyStore((s) => s.setOdidModalOpen);
  const odidConfig = useSkyStore((s) => s.odidConfig);
  const feeds = useSkyStore((s) => s.feeds);
  const airspace = useSkyStore((s) => s.airspace);
  const nearestSondeHint = useSkyStore((s) => s.nearestSondeHint);
  const triggerManualSweep = useSkyStore((s) => s.triggerManualSweep);
  const pwaInstallAvailable = useSkyStore((s) => s.pwaInstallAvailable);
  const pwaInstallDismissed = useSkyStore((s) => s.pwaInstallDismissed);
  const isStandalonePwa = useSkyStore((s) => s.isStandalonePwa);

  const [clearingCache, setClearingCache] = useState(false);

  const diagTriggerRef = useRef<HTMLButtonElement | null>(null);
  const diagPopoverRef = useRef<HTMLDivElement | null>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const settingsPopoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!diagnosticsOpen && !settingsOpen) return;

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;

      if (diagnosticsOpen) {
        const insideDiag =
          diagPopoverRef.current?.contains(target) || diagTriggerRef.current?.contains(target);
        if (!insideDiag) {
          setDiagnosticsOpen(false);
        }
      }
      if (settingsOpen) {
        const insideSettings =
          settingsPopoverRef.current?.contains(target) ||
          settingsTriggerRef.current?.contains(target);
        if (!insideSettings) {
          setSettingsOpen(false);
        }
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [diagnosticsOpen, settingsOpen, setDiagnosticsOpen, setSettingsOpen]);

  const handleSweepClick = () => {
    if (onManualSweep) {
      onManualSweep();
    } else {
      triggerManualSweep();
    }
  };

  const handleClearCacheReload = () => {
    if (clearingCache) return;
    setClearingCache(true);
    void clearBrowserCachesAndReload().finally(() => {
      setClearingCache(false);
    });
  };

  const handlePipClick = () => {
    if (layout === 'map') {
      toggleSkyDomePip();
    } else {
      setLayout('map');
      setSkyDomePip(true);
    }
  };

  const handleAudioClick = () => {
    const next = !audioEnabled;
    setAudioEnabled(next);
    onToggleAudio?.(next);
  };

  const handleDismissPwa = () => {
    onDismissPwa?.();
    useSkyStore.getState().setPwaInstallState({ dismissed: true });
  };

  const beacon = resolveSystemBeacon(
    feeds.flights.status,
    feeds.military.status,
    feeds.balloons.status,
  );
  const showPwaInstall = pwaInstallAvailable && !pwaInstallDismissed && !isStandalonePwa;
  const odidActive = odidConfig.connected || odidConfig.simulatorEnabled;
  const odidDotClass = odidConfig.connected
    ? 'odid-trigger-dot is-live'
    : odidConfig.simulatorEnabled
      ? 'odid-trigger-dot is-sim'
      : 'odid-trigger-dot';

  const isPendingLocation = observer.source === 'pending';
  const isLiveCurrentLocation = observer.source === 'gps' || observer.source === 'ip';
  const overheadConeDeg = counts.overheadConeDeg ?? 45;
  const hasOverhead = counts.overhead > 0;
  const stationLabel = isPendingLocation
    ? locationStatus === 'unavailable'
      ? 'Set Location'
      : 'Locating…'
    : observer.label;
  const stationCoordsText = isPendingLocation
    ? locationStatus === 'unavailable'
      ? 'GPS / SEARCH'
      : 'ACQUIRING FIX'
    : formatCoords(observer.lat, observer.lon, 2);

  return (
    <header className="top-telemetry-bar" aria-label="Telemetry status and cockpit controls">
      {/* Left Zone: Wordmark + Unified Location Omnibox Trigger */}
      <div className="topbar-zone topbar-zone--left">
        <div className="topbar-crest" title="Krunked Sky-Map Aerospace Situational Awareness">
          <span className="topbar-crest-dot" aria-hidden="true" />
          <span className="topbar-crest-title">KRUNKED // SKY-MAP</span>
        </div>

        <button
          type="button"
          className="topbar-omnibox-btn"
          data-testid="omnibox-trigger"
          onClick={() => setCommandPaletteOpen(true)}
          title={`Change observer station (${stationLabel}) — Press ⌘K or /`}
          aria-label={`Observer location ${stationLabel}, open location command palette`}
        >
          <MapPin size={12} color="#38BDF8" aria-hidden="true" style={{ flexShrink: 0 }} />
          <span className="topbar-omnibox-btn__label">{stationLabel}</span>
          <span className="topbar-omnibox-btn__coords tabular">
            {stationCoordsText}
          </span>
          <kbd className="topbar-keycap" aria-hidden="true">
            ⌘K
          </kbd>
        </button>

        {onLocateCurrent && (
          <button
            type="button"
            className={`topbar-action-btn topbar-action-btn--icon topbar-locate-btn${
              isLiveCurrentLocation ? ' is-active' : ''
            }`}
            data-testid="topbar-locate-btn"
            onClick={onLocateCurrent}
            disabled={gpsBusy}
            title="Center on my current geographic location"
            aria-label="Center on my current geographic location"
          >
            <Crosshair size={13} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Center Zone: Segmented View Switcher (MAP / SPLIT / DOME + PIP) & Scope Toggle */}
      <div className="topbar-zone topbar-zone--center">
        <div className="segmented-control" role="group" aria-label="Viewport layout mode">
          {LAYOUT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`segmented-btn${layout === opt.value ? ' is-active' : ''}`}
              aria-pressed={layout === opt.value}
              title={`${opt.label} view (${opt.value === 'map' ? 'M' : opt.value === 'split' ? 'S' : 'D'})`}
              onClick={() => setLayout(opt.value)}
            >
              {opt.label}
            </button>
          ))}
          <button
            type="button"
            className={`segmented-btn segmented-btn--pip${layout === 'map' && skyDomePip ? ' is-active' : ''}`}
            data-testid="topbar-pip-btn"
            aria-pressed={layout === 'map' && skyDomePip}
            onClick={handlePipClick}
            title="Toggle corner Polar Sky-Dome radar PIP in Map view (P)"
          >
            PIP
          </button>
        </div>

        <button
          type="button"
          className={`topbar-scope-pill${atmosphericScope === 'global' ? ' is-global' : ''}`}
          data-testid="scope-toggle-pill"
          aria-pressed={atmosphericScope === 'global'}
          onClick={toggleAtmosphericScope}
          title={
            atmosphericScope === 'global'
              ? `Global atmospheric scope active (click for Local ${radiusKm} km scan cylinder)`
              : `Local ${radiusKm} km scan cylinder active (click for Global Constellation & Military feeds)`
          }
        >
          <span className="topbar-scope-pill__dot" aria-hidden="true" />
          <span className="tabular">
            {atmosphericScope === 'global' ? 'GLOBAL' : `LOCAL ${radiusKm}KM`}
          </span>
          <span className="topbar-scope-pill__swap" aria-hidden="true">
            ⇄
          </span>
        </button>
      </div>

      {/* Right Zone: Overhead Target Lock, FPS Readout, Sweep, Telemetry Beacon, Settings & PWA */}
      <div className="topbar-zone topbar-zone--right">
        <button
          type="button"
          className={`topbar-overhead-btn tabular${hasOverhead ? ' has-targets' : ' is-empty'}`}
          data-testid="topbar-overhead-lock"
          aria-disabled={!hasOverhead}
          onClick={() => {
            useSkyStore.getState().lockHighestOverheadTarget();
          }}
          title={
            hasOverhead
              ? `Lock onto highest target directly overhead (EL >= ${overheadConeDeg}° — click again to cycle)`
              : 'No active targets overhead (EL >= 20°)'
          }
          aria-label={
            hasOverhead
              ? `Lock onto highest overhead target (${counts.overhead} active at elevation ${overheadConeDeg} degrees or higher)`
              : 'No active targets overhead'
          }
        >
          <span className="topbar-overhead-btn__dot" aria-hidden="true" />
          <span>OVERHEAD</span>
          <strong className="topbar-metrics-pill__val">{counts.overhead}</strong>
        </button>

        <div
          className="topbar-metrics-pill tabular"
          title={`Render FPS: ${Math.round(fps)} · ${workerReady ? 'SGP4 Worker Ready' : 'SGP4 Initializing'}`}
        >
          <span className={`worker-dot${workerReady ? ' is-ready' : ''}`} aria-hidden="true" />
          <span>
            <strong className="topbar-metrics-pill__val">{Math.round(fps)}</strong> FPS
          </span>
        </div>

        <button
          type="button"
          className="topbar-action-btn topbar-action-btn--sweep"
          data-testid="topbar-sweep-btn"
          onClick={handleSweepClick}
          title="Reset feed circuit breakers and trigger immediate radar sweep"
          aria-label="Sweep radar and refresh live feeds"
        >
          <Radar size={13} color="#22D3EE" aria-hidden="true" />
          <span className="topbar-sweep-text">SWEEP</span>
        </button>

        <button
          ref={diagTriggerRef}
          type="button"
          className={`topbar-beacon-pill topbar-beacon-pill--${beacon.status}${diagnosticsOpen ? ' is-open' : ''} tabular`}
          data-testid="hud-feed-diagnostics"
          aria-expanded={diagnosticsOpen}
          aria-haspopup="dialog"
          onClick={() => setDiagnosticsOpen(!diagnosticsOpen)}
          title="Open live feed health and circuit-breaker diagnostics"
        >
          <span className="topbar-beacon-pill__dot" aria-hidden="true" />
          <span>{beacon.label}</span>
        </button>

        <button
          ref={settingsTriggerRef}
          type="button"
          className={`topbar-action-btn topbar-action-btn--icon${settingsOpen ? ' is-active' : ''}`}
          data-testid="settings-popover-trigger"
          aria-expanded={settingsOpen}
          aria-haspopup="dialog"
          aria-label="Open cockpit settings"
          title="Cockpit settings (Units, Scope, Audio, Labels, ODID)"
          onClick={() => setSettingsOpen(!settingsOpen)}
        >
          <Settings size={14} aria-hidden="true" />
          {odidActive && <span className="topbar-settings-badge" aria-hidden="true" />}
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
              <Download size={12} aria-hidden="true" />
              <span>Install</span>
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

      {/* Feed Diagnostics Popover */}
      {diagnosticsOpen && (
        <div
          ref={diagPopoverRef}
          className="topbar-popover"
          role="dialog"
          aria-label="System telemetry feed diagnostics"
        >
          <div className="topbar-popover__header">
            <span className="topbar-popover__title">
              <Activity size={13} color="#22D3EE" aria-hidden="true" />
              <span>FEED TELEMETRY DIAGNOSTICS</span>
            </span>
            <button
              type="button"
              className="inspector-close-btn"
              onClick={() => setDiagnosticsOpen(false)}
              aria-label="Close feed diagnostics"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>

          <div className="topbar-popover__body cockpit-scroll">
            <div className="diag-metrics-strip tabular">
              <span>OVERHEAD EL&gt;={overheadConeDeg}°: {counts.overhead}</span>
              <span>TOTAL: {counts.total}</span>
              <span>{Math.round(fps)} FPS</span>
              <span>{workerReady ? 'SGP4 OK' : 'SGP4 INIT'}</span>
            </div>

            <div className="diag-table">
              {FEED_ORDER.map(({ key, label, accent }) => {
                const feed = feeds[key];
                const updatedClock = formatClockTime(feed.lastUpdatedMs, '--:--:--');
                const errorLines = feed.errorMsg
                  ? feed.errorMsg
                      .split(' | ')
                      .map((s) => s.trim())
                      .filter(Boolean)
                  : [];

                return (
                  <div key={key} className="diag-row">
                    <div className="diag-row__top">
                      <span className="diag-row__feed">
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            background: accent,
                            flexShrink: 0,
                          }}
                          aria-hidden="true"
                        />
                        <span>{label}</span>
                        <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
                          ({feed.count})
                        </span>
                      </span>

                      <span className={`feed-pill feed-pill--${feed.status}`}>
                        {STATUS_LABEL[feed.status]}
                      </span>
                    </div>

                    <div className="diag-row__meta tabular">
                      <span className="diag-row__provider" title={feed.provider}>
                        {feed.provider || '—'}
                      </span>
                      <span className="diag-row__timing">
                        UPD {updatedClock} · {formatCountdownShort(feed.nextRefreshSec)}
                      </span>
                    </div>

                    {feed.sourceBreakdown && (
                      <div className="diag-row__breakdown tabular">{feed.sourceBreakdown}</div>
                    )}

                    {errorLines.map((line, idx) => (
                      <div key={`${key}-err-${idx}`} className="diag-row__error tabular">
                        {line}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>

            {nearestSondeHint && (
              <div className="dock-notice dock-notice--sonde">{nearestSondeHint}</div>
            )}

            {!airspace.usCoverage && (
              <div className="dock-notice dock-notice--airspace">
                FAA UASFM / SUA airspace overlays apply to US &amp; territories only.
              </div>
            )}
          </div>

          <div className="topbar-popover__footer" style={{ flexWrap: 'wrap' }}>
            <button
              type="button"
              className="topbar-action-btn topbar-action-btn--sweep"
              style={{ flex: 1, minWidth: 0, width: 'auto', padding: '0 10px', whiteSpace: 'nowrap' }}
              onClick={handleSweepClick}
            >
              <RefreshCw size={12} aria-hidden="true" />
              <span>Reset Breakers &amp; Sweep</span>
            </button>
            <button
              type="button"
              className="topbar-action-btn"
              data-testid="diag-clear-cache-reload"
              style={{ flex: '0 0 auto', padding: '0 10px', whiteSpace: 'nowrap' }}
              onClick={handleClearCacheReload}
              disabled={clearingCache}
              title="Unregister Service Workers, purge browser Cache Storage, and perform a cache-busted reload"
            >
              <RotateCcw size={12} aria-hidden="true" />
              <span>{clearingCache ? 'Clearing…' : 'Clear Cache & Reload'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Cockpit Settings Popover */}
      {settingsOpen && (
        <div
          ref={settingsPopoverRef}
          className="topbar-popover topbar-popover--settings"
          role="dialog"
          aria-label="Cockpit settings"
        >
          <div className="topbar-popover__header">
            <span className="topbar-popover__title">
              <Settings size={13} color="#22D3EE" aria-hidden="true" />
              <span>COCKPIT SETTINGS</span>
            </span>
            <button
              type="button"
              className="inspector-close-btn"
              onClick={() => setSettingsOpen(false)}
              aria-label="Close cockpit settings"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>

          <div className="topbar-popover__body cockpit-scroll">
            <div className="settings-group">
              <span className="settings-group__label">Telemetry Units</span>
              <div className="settings-segment" role="group" aria-label="Unit system">
                {UNIT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`settings-segment__btn${units === opt.value ? ' is-active' : ''}`}
                    aria-pressed={units === opt.value}
                    onClick={() => setUnits(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-group">
              <span className="settings-group__label">Orbital Propagation Scope</span>
              <div className="settings-segment" role="group" aria-label="Orbital scope">
                {ORBITAL_SCOPE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`settings-segment__btn${orbitalScope === opt.value ? ' is-active' : ''}`}
                    aria-pressed={orbitalScope === opt.value}
                    onClick={() => setOrbitalScope(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-group">
              <span className="settings-group__label">Sky-Dome Vault</span>
              <div className="settings-segment" role="group" aria-label="Sky-dome vault zoom">
                <button
                  type="button"
                  className={`settings-segment__btn${skyDomeZoom === 'hemisphere' ? ' is-active' : ''}`}
                  aria-pressed={skyDomeZoom === 'hemisphere'}
                  onClick={() => setSkyDomeZoom('hemisphere')}
                >
                  FULL SKY
                </button>
                <button
                  type="button"
                  className={`settings-segment__btn${skyDomeZoom === 'zenith' ? ' is-active' : ''}`}
                  aria-pressed={skyDomeZoom === 'zenith'}
                  onClick={() => setSkyDomeZoom('zenith')}
                >
                  OVERHEAD 2×
                </button>
              </div>
            </div>

            <div className="settings-hotkeys-strip" data-testid="settings-hotkeys-strip">
              M Map · S Split · D Dome · P PIP · L Labels · ⌘K Search · Esc Close
            </div>

            <div className="settings-group">
              <span className="settings-group__label">WebAudio Acoustics</span>
              <div className="settings-audio-row">
                <button
                  type="button"
                  className={`topbar-action-btn${audioEnabled ? ' is-active' : ''}`}
                  onClick={handleAudioClick}
                  aria-pressed={audioEnabled}
                >
                  {audioEnabled ? (
                    <Volume2 size={13} aria-hidden="true" />
                  ) : (
                    <VolumeX size={13} aria-hidden="true" />
                  )}
                  <span>{audioEnabled ? 'ACTIVE' : 'MUTED'}</span>
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
                />
                <span className="tabular" style={{ fontSize: 10, color: 'var(--text-secondary)', minWidth: 32, textAlign: 'right' }}>
                  {Math.round(audioVolume * 100)}%
                </span>
              </div>
            </div>

            <div className="settings-group">
              <span className="settings-group__label">Overlay Layers</span>
              <div className="settings-toggle-grid">
                <button
                  type="button"
                  className={`settings-chip-btn${mapLabelsEnabled ? ' is-active' : ''}`}
                  aria-pressed={mapLabelsEnabled}
                  onClick={() => setMapLabelsEnabled(!mapLabelsEnabled)}
                >
                  MAP LBL
                </button>
                <button
                  type="button"
                  className={`settings-chip-btn${domeLabelsEnabled ? ' is-active' : ''}`}
                  aria-pressed={domeLabelsEnabled}
                  onClick={() => setDomeLabelsEnabled(!domeLabelsEnabled)}
                >
                  DOME LBL
                </button>
                <button
                  type="button"
                  className={`settings-chip-btn${sweepEnabled ? ' is-active' : ''}`}
                  aria-pressed={sweepEnabled}
                  onClick={() => setSweepEnabled(!sweepEnabled)}
                >
                  SWEEP
                </button>
              </div>
            </div>

            <div className="settings-group">
              <span className="settings-group__label">Observer Station Search</span>
              <button
                type="button"
                className="topbar-action-btn"
                style={{ width: '100%', justifyContent: 'space-between' }}
                onClick={() => {
                  setSettingsOpen(false);
                  setCommandPaletteOpen(true);
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Search size={12} color="#22D3EE" aria-hidden="true" />
                  <span>Location Command Palette</span>
                </span>
                <kbd className="topbar-keycap">⌘K</kbd>
              </button>
            </div>

            <div className="settings-group">
              <span className="settings-group__label">ASTM F3411 Telemetry</span>
              <button
                type="button"
                className="odid-trigger-btn"
                onClick={() => {
                  setOdidModalOpen(true);
                  setSettingsOpen(false);
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <span className={odidDotClass} aria-hidden="true" />
                  <Radio size={12} aria-hidden="true" />
                  <span>ODID STREAM</span>
                </span>
                <span style={{ fontSize: 9.5, color: 'var(--text-secondary)' }}>
                  {odidConfig.connected
                    ? 'LIVE'
                    : odidConfig.simulatorEnabled
                      ? 'SIM ON'
                      : 'CONFIGURE'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

export default TopTelemetryBar;
