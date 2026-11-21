import * as satellite from 'satellite.js';
import {
  AEROSPACE_PRESETS,
  SAT_KINEMATICS_STRIDE,
  type ObserverLocation,
  type OrbitalScope,
  type SatelliteGroup,
  type SatelliteOrbitOverlay,
  type SatelliteWorkerMeta,
  type TleRecord,
  type WorkerRequestMessage,
  type WorkerResponseMessage,
} from '../types/sky-contracts';
import {
  EARTH_MEAN_RADIUS_KM,
  clampLatDeg,
  computeBearingDeg,
  computeTopocentricLookAngles,
  haversineDistanceKm,
  normalizeAzimuthDeg,
  normalizeLonDeg,
  splitAntimeridianLine,
} from '../math/geodesy';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const MU_EARTH_KM3_S2 = 398600.4418;
const WGS84_A_KM = 6378.137;
const EARTH_OMEGA_RAD_S = 7.292115e-5;
const SPEED_OF_LIGHT_KM_S = 299792.458;
const DOPPLER_CARRIER_HZ = 437_000_000;
const STARLINK_STANDARD_CAP = 600;

interface ParsedSatellite {
  satrec: satellite.SatRec;
  meta: SatelliteWorkerMeta;
}

export interface AstroWorkerConfig {
  observer: ObserverLocation;
  radiusKm: number;
  orbitalScope: OrbitalScope;
  activeGroups: Record<SatelliteGroup, boolean>;
  fullConstellation: boolean;
}

const GROUP_PRIORITY: Record<SatelliteGroup, number> = {
  stations: 0,
  visual: 1,
  starlink: 2,
};

function isFiniteVec3(v: { x: number; y: number; z: number }): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/**
 * Compute approximate unit vector from Earth center to Sun in ECI coordinates (accurate to ~0.01 deg).
 */
export function getSunUnitEci(timestampMs: number): { x: number; y: number; z: number } {
  const jd = timestampMs / 86_400_000 + 2440587.5;
  const n = jd - 2451545.0;
  const meanLonDeg = (((280.46 + 0.9856474 * n) % 360) + 360) % 360;
  const meanAnomRad = ((((357.528 + 0.9856003 * n) % 360) + 360) % 360) * DEG_TO_RAD;
  const eclipticLonRad =
    (meanLonDeg + 1.915 * Math.sin(meanAnomRad) + 0.02 * Math.sin(2 * meanAnomRad)) * DEG_TO_RAD;
  const obliquityRad = (23.439 - 0.0000004 * n) * DEG_TO_RAD;

  return {
    x: Math.cos(eclipticLonRad),
    y: Math.cos(obliquityRad) * Math.sin(eclipticLonRad),
    z: Math.sin(obliquityRad) * Math.sin(eclipticLonRad),
  };
}

/** Cylindrical Earth-shadow model testing ECI position against unit Sun vector. */
export function isPositionSunlit(
  posEciKm: { x: number; y: number; z: number },
  sunUnitEci: { x: number; y: number; z: number }
): boolean {
  const dot = posEciKm.x * sunUnitEci.x + posEciKm.y * sunUnitEci.y + posEciKm.z * sunUnitEci.z;
  if (dot >= 0) return true;
  const r2 = posEciKm.x * posEciKm.x + posEciKm.y * posEciKm.y + posEciKm.z * posEciKm.z;
  const perp2 = r2 - dot * dot;
  return perp2 > WGS84_A_KM * WGS84_A_KM;
}

/** Parse raw TLE records via satellite.twoline2satrec, skipping invalid/corrupt records and deduplicating by NORAD ID. */
export function parseTleRecords(records: TleRecord[]): ParsedSatellite[] {
  const byNorad = new Map<number, ParsedSatellite>();

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec || typeof rec.line1 !== 'string' || typeof rec.line2 !== 'string') continue;
    const line1 = rec.line1.trim();
    const line2 = rec.line2.trim();
    if (line1.length < 68 || line2.length < 68) continue;
    if (!line1.startsWith('1 ') || !line2.startsWith('2 ')) continue;

    let satrec: satellite.SatRec;
    try {
      satrec = satellite.twoline2satrec(line1, line2);
    } catch {
      continue;
    }

    if (
      !satrec ||
      satrec.error !== 0 ||
      !Number.isFinite(satrec.no) ||
      satrec.no <= 0 ||
      !Number.isFinite(satrec.inclo) ||
      !Number.isFinite(satrec.ecco) ||
      satrec.ecco < 0 ||
      satrec.ecco >= 1 ||
      !Number.isFinite(satrec.jdsatepoch)
    ) {
      continue;
    }

    const noradId = Number.isFinite(rec.noradId) && rec.noradId > 0
      ? Math.trunc(rec.noradId)
      : Number.parseInt(satrec.satnum, 10);
    if (!Number.isFinite(noradId) || noradId <= 0) continue;

    const existing = byNorad.get(noradId);
    if (existing && GROUP_PRIORITY[existing.meta.group] <= GROUP_PRIORITY[rec.group]) {
      continue;
    }

    const inclinationDeg = (satrec.inclo * RAD_TO_DEG) % 360;
    const periodMin = (2 * Math.PI) / satrec.no;
    const nRadSec = satrec.no / 60;
    const semiMajorKm = Math.cbrt(MU_EARTH_KM3_S2 / (nRadSec * nRadSec));
    const apogeeKm = Math.max(0, semiMajorKm * (1 + satrec.ecco) - WGS84_A_KM);
    const perigeeKm = Math.max(0, semiMajorKm * (1 - satrec.ecco) - WGS84_A_KM);

    if (
      !Number.isFinite(inclinationDeg) ||
      !Number.isFinite(periodMin) ||
      !Number.isFinite(apogeeKm) ||
      !Number.isFinite(perigeeKm)
    ) {
      continue;
    }

    byNorad.set(noradId, {
      satrec,
      meta: {
        id: `sat-${noradId}`,
        noradId,
        name: (rec.name || `NORAD ${noradId}`).trim(),
        group: rec.group,
        inclinationDeg,
        periodMin,
        apogeeKm,
        perigeeKm,
      },
    });
  }

  return Array.from(byNorad.values());
}

/**
 * When fullConstellation is false, preserve all stations & visual records and cap starlink
 * to at most 600 evenly sampled records.
 */
export function selectSatellitePool(
  parsed: ParsedSatellite[],
  fullConstellation: boolean
): ParsedSatellite[] {
  if (fullConstellation) {
    return parsed.slice();
  }

  const priority: ParsedSatellite[] = [];
  const starlink: ParsedSatellite[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (item.meta.group === 'starlink') {
      starlink.push(item);
    } else {
      priority.push(item);
    }
  }

  if (starlink.length <= STARLINK_STANDARD_CAP) {
    return [...priority, ...starlink];
  }

  const sampledStarlink: ParsedSatellite[] = [];
  const step = starlink.length / STARLINK_STANDARD_CAP;
  for (let i = 0; i < STARLINK_STANDARD_CAP; i++) {
    sampledStarlink.push(starlink[Math.floor(i * step)]);
  }

  return [...priority, ...sampledStarlink];
}

function computeLookAnglesSafe(
  observer: ObserverLocation,
  observerGd: satellite.GeodeticLocation,
  posEcfKm: satellite.EcfVec3<number>,
  satLat: number,
  satLon: number,
  satAltKm: number
): { azimuthDeg: number; elevationDeg: number; slantRangeKm: number; groundDistKm: number } {
  const groundDistKm = haversineDistanceKm(observer.lat, observer.lon, satLat, satLon);
  const look = satellite.ecfToLookAngles(observerGd, posEcfKm);

  if (
    Number.isFinite(look.azimuth) &&
    Number.isFinite(look.elevation) &&
    Number.isFinite(look.rangeSat)
  ) {
    return {
      azimuthDeg: normalizeAzimuthDeg(look.azimuth * RAD_TO_DEG),
      elevationDeg: Math.max(-90, Math.min(90, look.elevation * RAD_TO_DEG)),
      slantRangeKm: Math.max(0, look.rangeSat),
      groundDistKm,
    };
  }

  const fallback = computeTopocentricLookAngles(observer, {
    lat: satLat,
    lon: satLon,
    altM: satAltKm * 1000,
  });
  return {
    azimuthDeg: fallback.azimuthDeg,
    elevationDeg: fallback.elevationDeg,
    slantRangeKm: fallback.slantRangeKm,
    groundDistKm: fallback.groundDistKm,
  };
}

/** Propagate an active satellite pool for timestampMs and pack stride-12 Float32Array kinematics. */
export function propagateSatellites(
  pool: ParsedSatellite[],
  timestampMs: number,
  config: AstroWorkerConfig
): { kinematics: Float32Array; meta: SatelliteWorkerMeta[] } {
  const date = new Date(timestampMs);
  const gmst = satellite.gstime(date);
  const dateNext = new Date(timestampMs + 2000);
  const gmstNext = satellite.gstime(dateNext);

  const obsLat = clampLatDeg(config.observer.lat);
  const obsLon = normalizeLonDeg(config.observer.lon);
  const obsAltKm = (Number.isFinite(config.observer.altM) ? config.observer.altM : 0) / 1000;

  const observerGd: satellite.GeodeticLocation = {
    longitude: obsLon * DEG_TO_RAD,
    latitude: obsLat * DEG_TO_RAD,
    height: obsAltKm,
  };
  const obsEcfKm = satellite.geodeticToEcf(observerGd);
  const sunEci = getSunUnitEci(timestampMs);

  const buffer = new Float32Array(pool.length * SAT_KINEMATICS_STRIDE);
  const metaOut: SatelliteWorkerMeta[] = [];
  let writeIdx = 0;

  for (let i = 0; i < pool.length; i++) {
    const sat = pool[i];
    if (!config.activeGroups[sat.meta.group]) continue;

    let pv: satellite.PositionAndVelocity;
    try {
      pv = satellite.propagate(sat.satrec, date);
    } catch {
      continue;
    }

    if (
      sat.satrec.error !== 0 ||
      !pv ||
      typeof pv.position === 'boolean' ||
      typeof pv.velocity === 'boolean' ||
      !isFiniteVec3(pv.position) ||
      !isFiniteVec3(pv.velocity)
    ) {
      continue;
    }

    const posEci = pv.position;
    const velEci = pv.velocity;

    const gd = satellite.eciToGeodetic(posEci, gmst);
    if (!Number.isFinite(gd.latitude) || !Number.isFinite(gd.longitude) || !Number.isFinite(gd.height)) {
      continue;
    }

    const lat = clampLatDeg(gd.latitude * RAD_TO_DEG);
    const lon = normalizeLonDeg(gd.longitude * RAD_TO_DEG);
    const altKm = gd.height;
    if (altKm < -50 || altKm > 500_000) continue;

    const posEcf = satellite.eciToEcf(posEci, gmst);
    if (!isFiniteVec3(posEcf)) continue;

    const look = computeLookAnglesSafe(config.observer, observerGd, posEcf, lat, lon, altKm);
    if (
      !Number.isFinite(look.azimuthDeg) ||
      !Number.isFinite(look.elevationDeg) ||
      !Number.isFinite(look.slantRangeKm) ||
      !Number.isFinite(look.groundDistKm)
    ) {
      continue;
    }

    if (config.orbitalScope === 'cylinder') {
      if (look.groundDistKm > config.radiusKm) continue;
    } else {
      if (look.elevationDeg < -2 && look.groundDistKm > config.radiusKm) continue;
    }

    // 2s finite-diff heading for surviving satellites
    let headingDeg = 0;
    try {
      const pvNext = satellite.propagate(sat.satrec, dateNext);
      if (pvNext && typeof pvNext.position !== 'boolean' && isFiniteVec3(pvNext.position)) {
        const gdNext = satellite.eciToGeodetic(pvNext.position, gmstNext);
        if (Number.isFinite(gdNext.latitude) && Number.isFinite(gdNext.longitude)) {
          const latNext = clampLatDeg(gdNext.latitude * RAD_TO_DEG);
          const lonNext = normalizeLonDeg(gdNext.longitude * RAD_TO_DEG);
          headingDeg = computeBearingDeg(lat, lon, latNext, lonNext);
        }
      }
    } catch {
      headingDeg = 0;
    }

    const speedMs = Math.hypot(velEci.x, velEci.y, velEci.z) * 1000;
    const sunlit = isPositionSunlit(posEci, sunEci);

    const vRot = satellite.eciToEcf(velEci, gmst);
    const vEcfX = vRot.x + EARTH_OMEGA_RAD_S * posEcf.y;
    const vEcfY = vRot.y - EARTH_OMEGA_RAD_S * posEcf.x;
    const vEcfZ = vRot.z;

    const dxKm = posEcf.x - obsEcfKm.x;
    const dyKm = posEcf.y - obsEcfKm.y;
    const dzKm = posEcf.z - obsEcfKm.z;
    const radialVelocityKmS =
      look.slantRangeKm > 1e-6
        ? (dxKm * vEcfX + dyKm * vEcfY + dzKm * vEcfZ) / look.slantRangeKm
        : 0;
    const dopplerHz437MHz = -DOPPLER_CARRIER_HZ * (radialVelocityKmS / SPEED_OF_LIGHT_KM_S);

    const base = writeIdx * SAT_KINEMATICS_STRIDE;
    buffer[base + 0] = lat;
    buffer[base + 1] = lon;
    buffer[base + 2] = altKm * 1000;
    buffer[base + 3] = speedMs;
    buffer[base + 4] = headingDeg;
    buffer[base + 5] = look.azimuthDeg;
    buffer[base + 6] = look.elevationDeg;
    buffer[base + 7] = look.slantRangeKm;
    buffer[base + 8] = look.groundDistKm;
    buffer[base + 9] = sunlit ? 1 : 0;
    buffer[base + 10] = radialVelocityKmS;
    buffer[base + 11] = dopplerHz437MHz;

    metaOut.push(sat.meta);
    writeIdx++;
  }

  return {
    kinematics: buffer.slice(0, writeIdx * SAT_KINEMATICS_STRIDE),
    meta: metaOut,
  };
}

/**
 * Compute -10 min to +20 min (20s step) Antimeridian-split ground track, Az/El pass arc with peak TCA marker,
 * and Earth horizon footprint radius in km.
 */
export function computeSatelliteOrbitOverlay(
  sat: ParsedSatellite,
  timestampMs: number,
  observer: ObserverLocation
): SatelliteOrbitOverlay {
  const obsLat = clampLatDeg(observer.lat);
  const obsLon = normalizeLonDeg(observer.lon);
  const obsAltKm = (Number.isFinite(observer.altM) ? observer.altM : 0) / 1000;
  const observerGd: satellite.GeodeticLocation = {
    longitude: obsLon * DEG_TO_RAD,
    latitude: obsLat * DEG_TO_RAD,
    height: obsAltKm,
  };

  const rawTrack: Array<[number, number]> = [];
  const passArcAzEl: Array<{ azDeg: number; elDeg: number; ts: number; isPeak?: boolean }> = [];
  let footprintRadiusKm = 0;

  for (let dtSec = -600; dtSec <= 1200; dtSec += 20) {
    const sampleTs = timestampMs + dtSec * 1000;
    const sampleDate = new Date(sampleTs);
    const gmst = satellite.gstime(sampleDate);

    let pv: satellite.PositionAndVelocity;
    try {
      pv = satellite.propagate(sat.satrec, sampleDate);
    } catch {
      continue;
    }

    if (
      !pv ||
      typeof pv.position === 'boolean' ||
      !isFiniteVec3(pv.position)
    ) {
      continue;
    }

    const gd = satellite.eciToGeodetic(pv.position, gmst);
    if (!Number.isFinite(gd.latitude) || !Number.isFinite(gd.longitude) || !Number.isFinite(gd.height)) {
      continue;
    }

    const lat = clampLatDeg(gd.latitude * RAD_TO_DEG);
    const lon = normalizeLonDeg(gd.longitude * RAD_TO_DEG);
    const altKm = gd.height;
    if (altKm < -50 || altKm > 500_000) continue;

    rawTrack.push([lon, lat]);

    if (dtSec === 0 && altKm > 0) {
      const cosLambda = EARTH_MEAN_RADIUS_KM / (EARTH_MEAN_RADIUS_KM + altKm);
      footprintRadiusKm = EARTH_MEAN_RADIUS_KM * Math.acos(Math.max(-1, Math.min(1, cosLambda)));
    }

    const posEcf = satellite.eciToEcf(pv.position, gmst);
    if (!isFiniteVec3(posEcf)) continue;

    const look = computeLookAnglesSafe(observer, observerGd, posEcf, lat, lon, altKm);
    if (look.elevationDeg >= -5) {
      passArcAzEl.push({
        azDeg: look.azimuthDeg,
        elDeg: look.elevationDeg,
        ts: sampleTs,
      });
    }
  }

  if (passArcAzEl.length > 0) {
    let peakIdx = 0;
    for (let i = 1; i < passArcAzEl.length; i++) {
      if (passArcAzEl[i].elDeg > passArcAzEl[peakIdx].elDeg) {
        peakIdx = i;
      }
    }
    passArcAzEl[peakIdx] = { ...passArcAzEl[peakIdx], isPeak: true };
  }

  if (footprintRadiusKm === 0) {
    const nowDate = new Date(timestampMs);
    const nowGmst = satellite.gstime(nowDate);
    try {
      const pvNow = satellite.propagate(sat.satrec, nowDate);
      if (pvNow && typeof pvNow.position !== 'boolean' && isFiniteVec3(pvNow.position)) {
        const gdNow = satellite.eciToGeodetic(pvNow.position, nowGmst);
        if (Number.isFinite(gdNow.height) && gdNow.height > 0) {
          const cosLambda = EARTH_MEAN_RADIUS_KM / (EARTH_MEAN_RADIUS_KM + gdNow.height);
          footprintRadiusKm = EARTH_MEAN_RADIUS_KM * Math.acos(Math.max(-1, Math.min(1, cosLambda)));
        }
      }
    } catch {
      footprintRadiusKm = 0;
    }
  }

  return {
    noradId: sat.meta.noradId,
    groundTrackSegments: splitAntimeridianLine(rawTrack),
    passArcAzEl,
    footprintRadiusKm,
  };
}

/** Stateful worker engine decoupled from Web Worker globals for clean unit testing. */
export function createAstroWorkerEngine() {
  const defaultPreset = AEROSPACE_PRESETS[0];
  let allParsed: ParsedSatellite[] = [];
  let activePool: ParsedSatellite[] = [];
  let byNorad = new Map<number, ParsedSatellite>();

  const config: AstroWorkerConfig = {
    observer: {
      lat: defaultPreset.lat,
      lon: defaultPreset.lon,
      altM: defaultPreset.altM,
      label: defaultPreset.name,
      source: 'default',
    },
    radiusKm: defaultPreset.defaultRadiusKm,
    orbitalScope: 'hemisphere',
    activeGroups: {
      stations: true,
      visual: true,
      starlink: true,
    },
    fullConstellation: false,
  };

  function handleMessage(msg: WorkerRequestMessage): WorkerResponseMessage | null {
    switch (msg.type) {
      case 'init-tles': {
        allParsed = parseTleRecords(msg.records);
        byNorad = new Map(allParsed.map((sat) => [sat.meta.noradId, sat]));
        if (msg.fullConstellation !== undefined) {
          config.fullConstellation = msg.fullConstellation;
        }
        activePool = selectSatellitePool(allParsed, config.fullConstellation);
        return {
          type: 'ready',
          count: activePool.length,
          totalParsed: allParsed.length,
        };
      }
      case 'update-config': {
        config.observer = msg.observer;
        config.radiusKm = msg.radiusKm;
        config.orbitalScope = msg.orbitalScope;
        config.activeGroups = msg.activeGroups;
        if (msg.fullConstellation !== undefined && msg.fullConstellation !== config.fullConstellation) {
          config.fullConstellation = msg.fullConstellation;
          activePool = selectSatellitePool(allParsed, config.fullConstellation);
        }
        return null;
      }
      case 'tick': {
        const { kinematics, meta } = propagateSatellites(activePool, msg.timestampMs, config);
        return {
          type: 'propagated',
          timestampMs: msg.timestampMs,
          count: meta.length,
          totalLoaded: activePool.length,
          kinematics,
          meta,
        };
      }
      case 'compute-orbit': {
        const sat = byNorad.get(msg.noradId);
        if (!sat) {
          return {
            type: 'orbit-overlay',
            overlay: {
              noradId: msg.noradId,
              groundTrackSegments: [],
              passArcAzEl: [],
              footprintRadiusKm: 0,
            },
          };
        }
        return {
          type: 'orbit-overlay',
          overlay: computeSatelliteOrbitOverlay(sat, msg.timestampMs, msg.observer),
        };
      }
    }
  }

  return { handleMessage };
}

const isWorkerRuntime =
  typeof window === 'undefined' &&
  typeof self !== 'undefined' &&
  typeof (self as unknown as { postMessage?: unknown }).postMessage === 'function';

if (isWorkerRuntime) {
  const workerScope = self as unknown as DedicatedWorkerGlobalScope;
  const engine = createAstroWorkerEngine();

  workerScope.onmessage = (event: MessageEvent<WorkerRequestMessage>) => {
    try {
      const response = engine.handleMessage(event.data);
      if (!response) return;
      if (response.type === 'propagated') {
        workerScope.postMessage(response, [response.kinematics.buffer]);
      } else {
        workerScope.postMessage(response);
      }
    } catch (err) {
      const errMsg: WorkerResponseMessage = {
        type: 'error',
        message: err instanceof Error ? err.message : 'Unknown worker propagation error',
      };
      workerScope.postMessage(errMsg);
    }
  };
}
