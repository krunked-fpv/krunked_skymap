import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  BREACH_COLOR,
  CATEGORY_COLORS,
  EMERGENCY_COLOR,
  SATELLITE_ECLIPSED_COLOR,
  SATELLITE_SUNLIT_COLOR,
  type SkyEntity,
  type UnitSystem,
} from '../../types/sky-contracts';
import { liveKinematicsRegistry, useSkyStore } from '../../store/useSkyStore';
import { registerTacticalSprites, resolveSpriteForEntity } from '../../assets/sprites/tacticalSprites';

export interface TacticalMapProps {
  className?: string;
}

interface HoverTooltipState {
  id: string;
  x: number;
  y: number;
  callsign: string;
  subtitle: string;
  categoryLabel: string;
  color: string;
  altText: string;
  speedText: string;
  azElText: string;
  belowHorizon: boolean;
  alertTag: string | null;
}

const EARTH_RADIUS_KM = 6371.0088;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

const EMPTY_FC: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

const SOURCE_IDS = {
  uasfm: 'uasfm-zones',
  sua: 'sua-zones',
  scanRing: 'scan-ring',
  orbitOverlay: 'orbit-overlay',
  entityTrails: 'entity-trails',
  operators: 'operators-src',
  observer: 'observer-src',
  entities: 'entities-src',
} as const;

const LAYER_IDS = {
  uasfmFill: 'uasfm-fill',
  uasfmOutline: 'uasfm-outline',
  suaFill: 'sua-fill',
  suaOutline: 'sua-outline',
  scanFill: 'scan-ring-fill',
  scanHalf: 'scan-ring-half',
  scanOuterGlow: 'scan-ring-outer-glow',
  scanOuter: 'scan-ring-outer',
  orbitFootprintFill: 'orbit-footprint-fill',
  orbitFootprintLine: 'orbit-footprint-line',
  orbitTrackGlow: 'orbit-groundtrack-glow',
  orbitTrackLine: 'orbit-groundtrack-line',
  trailsLine: 'trails-line',
  vectorsLine: 'vectors-line',
  tethersLine: 'tethers-line',
  operatorsSymbol: 'operators-symbol',
  observerSymbol: 'observer-symbol',
  entitiesAlertRing: 'entities-alert-ring',
  entitiesHighlightRing: 'entities-highlight-ring',
  entitiesSymbol: 'entities-symbol',
} as const;

const TACTICAL_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  name: 'Krunked Obsidian Tactical',
  sources: {
    'carto-dark': {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    },
  },
  layers: [
    {
      id: 'obsidian-bg',
      type: 'background',
      paint: {
        'background-color': '#06090F',
      },
    },
    {
      id: 'carto-dark-tiles',
      type: 'raster',
      source: 'carto-dark',
      paint: {
        'raster-opacity': 0.9,
        'raster-brightness-max': 0.88,
        'raster-contrast': 0.14,
        'raster-saturation': -0.35,
      },
    },
  ],
};

function normalizeLonDeg(lon: number): number {
  if (!Number.isFinite(lon)) return 0;
  let normalized = (((lon + 180) % 360) + 360) % 360 - 180;
  if (normalized === -180 && lon > 0) normalized = 180;
  return normalized;
}

function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lon1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lon2)
  ) {
    return 0;
  }
  const phi1 = lat1 * DEG_TO_RAD;
  const phi2 = lat2 * DEG_TO_RAD;
  const dPhi = (lat2 - lat1) * DEG_TO_RAD;
  const dLambda = (lon2 - lon1) * DEG_TO_RAD;
  const sinDPhi = Math.sin(dPhi * 0.5);
  const sinDLambda = Math.sin(dLambda * 0.5);
  const a = Math.max(
    0,
    Math.min(1, sinDPhi * sinDPhi + Math.cos(phi1) * Math.cos(phi2) * sinDLambda * sinDLambda)
  );
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

function greatCircleDestination(
  latDeg: number,
  lonDeg: number,
  bearingDeg: number,
  distKm: number
): { lat: number; lon: number } {
  const delta = distKm / EARTH_RADIUS_KM;
  const theta = bearingDeg * DEG_TO_RAD;
  const phi1 = latDeg * DEG_TO_RAD;
  const lambda1 = lonDeg * DEG_TO_RAD;

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const sinDelta = Math.sin(delta);
  const cosDelta = Math.cos(delta);

  const sinPhi2 = Math.max(-1, Math.min(1, sinPhi1 * cosDelta + cosPhi1 * sinDelta * Math.cos(theta)));
  const phi2 = Math.asin(sinPhi2);
  const y = Math.sin(theta) * sinDelta * cosPhi1;
  const x = cosDelta - sinPhi1 * sinPhi2;
  const lambda2 = lambda1 + Math.atan2(y, x);

  return {
    lat: phi2 * RAD_TO_DEG,
    lon: normalizeLonDeg(lambda2 * RAD_TO_DEG),
  };
}

function splitAntimeridianLine(coords: Array<[number, number]>): Array<Array<[number, number]>> {
  const valid: Array<[number, number]> = [];
  for (const pt of coords) {
    if (pt && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) {
      valid.push([normalizeLonDeg(pt[0]), Math.max(-89.999, Math.min(89.999, pt[1]))]);
    }
  }
  if (valid.length < 2) return [];

  const segments: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [valid[0]];

  for (let i = 1; i < valid.length; i++) {
    const [lonA, latA] = valid[i - 1];
    const [lonB, latB] = valid[i];
    const diff = lonB - lonA;

    if (Math.abs(diff) > 180) {
      if (lonA >= 0 && lonB < 0) {
        const lonBUnwrapped = lonB + 360;
        const span = lonBUnwrapped - lonA;
        const t = span !== 0 ? Math.max(0, Math.min(1, (180 - lonA) / span)) : 0.5;
        const latCross = latA + t * (latB - latA);
        if (current[current.length - 1][0] !== 180) {
          current.push([180, latCross]);
        }
        if (current.length >= 2) segments.push(current);
        current = [
          [-180, latCross],
          [lonB, latB],
        ];
      } else {
        const lonBUnwrapped = lonB - 360;
        const span = lonBUnwrapped - lonA;
        const t = span !== 0 ? Math.max(0, Math.min(1, (-180 - lonA) / span)) : 0.5;
        const latCross = latA + t * (latB - latA);
        if (current[current.length - 1][0] !== -180) {
          current.push([-180, latCross]);
        }
        if (current.length >= 2) segments.push(current);
        current = [
          [180, latCross],
          [lonB, latB],
        ];
      }
    } else {
      current.push([lonB, latB]);
    }
  }

  if (current.length >= 2) {
    segments.push(current);
  }
  return segments;
}

function buildGeodesicCircle(
  latDeg: number,
  lonDeg: number,
  radiusKm: number,
  steps = 96
): { segments: Array<Array<[number, number]>>; closedRing: Array<[number, number]> | null } {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || !Number.isFinite(radiusKm) || radiusKm <= 0) {
    return { segments: [], closedRing: null };
  }
  const ring: Array<[number, number]> = [];
  let crossesAntimeridian = false;

  for (let i = 0; i <= steps; i++) {
    const bearing = (i / steps) * 360;
    const pt = greatCircleDestination(latDeg, lonDeg, bearing, radiusKm);
    const coord: [number, number] = [pt.lon, Math.max(-85.05, Math.min(85.05, pt.lat))];
    if (ring.length > 0 && Math.abs(coord[0] - ring[ring.length - 1][0]) > 180) {
      crossesAntimeridian = true;
    }
    ring.push(coord);
  }

  if (ring.length > 1) {
    ring[ring.length - 1] = [ring[0][0], ring[0][1]];
  }

  const segments = splitAntimeridianLine(ring);
  return {
    segments,
    closedRing: !crossesAntimeridian && segments.length === 1 ? ring : null,
  };
}

function zoomForRadiusKm(radiusKm: number, latDeg = 38): number {
  const clampedRadius = Math.max(10, Math.min(250, radiusKm));
  const cosLat = Math.max(0.25, Math.cos(Math.min(80, Math.abs(latDeg)) * DEG_TO_RAD));
  const rawZoom = Math.log2((19568 * cosLat) / clampedRadius);
  return Math.max(4.5, Math.min(12.5, rawZoom));
}

function resolveEntityColor(entity: SkyEntity): string {
  if (entity.category === 'flight' || entity.category === 'military') {
    const isEmergency =
      Boolean(entity.emergencyFlag) ||
      entity.squawk === '7700' ||
      entity.squawk === '7600' ||
      entity.squawk === '7500';
    if (isEmergency) return EMERGENCY_COLOR;
    return entity.isMilitary || entity.category === 'military'
      ? CATEGORY_COLORS.military
      : CATEGORY_COLORS.flight;
  }
  if (entity.category === 'satellite') {
    return entity.sunlit ? SATELLITE_SUNLIT_COLOR : SATELLITE_ECLIPSED_COLOR;
  }
  if (entity.category === 'drone') {
    return entity.ceilingBreach || entity.tfrBreach || Boolean(entity.emergencyFlag)
      ? BREACH_COLOR
      : CATEGORY_COLORS.drone;
  }
  return CATEGORY_COLORS[entity.category];
}

function formatAltitudeCompact(entity: SkyEntity, units: UnitSystem): string {
  if (entity.category === 'satellite') {
    const altKm = entity.altM / 1000;
    return `${altKm.toFixed(0)} km`;
  }
  if (units === 'aviation') {
    const altFt = Math.round(entity.altM * 3.28084);
    if (altFt >= 18000) {
      return `FL${Math.round(altFt / 100).toString().padStart(3, '0')}`;
    }
    return `${altFt.toLocaleString()} ft`;
  }
  if (entity.altM >= 10000) {
    return `${(entity.altM / 1000).toFixed(1)} km`;
  }
  return `${Math.round(entity.altM).toLocaleString()} m`;
}

function formatSpeedCompact(entity: SkyEntity, units: UnitSystem): string {
  if (entity.category === 'satellite') {
    return `${(entity.speedMs / 1000).toFixed(2)} km/s`;
  }
  if (units === 'aviation') {
    return `${Math.round(entity.speedMs * 1.943844)} kts`;
  }
  if (entity.category === 'drone') {
    return `${entity.speedMs.toFixed(1)} m/s`;
  }
  return `${Math.round(entity.speedMs * 3.6)} km/h`;
}

function buildHoverTooltip(
  entity: SkyEntity,
  x: number,
  y: number,
  units: UnitSystem
): HoverTooltipState {
  let alertTag: string | null = null;
  if (entity.category === 'flight' || entity.category === 'military') {
    if (entity.squawk === '7700' || entity.squawk === '7600' || entity.squawk === '7500') {
      alertTag = `SQK ${entity.squawk}`;
    } else if (entity.emergencyFlag) {
      alertTag = entity.emergencyFlag;
    }
  } else if (entity.category === 'drone') {
    if (entity.tfrBreach) alertTag = 'TFR BREACH';
    else if (entity.ceilingBreach) alertTag = 'UASFM BREACH';
    else if (entity.isSimulated) alertTag = 'SIM-ODID';
  }

  const categoryMap: Record<SkyEntity['category'], string> = {
    flight: 'CIVIL',
    military: 'MIL',
    satellite: 'SAT',
    balloon: 'SONDE',
    drone: 'UAS',
  };

  const az = Math.round(((entity.topocentric.azimuthDeg % 360) + 360) % 360)
    .toString()
    .padStart(3, '0');
  const el = `${entity.topocentric.elevationDeg >= 0 ? '+' : ''}${entity.topocentric.elevationDeg.toFixed(1)}°`;

  return {
    id: entity.id,
    x,
    y,
    callsign: entity.callsign || entity.id,
    subtitle: entity.subtitle,
    categoryLabel: categoryMap[entity.category],
    color: resolveEntityColor(entity),
    altText: formatAltitudeCompact(entity, units),
    speedText: formatSpeedCompact(entity, units),
    azElText: `${az}° / ${el}`,
    belowHorizon: entity.topocentric.belowHorizon,
    alertTag,
  };
}

function buildScanRingFc(lat: number, lon: number, radiusKm: number): GeoJSON.FeatureCollection {
  const outer = buildGeodesicCircle(lat, lon, radiusKm, 108);
  const half = buildGeodesicCircle(lat, lon, radiusKm * 0.5, 96);
  const features: GeoJSON.Feature[] = [];

  if (outer.closedRing) {
    features.push({
      type: 'Feature',
      properties: { kind: 'outer-fill' },
      geometry: {
        type: 'Polygon',
        coordinates: [outer.closedRing],
      },
    });
  }
  if (outer.segments.length > 0) {
    features.push({
      type: 'Feature',
      properties: { kind: 'outer' },
      geometry: {
        type: 'MultiLineString',
        coordinates: outer.segments,
      },
    });
  }
  if (half.segments.length > 0) {
    features.push({
      type: 'Feature',
      properties: { kind: 'half' },
      geometry: {
        type: 'MultiLineString',
        coordinates: half.segments,
      },
    });
  }

  return { type: 'FeatureCollection', features };
}

function buildObserverFc(lat: number, lon: number, label: string): GeoJSON.FeatureCollection {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return EMPTY_FC;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { label },
        geometry: {
          type: 'Point',
          coordinates: [normalizeLonDeg(lon), lat],
        },
      },
    ],
  };
}

function buildOrbitOverlayFc(): GeoJSON.FeatureCollection {
  const overlay = liveKinematicsRegistry.orbitOverlay;
  if (!overlay) return EMPTY_FC;

  const features: GeoJSON.Feature[] = [];
  const trackSegments: Array<Array<[number, number]>> = [];
  for (const seg of overlay.groundTrackSegments) {
    const split = splitAntimeridianLine(seg);
    for (const s of split) {
      trackSegments.push(s);
    }
  }
  if (trackSegments.length > 0) {
    features.push({
      type: 'Feature',
      properties: { kind: 'groundtrack', noradId: overlay.noradId },
      geometry: {
        type: 'MultiLineString',
        coordinates: trackSegments,
      },
    });
  }

  const satEntity =
    liveKinematicsRegistry.entities.get(`sat-${overlay.noradId}`) ??
    Array.from(liveKinematicsRegistry.satellites.values()).find(
      (sat) => sat.noradId === overlay.noradId
    );

  if (satEntity && Number.isFinite(overlay.footprintRadiusKm) && overlay.footprintRadiusKm > 0) {
    const footprint = buildGeodesicCircle(
      satEntity.lat,
      satEntity.lon,
      Math.min(overlay.footprintRadiusKm, 9500),
      96
    );
    if (footprint.closedRing) {
      features.push({
        type: 'Feature',
        properties: { kind: 'footprint-fill', noradId: overlay.noradId },
        geometry: {
          type: 'Polygon',
          coordinates: [footprint.closedRing],
        },
      });
    }
    if (footprint.segments.length > 0) {
      features.push({
        type: 'Feature',
        properties: { kind: 'footprint', noradId: overlay.noradId },
        geometry: {
          type: 'MultiLineString',
          coordinates: footprint.segments,
        },
      });
    }
  }

  return { type: 'FeatureCollection', features };
}

function buildEntitiesAndOperatorsFc(
  layers: Record<SkyEntity['category'], boolean>,
  selectedId: string | null,
  hoveredId: string | null,
  nowMs: number
): {
  entitiesFc: GeoJSON.FeatureCollection;
  operatorsFc: GeoJSON.FeatureCollection;
} {
  const phase = (Math.sin(nowMs * 0.0065) + 1) * 0.5;
  const entityFeatures: GeoJSON.Feature<GeoJSON.Point>[] = [];
  const operatorFeatures: GeoJSON.Feature<GeoJSON.Point>[] = [];

  for (const entity of liveKinematicsRegistry.entities.values()) {
    if (!layers[entity.category]) continue;
    if (!Number.isFinite(entity.lat) || !Number.isFinite(entity.lon)) continue;

    const isSelected = entity.id === selectedId;
    const isHovered = entity.id === hoveredId;
    const isAlert = Boolean(
      entity.emergencyFlag ||
        ((entity.category === 'flight' || entity.category === 'military') &&
          (entity.squawk === '7700' || entity.squawk === '7600' || entity.squawk === '7500')) ||
        (entity.category === 'drone' && (entity.ceilingBreach || entity.tfrBreach))
    );

    const color = resolveEntityColor(entity);
    const headingDeg =
      entity.category === 'balloon'
        ? 0
        : Number.isFinite(entity.headingDeg)
          ? entity.headingDeg
          : 0;

    let iconScale = 0.84;
    if (entity.category === 'flight' && entity.airframeClass === 'heavy') iconScale = 0.94;
    if (entity.category === 'military') iconScale = 0.92;
    if (isSelected || isHovered) iconScale += 0.18;

    entityFeatures.push({
      type: 'Feature',
      properties: {
        id: entity.id,
        category: entity.category,
        callsign: entity.callsign,
        sprite: resolveSpriteForEntity(entity),
        headingDeg,
        color,
        isSelected,
        isHovered,
        isAlert,
        belowHorizon: entity.topocentric.belowHorizon,
        iconScale,
        pulseRadius: isSelected ? 18 + phase * 6 : 15 + phase * 3,
        pulseOpacity: isSelected ? 0.95 - phase * 0.35 : 0.72 - phase * 0.25,
        alertRadius: 17 + phase * 6,
        alertOpacity: 0.85 - phase * 0.45,
      },
      geometry: {
        type: 'Point',
        coordinates: [normalizeLonDeg(entity.lon), entity.lat],
      },
    });

    if (
      entity.category === 'drone' &&
      Number.isFinite(entity.operatorLat) &&
      Number.isFinite(entity.operatorLon)
    ) {
      operatorFeatures.push({
        type: 'Feature',
        properties: {
          droneId: entity.id,
          callsign: entity.callsign,
        },
        geometry: {
          type: 'Point',
          coordinates: [normalizeLonDeg(entity.operatorLon), entity.operatorLat],
        },
      });
    }
  }

  return {
    entitiesFc: { type: 'FeatureCollection', features: entityFeatures },
    operatorsFc: { type: 'FeatureCollection', features: operatorFeatures },
  };
}

function buildTrailsAndVectorsFc(
  layers: Record<SkyEntity['category'], boolean>
): GeoJSON.FeatureCollection {
  const trailFeatures: GeoJSON.Feature[] = [];

  for (const entity of liveKinematicsRegistry.entities.values()) {
    if (!layers[entity.category]) continue;
    if (!Number.isFinite(entity.lat) || !Number.isFinite(entity.lon)) continue;

    const color = resolveEntityColor(entity);

    if (entity.trail.length >= 1) {
      const pts: Array<[number, number]> = entity.trail.map((p) => [p.lon, p.lat]);
      const lastPt = pts[pts.length - 1];
      if (!lastPt || lastPt[0] !== entity.lon || lastPt[1] !== entity.lat) {
        pts.push([entity.lon, entity.lat]);
      }
      const splitTrail = splitAntimeridianLine(pts);
      if (splitTrail.length > 0) {
        trailFeatures.push({
          type: 'Feature',
          properties: { kind: 'trail', color },
          geometry: {
            type: 'MultiLineString',
            coordinates: splitTrail,
          },
        });
      }
    }

    const isAirborne =
      entity.category === 'flight' || entity.category === 'military' ? !entity.onGround : true;
    if (
      isAirborne &&
      Number.isFinite(entity.speedMs) &&
      entity.speedMs > 2 &&
      Number.isFinite(entity.headingDeg)
    ) {
      const distKm = (entity.speedMs * 60) / 1000;
      const dest = greatCircleDestination(entity.lat, entity.lon, entity.headingDeg, distKm);
      const vecSegs = splitAntimeridianLine([
        [entity.lon, entity.lat],
        [dest.lon, dest.lat],
      ]);
      if (vecSegs.length > 0) {
        trailFeatures.push({
          type: 'Feature',
          properties: { kind: 'vector', color },
          geometry: {
            type: 'MultiLineString',
            coordinates: vecSegs,
          },
        });
      }
    }

    if (
      entity.category === 'drone' &&
      Number.isFinite(entity.operatorLat) &&
      Number.isFinite(entity.operatorLon)
    ) {
      const tetherSegs = splitAntimeridianLine([
        [entity.operatorLon, entity.operatorLat],
        [entity.lon, entity.lat],
      ]);
      if (tetherSegs.length > 0) {
        trailFeatures.push({
          type: 'Feature',
          properties: {
            kind: 'tether',
            color: entity.ceilingBreach || entity.tfrBreach ? BREACH_COLOR : '#94A3B8',
          },
          geometry: {
            type: 'MultiLineString',
            coordinates: tetherSegs,
          },
        });
      }
    }
  }

  return { type: 'FeatureCollection', features: trailFeatures };
}

function hasWebGLContext(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (!window.WebGLRenderingContext && !window.WebGL2RenderingContext) return false;
  try {
    const probe = document.createElement('canvas');
    const gl =
      probe.getContext('webgl2') ||
      probe.getContext('webgl') ||
      probe.getContext('experimental-webgl');
    if (!gl) return false;
    if ('getExtension' in gl && typeof gl.getExtension === 'function') {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    return true;
  } catch {
    return false;
  }
}

function registerSourcesAndLayers(map: maplibregl.Map): void {
  const uasfmColorExpr: maplibregl.ExpressionSpecification = [
    'step',
    ['to-number', ['coalesce', ['get', 'CEILING'], ['get', 'ceiling'], 400]],
    '#EF4444',
    1,
    '#F59E0B',
    150,
    '#22D3EE',
    400,
    '#34D399',
  ];

  map.addSource(SOURCE_IDS.uasfm, { type: 'geojson', data: EMPTY_FC });
  map.addSource(SOURCE_IDS.sua, { type: 'geojson', data: EMPTY_FC });
  map.addSource(SOURCE_IDS.scanRing, { type: 'geojson', data: EMPTY_FC });
  map.addSource(SOURCE_IDS.orbitOverlay, { type: 'geojson', data: EMPTY_FC });
  map.addSource(SOURCE_IDS.entityTrails, { type: 'geojson', data: EMPTY_FC });
  map.addSource(SOURCE_IDS.operators, { type: 'geojson', data: EMPTY_FC });
  map.addSource(SOURCE_IDS.observer, { type: 'geojson', data: EMPTY_FC });
  map.addSource(SOURCE_IDS.entities, { type: 'geojson', data: EMPTY_FC });

  // 1. FAA UASFM LAANC grids
  map.addLayer({
    id: LAYER_IDS.uasfmFill,
    type: 'fill',
    source: SOURCE_IDS.uasfm,
    paint: {
      'fill-color': uasfmColorExpr,
      'fill-opacity': 0.12,
    },
  });
  map.addLayer({
    id: LAYER_IDS.uasfmOutline,
    type: 'line',
    source: SOURCE_IDS.uasfm,
    paint: {
      'line-color': uasfmColorExpr,
      'line-width': 1,
      'line-opacity': 0.45,
    },
  });

  // 2. SUA / SFRA / TFR hazard polygons
  map.addLayer({
    id: LAYER_IDS.suaFill,
    type: 'fill',
    source: SOURCE_IDS.sua,
    paint: {
      'fill-color': '#FB7185',
      'fill-opacity': 0.08,
    },
  });
  map.addLayer({
    id: LAYER_IDS.suaOutline,
    type: 'line',
    source: SOURCE_IDS.sua,
    paint: {
      'line-color': '#FB7185',
      'line-width': 1.5,
      'line-opacity': 0.72,
      'line-dasharray': [4, 3],
    },
  });

  // 3. Geodesic scan rings
  map.addLayer({
    id: LAYER_IDS.scanFill,
    type: 'fill',
    source: SOURCE_IDS.scanRing,
    filter: ['==', ['get', 'kind'], 'outer-fill'],
    paint: {
      'fill-color': '#22D3EE',
      'fill-opacity': 0.025,
    },
  });
  map.addLayer({
    id: LAYER_IDS.scanHalf,
    type: 'line',
    source: SOURCE_IDS.scanRing,
    filter: ['==', ['get', 'kind'], 'half'],
    paint: {
      'line-color': '#38BDF8',
      'line-width': 1,
      'line-opacity': 0.36,
      'line-dasharray': [5, 5],
    },
  });
  map.addLayer({
    id: LAYER_IDS.scanOuterGlow,
    type: 'line',
    source: SOURCE_IDS.scanRing,
    filter: ['==', ['get', 'kind'], 'outer'],
    paint: {
      'line-color': '#22D3EE',
      'line-width': 4,
      'line-opacity': 0.14,
    },
  });
  map.addLayer({
    id: LAYER_IDS.scanOuter,
    type: 'line',
    source: SOURCE_IDS.scanRing,
    filter: ['==', ['get', 'kind'], 'outer'],
    paint: {
      'line-color': '#22D3EE',
      'line-width': 1.5,
      'line-opacity': 0.68,
    },
  });

  // 4. Satellite orbital ground track & visibility footprint
  map.addLayer({
    id: LAYER_IDS.orbitFootprintFill,
    type: 'fill',
    source: SOURCE_IDS.orbitOverlay,
    filter: ['==', ['get', 'kind'], 'footprint-fill'],
    paint: {
      'fill-color': '#C084FC',
      'fill-opacity': 0.06,
    },
  });
  map.addLayer({
    id: LAYER_IDS.orbitFootprintLine,
    type: 'line',
    source: SOURCE_IDS.orbitOverlay,
    filter: ['==', ['get', 'kind'], 'footprint'],
    paint: {
      'line-color': '#E879F9',
      'line-width': 1.3,
      'line-opacity': 0.65,
      'line-dasharray': [5, 4],
    },
  });
  map.addLayer({
    id: LAYER_IDS.orbitTrackGlow,
    type: 'line',
    source: SOURCE_IDS.orbitOverlay,
    filter: ['==', ['get', 'kind'], 'groundtrack'],
    paint: {
      'line-color': '#C084FC',
      'line-width': 4.5,
      'line-opacity': 0.2,
    },
  });
  map.addLayer({
    id: LAYER_IDS.orbitTrackLine,
    type: 'line',
    source: SOURCE_IDS.orbitOverlay,
    filter: ['==', ['get', 'kind'], 'groundtrack'],
    paint: {
      'line-color': '#E879F9',
      'line-width': 1.8,
      'line-opacity': 0.9,
    },
  });

  // 5. Trails, predicted velocity vectors, and OpenDroneID tethers
  map.addLayer({
    id: LAYER_IDS.trailsLine,
    type: 'line',
    source: SOURCE_IDS.entityTrails,
    filter: ['==', ['get', 'kind'], 'trail'],
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 1.5,
      'line-opacity': 0.45,
    },
  });
  map.addLayer({
    id: LAYER_IDS.vectorsLine,
    type: 'line',
    source: SOURCE_IDS.entityTrails,
    filter: ['==', ['get', 'kind'], 'vector'],
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 1.25,
      'line-opacity': 0.68,
      'line-dasharray': [2, 2],
    },
  });
  map.addLayer({
    id: LAYER_IDS.tethersLine,
    type: 'line',
    source: SOURCE_IDS.entityTrails,
    filter: ['==', ['get', 'kind'], 'tether'],
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 1.5,
      'line-opacity': 0.85,
      'line-dasharray': [3, 3],
    },
  });

  // 6. UAS ground operators & observer origin
  map.addLayer({
    id: LAYER_IDS.operatorsSymbol,
    type: 'symbol',
    source: SOURCE_IDS.operators,
    layout: {
      'icon-image': 'sprite-operator',
      'icon-size': 0.72,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
  map.addLayer({
    id: LAYER_IDS.observerSymbol,
    type: 'symbol',
    source: SOURCE_IDS.observer,
    layout: {
      'icon-image': 'sprite-observer',
      'icon-size': 0.9,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  // 7. Alert / selection / hover rings & sky entity sprites
  map.addLayer({
    id: LAYER_IDS.entitiesAlertRing,
    type: 'circle',
    source: SOURCE_IDS.entities,
    filter: ['==', ['get', 'isAlert'], true],
    paint: {
      'circle-radius': ['coalesce', ['get', 'alertRadius'], 18],
      'circle-color': 'rgba(239, 68, 68, 0.12)',
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': 1.8,
      'circle-stroke-opacity': ['coalesce', ['get', 'alertOpacity'], 0.8],
    },
  });
  map.addLayer({
    id: LAYER_IDS.entitiesHighlightRing,
    type: 'circle',
    source: SOURCE_IDS.entities,
    filter: ['any', ['==', ['get', 'isSelected'], true], ['==', ['get', 'isHovered'], true]],
    paint: {
      'circle-radius': ['coalesce', ['get', 'pulseRadius'], 19],
      'circle-color': 'rgba(34, 211, 238, 0.08)',
      'circle-stroke-color': ['case', ['==', ['get', 'isSelected'], true], '#F8FAFC', ['get', 'color']],
      'circle-stroke-width': ['case', ['==', ['get', 'isSelected'], true], 2.2, 1.5],
      'circle-stroke-opacity': ['coalesce', ['get', 'pulseOpacity'], 0.9],
    },
  });
  map.addLayer({
    id: LAYER_IDS.entitiesSymbol,
    type: 'symbol',
    source: SOURCE_IDS.entities,
    layout: {
      'icon-image': ['get', 'sprite'],
      'icon-size': ['coalesce', ['get', 'iconScale'], 0.85],
      'icon-rotate': ['get', 'headingDeg'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: {
      'icon-opacity': ['case', ['==', ['get', 'belowHorizon'], true], 0.72, 1.0],
    },
  });
}

export function TacticalMap({ className }: TacticalMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const scaleControlRef = useRef<maplibregl.ScaleControl | null>(null);
  const mapLoadedRef = useRef(false);
  const isPointerDownRef = useRef(false);
  const lastEaseMsRef = useRef(0);

  const observer = useSkyStore((s) => s.observer);
  const radiusKm = useSkyStore((s) => s.radiusKm);
  const layers = useSkyStore((s) => s.layers);
  const airspace = useSkyStore((s) => s.airspace);
  const selectedId = useSkyStore((s) => s.selectedId);
  const hoveredId = useSkyStore((s) => s.hoveredId);
  const followSelected = useSkyStore((s) => s.followSelected);
  const units = useSkyStore((s) => s.units);
  const layout = useSkyStore((s) => s.layout);
  const counts = useSkyStore((s) => s.counts);

  const [webglError, setWebglError] = useState<string | null>(null);
  const [hoverTip, setHoverTip] = useState<HoverTooltipState | null>(null);
  const hoverCoordsRef = useRef<{ id: string; x: number; y: number } | null>(null);

  const prevObserverRef = useRef<{ lat: number; lon: number }>({
    lat: observer.lat,
    lon: observer.lon,
  });

  // Initialize MapLibre once
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (!hasWebGLContext()) {
      setWebglError('WebGL hardware or software context is unavailable in this browser environment.');
      return;
    }

    let cancelled = false;
    let map: maplibregl.Map;
    const initialState = useSkyStore.getState();
    const mountObserver = { lat: initialState.observer.lat, lon: initialState.observer.lon };

    try {
      map = new maplibregl.Map({
        container,
        style: TACTICAL_STYLE,
        center: [normalizeLonDeg(initialState.observer.lon), initialState.observer.lat],
        zoom: zoomForRadiusKm(initialState.radiusKm, initialState.observer.lat),
        minZoom: 1.5,
        maxZoom: 18,
        pitchWithRotate: false,
        dragRotate: true,
        attributionControl: { compact: true },
        failIfMajorPerformanceCaveat: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to initialize WebGL MapLibre surface.';
      setWebglError(msg);
      return;
    }

    mapRef.current = map;
    mapLoadedRef.current = false;

    const scaleControl = new maplibregl.ScaleControl({
      maxWidth: 96,
      unit: initialState.units === 'aviation' ? 'nautical' : 'metric',
    });
    scaleControlRef.current = scaleControl;

    map.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true }), 'bottom-right');
    map.addControl(scaleControl, 'bottom-right');

    const handleCanvasContextLost = (ev: Event) => {
      ev.preventDefault();
    };

    const handleMouseMove = (
      ev: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }
    ) => {
      const feat = ev.features?.[0];
      const id = feat?.properties?.id;
      if (typeof id !== 'string' || !id) return;
      map.getCanvas().style.cursor = 'pointer';
      const store = useSkyStore.getState();
      if (store.hoveredId !== id) {
        store.setHoveredId(id);
      }
      const entity = liveKinematicsRegistry.entities.get(id);
      hoverCoordsRef.current = { id, x: ev.point.x, y: ev.point.y };
      if (entity) {
        setHoverTip(buildHoverTooltip(entity, ev.point.x, ev.point.y, store.units));
      }
    };

    const handleMouseLeave = () => {
      map.getCanvas().style.cursor = '';
      hoverCoordsRef.current = null;
      setHoverTip(null);
      if (useSkyStore.getState().hoveredId !== null) {
        useSkyStore.getState().setHoveredId(null);
      }
    };

    const handleClick = (
      ev: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }
    ) => {
      const feat = ev.features?.[0];
      const id = feat?.properties?.id;
      if (typeof id === 'string' && id) {
        useSkyStore.getState().selectEntity(id, true);
      }
    };

    const handleDragStart = () => {
      isPointerDownRef.current = true;
    };
    const handleDragEnd = () => {
      isPointerDownRef.current = false;
    };

    map.on('error', (ev) => {
      // Swallow tile/network errors quietly without throwing uncaught exceptions.
      const msg = ev?.error?.message ?? '';
      if (!mapLoadedRef.current && /webgl/i.test(msg)) {
        setWebglError(msg || 'WebGL context initialization failed.');
      }
    });
    map.on('dragstart', handleDragStart);
    map.on('dragend', handleDragEnd);
    map.on('touchstart', handleDragStart);
    map.on('touchend', handleDragEnd);

    map.on('load', () => {
      if (cancelled) return;
      mapLoadedRef.current = true;
      registerTacticalSprites(map);
      registerSourcesAndLayers(map);

      const canvas = map.getCanvas();
      canvas.addEventListener('webglcontextlost', handleCanvasContextLost);

      const st = useSkyStore.getState();
      if (
        haversineDistanceKm(mountObserver.lat, mountObserver.lon, st.observer.lat, st.observer.lon) > 1
      ) {
        map.jumpTo({
          center: [normalizeLonDeg(st.observer.lon), st.observer.lat],
          zoom: zoomForRadiusKm(st.radiusKm, st.observer.lat),
        });
      }
      prevObserverRef.current = { lat: st.observer.lat, lon: st.observer.lon };
      (map.getSource(SOURCE_IDS.uasfm) as maplibregl.GeoJSONSource | undefined)?.setData(
        st.airspace.uasfm ?? EMPTY_FC
      );
      (map.getSource(SOURCE_IDS.sua) as maplibregl.GeoJSONSource | undefined)?.setData(
        st.airspace.sua ?? EMPTY_FC
      );
      (map.getSource(SOURCE_IDS.scanRing) as maplibregl.GeoJSONSource | undefined)?.setData(
        buildScanRingFc(st.observer.lat, st.observer.lon, st.radiusKm)
      );
      (map.getSource(SOURCE_IDS.observer) as maplibregl.GeoJSONSource | undefined)?.setData(
        buildObserverFc(st.observer.lat, st.observer.lon, st.observer.label)
      );

      const droneVis = st.layers.drone ? 'visible' : 'none';
      map.setLayoutProperty(LAYER_IDS.uasfmFill, 'visibility', droneVis);
      map.setLayoutProperty(LAYER_IDS.uasfmOutline, 'visibility', droneVis);
      map.setLayoutProperty(LAYER_IDS.operatorsSymbol, 'visibility', droneVis);

      map.on('mousemove', LAYER_IDS.entitiesSymbol, handleMouseMove);
      map.on('mouseleave', LAYER_IDS.entitiesSymbol, handleMouseLeave);
      map.on('click', LAYER_IDS.entitiesSymbol, handleClick);
    });

    const resizeObserver = new ResizeObserver(() => {
      if (mapRef.current) {
        try {
          mapRef.current.resize();
        } catch {
          // Ignore transient resize errors during teardown
        }
      }
    });
    resizeObserver.observe(container);

    // 60fps GeoJSON update loop reading directly from liveKinematicsRegistry
    let rafId = 0;
    let lastEntityVersion = -1;
    let lastLayersKey = '';
    let lastSelectedId: string | null = null;
    let lastHoveredId: string | null = null;
    let lastOrbitOverlayRef: typeof liveKinematicsRegistry.orbitOverlay | undefined = undefined;
    let lastTrailSyncMs = 0;
    let lastPulseSyncMs = 0;
    let lastTipSyncMs = 0;

    const frameLoop = (nowMs: number) => {
      if (cancelled) return;
      rafId = window.requestAnimationFrame(frameLoop);

      const activeMap = mapRef.current;
      if (!activeMap || !mapLoadedRef.current) return;

      const state = useSkyStore.getState();
      const layersKey = `${state.layers.flight}-${state.layers.military}-${state.layers.satellite}-${state.layers.balloon}-${state.layers.drone}`;
      const versionChanged = liveKinematicsRegistry.version !== lastEntityVersion;
      const stateChanged =
        layersKey !== lastLayersKey ||
        state.selectedId !== lastSelectedId ||
        state.hoveredId !== lastHoveredId;

      const hasHighlight = state.selectedId !== null || state.hoveredId !== null;
      const pulseTickDue = nowMs - lastPulseSyncMs >= 45;
      const minTrailInterval = liveKinematicsRegistry.entities.size > 250 ? 45 : 0;
      const trailUpdateDue =
        stateChanged || (versionChanged && nowMs - lastTrailSyncMs >= minTrailInterval);

      if (versionChanged || stateChanged || (hasHighlight && pulseTickDue)) {
        lastEntityVersion = liveKinematicsRegistry.version;
        lastLayersKey = layersKey;
        lastSelectedId = state.selectedId;
        lastHoveredId = state.hoveredId;
        lastPulseSyncMs = nowMs;

        const { entitiesFc, operatorsFc } = buildEntitiesAndOperatorsFc(
          state.layers,
          state.selectedId,
          state.hoveredId,
          nowMs
        );
        (activeMap.getSource(SOURCE_IDS.entities) as maplibregl.GeoJSONSource | undefined)?.setData(
          entitiesFc
        );
        (activeMap.getSource(SOURCE_IDS.operators) as maplibregl.GeoJSONSource | undefined)?.setData(
          operatorsFc
        );
      }

      if (trailUpdateDue) {
        lastTrailSyncMs = nowMs;
        (
          activeMap.getSource(SOURCE_IDS.entityTrails) as maplibregl.GeoJSONSource | undefined
        )?.setData(buildTrailsAndVectorsFc(state.layers));
      }

      // Orbit overlay update (on overlay change or every ~120ms for moving footprint)
      const overlayChanged = liveKinematicsRegistry.orbitOverlay !== lastOrbitOverlayRef;
      if (overlayChanged || (liveKinematicsRegistry.orbitOverlay && versionChanged)) {
        lastOrbitOverlayRef = liveKinematicsRegistry.orbitOverlay;
        const orbitSrc = activeMap.getSource(SOURCE_IDS.orbitOverlay) as
          | maplibregl.GeoJSONSource
          | undefined;
        orbitSrc?.setData(buildOrbitOverlayFc());
      }

      // Smooth camera follow when followSelected is enabled
      if (
        state.followSelected &&
        state.selectedId &&
        !isPointerDownRef.current &&
        nowMs - lastEaseMsRef.current >= 220
      ) {
        const target = liveKinematicsRegistry.entities.get(state.selectedId);
        if (target && Number.isFinite(target.lat) && Number.isFinite(target.lon)) {
          const center = activeMap.getCenter();
          const dLat = Math.abs(center.lat - target.lat);
          const dLon = Math.abs(normalizeLonDeg(center.lng - target.lon));
          if (dLat > 0.0001 || dLon > 0.0001) {
            lastEaseMsRef.current = nowMs;
            activeMap.easeTo({
              center: [normalizeLonDeg(target.lon), target.lat],
              duration: 240,
              easing: (t) => t,
              essential: true,
            });
          }
        }
      }

      // Refresh active hover tooltip numbers smoothly at ~5Hz while hovered
      const hc = hoverCoordsRef.current;
      if (hc && nowMs - lastTipSyncMs >= 200) {
        lastTipSyncMs = nowMs;
        const hoveredEntity = liveKinematicsRegistry.entities.get(hc.id);
        if (hoveredEntity) {
          setHoverTip(buildHoverTooltip(hoveredEntity, hc.x, hc.y, state.units));
        } else {
          hoverCoordsRef.current = null;
          setHoverTip(null);
        }
      }
    };

    rafId = window.requestAnimationFrame(frameLoop);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      mapLoadedRef.current = false;
      scaleControlRef.current = null;
      try {
        map.getCanvas().removeEventListener('webglcontextlost', handleCanvasContextLost);
        map.remove();
      } catch {
        // Ignore teardown issues
      }
      mapRef.current = null;
    };
  }, []);

  // Sync observer, scan ring, and flyTo on observer shifts > 1km
  useEffect(() => {
    const map = mapRef.current;
    if (map && mapLoadedRef.current) {
      (map.getSource(SOURCE_IDS.scanRing) as maplibregl.GeoJSONSource | undefined)?.setData(
        buildScanRingFc(observer.lat, observer.lon, radiusKm)
      );
      (map.getSource(SOURCE_IDS.observer) as maplibregl.GeoJSONSource | undefined)?.setData(
        buildObserverFc(observer.lat, observer.lon, observer.label)
      );

      const shiftKm = haversineDistanceKm(
        prevObserverRef.current.lat,
        prevObserverRef.current.lon,
        observer.lat,
        observer.lon
      );
      if (shiftKm > 1) {
        map.flyTo({
          center: [normalizeLonDeg(observer.lon), observer.lat],
          zoom: zoomForRadiusKm(radiusKm, observer.lat),
          duration: 1100,
          essential: true,
        });
      }
    }
    prevObserverRef.current = { lat: observer.lat, lon: observer.lon };
  }, [observer.lat, observer.lon, observer.label, radiusKm]);

  // Sync FAA UASFM & SUA airspace collections
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) return;
    (map.getSource(SOURCE_IDS.uasfm) as maplibregl.GeoJSONSource | undefined)?.setData(
      airspace.uasfm ?? EMPTY_FC
    );
    (map.getSource(SOURCE_IDS.sua) as maplibregl.GeoJSONSource | undefined)?.setData(
      airspace.sua ?? EMPTY_FC
    );
  }, [airspace]);

  // Sync UASFM & operator visibility when drone layer toggles
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) return;
    const vis = layers.drone ? 'visible' : 'none';
    if (map.getLayer(LAYER_IDS.uasfmFill)) {
      map.setLayoutProperty(LAYER_IDS.uasfmFill, 'visibility', vis);
    }
    if (map.getLayer(LAYER_IDS.uasfmOutline)) {
      map.setLayoutProperty(LAYER_IDS.uasfmOutline, 'visibility', vis);
    }
    if (map.getLayer(LAYER_IDS.operatorsSymbol)) {
      map.setLayoutProperty(LAYER_IDS.operatorsSymbol, 'visibility', vis);
    }
  }, [layers.drone]);

  // Trigger immediate easeTo when followSelected is toggled on
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current || !followSelected || !selectedId) return;
    const target = liveKinematicsRegistry.entities.get(selectedId);
    if (target && Number.isFinite(target.lat) && Number.isFinite(target.lon)) {
      lastEaseMsRef.current = performance.now();
      map.easeTo({
        center: [normalizeLonDeg(target.lon), target.lat],
        duration: 450,
        essential: true,
      });
    }
  }, [followSelected, selectedId]);

  // Resize MapLibre canvas when layout mode switches (e.g. dome -> split/map)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const timer = window.setTimeout(() => {
      try {
        map.resize();
      } catch {
        // Ignore if unmounted
      }
    }, 60);
    return () => window.clearTimeout(timer);
  }, [layout]);

  // Keep hover tooltip units and ScaleControl synced when user switches AVIATION <-> METRIC
  useEffect(() => {
    scaleControlRef.current?.setUnit(units === 'aviation' ? 'nautical' : 'metric');
    const hc = hoverCoordsRef.current;
    if (!hc) return;
    const entity = liveKinematicsRegistry.entities.get(hc.id);
    if (entity) {
      setHoverTip(buildHoverTooltip(entity, hc.x, hc.y, units));
    }
  }, [units, hoveredId]);

  const containerWidth = containerRef.current?.clientWidth ?? 800;
  const containerHeight = containerRef.current?.clientHeight ?? 600;

  return (
    <div
      className={className}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        backgroundColor: '#06090F',
        overflow: 'hidden',
      }}
    >
      <div
        ref={containerRef}
        aria-label="Tactical Airspace Map"
        style={{
          width: '100%',
          height: '100%',
        }}
      />

      {webglError && (
        <div
          role="status"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            background:
              'radial-gradient(circle at 50% 45%, rgba(34, 211, 238, 0.08), rgba(6, 9, 15, 0.96) 70%)',
            color: '#E2E8F0',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            textAlign: 'center',
            gap: 10,
          }}
        >
          <div
            style={{
              padding: '4px 10px',
              borderRadius: 999,
              border: '1px solid rgba(245, 158, 11, 0.45)',
              backgroundColor: 'rgba(245, 158, 11, 0.12)',
              color: '#FBBF24',
              fontSize: 11,
              letterSpacing: '0.1em',
            }}
          >
            WEBGL MAP FALLBACK MODE
          </div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Tactical WebGL Canvas Unavailable</div>
          <div style={{ fontSize: 12, color: '#94A3B8', maxWidth: 420, lineHeight: 1.5 }}>
            {webglError} Polar Sky-Dome radar and live telemetry feeds remain active.
          </div>
          <div
            style={{
              marginTop: 6,
              padding: '8px 14px',
              borderRadius: 8,
              backgroundColor: 'rgba(11, 17, 30, 0.85)',
              border: '1px solid rgba(120, 190, 255, 0.18)',
              fontSize: 12,
              fontVariantNumeric: 'tabular-nums',
              color: '#CBD5E1',
            }}
          >
            OBS: {observer.label} ({observer.lat.toFixed(3)}°, {observer.lon.toFixed(3)}°) · R=
            {radiusKm} km · TARGETS={counts.total}
          </div>
        </div>
      )}

      {!webglError && hoverTip && (
        <div
          style={{
            position: 'absolute',
            left: Math.max(8, Math.min(hoverTip.x + 14, containerWidth - 232)),
            top: Math.max(8, Math.min(hoverTip.y + 14, containerHeight - 96)),
            width: 220,
            maxWidth: 'calc(100% - 16px)',
            pointerEvents: 'none',
            zIndex: 20,
            padding: '8px 10px',
            borderRadius: 8,
            backgroundColor: 'rgba(11, 17, 30, 0.92)',
            backdropFilter: 'blur(10px)',
            border: `1px solid ${hoverTip.color}55`,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.55)',
            color: '#E2E8F0',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 6,
              marginBottom: 3,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  backgroundColor: hoverTip.color,
                  boxShadow: `0 0 6px ${hoverTip.color}`,
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {hoverTip.callsign}
              </span>
            </div>
            <span
              style={{
                fontSize: 10,
                padding: '1px 5px',
                borderRadius: 4,
                backgroundColor: hoverTip.alertTag
                  ? 'rgba(239, 68, 68, 0.22)'
                  : 'rgba(148, 163, 184, 0.14)',
                color: hoverTip.alertTag ? '#FCA5A5' : hoverTip.color,
                border: `1px solid ${hoverTip.alertTag ? 'rgba(239, 68, 68, 0.45)' : 'rgba(148, 163, 184, 0.2)'}`,
                flexShrink: 0,
              }}
            >
              {hoverTip.alertTag ?? hoverTip.categoryLabel}
            </span>
          </div>

          {hoverTip.subtitle && (
            <div
              style={{
                fontSize: 10,
                color: '#94A3B8',
                marginBottom: 5,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {hoverTip.subtitle}
            </div>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '2px 8px',
              fontSize: 11,
              color: '#CBD5E1',
            }}
          >
            <div>
              <span style={{ color: '#64748B' }}>ALT </span>
              <span>{hoverTip.altText}</span>
            </div>
            <div>
              <span style={{ color: '#64748B' }}>SPD </span>
              <span>{hoverTip.speedText}</span>
            </div>
            <div style={{ gridColumn: '1 / span 2', marginTop: 1 }}>
              <span style={{ color: '#64748B' }}>AZ/EL </span>
              <span style={{ color: hoverTip.belowHorizon ? '#94A3B8' : '#E2E8F0' }}>
                {hoverTip.azElText}
                {hoverTip.belowHorizon ? ' (OTH)' : ''}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default TacticalMap;
