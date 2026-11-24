import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  ChevronUp,
  Crosshair,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import {
  AEROSPACE_PRESETS,
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  type BalloonSublayerState,
  type DroneSublayerState,
  type FeedHealthStatus,
  type FeedKey,
  type FeedTelemetryState,
  type SatelliteGroup,
  type SkyCategory,
} from '../../types/sky-contracts';
import { useSkyStore } from '../../store/useSkyStore';
import { formatCoords } from '../inspector/unitFormatters';

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

type ExpandableCategory = 'satellite' | 'balloon' | 'drone';

interface CategoryChipSpec {
  category: SkyCategory;
  shortLabel: string;
  feedKey: FeedKey;
  expandable?: ExpandableCategory;
}

const CATEGORY_CHIPS: CategoryChipSpec[] = [
  { category: 'flight', shortLabel: 'FLIGHTS', feedKey: 'flights' },
  { category: 'military', shortLabel: 'MILITARY', feedKey: 'military' },
  { category: 'satellite', shortLabel: 'ORBITAL', feedKey: 'satellites', expandable: 'satellite' },
  { category: 'balloon', shortLabel: 'BALLOONS', feedKey: 'balloons', expandable: 'balloon' },
  { category: 'drone', shortLabel: 'UAS', feedKey: 'drones', expandable: 'drone' },
];

const SAT_GROUP_CHIPS: Array<{ group: SatelliteGroup; label: string }> = [
  { group: 'stations', label: 'Stations' },
  { group: 'visual', label: 'Visual' },
  { group: 'starlink', label: 'Starlink' },
];

const BALLOON_SUB_CHIPS: Array<{ key: keyof BalloonSublayerState; label: string }> = [
  { key: 'windborne', label: 'WindBorne' },
  { key: 'sondehub', label: 'SondeHub' },
  { key: 'adsbLta', label: 'ADS-B LTA' },
];

const DRONE_SUB_CHIPS: Array<{ key: keyof DroneSublayerState; label: string }> = [
  { key: 'liveUas', label: 'Live UAS' },
  { key: 'airspace', label: 'Airspace' },
  { key: 'simOdid', label: 'Sim' },
];

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

function computeRefreshProgressPct(feed: FeedTelemetryState): number {
  if (feed.status === 'loading') return 100;
  if (feed.intervalSec <= 0) return 100;
  const ratio = (feed.intervalSec - feed.nextRefreshSec) / feed.intervalSec;
  return Math.round(Math.max(0, Math.min(1, ratio)) * 100);
}

function getDegradedFeedSummary(status: FeedHealthStatus, errorMsg?: string): string {
  if (errorMsg) {
    const first = errorMsg.split(' | ')[0]?.trim();
    if (first) return `${STATUS_LABEL[status]} · ${first}`;
  }
  switch (status) {
    case 'rate-limited':
      return 'RATE-LIMITED · Upstream ADS-B cooldown active';
    case 'delayed':
      return 'DELAYED · Live ADS-B refresh delayed';
    default:
      return 'ADS-B ERROR · Live flight feed unavailable';
  }
}

function CategoryGlyph({ category }: { category: SkyCategory }) {
  switch (category) {
    case 'flight':
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 2.5L14.2 9.2L21.5 13.5V15.5L14.2 13.4V18.3L17 20.5V22L12 20.6L7 22V20.5L9.8 18.3V13.4L2.5 15.5V13.5L9.8 9.2L12 2.5Z"
            fill="currentColor"
          />
        </svg>
      );
    case 'military':
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 2L14.3 8.5L21 15L19.2 16.4L14 14.2L13.5 19L16 21.3L12 20.2L8 21.3L10.5 19L10 14.2L4.8 16.4L3 15L9.7 8.5L12 2Z"
            fill="currentColor"
          />
        </svg>
      );
    case 'satellite':
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="9.5" y="9.5" width="5" height="5" rx="1" fill="currentColor" />
          <path
            d="M3.5 6.5L7.5 2.5L10.5 5.5L6.5 9.5L3.5 6.5ZM13.5 18.5L17.5 14.5L20.5 17.5L16.5 21.5L13.5 18.5Z"
            fill="currentColor"
            opacity="0.88"
          />
          <path d="M15.5 8.5L19.5 4.5M8.5 15.5L4.5 19.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case 'balloon':
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 2.5C8.1 2.5 5.5 5.3 5.5 9C5.5 12.6 9.3 15.6 11 17.3H13C14.7 15.6 18.5 12.6 18.5 9C18.5 5.3 15.9 2.5 12 2.5Z"
            fill="currentColor"
          />
          <path d="M10.5 17.3L10.9 20H13.1L13.5 17.3" stroke="currentColor" strokeWidth="1.4" />
          <rect x="10.2" y="20" width="3.6" height="2.2" rx="0.5" fill="currentColor" />
        </svg>
      );
    case 'drone':
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="5.5" cy="5.5" r="2.6" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="18.5" cy="5.5" r="2.6" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="5.5" cy="18.5" r="2.6" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="18.5" cy="18.5" r="2.6" stroke="currentColor" strokeWidth="1.6" />
          <path d="M7.5 7.5L16.5 16.5M16.5 7.5L7.5 16.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          <rect x="10" y="10" width="4" height="4" rx="1" fill="currentColor" />
        </svg>
      );
  }
}

export function ControlDock({
  onLocateGps,
  onSearchLocation,
  onManualSweep,
  gpsBusy = false,
  gpsError = null,
}: ControlDockProps) {
  const observer = useSkyStore((s) => s.observer);
  const locationStatus = useSkyStore((s) => s.locationStatus);
  const setObserver = useSkyStore((s) => s.setObserver);
  const radiusKm = useSkyStore((s) => s.radiusKm);
  const setRadiusKm = useSkyStore((s) => s.setRadiusKm);
  const atmosphericScope = useSkyStore((s) => s.atmosphericScope);
  const layers = useSkyStore((s) => s.layers);
  const toggleLayer = useSkyStore((s) => s.toggleLayer);
  const satGroups = useSkyStore((s) => s.satGroups);
  const toggleSatGroup = useSkyStore((s) => s.toggleSatGroup);
  const balloonSublayers = useSkyStore((s) => s.balloonSublayers);
  const toggleBalloonSublayer = useSkyStore((s) => s.toggleBalloonSublayer);
  const droneSublayers = useSkyStore((s) => s.droneSublayers);
  const toggleDroneSublayer = useSkyStore((s) => s.toggleDroneSublayer);
  const fullConstellation = useSkyStore((s) => s.fullConstellation);
  const setFullConstellation = useSkyStore((s) => s.setFullConstellation);
  const feeds = useSkyStore((s) => s.feeds);
  const counts = useSkyStore((s) => s.counts);
  const airspace = useSkyStore((s) => s.airspace);
  const nearestSondeHint = useSkyStore((s) => s.nearestSondeHint);
  const commandPaletteOpen = useSkyStore((s) => s.commandPaletteOpen);
  const setCommandPaletteOpen = useSkyStore((s) => s.setCommandPaletteOpen);
  const activeTrayCategory = useSkyStore((s) => s.activeDockTray);
  const setActiveTrayCategory = useSkyStore((s) => s.setActiveDockTray);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LocationSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const dockWrapRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);
  const suppressNextSearchRef = useRef<string | null>(null);
  const lastResolvedQueryRef = useRef<string>('');

  // Dismiss sub-filter tray on outside click
  useEffect(() => {
    if (activeTrayCategory === null) return;
    const handleOutsideClick = (event: MouseEvent) => {
      if (
        dockWrapRef.current &&
        event.target instanceof Node &&
        !dockWrapRef.current.contains(event.target)
      ) {
        setActiveTrayCategory(null);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [activeTrayCategory, setActiveTrayCategory]);

  // Auto-focus search input when Command Palette opens
  useEffect(() => {
    if (commandPaletteOpen) {
      const id = window.requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
      return () => window.cancelAnimationFrame(id);
    }
    abortRef.current?.abort();
    abortRef.current = null;
    return undefined;
  }, [commandPaletteOpen]);

  const runSearch = useCallback(
    async (rawQuery: string): Promise<LocationSearchResult[] | null> => {
      const trimmed = rawQuery.trim();
      abortRef.current?.abort();
      if (!trimmed) {
        requestSeqRef.current += 1;
        lastResolvedQueryRef.current = '';
        setResults([]);
        setDropdownOpen(false);
        setActiveIndex(-1);
        setSearching(false);
        return [];
      }

      const controller = new AbortController();
      abortRef.current = controller;
      const seq = ++requestSeqRef.current;
      setSearching(true);

      try {
        const nextResults = await onSearchLocation(trimmed);
        if (controller.signal.aborted || seq !== requestSeqRef.current) return null;
        lastResolvedQueryRef.current = trimmed;
        setResults(nextResults);
        setDropdownOpen(nextResults.length > 0);
        setActiveIndex(nextResults.length > 0 ? 0 : -1);
        return nextResults;
      } catch {
        if (controller.signal.aborted || seq !== requestSeqRef.current) return null;
        lastResolvedQueryRef.current = '';
        setResults([]);
        setDropdownOpen(false);
        setActiveIndex(-1);
        return [];
      } finally {
        if (!controller.signal.aborted && seq === requestSeqRef.current) {
          setSearching(false);
        }
      }
    },
    [onSearchLocation],
  );

  // 250ms debounced location/coordinate search
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
      abortRef.current?.abort();
      requestSeqRef.current += 1;
      lastResolvedQueryRef.current = '';
      setResults([]);
      setDropdownOpen(false);
      setActiveIndex(-1);
      setSearching(false);
      return;
    }

    debounceRef.current = window.setTimeout(() => {
      void runSearch(trimmed);
    }, 250);

    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [query, runSearch]);

  const selectSearchResult = (item: LocationSearchResult) => {
    suppressNextSearchRef.current = item.label.trim();
    lastResolvedQueryRef.current = '';
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
    setCommandPaletteOpen(false);
  };

  const submitQuerySearch = async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (results.length > 0 && lastResolvedQueryRef.current === trimmed) {
      const chosen = results[activeIndex >= 0 ? activeIndex : 0];
      if (chosen) {
        selectSearchResult(chosen);
        return;
      }
    }
    const nextResults = await runSearch(trimmed);
    if (nextResults && nextResults.length > 0) {
      selectSearchResult(nextResults[0]);
    }
  };

  const handleSearchFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitQuerySearch();
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
      void submitQuerySearch();
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setDropdownOpen(false);
      setActiveIndex(-1);
      setCommandPaletteOpen(false);
    }
  };

  const matchedPresetId = useMemo(() => {
    if (observer.source === 'pending') return '';
    const match = AEROSPACE_PRESETS.find(
      (p) => Math.abs(p.lat - observer.lat) < 0.002 && Math.abs(p.lon - observer.lon) < 0.002,
    );
    return match?.id ?? '';
  }, [observer.lat, observer.lon, observer.source]);

  const handlePresetSelect = (presetId: string) => {
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
    setCommandPaletteOpen(false);
  };

  const commandPaletteModal = commandPaletteOpen ? (
    <div
      className="cockpit-modal-backdrop"
      data-testid="command-palette-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          setCommandPaletteOpen(false);
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          setCommandPaletteOpen(false);
        }
      }}
    >
      <div
        className="command-palette"
        data-testid="command-palette-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Observer Location Command Palette"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="command-palette__search-header">
          <form className="command-palette__search-form" onSubmit={handleSearchFormSubmit}>
            <div className="command-palette__input-wrap">
              <Search size={14} className="command-palette__search-icon" aria-hidden="true" />
              <input
                ref={searchInputRef}
                type="text"
                className="command-palette__input"
                data-testid="command-palette-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => {
                  if (results.length > 0) setDropdownOpen(true);
                }}
                onKeyDown={handleSearchKeyDown}
                placeholder="City, airport, ICAO, or coordinates (lat, lon)..."
                aria-label="Search observer city, airport, ICAO, or coordinates"
                aria-expanded={dropdownOpen}
                aria-autocomplete="list"
                role="combobox"
              />
              {query && (
                <button
                  type="button"
                  className="dock-clear-btn"
                  onClick={() => {
                    lastResolvedQueryRef.current = '';
                    setQuery('');
                    setResults([]);
                    setDropdownOpen(false);
                    setActiveIndex(-1);
                    searchInputRef.current?.focus();
                  }}
                  aria-label="Clear location search"
                >
                  <X size={13} aria-hidden="true" />
                </button>
              )}
            </div>

            <button
              type="submit"
              className="command-palette__submit-btn"
              data-testid="command-palette-submit"
              disabled={!query.trim()}
              title="Jump directly to entered coordinates or top location match"
            >
              GO
            </button>
          </form>

          <button
            type="button"
            className="dock-gps-btn"
            data-testid="command-palette-gps"
            onClick={onLocateGps}
            disabled={gpsBusy}
            title="Acquire live browser GPS coordinates"
          >
            <Crosshair size={13} aria-hidden="true" />
            <span>{gpsBusy ? 'LOCATING...' : 'GPS LOCATE'}</span>
          </button>

          <button
            type="button"
            className="inspector-close-btn"
            data-testid="command-palette-close"
            onClick={() => setCommandPaletteOpen(false)}
            aria-label="Close location command palette"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        <div className="command-palette__body cockpit-scroll">
          {gpsError && (
            <div className="dock-notice dock-notice--error" role="alert">
              <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
              <span>{gpsError}</span>
            </div>
          )}

          {searching && (
            <div className="command-palette__section-head">
              <span>Resolving geodetic coordinates...</span>
            </div>
          )}

          {dropdownOpen && results.length > 0 && (
            <div>
              <div className="command-palette__section-head" style={{ marginBottom: 6 }}>
                <span>Search Matches</span>
                <span className="tabular">{results.length}</span>
              </div>
              <ul className="command-palette__results" role="listbox">
                {results.map((item, idx) => (
                  <li
                    key={`${item.lat}-${item.lon}-${item.label}-${idx}`}
                    role="option"
                    aria-selected={idx === activeIndex}
                    data-testid={`command-palette-result-${idx}`}
                    className={`dock-search-option${idx === activeIndex ? ' is-active' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                    }}
                    onClick={() => selectSearchResult(item)}
                    onMouseEnter={() => setActiveIndex(idx)}
                  >
                    <div className="dock-search-option__top">
                      <span className="dock-search-option__label">{item.label}</span>
                      <span className="dock-search-option__coords tabular">
                        {formatCoords(item.lat, item.lon, 2)}
                      </span>
                    </div>
                    <span className="dock-search-option__sub">{item.subtitle}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <div className="command-palette__section-head" style={{ marginBottom: 7 }}>
              <span>Aerospace Hotspot Presets</span>
              <span className="tabular">
                {observer.source === 'pending'
                  ? locationStatus === 'unavailable'
                    ? 'ACTIVE: AWAITING LOCATION'
                    : 'ACTIVE: ACQUIRING LOCATION…'
                  : `ACTIVE: ${observer.label} (${formatCoords(observer.lat, observer.lon, 2)})`}
              </span>
            </div>
            <div className="command-palette__presets">
              {AEROSPACE_PRESETS.map((preset) => {
                const isActive = matchedPresetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    data-testid={`preset-${preset.id}`}
                    className={`palette-preset-card${isActive ? ' is-active' : ''}`}
                    onClick={() => handlePresetSelect(preset.id)}
                  >
                    <div className="palette-preset-card__top">
                      <span className="palette-preset-card__name">{preset.name}</span>
                      <span className="palette-preset-card__coords tabular">
                        {preset.lat.toFixed(2)}, {preset.lon.toFixed(2)}
                      </span>
                    </div>
                    <span className="palette-preset-card__sub">{preset.subtitle}</span>
                    {isActive && <span className="palette-preset-card__badge">ACTIVE STATION</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="command-palette__footer tabular">
          <span>↑↓ Navigate · ↵ or GO Jump to Station</span>
          <span>ESC Close</span>
        </div>
      </div>
    </div>
  ) : null;

  const flightsFeed = feeds.flights;
  const canRetryLiveFeed =
    flightsFeed.status === 'error' ||
    flightsFeed.status === 'rate-limited' ||
    flightsFeed.status === 'delayed';

  return (
    <>
      <div className="control-dock-wrap" ref={dockWrapRef}>
      {/* A) Floating Bottom-Center Tactical Layer Pill Dock + Contextual Trays */}
      {canRetryLiveFeed && (
        <div
          className={`dock-retry-banner${flightsFeed.status === 'error' ? ' is-critical' : ''}`}
          role="status"
          data-testid="dock-feed-diagnostics"
        >
          <AlertTriangle size={13} style={{ flexShrink: 0 }} aria-hidden="true" />
          <span className="dock-retry-banner__msg tabular">
            {getDegradedFeedSummary(flightsFeed.status, flightsFeed.errorMsg)}
          </span>
          <button
            type="button"
            className="dock-feed-diag__retry-btn"
            data-testid="dock-feed-retry"
            onClick={onManualSweep}
            title="Reset feed circuit breakers and retry live ADS-B sweep"
          >
            <RefreshCw size={11} aria-hidden="true" />
            <span>Retry</span>
          </button>
        </div>
      )}

      {activeTrayCategory === 'satellite' && (
        <div
          className="dock-subtray"
          style={{ '--tray-accent': CATEGORY_COLORS.satellite } as CSSProperties}
          role="group"
          aria-label="Orbital sub-filters"
        >
          <span className="dock-subtray__label">ORBITAL</span>
          {SAT_GROUP_CHIPS.map(({ group, label }) => {
            const active = satGroups[group];
            return (
              <button
                key={group}
                type="button"
                className={`dock-subtray__chip${active ? ' is-active' : ''}`}
                aria-pressed={active}
                onClick={() => toggleSatGroup(group)}
              >
                <span className="dock-subtray__chip-dot" aria-hidden="true" />
                <span>{label}</span>
              </button>
            );
          })}
          <button
            type="button"
            className={`dock-subtray__chip${fullConstellation ? ' is-active' : ''}`}
            aria-pressed={fullConstellation}
            onClick={() => setFullConstellation(!fullConstellation)}
            title="Load full Starlink constellation instead of sampled shell"
          >
            <span className="dock-subtray__chip-dot" aria-hidden="true" />
            <span>Full Const.</span>
          </button>
        </div>
      )}

      {activeTrayCategory === 'balloon' && (
        <div
          className="dock-subtray"
          style={{ '--tray-accent': CATEGORY_COLORS.balloon } as CSSProperties}
          role="group"
          aria-label="Balloon constellation sub-filters"
        >
          <span className="dock-subtray__label">BALLOONS</span>
          {BALLOON_SUB_CHIPS.map(({ key, label }) => {
            const active = balloonSublayers[key];
            return (
              <button
                key={key}
                type="button"
                className={`dock-subtray__chip${active ? ' is-active' : ''}`}
                aria-pressed={active}
                onClick={() => toggleBalloonSublayer(key)}
              >
                <span className="dock-subtray__chip-dot" aria-hidden="true" />
                <span>{label}</span>
              </button>
            );
          })}
          {nearestSondeHint && (
            <span className="dock-subtray__hint tabular">{nearestSondeHint}</span>
          )}
        </div>
      )}

      {activeTrayCategory === 'drone' && (
        <div
          className="dock-subtray"
          style={{ '--tray-accent': CATEGORY_COLORS.drone } as CSSProperties}
          role="group"
          aria-label="UAS and airspace sub-filters"
        >
          <span className="dock-subtray__label">UAS</span>
          {DRONE_SUB_CHIPS.map(({ key, label }) => {
            const active = droneSublayers[key];
            return (
              <button
                key={key}
                type="button"
                className={`dock-subtray__chip${active ? ' is-active' : ''}`}
                aria-pressed={active}
                onClick={() => toggleDroneSublayer(key)}
              >
                <span className="dock-subtray__chip-dot" aria-hidden="true" />
                <span>{label}</span>
              </button>
            );
          })}
          {!airspace.usCoverage && (
            <span className="dock-subtray__hint">US FAA ONLY</span>
          )}
        </div>
      )}

      <nav className="dock-pill" aria-label="Tactical layer dock and local scan radius">
        <div className="dock-cat-chips">
          {CATEGORY_CHIPS.map(({ category, shortLabel, feedKey, expandable }) => {
            const active = layers[category];
            const feed = feeds[feedKey];
            const accent = CATEGORY_COLORS[category];
            const progressPct = computeRefreshProgressPct(feed);
            const isTrayOpen = expandable !== undefined && activeTrayCategory === expandable;

            return (
              <div
                key={category}
                className={`dock-cat-chip${active ? ' is-active' : ' is-off'}`}
                style={{ '--chip-accent': accent } as CSSProperties}
              >
                <button
                  type="button"
                  className="dock-cat-chip__main"
                  aria-pressed={active}
                  title={`Toggle ${CATEGORY_LABELS[category]} (${counts[category]} tracked · ${STATUS_LABEL[feed.status]})`}
                  onClick={() => toggleLayer(category)}
                >
                  <span className="dock-cat-chip__head">
                    <span className="dock-cat-chip__icon">
                      <CategoryGlyph category={category} />
                    </span>
                    <span className="dock-cat-chip__count tabular">{counts[category]}</span>
                  </span>
                  <span className="dock-cat-chip__label">{shortLabel}</span>
                </button>

                {expandable && (
                  <button
                    type="button"
                    className={`dock-cat-chip__chevron${isTrayOpen ? ' is-open' : ''}`}
                    aria-expanded={isTrayOpen}
                    aria-label={`${isTrayOpen ? 'Close' : 'Open'} ${shortLabel} sub-filters`}
                    title={`${shortLabel} sub-filters`}
                    onClick={() =>
                      setActiveTrayCategory(activeTrayCategory === expandable ? null : expandable)
                    }
                  >
                    <ChevronUp
                      size={12}
                      style={{
                        transform: isTrayOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 140ms ease',
                      }}
                      aria-hidden="true"
                    />
                  </button>
                )}

                <span className="dock-cat-chip__progress" aria-hidden="true">
                  <span
                    className="dock-cat-chip__progress-bar"
                    style={{ width: `${progressPct}%` }}
                  />
                </span>
              </div>
            );
          })}
        </div>

        <div
          className={`dock-radius-scrubber${atmosphericScope === 'global' ? ' is-dimmed' : ''}`}
          title={
            atmosphericScope === 'global'
              ? `Local ADS-B & airspace cylinder radius (${radiusKm} km) — Global scope active`
              : `Local scan radius: ${radiusKm} km`
          }
        >
          <span className="dock-radius-scrubber__label tabular">LOCAL {radiusKm}KM</span>
          <input
            type="range"
            className="dock-range"
            min={10}
            max={250}
            step={5}
            value={radiusKm}
            onChange={(e) => setRadiusKm(Number(e.target.value))}
            aria-label="Local scan radius in kilometers"
          />
        </div>
      </nav>
    </div>

      {/* B) Portal-Mounted Glass ⌘K Location Command Palette Modal (escapes .control-dock-wrap pointer-events: none) */}
      {commandPaletteModal &&
        (typeof document !== 'undefined' && document.body
          ? createPortal(commandPaletteModal, document.body)
          : commandPaletteModal)}
    </>
  );
}

export default ControlDock;
