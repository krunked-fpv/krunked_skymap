import type { UnitSystem } from '../types/sky-contracts';
import { clampLatDeg, normalizeAzimuthDeg, normalizeLonDeg } from './geodesy';

const MS_TO_KNOTS = 1.9438444924406;
const MS_TO_KMH = 3.6;
const M_TO_FEET = 3.280839895013123;
const MS_TO_FPM = 196.8503937007874;
const KM_TO_NM = 1 / 1.852;

function cleanZero(val: number): number {
  return val === 0 ? 0 : val;
}

/** Format ground/orbital speed in knots (aviation) or km/h (metric) with tabular alignment. */
export function formatSpeed(speedMs: number, units: UnitSystem = 'aviation'): string {
  if (!Number.isFinite(speedMs)) return '---';
  if (units === 'metric') {
    const kmh = cleanZero(Math.round(speedMs * MS_TO_KMH));
    return `${kmh.toLocaleString('en-US')} km/h`;
  }
  const knots = cleanZero(Math.round(speedMs * MS_TO_KNOTS));
  return `${knots.toLocaleString('en-US')} kt`;
}

/** Format altitude in ft / Flight Levels (aviation) or m / km (metric), switching to km above 100 km. */
export function formatAltitude(altM: number, units: UnitSystem = 'aviation'): string {
  if (!Number.isFinite(altM)) return '---';
  if (altM >= 100_000) {
    return `${(altM / 1000).toFixed(1)} km`;
  }
  if (units === 'metric') {
    if (altM >= 10_000) {
      return `${(altM / 1000).toFixed(1)} km`;
    }
    const meters = cleanZero(Math.round(altM));
    return `${meters.toLocaleString('en-US')} m`;
  }
  const feet = cleanZero(Math.round(altM * M_TO_FEET));
  if (feet >= 18_000) {
    const fl = Math.round(feet / 100);
    return `FL${String(fl).padStart(3, '0')}`;
  }
  return `${feet.toLocaleString('en-US')} ft`;
}

/** Format vertical rate in signed fpm (aviation) or m/s (metric). */
export function formatVerticalRate(vertRateMs: number, units: UnitSystem = 'aviation'): string {
  if (!Number.isFinite(vertRateMs)) return '---';
  if (units === 'metric') {
    if (Math.abs(vertRateMs) < 0.05) return '0.0 m/s';
    const sign = vertRateMs > 0 ? '+' : '';
    return `${sign}${vertRateMs.toFixed(1)} m/s`;
  }
  const fpm = Math.round(vertRateMs * MS_TO_FPM);
  if (Math.abs(fpm) < 1) return '0 fpm';
  const sign = fpm > 0 ? '+' : '';
  return `${sign}${fpm.toLocaleString('en-US')} fpm`;
}

/** Format slant or ground distance in NM (aviation) or m / km (metric). */
export function formatDistance(distKm: number, units: UnitSystem = 'aviation'): string {
  if (!Number.isFinite(distKm)) return '---';
  const clampedKm = Math.max(0, distKm);
  if (units === 'metric') {
    if (clampedKm < 1) {
      return `${Math.round(clampedKm * 1000)} m`;
    }
    if (clampedKm < 100) {
      return `${clampedKm.toFixed(1)} km`;
    }
    return `${Math.round(clampedKm).toLocaleString('en-US')} km`;
  }
  const nm = clampedKm * KM_TO_NM;
  if (nm >= 100) {
    return `${Math.round(nm).toLocaleString('en-US')} NM`;
  }
  return `${nm.toFixed(1)} NM`;
}

/** Format geodetic latitude/longitude with N/S and E/W hemisphere designators. */
export function formatCoords(lat: number, lon: number, decimals = 4): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return '---, ---';
  }
  const cLat = clampLatDeg(lat);
  const nLon = normalizeLonDeg(lon);
  const latDir = cLat >= 0 ? 'N' : 'S';
  const lonDir = nLon >= 0 ? 'E' : 'W';
  const digits = Math.max(0, Math.min(8, Math.floor(decimals)));
  return `${Math.abs(cLat).toFixed(digits)}°${latDir}, ${Math.abs(nLon).toFixed(digits)}°${lonDir}`;
}

/** Format topocentric look angles as fixed-width "AAA.A° / +EE.E°". */
export function formatAzEl(azimuthDeg: number, elevationDeg: number): string {
  if (!Number.isFinite(azimuthDeg) || !Number.isFinite(elevationDeg)) {
    return '---.-° / ---.-°';
  }
  const az = normalizeAzimuthDeg(azimuthDeg);
  const el = Math.max(-90, Math.min(90, elevationDeg));
  const cleanEl = Math.abs(el) < 0.05 ? 0 : el;
  const azStr = az.toFixed(1).padStart(5, '0');
  const elSign = cleanEl >= 0 ? '+' : '';
  return `${azStr}° / ${elSign}${cleanEl.toFixed(1)}°`;
}

/** Format 437 MHz Doppler shift in Hz or kHz with explicit polarity sign. */
export function formatDoppler(dopplerHz: number): string {
  if (!Number.isFinite(dopplerHz)) return '--- Hz';
  if (Math.abs(dopplerHz) < 0.5) return '0 Hz';
  const sign = dopplerHz > 0 ? '+' : '-';
  const absHz = Math.abs(dopplerHz);
  if (absHz >= 1000) {
    return `${sign}${(absHz / 1000).toFixed(2)} kHz`;
  }
  return `${sign}${Math.round(absHz)} Hz`;
}
