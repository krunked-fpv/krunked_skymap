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

export function compassCardinal(deg: number): string {
  if (!Number.isFinite(deg)) return '—';
  const normalized = ((deg % 360) + 360) % 360;
  const idx = Math.round(normalized / 22.5) % 16;
  return COMPASS_POINTS[idx];
}

export function formatHeading(headingDeg: number): string {
  if (!Number.isFinite(headingDeg)) return '—';
  const normalized = Math.round(((headingDeg % 360) + 360) % 360) % 360;
  return `${normalized.toString().padStart(3, '0')}° ${compassCardinal(normalized)}`;
}

export function formatSpeed(speedMs: number, units: UnitSystem): string {
  if (!Number.isFinite(speedMs)) return '—';
  if (units === 'aviation') {
    const knots = speedMs * 1.94384449;
    return `${Math.round(knots).toLocaleString()} kt`;
  }
  if (Math.abs(speedMs) >= 1500) {
    return `${(speedMs / 1000).toFixed(2)} km/s`;
  }
  return `${Math.round(speedMs * 3.6).toLocaleString()} km/h`;
}

export function formatAltitude(altM: number, units: UnitSystem, forceFeet = false): string {
  if (!Number.isFinite(altM)) return '—';
  if (units === 'aviation') {
    if (!forceFeet && altM >= 60_000) {
      return `${(altM / 1852).toFixed(1)} NM`;
    }
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
  const rounded = Math.round(dopplerHz);
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded.toLocaleString()} Hz`;
}
