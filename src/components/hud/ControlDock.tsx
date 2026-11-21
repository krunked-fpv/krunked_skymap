import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  Crosshair,
  Info,
  Radar,
  Search,
  SlidersHorizontal,
  Wind,
  X,
} from 'lucide-react';
import {
  AEROSPACE_PRESETS,
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  type FeedHealthStatus,
  type FeedKey,
  type SatelliteGroup,
  type SkyCategory,
} from '../../types/sky-contracts';
import { useSkyStore } from '../../store/useSkyStore';
import { formatClockTime } from '../inspector/unitFormatters';

export interface LocationSearchResult {
  lat: number;
  lon: number;
  label: string;
  subtitle: string;
  altM?: number;
}

export interface ControlDockProps {
  onLocateGps: () => void;
  onSearchLocation: (query: string) => Promise<LocationSearchResult[]>;
  onManualSweep: () => void;
  gpsBusy?: boolean;
  gpsError?: string | null;
}

interface LayerRowDescriptor {
  category: SkyCategory;
  feedKey: FeedKey;
}

const LAYER_ROWS: LayerRowDescriptor[] = [
  { category: 'flight', feedKey: 'flights' },
  { category: 'military', feedKey: 'flights' },
  { category: 'satellite', feedKey: 'satellites' },
  { category: 'balloon', feedKey: 'balloons' },
  { category: 'drone', feedKey: 'drones' },
];

const SAT_GROUP_CHIPS: Array<{ group: SatelliteGroup; label: string }> = [
  { group: 'stations', label: 'Stations' },
  { group: 'visual', label: 'Visual' },
  { group: 'starlink', label: 'Starlink' },
];

const RING_RADIUS = 8.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export const STATUS_LABEL: Record<FeedHealthStatus, string> = {
  idle: 'IDLE',
  loading: 'SYNCING',
  live: 'LIVE',
  delayed: 'DELAYED',
  'rate-limited': 'RATE-LIMITED',
  offline: 'OFFLINE',
  cached: 'CACHED',
  fallback: 'SEEDED',
  error: 'ERROR',
};

function getDegradedFeedNotice(status: FeedHealthStatus): string | null {
  switch (status) {
    case 'rate-limited':
      return 'Upstream ADS-B rate limit reached. Live telemetry is degraded; no synthetic fallback aircraft are shown.';
    case 'offline':
      return 'Network offline. Live ADS-B telemetry is unavailable; no synthetic fallback aircraft are shown.';
    case 'delayed':
      return 'Live ADS-B refresh is delayed. Showing recent verified observations only; no synthetic fallback aircraft are shown.';
    case 'error':
      return 'Live ADS-B telemetry is currently unavailable. No synthetic fallback aircraft are shown.';
    default:
      return null;
  }
}

function formatCountdownShort(sec: number): string {
  if (sec <= 0) return '0s';
  if (sec >= 3600) return `${Math.ceil(sec / 3600)}h`;
  if (sec >= 120) return `${Math.ceil(sec / 60)}m`;
  return `${sec}s`;
}

export function ControlDock({
  onLocateGps,
  onSearchLocation,
  onManualSweep,
  gpsBusy = false,
  gpsError = null,
}: ControlDockProps) {
  const observer = useSkyStore((s) => s.observer);
  const setObserver = useSkyStore((s) => s.setObserver);
  const radiusKm = useSkyStore((s) => s.radiusKm);
  const setRadiusKm = useSkyStore((s) => s.setRadiusKm);
  const units = useSkyStore((s) => s.units);
  const orbitalScope = useSkyStore((s) => s.orbitalScope);
  const setOrbitalScope = useSkyStore((s) => s.setOrbitalScope);
  const layers = useSkyStore((s) => s.layers);
  const toggleLayer = useSkyStore((s) => s.toggleLayer);
  const satGroups = useSkyStore((s) => s.satGroups);
  const toggleSatGroup = useSkyStore((s) => s.toggleSatGroup);
  const fullConstellation = useSkyStore((s) => s.fullConstellation);
  const setFullConstellation = useSkyStore((s) => s.setFullConstellation);
  const feeds = useSkyStore((s) => s.feeds);
  const counts = useSkyStore((s) => s.counts);
  const airspace = useSkyStore((s) => s.airspace);
  const nearestSondeHint = useSkyStore((s) => s.nearestSondeHint);

  const [collapsed, setCollapsed] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth <= 860 : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 860px)');
    const handleMediaChange = (event: MediaQueryListEvent) => {
      setCollapsed(event.matches);
    };
    mq.addEventListener('change', handleMediaChange);
    return () => mq.removeEventListener('change', handleMediaChange);
  }, []);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LocationSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const searchBoxRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<number | null>(null);
  const requestSeqRef = useRef(0);
  const suppressNextSearchRef = useRef<string | null>(null);

  const runSearch = useCallback(
    async (rawQuery: string) => {
      const trimmed = rawQuery.trim();
      if (!trimmed) {
        requestSeqRef.current += 1;
        setResults([]);
        setDropdownOpen(false);
        setActiveIndex(-1);
        setSearching(false);
        return;
      }

      const seq = ++requestSeqRef.current;
      setSearching(true);
      try {
        const nextResults = await onSearchLocation(trimmed);
        if (seq !== requestSeqRef.current) return;
        setResults(nextResults);
        setDropdownOpen(nextResults.length > 0);
        setActiveIndex(nextResults.length > 0 ? 0 : -1);
      } catch {
        if (seq !== requestSeqRef.current) return;
        setResults([]);
        setDropdownOpen(false);
        setActiveIndex(-1);
      } finally {
        if (seq === requestSeqRef.current) {
          setSearching(false);
        }
      }
    },
    [onSearchLocation],
  );

  // 300ms debounced location/coordinate search
  useEffect(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    const trimmed = query.trim();
    if (suppressNextSearchRef.current !== null && suppressNextSearchRef.current === trimmed) {
      suppressNextSearchRef.current = null;
      return;
    }
    if (!trimmed) {
      requestSeqRef.current += 1;
      setResults([]);
      setDropdownOpen(false);
      setActiveIndex(-1);
      setSearching(false);
      return;
    }

    debounceRef.current = window.setTimeout(() => {
      void runSearch(trimmed);
    }, 300);

    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [query, runSearch]);

  // Dismiss dropdown when clicking outside search box
  useEffect(() => {
    const handleOutsideMouseDown = (event: MouseEvent) => {
      if (
        searchBoxRef.current &&
        event.target instanceof Node &&
        !searchBoxRef.current.contains(event.target)
      ) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideMouseDown);
    return () => document.removeEventListener('mousedown', handleOutsideMouseDown);
  }, []);

  const selectSearchResult = (item: LocationSearchResult) => {
    suppressNextSearchRef.current = item.label.trim();
    setObserver({
      lat: item.lat,
      lon: item.lon,
      altM: item.altM ?? 15,
      label: item.label,
      source: 'search',
    });
    setQuery(item.label);
    setDropdownOpen(false);
    setActiveIndex(-1);
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!dropdownOpen && results.length > 0) {
        setDropdownOpen(true);
        setActiveIndex(0);
      } else if (results.length > 0) {
        setActiveIndex((prev) => (prev + 1) % results.length);
      }
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length > 0) {
        setDropdownOpen(true);
        setActiveIndex((prev) => (prev <= 0 ? results.length - 1 : prev - 1));
      }
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (dropdownOpen && results.length > 0) {
        const chosen = results[activeIndex >= 0 ? activeIndex : 0];
        if (chosen) selectSearchResult(chosen);
      } else if (query.trim()) {
        if (debounceRef.current !== null) {
          window.clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        void runSearch(query);
      }
      return;
    }

    if (event.key === 'Escape') {
      setDropdownOpen(false);
      setActiveIndex(-1);
    }
  };

  const matchedPresetId = useMemo(() => {
    const match = AEROSPACE_PRESETS.find(
      (p) =>
        Math.abs(p.lat - observer.lat) < 0.002 &&
        Math.abs(p.lon - observer.lon) < 0.002,
    );
    return match?.id ?? '';
  }, [observer.lat, observer.lon]);

  const activePreset = useMemo(
    () => AEROSPACE_PRESETS.find((p) => p.id === matchedPresetId) ?? null,
    [matchedPresetId],
  );

  const handlePresetChange = (presetId: string) => {
    const preset = AEROSPACE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setObserver({
      lat: preset.lat,
      lon: preset.lon,
      altM: preset.altM,
      label: preset.name,
      source: 'preset',
    });
    setRadiusKm(preset.defaultRadiusKm);
  };

  const radiusSecondaryText =
    units === 'aviation'
      ? `${Math.round(radiusKm * 0.5399568)} NM`
      : `${Math.round(observer.altM)} m MSL`;

  if (collapsed) {
    return (
      <div className="control-dock-wrap">
        <button
          type="button"
          className="control-dock-collapsed-pill"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          aria-label="Open command dock"
          data-testid="control-dock-toggle"
        >
          <SlidersHorizontal size={14} color="#22D3EE" aria-hidden="true" />
          <span>COMMAND DOCK</span>
        </button>
      </div>
    );
  }

  return (
    <div className="control-dock-wrap">
      <aside className="control-dock" aria-label="Mission control dock">
        <div className="control-dock__header">
          <div className="control-dock__title-group">
            <SlidersHorizontal size={13} color="#22D3EE" aria-hidden="true" />
            <span>COMMAND DOCK</span>
          </div>
          <button
            type="button"
            className="control-dock__collapse-btn"
            onClick={() => setCollapsed(true)}
            aria-expanded={true}
            aria-label="Collapse command dock"
            data-testid="control-dock-toggle"
          >
            <ChevronLeft size={13} aria-hidden="true" />
            <span>HIDE</span>
          </button>
        </div>

        <div className="control-dock__body cockpit-scroll">
          {/* Observer Search & GPS */}
          <section className="dock-section" aria-label="Observer location">
            <div className="dock-section-label">
              <span>OBSERVER ORIGIN</span>
              <span className="tabular">
                {observer.lat.toFixed(3)}°, {observer.lon.toFixed(3)}°
              </span>
            </div>

            <div className="dock-search-box" ref={searchBoxRef}>
              <div className="dock-search-row">
                <div className="dock-search-input-wrap">
                  <Search size={13} className="dock-search-icon" aria-hidden="true" />
                  <input
                    type="text"
                    className="dock-input"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onFocus={() => {
                      if (results.length > 0) setDropdownOpen(true);
                    }}
                    onKeyDown={handleSearchKeyDown}
                    placeholder="City, airport, or lat, lon..."
                    aria-label="Search observer city or coordinates"
                    aria-expanded={dropdownOpen}
                    aria-autocomplete="list"
                    role="combobox"
                  />
                  {query && (
                    <button
                      type="button"
                      className="dock-clear-btn"
                      onClick={() => {
                        setQuery('');
                        setResults([]);
                        setDropdownOpen(false);
                        setActiveIndex(-1);
                      }}
                      aria-label="Clear location search"
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  className="dock-gps-btn"
                  onClick={onLocateGps}
                  disabled={gpsBusy}
                  title="Use browser GPS location"
                >
                  <Crosshair size={12} aria-hidden="true" />
                  <span>{gpsBusy ? 'Locating...' : 'Locate Me'}</span>
                </button>
              </div>

              {searching && (
                <div className="dock-inline-meta" style={{ marginTop: 4 }}>
                  <span>Resolving coordinates...</span>
                </div>
              )}

              {dropdownOpen && results.length > 0 && (
                <ul className="dock-search-dropdown cockpit-scroll" role="listbox">
                  {results.map((item, idx) => (
                    <li
                      key={`${item.lat}-${item.lon}-${item.label}-${idx}`}
                      role="option"
                      aria-selected={idx === activeIndex}
                      className={`dock-search-option${idx === activeIndex ? ' is-active' : ''}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectSearchResult(item);
                      }}
                      onMouseEnter={() => setActiveIndex(idx)}
                    >
                      <div className="dock-search-option__top">
                        <span className="dock-search-option__label">{item.label}</span>
                        <span className="dock-search-option__coords tabular">
                          {item.lat.toFixed(2)}, {item.lon.toFixed(2)}
                        </span>
                      </div>
                      <span className="dock-search-option__sub">{item.subtitle}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {gpsError && (
              <div className="dock-notice dock-notice--error" role="alert">
                <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
                <span>{gpsError}</span>
              </div>
            )}

            <select
              className="dock-select"
              value={matchedPresetId}
              onChange={(e) => handlePresetChange(e.target.value)}
              aria-label="Aerospace hotspot preset"
            >
              {matchedPresetId === '' && (
                <option value="" disabled>
                  Custom ({observer.label})
                </option>
              )}
              {AEROSPACE_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>

            <div className="dock-inline-meta">
              <span>{activePreset ? activePreset.subtitle : `Source: ${observer.source.toUpperCase()}`}</span>
            </div>
          </section>

          {/* Scan Radius & Orbital Scope */}
          <section className="dock-section" aria-label="Scan geometry and orbital scope">
            <div className="dock-section-label">
              <span>SCAN RADIUS</span>
              <span className="dock-readout-pill tabular">
                {radiusKm} km · {radiusSecondaryText}
              </span>
            </div>

            <div className="dock-slider-row">
              <span className="tabular" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                10
              </span>
              <input
                type="range"
                className="dock-range"
                min={10}
                max={250}
                step={5}
                value={radiusKm}
                onChange={(e) => setRadiusKm(Number(e.target.value))}
                aria-label="Scan radius in kilometers"
              />
              <span className="tabular" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                250
              </span>
            </div>

            <div className="dock-section-label" style={{ marginTop: 3 }}>
              <span>ORBITAL SCOPE</span>
            </div>
            <div className="dock-scope-grid" role="group" aria-label="Orbital propagation scope">
              <button
                type="button"
                className={`dock-scope-btn${orbitalScope === 'cylinder' ? ' is-active' : ''}`}
                aria-pressed={orbitalScope === 'cylinder'}
                onClick={() => setOrbitalScope('cylinder')}
              >
                Scan Cylinder
              </button>
              <button
                type="button"
                className={`dock-scope-btn${orbitalScope === 'hemisphere' ? ' is-active' : ''}`}
                aria-pressed={orbitalScope === 'hemisphere'}
                onClick={() => setOrbitalScope('hemisphere')}
              >
                Full Sky EL&gt;0°
              </button>
            </div>
          </section>

          {/* 5 Layer Toggles with Countdown Rings & Feed Health */}
          <section className="dock-section" aria-label="Telemetry layers">
            <div className="dock-section-label">
              <span>AEROSPACE LAYERS</span>
              <span className="tabular">{counts.total} TRACKED</span>
            </div>

            <div className="layer-list">
              {LAYER_ROWS.map(({ category, feedKey }) => {
                const active = layers[category];
                const feed = feeds[feedKey];
                const color = CATEGORY_COLORS[category];
                const ratio =
                  feed.intervalSec > 0
                    ? Math.max(0, Math.min(1, feed.nextRefreshSec / feed.intervalSec))
                    : 0;
                const dashOffset = RING_CIRCUMFERENCE * (1 - ratio);
                const statusClass = `feed-pill feed-pill--${feed.status}`;
                const ringTitle = `${feed.provider} · Next sync ${formatCountdownShort(
                  feed.nextRefreshSec,
                )}${feed.errorMsg ? ` · ${feed.errorMsg}` : ''}`;

                return (
                  <button
                    key={category}
                    type="button"
                    className={`layer-row${active ? '' : ' is-off'}`}
                    style={{ '--layer-color': color } as CSSProperties}
                    onClick={() => toggleLayer(category)}
                    aria-pressed={active}
                    title={ringTitle}
                  >
                    <span className="layer-row__left">
                      <span className="layer-row__dot" aria-hidden="true" />
                      <span className="layer-row__name">{CATEGORY_LABELS[category]}</span>
                    </span>

                    <span className="layer-row__right">
                      <span className="layer-row__count tabular">{counts[category]}</span>
                      <span className={statusClass}>{STATUS_LABEL[feed.status]}</span>
                      <span
                        className="countdown-ring-wrap"
                        title={ringTitle}
                        aria-hidden="true"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          className={`countdown-ring-svg${
                            feed.status === 'loading' ? ' is-spinning' : ''
                          }`}
                        >
                          <circle
                            cx="12"
                            cy="12"
                            r={RING_RADIUS}
                            className="countdown-ring-bg"
                          />
                          <circle
                            cx="12"
                            cy="12"
                            r={RING_RADIUS}
                            className="countdown-ring-fg"
                            stroke={color}
                            strokeDasharray={RING_CIRCUMFERENCE}
                            strokeDashoffset={dashOffset}
                          />
                        </svg>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            {(() => {
              const flightsFeed = feeds.flights;
              const liveAircraftCount = counts.flight + counts.military;
              const lastUpdatedText = formatClockTime(flightsFeed.lastUpdatedMs, 'Never');
              const degradedNotice = getDegradedFeedNotice(flightsFeed.status);
              const isCritical =
                flightsFeed.status === 'offline' || flightsFeed.status === 'error';

              return (
                <div className="dock-feed-diag" data-testid="dock-feed-diagnostics">
                  <div className="dock-feed-diag__header">
                    <span className="dock-feed-diag__title">LIVE FEED DIAGNOSTICS</span>
                    <span className={`feed-pill feed-pill--${flightsFeed.status}`}>
                      {STATUS_LABEL[flightsFeed.status]}
                    </span>
                  </div>

                  <div className="dock-feed-diag__meta">
                    <span className="dock-feed-diag__key">ADS-B Targets</span>
                    <span className="dock-feed-diag__val tabular">
                      {liveAircraftCount} verified live
                    </span>

                    <span className="dock-feed-diag__key">Last Updated</span>
                    <span className="dock-feed-diag__val tabular">{lastUpdatedText}</span>

                    <span className="dock-feed-diag__key">Provider</span>
                    <span
                      className="dock-feed-diag__val tabular"
                      title={flightsFeed.provider || 'adsb-cascade'}
                    >
                      {flightsFeed.provider || 'adsb-cascade'}
                    </span>
                  </div>

                  {degradedNotice && (
                    <div
                      className={`dock-feed-diag__notice${isCritical ? ' is-critical' : ''}`}
                      role="status"
                    >
                      <AlertTriangle
                        size={12}
                        style={{ flexShrink: 0, marginTop: 1 }}
                        aria-hidden="true"
                      />
                      <div>
                        <span>{degradedNotice}</span>
                        {flightsFeed.errorMsg && (
                          <span className="dock-feed-diag__error-detail">
                            {flightsFeed.errorMsg}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </section>

          {/* Satellite Subfilters */}
          <section className="dock-section" aria-label="Satellite constellation filters">
            <div className="dock-section-label">
              <span>ORBITAL SUBFILTERS</span>
              <span className="tabular" style={{ color: 'var(--cat-satellite)' }}>
                SGP4
              </span>
            </div>

            <div className="chip-row" role="group" aria-label="Satellite groups">
              {SAT_GROUP_CHIPS.map(({ group, label }) => {
                const active = satGroups[group];
                return (
                  <button
                    key={group}
                    type="button"
                    className={`sat-chip${active ? ' is-active' : ''}`}
                    aria-pressed={active}
                    onClick={() => toggleSatGroup(group)}
                  >
                    {label}
                  </button>
                );
              })}
              <button
                type="button"
                className={`sat-chip${fullConstellation ? ' is-active' : ''}`}
                aria-pressed={fullConstellation}
                onClick={() => setFullConstellation(!fullConstellation)}
                title="Load all Starlink shells instead of sampled constellation"
              >
                Full Const.
              </button>
            </div>
          </section>

          {/* Contextual Sonde & FAA Coverage Notices */}
          {(nearestSondeHint || !airspace.usCoverage) && (
            <section className="dock-section" aria-label="Regional feed notices">
              {nearestSondeHint && (
                <div className="dock-notice dock-notice--sonde">
                  <Wind size={13} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
                  <span>{nearestSondeHint}</span>
                </div>
              )}

              {!airspace.usCoverage && (
                <div className="dock-notice dock-notice--airspace">
                  <Info size={13} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
                  <span>
                    FAA UASFM / SUA airspace overlays apply to US &amp; territories only.
                  </span>
                </div>
              )}
            </section>
          )}

          {/* Manual Sweep Action */}
          <section className="dock-section" aria-label="Radar sweep trigger">
            <div className="dock-inline-meta">
              <span>FAA Airspace Feed</span>
              <span className={`feed-pill feed-pill--${feeds.airspace.status}`}>
                {STATUS_LABEL[feeds.airspace.status]}
              </span>
            </div>
            <button
              type="button"
              className="dock-sweep-btn"
              onClick={onManualSweep}
              title="Trigger immediate radar sweep pulse and refresh active feeds"
            >
              <Radar size={14} aria-hidden="true" />
              <span>Sweep Now</span>
            </button>
          </section>
        </div>
      </aside>
    </div>
  );
}

export default ControlDock;
