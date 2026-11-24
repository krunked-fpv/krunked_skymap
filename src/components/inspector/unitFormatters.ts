import type { UnitSystem } from '../../types/sky-contracts';

const COMPASS_POINTS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
] as const;

function compassCardinal(deg: number): string {
  if (!Number.isFinite(deg)) return '—';
  const normalized = ((deg % 360) + 360) % 360;
  const idx = Math.round(normalized / 22.5) % 16;
  return COMPASS_POINTS[idx];
}

export function formatHeading(headingDeg: number, headingValid = true): string {
  if (headingValid === false) return 'TRACK UNKNOWN';
  if (!Number.isFinite(headingDeg)) return '—';
  const normalized = Math.round(((headingDeg % 360) + 360) % 360) % 360;
  return `${normalized.toString().padStart(3, '0')}° ${compassCardinal(normalized)}`;
}

export function formatSpeed(speedMs: number, units: UnitSystem): string {
  if (!Number.isFinite(speedMs)) return '—';
  if (Math.abs(speedMs) >= 1500) {
    return `${(speedMs / 1000).toFixed(2)} km/s`;
  }
  if (units === 'aviation') {
    const knots = speedMs * 1.94384449;
    return `${Math.round(knots).toLocaleString()} kt`;
  }
  return `${Math.round(speedMs * 3.6).toLocaleString()} km/h`;
}

export function formatAltitude(altM: number, units: UnitSystem, forceFeet = false): string {
  if (!Number.isFinite(altM)) return '—';
  if (!forceFeet && altM >= 100_000) {
    return `${(altM / 1000).toFixed(1)} km`;
  }
  if (units === 'aviation') {
    const ft = Math.round(altM * 3.2808399);
    if (!forceFeet && ft >= 18_000) {
      const fl = Math.round(ft / 100);
      return `FL${fl} (${ft.toLocaleString()} ft)`;
    }
    return `${ft.toLocaleString()} ft`;
  }
  if (Math.abs(altM) >= 20_000) {
    return `${(altM / 1000).toFixed(1)} km`;
  }
  return `${Math.round(altM).toLocaleString()} m`;
}

export function formatVerticalRate(vertRateMs: number, units: UnitSystem): {
  text: string;
  direction: 'up' | 'down' | 'level';
} {
  if (!Number.isFinite(vertRateMs)) {
    return { text: '—', direction: 'level' };
  }
  if (Math.abs(vertRateMs) < 0.15) {
    return {
      text: units === 'aviation' ? '0 fpm' : '0.0 m/s',
      direction: 'level',
    };
  }
  const arrow = vertRateMs > 0 ? '▲' : '▼';
  const direction = vertRateMs > 0 ? 'up' : 'down';
  if (units === 'aviation') {
    const fpm = Math.round(vertRateMs * 196.850394);
    const sign = fpm > 0 ? '+' : '';
    return { text: `${arrow} ${sign}${fpm.toLocaleString()} fpm`, direction };
  }
  const sign = vertRateMs > 0 ? '+' : '';
  return { text: `${arrow} ${sign}${vertRateMs.toFixed(1)} m/s`, direction };
}

export function formatDistance(distKm: number, units: UnitSystem): string {
  if (!Number.isFinite(distKm)) return '—';
  if (units === 'aviation') {
    const nm = distKm * 0.5399568;
    return nm >= 100 ? `${Math.round(nm).toLocaleString()} NM` : `${nm.toFixed(1)} NM`;
  }
  return distKm >= 100 ? `${Math.round(distKm).toLocaleString()} km` : `${distKm.toFixed(1)} km`;
}

export function formatShortRangeM(distM: number, units: UnitSystem): string {
  if (!Number.isFinite(distM)) return '—';
  if (units === 'aviation') {
    return `${Math.round(distM * 3.2808399).toLocaleString()} ft`;
  }
  return distM >= 1000 ? `${(distM / 1000).toFixed(2)} km` : `${Math.round(distM)} m`;
}

export function formatCoords(lat: number, lon: number, decimals = 4): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '—';
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(decimals)}°${ns}, ${Math.abs(lon).toFixed(decimals)}°${ew}`;
}

export function formatAzEl(azimuthDeg: number, elevationDeg: number): {
  azText: string;
  elText: string;
} {
  const azText = Number.isFinite(azimuthDeg)
    ? `${(((azimuthDeg % 360) + 360) % 360).toFixed(1)}° ${compassCardinal(azimuthDeg)}`
    : '—';
  const elText = Number.isFinite(elevationDeg)
    ? `${elevationDeg >= 0 ? '+' : ''}${elevationDeg.toFixed(1)}°`
    : '—';
  return { azText, elText };
}

export function formatDoppler(dopplerHz: number): string {
  if (!Number.isFinite(dopplerHz)) return '—';
  if (Math.abs(dopplerHz) < 0.5) return '0 Hz';
  const sign = dopplerHz > 0 ? '+' : '-';
  const absHz = Math.abs(dopplerHz);
  if (absHz >= 1000) {
    return `${sign}${(absHz / 1000).toFixed(2)} kHz`;
  }
  return `${sign}${Math.round(absHz)} Hz`;
}

/**
 * Formats an epoch timestamp (ms) into local `HH:MM:SS` 24-hour clock string.
 */
export function formatClockTime(
  timestampMs: number | null | undefined,
  emptyText = '--:--:--',
): string {
  if (
    timestampMs === null ||
    timestampMs === undefined ||
    !Number.isFinite(timestampMs) ||
    timestampMs <= 0
  ) {
    return emptyText;
  }
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return emptyText;
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Formats relative observation age (`Xs ago` under 1 min, `Xm Ys ago` under 1 hr).
 */
export function formatRelativeAge(
  timestampMs: number | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (
    timestampMs === null ||
    timestampMs === undefined ||
    !Number.isFinite(timestampMs) ||
    timestampMs <= 0
  ) {
    return '—';
  }
  const ageSec = Math.max(0, Math.round((nowMs - timestampMs) / 1000));
  if (ageSec < 60) {
    return `${ageSec}s ago`;
  }
  if (ageSec < 3600) {
    const mins = Math.floor(ageSec / 60);
    const secs = ageSec % 60;
    return `${mins}m ${secs}s ago`;
  }
  const hours = Math.floor(ageSec / 3600);
  const mins = Math.floor((ageSec % 3600) / 60);
  return `${hours}h ${mins}m ago`;
}

/**
 * Formats a countdown duration in seconds into compact `Xs`, `Xm`, or `Xh` form.
 */
export function formatTcaCountdown(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.round(seconds);
  if (total < 60) return `T-${total}s`;
  return `T-${Math.floor(total / 60)}m ${total % 60}s`;
}

export function formatCountdownShort(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0s';
  if (sec >= 3600) return `${Math.ceil(sec / 3600)}h`;
  if (sec >= 120) return `${Math.ceil(sec / 60)}m`;
  return `${Math.round(sec)}s`;
}
