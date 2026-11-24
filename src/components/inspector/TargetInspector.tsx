import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Navigation,
  Radio,
  ShieldAlert,
  X,
} from 'lucide-react';
import {
  BREACH_COLOR,
  CATEGORY_COLORS,
  EMERGENCY_COLOR,
  SATELLITE_ECLIPSED_COLOR,
  SATELLITE_SUNLIT_COLOR,
  type SkyEntity,
} from '../../types/sky-contracts';
import { useSkyStore } from '../../store/useSkyStore';
import { computeClosestApproach } from '../../math/geodesy';
import {
  formatAltitude,
  formatAzEl,
  formatTcaCountdown,
  formatClockTime,
  formatCoords,
  formatDistance,
  formatDoppler,
  formatHeading,
  formatRelativeAge,
  formatShortRangeM,
  formatSpeed,
  formatVerticalRate,
} from './unitFormatters';

function getCategoryAccent(entity: SkyEntity): string {
  if (entity.category === 'satellite') {
    return entity.sunlit ? SATELLITE_SUNLIT_COLOR : SATELLITE_ECLIPSED_COLOR;
  }
  if (entity.category === 'drone' && (entity.ceilingBreach || entity.tfrBreach)) {
    return BREACH_COLOR;
  }
  if (
    (entity.category === 'flight' || entity.category === 'military') &&
    (entity.squawk === '7700' ||
      entity.squawk === '7600' ||
      entity.squawk === '7500' ||
      Boolean(entity.emergencyFlag))
  ) {
    return EMERGENCY_COLOR;
  }
  return CATEGORY_COLORS[entity.category];
}

function getSquawkMeaning(squawk?: string): string | null {
  if (squawk === '7700') return 'SQUAWK 7700 · GENERAL EMERGENCY';
  if (squawk === '7600') return 'SQUAWK 7600 · RADIO FAILURE';
  if (squawk === '7500') return 'SQUAWK 7500 · UNLAWFUL INTERFERENCE';
  return null;
}

function resolveProvenanceBadge(entity: SkyEntity): string {
  switch (entity.category) {
    case 'balloon':
      if (entity.subSource === 'windborne') {
        return entity.isCachedSeed ? 'WINDBORNE · CACHED' : 'WINDBORNE ATLAS';
      }
      if (entity.subSource === 'adsb-lta') {
        return 'ADS-B LTA';
      }
      return 'SONDEHUB V2';
    case 'drone':
      if (entity.subSource === 'adsb-uas') {
        return entity.isMilitary ? 'LIVE ATC UAS · MILITARY' : 'LIVE ATC UAS';
      }
      if (entity.subSource === 'odid-sim' || entity.isSimulated) {
        return 'SIM-ODID';
      }
      return 'OPENDRONEID LIVE';
    case 'flight':
    case 'military':
      if (entity.isLadd) return 'MIL / LADD';
      if (entity.isPia) return 'MIL / PIA';
      if (entity.isMilitary || entity.category === 'military') return 'MILITARY';
      return 'ADS-B LIVE';
    case 'satellite':
      return 'CELESTRAK SGP4';
  }
}

export function TargetInspector() {
  const inspectorOpen = useSkyStore((s) => s.inspectorOpen);
  const entity = useSkyStore((s) => s.selectedEntitySnapshot);
  const units = useSkyStore((s) => s.units);
  const followSelected = useSkyStore((s) => s.followSelected);
  const setFollowSelected = useSkyStore((s) => s.setFollowSelected);
  const selectEntity = useSkyStore((s) => s.selectEntity);
  const observer = useSkyStore((s) => s.observer);
  const radiusKm = useSkyStore((s) => s.radiusKm);
  const layout = useSkyStore((s) => s.layout);
  const orbitalScope = useSkyStore((s) => s.orbitalScope);
  const atmosphericScope = useSkyStore((s) => s.atmosphericScope);
  const skyDomePip = useSkyStore((s) => s.skyDomePip);
  const skyDomeZoom = useSkyStore((s) => s.skyDomeZoom);

  const [copied, setCopied] = useState(false);
  const [, setClockTick] = useState(0);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setCopied(false);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
  }, [entity?.id]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const isOpen = inspectorOpen && entity !== null;

  useEffect(() => {
    if (!isOpen) return undefined;
    const timer = window.setInterval(() => {
      setClockTick((t) => (t + 1) % 1_000_000);
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [isOpen]);

  const handleCopyPermalink = async () => {
    if (!entity || typeof window === 'undefined') return;
    const params = new URLSearchParams();
    params.set('pin', '1');
    params.set('lat', observer.lat.toFixed(4));
    params.set('lon', observer.lon.toFixed(4));
    params.set('alt', String(Math.round(observer.altM)));
    params.set('label', observer.label);
    params.set('r', String(radiusKm));
    params.set('units', units);
    params.set('layout', layout);
    params.set('scope', orbitalScope);
    params.set('atm', atmosphericScope);
    params.set('pip', skyDomePip ? '1' : '0');
    if (skyDomeZoom === 'zenith') params.set('dz', 'zenith');
    params.set('selected', entity.id);
    const permalink = new URL(`#${params.toString()}`, window.location.href).toString();

    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(permalink);
        ok = true;
      }
    } catch {
      ok = false;
    }

    if (!ok) {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = permalink;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        ok = document.execCommand('copy');
        document.body.removeChild(textarea);
      } catch {
        ok = false;
      }
    }

    if (ok) {
      setCopied(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 2000);
    }
  };

  if (!entity) {
    return (
      <aside
        className="target-inspector"
        aria-hidden="true"
        aria-label="Target telemetry inspector"
      />
    );
  }

  const accent = getCategoryAccent(entity);
  const provenanceLabel = resolveProvenanceBadge(entity);
  const vert = formatVerticalRate(entity.vertRateMs, units);
  const tca = computeClosestApproach(observer, entity, 600);
  const observationClock = formatClockTime(entity.timestampMs, '--:--:--');
  const observationAge = formatRelativeAge(entity.timestampMs, Date.now());
  const observationLabel =
    observationClock === '--:--:--'
      ? '--:--:--'
      : `${observationClock} · ${observationAge}`;
  const { azText, elText } = formatAzEl(
    entity.topocentric.azimuthDeg,
    entity.topocentric.elevationDeg,
  );
  const belowHorizon =
    entity.topocentric.belowHorizon || entity.topocentric.elevationDeg < 0;

  const flightSquawk =
    entity.category === 'flight' || entity.category === 'military'
      ? entity.squawk
      : undefined;
  const squawkAlert = getSquawkMeaning(flightSquawk);

  const showGenericEmergency =
    Boolean(entity.emergencyFlag) &&
    (!squawkAlert || !flightSquawk || !entity.emergencyFlag?.includes(flightSquawk));

  const showAlerts =
    Boolean(squawkAlert) ||
    showGenericEmergency ||
    (entity.category === 'drone' && (entity.ceilingBreach || entity.tfrBreach)) ||
    Boolean(entity.isSimulated);

  const hasOdidOperator =
    entity.category === 'drone' &&
    entity.subSource !== 'adsb-uas' &&
    entity.hasOperatorLocation !== false;

  return (
    <aside
      className={`target-inspector${isOpen ? ' is-open' : ''}`}
      aria-hidden={!isOpen}
      aria-label={`Target inspector for ${entity.callsign || entity.id}`}
    >
      <div className="target-inspector__grab-bar" aria-hidden="true" />

      <div className="target-inspector__header">
        <div style={{ minWidth: 0 }}>
          <h2 className="inspector-callsign tabular">{entity.callsign || entity.id}</h2>
          <p className="inspector-subtitle">{entity.subtitle || entity.id}</p>
          <span className="inspector-cat-badge" style={{ color: accent }}>
            {provenanceLabel}
          </span>
        </div>

        <button
          type="button"
          className="inspector-close-btn"
          onClick={() => selectEntity(null, false)}
          aria-label="Close target inspector"
          title="Close inspector (Esc)"
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      <div className="target-inspector__body cockpit-scroll">
        {showAlerts && (
          <div className="inspector-alerts" role="status">
            {squawkAlert && (
              <div className="inspector-alert inspector-alert--emergency">
                <ShieldAlert size={14} style={{ flexShrink: 0 }} aria-hidden="true" />
                <span>{squawkAlert}</span>
              </div>
            )}

            {showGenericEmergency && (
              <div className="inspector-alert inspector-alert--emergency">
                <AlertTriangle size={14} style={{ flexShrink: 0 }} aria-hidden="true" />
                <span>{entity.emergencyFlag}</span>
              </div>
            )}

            {entity.category === 'drone' && entity.ceilingBreach && (
              <div className="inspector-alert inspector-alert--breach">
                <AlertTriangle size={14} style={{ flexShrink: 0 }} aria-hidden="true" />
                <span>
                  UASFM BREACH · Exceeds{' '}
                  {entity.faaCeilingFt !== null ? `${entity.faaCeilingFt} ft` : 'LAANC'} ceiling
                </span>
              </div>
            )}

            {entity.category === 'drone' && entity.tfrBreach && (
              <div className="inspector-alert inspector-alert--emergency">
                <ShieldAlert size={14} style={{ flexShrink: 0 }} aria-hidden="true" />
                <span>TFR INCURSION · Restricted / SUA Airspace</span>
              </div>
            )}

            {entity.isSimulated && (
              <div className="inspector-alert inspector-alert--sim">
                <Radio size={14} style={{ flexShrink: 0 }} aria-hidden="true" />
                <span>SIM-ODID · Synthesized Local Telemetry</span>
              </div>
            )}
          </div>
        )}

        {/* 2x3 Primary Telemetry Matrix */}
        <section aria-label="Primary telemetry matrix">
          <div className="inspector-section-head">
            <span className="inspector-section-title">PRIMARY TELEMETRY</span>
            <span
              className={`horizon-pill ${
                belowHorizon ? 'horizon-pill--below' : 'horizon-pill--above'
              }`}
            >
              {belowHorizon ? 'BELOW HORIZON' : 'LINE OF SIGHT'}
            </span>
          </div>

          <div className="telemetry-grid">
            <div className="telemetry-cell">
              <div className="telemetry-cell__label">ALTITUDE</div>
              <div className="telemetry-cell__value tabular">
                {entity.altBaroM !== undefined
                  ? formatAltitude(entity.altBaroM, units)
                  : formatAltitude(entity.altM, units)}
              </div>
              <div className="telemetry-cell__sub tabular">
                {entity.altBaroM !== undefined
                  ? `BARO · GEOM ${formatAltitude(entity.altM, units)}`
                  : 'GEOM WGS-84'}
              </div>
            </div>

            <div className="telemetry-cell">
              <div className="telemetry-cell__label">GROUND SPEED</div>
              <div className="telemetry-cell__value tabular">
                {formatSpeed(entity.speedMs, units)}
              </div>
            </div>

            <div className="telemetry-cell">
              <div className="telemetry-cell__label">HEADING / TRACK</div>
              <div
                className="telemetry-cell__value tabular"
                style={
                  entity.headingValid === false
                    ? { color: 'var(--text-secondary)' }
                    : undefined
                }
              >
                {formatHeading(entity.headingDeg, entity.headingValid)}
              </div>
            </div>

            <div className="telemetry-cell">
              <div className="telemetry-cell__label">VERTICAL RATE</div>
              <div
                className="telemetry-cell__value tabular"
                style={{
                  color:
                    vert.direction === 'up'
                      ? '#34D399'
                      : vert.direction === 'down'
                        ? '#F59E0B'
                        : 'var(--text-bright)',
                }}
              >
                {vert.text}
              </div>
            </div>

            <div className="telemetry-cell">
              <div className="telemetry-cell__label">SLANT RANGE</div>
              <div className="telemetry-cell__value tabular">
                {formatDistance(entity.topocentric.slantRangeKm, units)}
              </div>
              <div className="telemetry-cell__sub tabular">
                GND {formatDistance(entity.topocentric.groundDistKm, units)}
              </div>
            </div>

            <div className="telemetry-cell">
              <div className="telemetry-cell__label">AZ / EL</div>
              <div
                className="telemetry-cell__value tabular"
                style={{ color: belowHorizon ? '#FCD34D' : '#6EE7B7' }}
              >
                {azText} · {elText}
              </div>
            </div>
          </div>
        </section>

        {tca.isApproaching && (
          <section
            className="inspector-tca-card"
            data-testid="inspector-tca-card"
            aria-label="Approaching pass prediction"
          >
            <div className="inspector-section-title">APPROACHING PASS · 3D ENU TCA</div>
            <div className="inspector-tca-grid">
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">TCA</div>
                <div className="telemetry-cell__value tabular">{formatTcaCountdown(tca.tcaSeconds)}</div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">PEAK EL</div>
                <div className="telemetry-cell__value tabular">
                  {Number.isFinite(tca.peakElevationDeg)
                    ? `${tca.peakElevationDeg >= 0 ? '+' : ''}${tca.peakElevationDeg.toFixed(1)}°`
                    : '—'}
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">MIN SLANT</div>
                <div className="telemetry-cell__value tabular">
                  {formatDistance(tca.minSlantRangeKm, units)}
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">PEAK AZ</div>
                <div className="telemetry-cell__value tabular">
                  {Number.isFinite(tca.peakAzimuthDeg)
                    ? `${String(Math.round(((tca.peakAzimuthDeg % 360) + 360) % 360) % 360).padStart(3, '0')}°`
                    : '—'}
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Category Deep-Telemetry Section */}
        {(entity.category === 'flight' || entity.category === 'military') && (
          <section aria-label="Flight transponder details">
            <div className="inspector-section-title">TRANSPONDER &amp; AIRFRAME</div>
            <div className="telemetry-grid">
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">ICAO24 HEX</div>
                <div className="telemetry-cell__value tabular">
                  {entity.icaoHex.toUpperCase()}
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">SQUAWK</div>
                <div className="telemetry-cell__value tabular">{entity.squawk || '—'}</div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">REGISTRATION</div>
                <div className="telemetry-cell__value tabular">
                  {entity.registration || '—'}
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">TYPE / CLASS</div>
                <div className="telemetry-cell__value tabular">
                  {entity.aircraftType || entity.airframeClass.toUpperCase()}
                </div>
              </div>
              <div className="telemetry-cell telemetry-cell--wide">
                <div className="telemetry-cell__label">FLAGS</div>
                <div className="telemetry-cell__value tabular">
                  {[
                    entity.onGround ? 'ON GROUND' : 'AIRBORNE',
                    entity.isMilitary ? 'MILITARY' : 'CIVIL',
                    entity.isLadd ? 'LADD' : null,
                    entity.isPia ? 'PIA' : null,
                    entity.sourceFeed ? entity.sourceFeed.toUpperCase() : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">COUNTRY / OPERATOR</div>
                <div className="telemetry-cell__value">{entity.country || 'Unknown'}</div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">COORDINATES</div>
                <div className="telemetry-cell__value tabular">
                  {formatCoords(entity.lat, entity.lon)}
                </div>
              </div>
              <div className="telemetry-cell telemetry-cell--wide">
                <div className="telemetry-cell__label">LAST UPDATED</div>
                <div className="telemetry-cell__value tabular">{observationLabel}</div>
              </div>
            </div>
          </section>
        )}

        {entity.category === 'balloon' && entity.subSource === 'windborne' && (
          <section aria-label="WindBorne stratospheric telemetry">
            <div className="inspector-section-title">WINDBORNE CONSTELLATION</div>
            <div className="telemetry-grid">
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">CONSTELLATION ID</div>
                <div className="telemetry-cell__value tabular">
                  {entity.constellationId || entity.serial}
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">TELEMETRY CACHE</div>
                <div
                  className="telemetry-cell__value tabular"
                  style={{ color: entity.isCachedSeed ? '#FCD34D' : '#6EE7B7' }}
                >
                  {entity.isCachedSeed ? 'CACHED SEED' : 'LIVE'}
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">FLIGHT PHASE</div>
                <div className="telemetry-cell__value tabular">
                  {entity.burstState.toUpperCase()}
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">HISTORICAL TRACK</div>
                <div className="telemetry-cell__value tabular">
                  {entity.trail.length} PTS
                </div>
              </div>
              <div className="telemetry-cell telemetry-cell--wide">
                <div className="telemetry-cell__label">COORDINATES</div>
                <div className="telemetry-cell__value tabular">
                  {formatCoords(entity.lat, entity.lon)}
                </div>
              </div>
              <div className="telemetry-cell telemetry-cell--wide">
                <div className="telemetry-cell__label">LAST UPDATED</div>
                <div className="telemetry-cell__value tabular">{observationLabel}</div>
              </div>
            </div>
          </section>
        )}

        {entity.category === 'balloon' && entity.subSource === 'adsb-lta' && (
          <section aria-label="ADS-B Lighter-Than-Air telemetry">
            <div className="inspector-section-title">ADS-B LTA BALLOON</div>
            <div className="telemetry-grid">
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">ICAO24 HEX</div>
                <div className="telemetry-cell__value tabular">
                  {entity.icaoHex ? entity.icaoHex.toUpperCase() : '—'}
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">REGISTRATION</div>
                <div className="telemetry-cell__value tabular">
                  {entity.registration || '—'}
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">SQUAWK</div>
                <div className="telemetry-cell__value tabular">{entity.squawk || '—'}</div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">AIRCRAFT TYPE</div>
                <div className="telemetry-cell__value tabular">
                  {entity.sondeType || 'ADS-B LTA'}
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">FLIGHT PHASE</div>
                <div className="telemetry-cell__value tabular">
                  {entity.burstState.toUpperCase()}
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">COORDINATES</div>
                <div className="telemetry-cell__value tabular">
                  {formatCoords(entity.lat, entity.lon)}
                </div>
              </div>
              <div className="telemetry-cell telemetry-cell--wide">
                <div className="telemetry-cell__label">LAST UPDATED</div>
                <div className="telemetry-cell__value tabular">{observationLabel}</div>
              </div>
            </div>
          </section>
        )}

        {entity.category === 'balloon' &&
          entity.subSource !== 'windborne' &&
          entity.subSource !== 'adsb-lta' && (
            <section aria-label="Radiosonde meteorological telemetry">
              <div className="inspector-section-title">RADIOSONDE TELEMETRY</div>
              <div className="telemetry-grid">
                <div className="telemetry-cell">
                  <div className="telemetry-cell__label">SERIAL / MODEL</div>
                  <div className="telemetry-cell__value tabular">{entity.serial}</div>
                  <div className="telemetry-cell__sub">{entity.sondeType}</div>
                </div>
                <div className="telemetry-cell">
                  <div className="telemetry-cell__label">FLIGHT PHASE</div>
                  <div className="telemetry-cell__value tabular">
                    {entity.burstState.toUpperCase()}
                  </div>
                </div>
                <div className="telemetry-cell">
                  <div className="telemetry-cell__label">FREQUENCY</div>
                  <div className="telemetry-cell__value tabular">
                    {entity.freqMHz !== undefined ? `${entity.freqMHz.toFixed(3)} MHz` : '—'}
                  </div>
                </div>
                <div className="telemetry-cell">
                  <div className="telemetry-cell__label">TEMP / HUMIDITY</div>
                  <div className="telemetry-cell__value tabular">
                    {entity.tempC !== undefined ? `${entity.tempC.toFixed(1)} °C` : '—'}
                    {' · '}
                    {entity.humidityPct !== undefined ? `${Math.round(entity.humidityPct)}%` : '—'}
                  </div>
                </div>
                <div className="telemetry-cell">
                  <div className="telemetry-cell__label">PRESSURE</div>
                  <div className="telemetry-cell__value tabular">
                    {entity.pressureHPa !== undefined
                      ? `${entity.pressureHPa.toFixed(1)} hPa`
                      : '—'}
                  </div>
                </div>
                <div className="telemetry-cell">
                  <div className="telemetry-cell__label">RX UPLOADER</div>
                  <div className="telemetry-cell__value">
                    {entity.uploaderCallsign || 'SondeHub'}
                  </div>
                </div>
                <div className="telemetry-cell">
                  <div className="telemetry-cell__label">COORDINATES</div>
                  <div className="telemetry-cell__value tabular">
                    {formatCoords(entity.lat, entity.lon)}
                  </div>
                </div>
                <div className="telemetry-cell">
                  <div className="telemetry-cell__label">LAST UPDATED</div>
                  <div className="telemetry-cell__value tabular">{observationLabel}</div>
                </div>
              </div>
            </section>
          )}

        {entity.category === 'drone' && entity.subSource === 'adsb-uas' && (
          <section aria-label="Live ATC unmanned aircraft telemetry">
            <div className="inspector-section-title">ATC UNMANNED AIRCRAFT</div>
            <div className="telemetry-grid">
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">ICAO24 HEX</div>
                <div className="telemetry-cell__value tabular">
                  {entity.icaoHex ? entity.icaoHex.toUpperCase() : '—'}
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">TYPE / CLASS</div>
                <div className="telemetry-cell__value tabular">
                  {[
                    entity.aircraftType,
                    entity.adsbCategory,
                    entity.uaType.toUpperCase(),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">SQUAWK</div>
                <div className="telemetry-cell__value tabular">{entity.squawk || '—'}</div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">COORDINATES</div>
                <div className="telemetry-cell__value tabular">
                  {formatCoords(entity.lat, entity.lon)}
                </div>
              </div>
              <div className="telemetry-cell telemetry-cell--wide">
                <div className="telemetry-cell__label">FLAGS</div>
                <div className="telemetry-cell__value tabular">
                  {[
                    'LIVE ATC UAS',
                    entity.isMilitary ? 'MILITARY' : null,
                    entity.isLadd ? 'LADD' : null,
                    entity.isPia ? 'PIA' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <div className="telemetry-cell telemetry-cell--wide">
                <div className="telemetry-cell__label">LAST UPDATED</div>
                <div className="telemetry-cell__value tabular">{observationLabel}</div>
              </div>
            </div>
          </section>
        )}

        {entity.category === 'drone' && entity.subSource !== 'adsb-uas' && (
          <section aria-label="ASTM F3411 OpenDroneID telemetry">
            <div className="inspector-section-title">OPEN DRONE ID · ASTM F3411</div>
            <div className="telemetry-grid">
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">UAS ID</div>
                <div className="telemetry-cell__value tabular">{entity.uasId}</div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">AIRFRAME / AGL</div>
                <div className="telemetry-cell__value tabular">
                  {entity.uaType.toUpperCase()} · {formatAltitude(entity.altAglM, units, true)} AGL
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">FAA UASFM CEILING</div>
                <div
                  className="telemetry-cell__value tabular"
                  style={{ color: entity.ceilingBreach ? BREACH_COLOR : 'var(--text-bright)' }}
                >
                  {entity.faaCeilingFt !== null ? `${entity.faaCeilingFt} ft AGL` : 'Uncontrolled'}
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">OPERATOR RANGE</div>
                <div className="telemetry-cell__value tabular">
                  {hasOdidOperator
                    ? formatShortRangeM(entity.operatorDistM, units)
                    : 'UNAVAILABLE'}
                </div>
              </div>
              {hasOdidOperator && (
                <div className="telemetry-cell telemetry-cell--wide">
                  <div className="telemetry-cell__label">OPERATOR POSITION</div>
                  <div className="telemetry-cell__value tabular">
                    {formatCoords(entity.operatorLat, entity.operatorLon)}
                  </div>
                  <div className="telemetry-cell__sub">{entity.missionDesc}</div>
                </div>
              )}
              {!hasOdidOperator && (
                <div className="telemetry-cell telemetry-cell--wide">
                  <div className="telemetry-cell__label">MISSION</div>
                  <div className="telemetry-cell__value">{entity.missionDesc || '—'}</div>
                </div>
              )}
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">COORDINATES</div>
                <div className="telemetry-cell__value tabular">
                  {formatCoords(entity.lat, entity.lon)}
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">LAST UPDATED</div>
                <div className="telemetry-cell__value tabular">{observationLabel}</div>
              </div>
            </div>
          </section>
        )}

        {entity.category === 'satellite' && (
          <section aria-label="Orbital Keplerian telemetry">
            <div className="inspector-section-title">ORBITAL SGP4 TELEMETRY</div>
            <div className="telemetry-grid">
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">NORAD ID</div>
                <div className="telemetry-cell__value tabular">#{entity.noradId}</div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">ILLUMINATION</div>
                <div
                  className="telemetry-cell__value tabular"
                  style={{
                    color: entity.sunlit ? SATELLITE_SUNLIT_COLOR : '#A78BFA',
                  }}
                >
                  {entity.sunlit ? 'SUNLIT' : 'ECLIPSED'}
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">INCLINATION</div>
                <div className="telemetry-cell__value tabular">
                  {entity.inclinationDeg.toFixed(2)}°
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">ORBIT PERIOD</div>
                <div className="telemetry-cell__value tabular">
                  {entity.periodMin.toFixed(1)} min
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">APOGEE / PERIGEE</div>
                <div className="telemetry-cell__value tabular">
                  {Math.round(entity.apogeeKm)} / {Math.round(entity.perigeeKm)} km
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">437 MHz DOPPLER</div>
                <div className="telemetry-cell__value tabular">
                  {formatDoppler(entity.dopplerHz437MHz)}
                </div>
                <div className="telemetry-cell__sub tabular">
                  Radial: {entity.radialVelocityKmS >= 0 ? '+' : ''}
                  {entity.radialVelocityKmS.toFixed(2)} km/s
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">SUB-SATELLITE</div>
                <div className="telemetry-cell__value tabular">
                  {formatCoords(entity.lat, entity.lon)}
                </div>
              </div>
              <div className="telemetry-cell">
                <div className="telemetry-cell__label">LAST UPDATED</div>
                <div className="telemetry-cell__value tabular">{observationLabel}</div>
              </div>
            </div>
          </section>
        )}
      </div>

      <div className="target-inspector__footer">
        <button
          type="button"
          className={`inspector-action-btn${followSelected ? ' is-active' : ''}`}
          aria-pressed={followSelected}
          onClick={() => setFollowSelected(!followSelected)}
        >
          <Navigation size={13} aria-hidden="true" />
          <span>{followSelected ? 'FOLLOWING' : 'FOLLOW'}</span>
        </button>

        <button
          type="button"
          className={`inspector-action-btn${copied ? ' is-copied' : ''}`}
          onClick={() => void handleCopyPermalink()}
        >
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          <span>{copied ? 'COPIED!' : 'SHARE LINK'}</span>
        </button>
      </div>
    </aside>
  );
}

export default TargetInspector;
