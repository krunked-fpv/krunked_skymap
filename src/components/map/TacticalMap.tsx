import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  BREACH_COLOR,
  CATEGORY_COLORS,
  EMERGENCY_COLOR,
  SATELLITE_ECLIPSED_COLOR,
  SATELLITE_SUNLIT_COLOR,
  type LayoutMode,
  type SkyEntity,
  type UnitSystem,
} from '../../types/sky-contracts';
import { liveKinematicsRegistry, useSkyStore } from '../../store/useSkyStore';
import {
  registerTacticalSprites,
  resolveSpriteForEntity,
  type TacticalSpriteId,
} from '../../assets/sprites/tacticalSprites';
import {
  clampLatDeg,
  geodesicCirclePolygon,
  greatCircleDestination,
  haversineDistanceKm,
  normalizeLonDeg,
  splitAntimeridianLine,
} from '../../math/geodesy';

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

const DEG_TO_RAD = Math.PI / 180;
const MONO_FONT =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace";

interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxesOverlap(a: LabelBox, b: LabelBox, padding = 0): boolean {
  return (
    a.x - padding < b.x + b.w &&
    a.x + a.w + padding > b.x &&
    a.y - padding < b.y + b.h &&
    a.y + a.h + padding > b.y
  );
}

function overlapsAny(box: LabelBox, existing: LabelBox[], padding = 0): boolean {
  for (let i = 0; i < existing.length; i += 1) {
    if (boxesOverlap(box, existing[i], padding)) return true;
  }
  return false;
}

function findAvailableLabelSlot(
  slotCandidates: readonly [LabelBox, LabelBox, LabelBox, LabelBox],
  width: number,
  height: number,
  spriteBoxes: LabelBox[],
  placedLabelBoxes: LabelBox[],
  checkSprites: boolean
): LabelBox | null {
  for (let s = 0; s < 4; s += 1) {
    const candidateBox = slotCandidates[s];
    if (
      candidateBox.x < 6 ||
      candidateBox.x + candidateBox.w > width - 6 ||
      candidateBox.y < 6 ||
      candidateBox.y + candidateBox.h > height - 6
    ) {
      continue;
    }
    if (checkSprites && overlapsAny(candidateBox, spriteBoxes)) {
      continue;
    }
    if (!overlapsAny(candidateBox, placedLabelBoxes, 4)) {
      return candidateBox;
    }
  }
  return null;
}

function traceRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  const radius = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function isAlertEntity(entity: SkyEntity): boolean {
  return Boolean(
    entity.emergencyFlag ||
      ((entity.category === 'flight' || entity.category === 'military') &&
        (entity.squawk === '7700' || entity.squawk === '7600' || entity.squawk === '7500')) ||
      (entity.category === 'drone' && (entity.ceilingBreach || entity.tfrBreach))
  );
}

function getEntitySortKey(
  entity: SkyEntity,
  isSelected: boolean,
  isHovered: boolean,
  isAlert: boolean
): number {
  if (isSelected) return 1000;
  if (isHovered) return 900;
  if (isAlert) return 800;
  switch (entity.category) {
    case 'military':
      return 500;
    case 'flight':
      return entity.isMilitary ? 500 : 400;
    case 'balloon':
      return 350;
    case 'drone':
      return 300;
    case 'satellite':
      return entity.group === 'starlink' ? 100 : 250;
  }
}

function getLabelPriority(
  entity: SkyEntity,
  isSelected: boolean,
  isHovered: boolean,
  isAlert: boolean
): number {
  if (isSelected) return 1000;
  if (isHovered) return 900;
  if (isAlert) return 800;
  switch (entity.category) {
    case 'military':
      return 500;
    case 'flight':
      return entity.isMilitary ? 500 : 400;
    case 'balloon':
      return 460;
    case 'drone':
      return 430;
    case 'satellite':
      return entity.group === 'starlink' ? 100 : 250;
  }
}

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
    'esri-dark-base': {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      maxzoom: 16,
      attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
    },
    'esri-dark-ref': {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      maxzoom: 16,
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
      id: 'esri-dark-base-tiles',
      type: 'raster',
      source: 'esri-dark-base',
      paint: {
        'raster-opacity': 0.94,
        'raster-brightness-max': 0.78,
        'raster-contrast': 0.24,
        'raster-saturation': -0.25,
      },
    },
    {
      id: 'esri-dark-ref-tiles',
      type: 'raster',
      source: 'esri-dark-ref',
      paint: {
        'raster-opacity': 0.65,
        'raster-brightness-max': 0.85,
      },
    },
  ],
};

function buildGeodesicCircle(
  latDeg: number,
  lonDeg: number,
  radiusKm: number,
  steps = 96
): {
  polygons: Array<Array<[number, number]>>;
  segments: Array<Array<[number, number]>>;
} {
  const polygons = geodesicCirclePolygon(latDeg, lonDeg, radiusKm, steps);
  const segments: Array<Array<[number, number]>> = [];
  for (const ring of polygons) {
    for (const seg of splitAntimeridianLine(ring)) {
      segments.push(seg);
    }
  }
  return { polygons, segments };
}

function zoomForRadiusKm(radiusKm: number, latDeg = 38): number {
  const clampedRadius = Math.max(10, Math.min(250, radiusKm));
  const cosLat = Math.max(0.25, Math.cos(Math.min(80, Math.abs(latDeg)) * DEG_TO_RAD));
  const rawZoom = Math.log2((19568 * cosLat) / clampedRadius);
  return Math.max(4.5, Math.min(12.5, rawZoom));
}

const ZERO_CAMERA_PADDING: maplibregl.PaddingOptions = {
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
};

export function computeLayoutCameraPadding(
  layout: LayoutMode,
  containerWidth: number,
  containerHeight: number
): maplibregl.PaddingOptions {
  if (layout !== 'split') {
    return ZERO_CAMERA_PADDING;
  }

  const width =
    Number.isFinite(containerWidth) && containerWidth > 0
      ? containerWidth
      : typeof window !== 'undefined' && Number.isFinite(window.innerWidth) && window.innerWidth > 0
        ? window.innerWidth
        : 1280;
  const height =
    Number.isFinite(containerHeight) && containerHeight > 0
      ? containerHeight
      : typeof window !== 'undefined' && Number.isFinite(window.innerHeight) && window.innerHeight > 0
        ? window.innerHeight
        : 720;

  const isMobile = width <= 767;
  const domeRect =
    typeof document !== 'undefined'
      ? document.querySelector('[data-pane="dome"]')?.getBoundingClientRect()
      : undefined;

  if (isMobile) {
    const fallbackH = Math.round(height * 0.48);
    const measuredH =
      domeRect &&
      Number.isFinite(domeRect.height) &&
      domeRect.height > 0 &&
      domeRect.height < height * 0.85
        ? Math.round(domeRect.height)
        : fallbackH;
    const domeH = Math.max(0, Math.min(Math.round(height * 0.85), measuredH));
    return { top: 0, bottom: domeH, left: 0, right: 0 };
  }

  const fallbackW = Math.round(Math.min(680, Math.max(340, width * 0.42)));
  const measuredW =
    domeRect &&
    Number.isFinite(domeRect.width) &&
    domeRect.width > 0 &&
    domeRect.width < width * 0.85
      ? Math.round(domeRect.width)
      : fallbackW;
  const domeW = Math.max(0, Math.min(Math.round(width * 0.85), measuredW));
  return { top: 0, bottom: 0, left: 0, right: domeW };
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

function resolveTooltipCategoryLabel(entity: SkyEntity): string {
  switch (entity.category) {
    case 'flight':
      return entity.isMilitary ? 'MIL' : 'CIVIL';
    case 'military':
      return 'MIL';
    case 'satellite':
      return 'SAT';
    case 'balloon':
      if (entity.subSource === 'windborne') return 'WINDBORNE';
      if (entity.subSource === 'adsb-lta') return 'ADS-B LTA';
      return 'SONDEHUB';
    case 'drone':
      return entity.subSource === 'adsb-uas' ? 'ATC UAS' : 'UAS';
  }
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
    categoryLabel: resolveTooltipCategoryLabel(entity),
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

  if (outer.polygons.length > 0) {
    features.push({
      type: 'Feature',
      properties: { kind: 'outer-fill' },
      geometry: {
        type: 'MultiPolygon',
        coordinates: outer.polygons.map((r) => [r]),
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

function buildOrbitOverlayFc(satelliteLayerVisible: boolean): GeoJSON.FeatureCollection {
  const overlay = liveKinematicsRegistry.orbitOverlay;
  if (!satelliteLayerVisible || !overlay) return EMPTY_FC;

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
    if (footprint.polygons.length > 0) {
      features.push({
        type: 'Feature',
        properties: { kind: 'footprint-fill', noradId: overlay.noradId },
        geometry: {
          type: 'MultiPolygon',
          coordinates: footprint.polygons.map((r) => [r]),
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

const MAX_TRAIL_POINTS = 40;

type EntityFeatureProperties = {
  id: string;
  category: SkyEntity['category'];
  callsign: string;
  sprite: TacticalSpriteId;
  headingDeg: number;
  color: string;
  isSelected: boolean;
  isHovered: boolean;
  isAlert: boolean;
  belowHorizon: boolean;
  iconScale: number;
  sortKey: number;
  pulseRadius: number;
  pulseOpacity: number;
  alertRadius: number;
  alertOpacity: number;
};

type OperatorFeatureProperties = {
  droneId: string;
  callsign: string;
};

type TrailFeatureProperties = {
  kind: 'trail' | 'vector' | 'tether';
  color: string;
};

type PooledEntityFeature = GeoJSON.Feature<GeoJSON.Point, EntityFeatureProperties>;
type PooledOperatorFeature = GeoJSON.Feature<GeoJSON.Point, OperatorFeatureProperties>;
type PooledTrailFeature = GeoJSON.Feature<GeoJSON.MultiLineString, TrailFeatureProperties>;

interface PooledTrailSlot {
  feature: PooledTrailFeature;
  fastCoords: [Array<[number, number]>];
  fastLine: Array<[number, number]>;
  coordPool: Array<[number, number]>;
}

const entityFeaturePool: PooledEntityFeature[] = [];
const operatorFeaturePool: PooledOperatorFeature[] = [];
const trailSlotPool: PooledTrailSlot[] = [];

const entitiesFc: GeoJSON.FeatureCollection<GeoJSON.Point, EntityFeatureProperties> = {
  type: 'FeatureCollection',
  features: [],
};
const operatorsFc: GeoJSON.FeatureCollection<GeoJSON.Point, OperatorFeatureProperties> = {
  type: 'FeatureCollection',
  features: [],
};
const trailsFc: GeoJSON.FeatureCollection<GeoJSON.MultiLineString, TrailFeatureProperties> = {
  type: 'FeatureCollection',
  features: [],
};

const entitiesAndOperatorsResult = { entitiesFc, operatorsFc };
const seenIds = new Set<string>();
const antimeridianPairScratch: [[number, number], [number, number]] = [
  [0, 0],
  [0, 0],
];

function acquireEntityFeature(idx: number): PooledEntityFeature {
  let feat = entityFeaturePool[idx];
  if (!feat) {
    feat = {
      type: 'Feature',
      properties: {
        id: '',
        category: 'flight',
        callsign: '',
        sprite: 'sprite-jet-civil',
        headingDeg: 0,
        color: '#22D3EE',
        isSelected: false,
        isHovered: false,
        isAlert: false,
        belowHorizon: false,
        iconScale: 0.84,
        sortKey: 0,
        pulseRadius: 15,
        pulseOpacity: 0.72,
        alertRadius: 17,
        alertOpacity: 0.85,
      },
      geometry: {
        type: 'Point',
        coordinates: [0, 0],
      },
    };
    entityFeaturePool[idx] = feat;
  }
  return feat;
}

function acquireOperatorFeature(idx: number): PooledOperatorFeature {
  let feat = operatorFeaturePool[idx];
  if (!feat) {
    feat = {
      type: 'Feature',
      properties: {
        droneId: '',
        callsign: '',
      },
      geometry: {
        type: 'Point',
        coordinates: [0, 0],
      },
    };
    operatorFeaturePool[idx] = feat;
  }
  return feat;
}

function acquireTrailSlot(idx: number): PooledTrailSlot {
  let slot = trailSlotPool[idx];
  if (!slot) {
    const fastLine: Array<[number, number]> = [];
    const fastCoords: [Array<[number, number]>] = [fastLine];
    slot = {
      feature: {
        type: 'Feature',
        properties: { kind: 'trail', color: '#22D3EE' },
        geometry: {
          type: 'MultiLineString',
          coordinates: fastCoords,
        },
      },
      fastCoords,
      fastLine,
      coordPool: [],
    };
    trailSlotPool[idx] = slot;
  }
  return slot;
}

function acquireSlotCoord(slot: PooledTrailSlot, idx: number): [number, number] {
  let pt = slot.coordPool[idx];
  if (!pt) {
    pt = [0, 0];
    slot.coordPool[idx] = pt;
  }
  return pt;
}

function populatePairTrailSlot(
  slot: PooledTrailSlot,
  kind: TrailFeatureProperties['kind'],
  color: string,
  lonA: number,
  latA: number,
  lonB: number,
  latB: number
): boolean {
  if (
    !Number.isFinite(lonA) ||
    !Number.isFinite(latA) ||
    !Number.isFinite(lonB) ||
    !Number.isFinite(latB)
  ) {
    return false;
  }

  const nLonA = normalizeLonDeg(lonA);
  const cLatA = clampLatDeg(latA);
  const nLonB = normalizeLonDeg(lonB);
  const cLatB = clampLatDeg(latB);

  slot.feature.properties.kind = kind;
  slot.feature.properties.color = color;

  if (Math.abs(nLonB - nLonA) > 180) {
    antimeridianPairScratch[0][0] = nLonA;
    antimeridianPairScratch[0][1] = cLatA;
    antimeridianPairScratch[1][0] = nLonB;
    antimeridianPairScratch[1][1] = cLatB;
    const segs = splitAntimeridianLine(antimeridianPairScratch);
    if (segs.length === 0) return false;
    slot.feature.geometry.coordinates = segs;
    return true;
  }

  const p0 = acquireSlotCoord(slot, 0);
  p0[0] = nLonA;
  p0[1] = cLatA;
  const p1 = acquireSlotCoord(slot, 1);
  p1[0] = nLonB;
  p1[1] = cLatB;
  slot.fastLine[0] = p0;
  slot.fastLine[1] = p1;
  slot.fastLine.length = 2;
  slot.fastCoords[0] = slot.fastLine;
  slot.feature.geometry.coordinates = slot.fastCoords;
  return true;
}

function populateEntityTrailSlot(
  slot: PooledTrailSlot,
  entity: SkyEntity,
  color: string
): boolean {
  const trailLen = entity.trail.length;
  if (trailLen < 1) return false;

  const startIdx = Math.max(0, trailLen - MAX_TRAIL_POINTS);
  let validCount = 0;
  let prevLon = 0;
  let crossesAntimeridian = false;

  for (let i = startIdx; i < trailLen; i += 1) {
    const tp = entity.trail[i];
    if (!Number.isFinite(tp.lon) || !Number.isFinite(tp.lat)) continue;
    const lon = normalizeLonDeg(tp.lon);
    const lat = clampLatDeg(tp.lat);
    if (validCount > 0 && Math.abs(lon - prevLon) > 180) {
      crossesAntimeridian = true;
    }
    const coord = acquireSlotCoord(slot, validCount);
    coord[0] = lon;
    coord[1] = lat;
    slot.fastLine[validCount] = coord;
    prevLon = lon;
    validCount += 1;
  }

  const lastTrailPt = entity.trail[trailLen - 1];
  if (!lastTrailPt || lastTrailPt.lon !== entity.lon || lastTrailPt.lat !== entity.lat) {
    const lon = normalizeLonDeg(entity.lon);
    const lat = clampLatDeg(entity.lat);
    if (validCount > 0 && Math.abs(lon - prevLon) > 180) {
      crossesAntimeridian = true;
    }
    const coord = acquireSlotCoord(slot, validCount);
    coord[0] = lon;
    coord[1] = lat;
    slot.fastLine[validCount] = coord;
    validCount += 1;
  }

  if (validCount === 0) return false;
  slot.fastLine.length = validCount;
  slot.feature.properties.kind = 'trail';
  slot.feature.properties.color = color;

  if (crossesAntimeridian) {
    const splitTrail = splitAntimeridianLine(slot.fastLine);
    if (splitTrail.length === 0) return false;
    slot.feature.geometry.coordinates = splitTrail;
  } else {
    slot.fastCoords[0] = slot.fastLine;
    slot.feature.geometry.coordinates = slot.fastCoords;
  }
  return true;
}

function buildEntitiesAndOperatorsFc(
  layers: Record<SkyEntity['category'], boolean>,
  selectedId: string | null,
  hoveredId: string | null,
  nowMs: number
): {
  entitiesFc: GeoJSON.FeatureCollection<GeoJSON.Point, EntityFeatureProperties>;
  operatorsFc: GeoJSON.FeatureCollection<GeoJSON.Point, OperatorFeatureProperties>;
} {
  const phase = (Math.sin(nowMs * 0.0065) + 1) * 0.5;
  let entityIdx = 0;
  let operatorIdx = 0;
  seenIds.clear();

  for (const entity of liveKinematicsRegistry.entities.values()) {
    if (!layers[entity.category]) continue;
    if (seenIds.has(entity.id)) continue;
    if (!Number.isFinite(entity.lat) || !Number.isFinite(entity.lon)) continue;
    seenIds.add(entity.id);

    const isSelected = entity.id === selectedId;
    const isHovered = entity.id === hoveredId;
    const isAlert = isAlertEntity(entity);

    const color = resolveEntityColor(entity);
    const headingDeg =
      entity.category === 'balloon' || entity.headingValid === false
        ? 0
        : Number.isFinite(entity.headingDeg)
          ? entity.headingDeg
          : 0;

    let iconScale = 0.84;
    if (entity.category === 'flight' && entity.airframeClass === 'heavy') iconScale = 0.94;
    if (entity.category === 'military' || (entity.category === 'flight' && entity.isMilitary)) {
      iconScale = entity.airframeClass === 'heavy' ? 0.96 : 0.92;
    }
    if (entity.category === 'drone' && entity.subSource === 'adsb-uas') iconScale = 0.9;
    if (isSelected || isHovered) iconScale += 0.18;

    const sortKey = getEntitySortKey(entity, isSelected, isHovered, isAlert);

    const feat = acquireEntityFeature(entityIdx);
    const props = feat.properties;
    props.id = entity.id;
    props.category = entity.category;
    props.callsign = entity.callsign;
    props.sprite = resolveSpriteForEntity(entity);
    props.headingDeg = headingDeg;
    props.color = color;
    props.isSelected = isSelected;
    props.isHovered = isHovered;
    props.isAlert = isAlert;
    props.belowHorizon = entity.topocentric.belowHorizon;
    props.iconScale = iconScale;
    props.sortKey = sortKey;
    props.pulseRadius = isSelected ? 18 + phase * 6 : 15 + phase * 3;
    props.pulseOpacity = isSelected ? 0.95 - phase * 0.35 : 0.72 - phase * 0.25;
    props.alertRadius = 17 + phase * 6;
    props.alertOpacity = 0.85 - phase * 0.45;
    feat.geometry.coordinates[0] = normalizeLonDeg(entity.lon);
    feat.geometry.coordinates[1] = entity.lat;
    entitiesFc.features[entityIdx] = feat;
    entityIdx += 1;

    if (
      entity.category === 'drone' &&
      entity.hasOperatorLocation !== false &&
      entity.subSource !== 'adsb-uas' &&
      Number.isFinite(entity.operatorLat) &&
      Number.isFinite(entity.operatorLon)
    ) {
      const opFeat = acquireOperatorFeature(operatorIdx);
      opFeat.properties.droneId = entity.id;
      opFeat.properties.callsign = entity.callsign;
      opFeat.geometry.coordinates[0] = normalizeLonDeg(entity.operatorLon);
      opFeat.geometry.coordinates[1] = entity.operatorLat;
      operatorsFc.features[operatorIdx] = opFeat;
      operatorIdx += 1;
    }
  }

  entitiesFc.features.length = entityIdx;
  operatorsFc.features.length = operatorIdx;
  return entitiesAndOperatorsResult;
}

function buildTrailsAndVectorsFc(
  layers: Record<SkyEntity['category'], boolean>
): GeoJSON.FeatureCollection<GeoJSON.MultiLineString, TrailFeatureProperties> {
  let trailIdx = 0;
  seenIds.clear();

  for (const entity of liveKinematicsRegistry.entities.values()) {
    if (!layers[entity.category]) continue;
    if (seenIds.has(entity.id)) continue;
    if (!Number.isFinite(entity.lat) || !Number.isFinite(entity.lon)) continue;
    seenIds.add(entity.id);

    const color = resolveEntityColor(entity);

    if (entity.trail.length >= 1) {
      const slot = acquireTrailSlot(trailIdx);
      if (populateEntityTrailSlot(slot, entity, color)) {
        trailsFc.features[trailIdx] = slot.feature;
        trailIdx += 1;
      }
    }

    const isAirborne =
      entity.category === 'flight' || entity.category === 'military' ? !entity.onGround : true;
    if (
      isAirborne &&
      entity.headingValid !== false &&
      Number.isFinite(entity.speedMs) &&
      entity.speedMs > 2 &&
      Number.isFinite(entity.headingDeg)
    ) {
      const distKm = (entity.speedMs * 60) / 1000;
      const dest = greatCircleDestination(entity.lat, entity.lon, entity.headingDeg, distKm);
      const slot = acquireTrailSlot(trailIdx);
      if (populatePairTrailSlot(slot, 'vector', color, entity.lon, entity.lat, dest.lon, dest.lat)) {
        trailsFc.features[trailIdx] = slot.feature;
        trailIdx += 1;
      }
    }

    if (
      entity.category === 'drone' &&
      entity.hasOperatorLocation !== false &&
      entity.subSource !== 'adsb-uas' &&
      Number.isFinite(entity.operatorLat) &&
      Number.isFinite(entity.operatorLon)
    ) {
      const slot = acquireTrailSlot(trailIdx);
      const tetherColor = entity.ceilingBreach || entity.tfrBreach ? BREACH_COLOR : '#94A3B8';
      if (
        populatePairTrailSlot(
          slot,
          'tether',
          tetherColor,
          entity.operatorLon,
          entity.operatorLat,
          entity.lon,
          entity.lat
        )
      ) {
        trailsFc.features[trailIdx] = slot.feature;
        trailIdx += 1;
      }
    }
  }

  trailsFc.features.length = trailIdx;
  return trailsFc;
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
      'fill-opacity': [
        'interpolate',
        ['linear'],
        ['zoom'],
        6.0,
        0.0,
        7.5,
        0.02,
        9.0,
        0.045,
        10.0,
        0.09,
        12.0,
        0.14,
      ],
    },
  });
  map.addLayer({
    id: LAYER_IDS.uasfmOutline,
    type: 'line',
    source: SOURCE_IDS.uasfm,
    paint: {
      'line-color': uasfmColorExpr,
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        7.5,
        0.4,
        9.5,
        0.65,
        11.0,
        1.0,
        13.0,
        1.3,
      ],
      'line-opacity': [
        'interpolate',
        ['linear'],
        ['zoom'],
        6.5,
        0.0,
        8.0,
        0.06,
        9.5,
        0.16,
        10.5,
        0.36,
        12.5,
        0.52,
      ],
    },
  });

  // 2. SUA / SFRA / TFR hazard polygons
  map.addLayer({
    id: LAYER_IDS.suaFill,
    type: 'fill',
    source: SOURCE_IDS.sua,
    paint: {
      'fill-color': '#FB7185',
      'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5.0, 0.035, 8.5, 0.055, 10.5, 0.08],
    },
  });
  map.addLayer({
    id: LAYER_IDS.suaOutline,
    type: 'line',
    source: SOURCE_IDS.sua,
    paint: {
      'line-color': '#FB7185',
      'line-width': 1.5,
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 5.0, 0.38, 8.5, 0.56, 10.5, 0.72],
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
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 1.5, 0.18, 6, 0.45],
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
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 1.5, 0.14, 5, 0.35, 9, 0.65],
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
      'icon-anchor': 'center',
      'icon-pitch-alignment': 'map',
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
      'icon-anchor': 'center',
      'icon-pitch-alignment': 'map',
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
      'circle-pitch-alignment': 'map',
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
      'circle-pitch-alignment': 'map',
    },
  });
  map.addLayer({
    id: LAYER_IDS.entitiesSymbol,
    type: 'symbol',
    source: SOURCE_IDS.entities,
    layout: {
      'icon-image': ['get', 'sprite'],
      'icon-size': [
        'interpolate',
        ['linear'],
        ['zoom'],
        1.5,
        ['*', ['coalesce', ['get', 'iconScale'], 0.85], 0.34],
        3.5,
        ['*', ['coalesce', ['get', 'iconScale'], 0.85], 0.52],
        6,
        ['*', ['coalesce', ['get', 'iconScale'], 0.85], 0.72],
        9,
        ['*', ['coalesce', ['get', 'iconScale'], 0.85], 0.9],
        12,
        ['*', ['coalesce', ['get', 'iconScale'], 0.85], 1.05],
        14,
        ['*', ['coalesce', ['get', 'iconScale'], 0.85], 1.18],
      ],
      'icon-rotate': ['get', 'headingDeg'],
      'icon-rotation-alignment': 'map',
      'icon-anchor': 'center',
      'icon-pitch-alignment': 'map',
      'symbol-sort-key': ['get', 'sortKey'],
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
  const labelCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const scaleControlRef = useRef<maplibregl.ScaleControl | null>(null);
  const drawMapLabelsRef = useRef<(() => void) | null>(null);
  const syncCameraPaddingRef = useRef<
    ((targetLayout: LayoutMode, animate: boolean, force?: boolean) => void) | null
  >(null);
  const appliedPaddingRef = useRef<maplibregl.PaddingOptions>({
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  });
  const mapLoadedRef = useRef(false);
  const isPointerDownRef = useRef(false);
  const lastEaseMsRef = useRef(0);
  const labelMetricsRef = useRef<{ width: number; height: number; dpr: number }>({
    width: 0,
    height: 0,
    dpr: 1,
  });

  const observer = useSkyStore((s) => s.observer);
  const radiusKm = useSkyStore((s) => s.radiusKm);
  const recenterNonce = useSkyStore((s) => s.recenterNonce);
  const layers = useSkyStore((s) => s.layers);
  const droneSublayers = useSkyStore((s) => s.droneSublayers);
  const atmosphericScope = useSkyStore((s) => s.atmosphericScope);
  const airspace = useSkyStore((s) => s.airspace);
  const selectedId = useSkyStore((s) => s.selectedId);
  const hoveredId = useSkyStore((s) => s.hoveredId);
  const followSelected = useSkyStore((s) => s.followSelected);
  const units = useSkyStore((s) => s.units);
  const layout = useSkyStore((s) => s.layout);
  const counts = useSkyStore((s) => s.counts);
  const mapLabelsEnabled = useSkyStore((s) => s.mapLabelsEnabled);
  const setMapLabelsEnabled = useSkyStore((s) => s.setMapLabelsEnabled);

  const [webglError, setWebglError] = useState<string | null>(null);
  const [hoverTip, setHoverTip] = useState<HoverTooltipState | null>(null);
  const hoverCoordsRef = useRef<{ id: string; x: number; y: number } | null>(null);

  const prevObserverRef = useRef<{ lat: number; lon: number }>({
    lat: observer.lat,
    lon: observer.lon,
  });
  const prevObserverSourceRef = useRef(observer.source);
  const prevRadiusRef = useRef<number>(radiusKm);
  const prevRecenterNonceRef = useRef<number>(recenterNonce);
  const prevScopeRef = useRef(atmosphericScope);
  const prevLayoutEffectRef = useRef<LayoutMode>(layout);

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
    const mountPending = initialState.observer.source === 'pending';
    const mountObserver = { lat: initialState.observer.lat, lon: initialState.observer.lon };
    const mountRadiusKm = initialState.radiusKm;
    const mountRecenterNonce = initialState.recenterNonce;

    prevObserverRef.current = mountObserver;
    prevObserverSourceRef.current = initialState.observer.source;
    prevRadiusRef.current = mountRadiusKm;
    prevRecenterNonceRef.current = mountRecenterNonce;

    try {
      map = new maplibregl.Map({
        container,
        style: TACTICAL_STYLE,
        center: mountPending
          ? [0, 20]
          : [normalizeLonDeg(initialState.observer.lon), initialState.observer.lat],
        zoom: mountPending ? 1.8 : zoomForRadiusKm(initialState.radiusKm, initialState.observer.lat),
        minZoom: 1.5,
        maxZoom: 18,
        pitch: 0,
        maxPitch: 0,
        touchPitch: false,
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

    const applyCameraPadding = (
      targetMap: maplibregl.Map,
      targetLayout: LayoutMode,
      animate: boolean,
      force = false
    ) => {
      const rect = container.getBoundingClientRect();
      const next = computeLayoutCameraPadding(targetLayout, rect.width, rect.height);
      const prev = appliedPaddingRef.current;
      if (
        !force &&
        prev.top === next.top &&
        prev.bottom === next.bottom &&
        prev.left === next.left &&
        prev.right === next.right
      ) {
        return;
      }
      appliedPaddingRef.current = next;
      try {
        if (animate && typeof targetMap.easeTo === 'function') {
          lastEaseMsRef.current = performance.now();
          targetMap.easeTo({
            padding: next,
            duration: 220,
            essential: true,
          });
        } else if (typeof targetMap.setPadding === 'function') {
          targetMap.setPadding(next);
        }
      } catch {
        // Ignore transient padding errors during map initialization or teardown
      }
    };

    syncCameraPaddingRef.current = (
      targetLayout: LayoutMode,
      animate: boolean,
      force = false
    ) => {
      if (mapRef.current) {
        applyCameraPadding(mapRef.current, targetLayout, animate, force);
      }
    };

    applyCameraPadding(map, initialState.layout, false, true);

    const syncLabelCanvasSize = (w: number, h: number) => {
      const labelCanvas = labelCanvasRef.current;
      if (!labelCanvas) return;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const targetW = Math.max(0, Math.round(w * dpr));
      const targetH = Math.max(0, Math.round(h * dpr));
      if (labelCanvas.width !== targetW || labelCanvas.height !== targetH) {
        labelCanvas.width = targetW;
        labelCanvas.height = targetH;
      }
      labelMetricsRef.current = { width: w, height: h, dpr };
    };

    const initialRect = container.getBoundingClientRect();
    syncLabelCanvasSize(initialRect.width, initialRect.height);

    interface LabelCandidate {
      entity: SkyEntity | null;
      px: number;
      py: number;
      priority: number;
      isSelected: boolean;
      isHovered: boolean;
      isAlert: boolean;
      color: string;
    }

    const labelSeenIds = new Set<string>();
    const candidatePool: LabelCandidate[] = [];
    const candidates: LabelCandidate[] = [];
    const spriteBoxPool: LabelBox[] = [];
    const spriteBoxes: LabelBox[] = [];
    const placedBoxPool: LabelBox[] = [];
    const placedLabelBoxes: LabelBox[] = [];
    const labelProjCoord: [number, number] = [0, 0];
    const slotCandidates: readonly [LabelBox, LabelBox, LabelBox, LabelBox] = [
      { x: 0, y: 0, w: 0, h: 0 },
      { x: 0, y: 0, w: 0, h: 0 },
      { x: 0, y: 0, w: 0, h: 0 },
      { x: 0, y: 0, w: 0, h: 0 },
    ];

    const acquireLabelCandidate = (idx: number): LabelCandidate => {
      let cand = candidatePool[idx];
      if (!cand) {
        cand = {
          entity: null,
          px: 0,
          py: 0,
          priority: 0,
          isSelected: false,
          isHovered: false,
          isAlert: false,
          color: '#22D3EE',
        };
        candidatePool[idx] = cand;
      }
      return cand;
    };

    const acquirePooledBox = (pool: LabelBox[], idx: number): LabelBox => {
      let box = pool[idx];
      if (!box) {
        box = { x: 0, y: 0, w: 0, h: 0 };
        pool[idx] = box;
      }
      return box;
    };

    const compareLabelCandidatesDesc = (a: LabelCandidate, b: LabelCandidate): number =>
      b.priority - a.priority;

    const drawMapLabels = () => {
      const labelCanvas = labelCanvasRef.current;
      if (!labelCanvas) return;
      const ctx = labelCanvas.getContext('2d');
      if (!ctx) return;

      const dpr = Math.max(1, window.devicePixelRatio || 1);
      if (
        labelMetricsRef.current.dpr !== dpr &&
        labelMetricsRef.current.width > 0 &&
        labelMetricsRef.current.height > 0
      ) {
        syncLabelCanvasSize(labelMetricsRef.current.width, labelMetricsRef.current.height);
      }

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, labelCanvas.width, labelCanvas.height);
      ctx.restore();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const activeMap = mapRef.current;
      const state = useSkyStore.getState();
      const { width, height } = labelMetricsRef.current;
      if (
        !activeMap ||
        !mapLoadedRef.current ||
        state.layout === 'dome' ||
        (typeof document !== 'undefined' && document.hidden) ||
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0
      ) {
        return;
      }

      const activePad = appliedPaddingRef.current;
      const exposedWidth =
        state.layout === 'split' ? Math.max(0, width - activePad.right) : width;
      const exposedHeight =
        state.layout === 'split' ? Math.max(0, height - activePad.bottom) : height;
      if (exposedWidth <= 0 || exposedHeight <= 0) {
        return;
      }

      const zoom = activeMap.getZoom();
      const maxAutoLabels = zoom < 6.0 ? 0 : zoom < 8.0 ? 8 : zoom < 10.0 ? 18 : 34;

      labelSeenIds.clear();
      candidates.length = 0;
      spriteBoxes.length = 0;
      placedLabelBoxes.length = 0;
      let candIdx = 0;
      let spriteIdx = 0;
      let placedIdx = 0;

      for (const entity of liveKinematicsRegistry.entities.values()) {
        if (!state.layers[entity.category]) continue;
        if (labelSeenIds.has(entity.id)) continue;
        if (!Number.isFinite(entity.lat) || !Number.isFinite(entity.lon)) continue;
        labelSeenIds.add(entity.id);

        labelProjCoord[0] = normalizeLonDeg(entity.lon);
        labelProjCoord[1] = entity.lat;
        const pt = activeMap.project(labelProjCoord);
        if (
          !Number.isFinite(pt.x) ||
          !Number.isFinite(pt.y) ||
          pt.x < 0 ||
          pt.x > exposedWidth ||
          pt.y < 0 ||
          pt.y > exposedHeight
        ) {
          continue;
        }

        // Reserve each sprite's central 26x26 icon exclusion bounding box
        const sBox = acquirePooledBox(spriteBoxPool, spriteIdx);
        sBox.x = pt.x - 13;
        sBox.y = pt.y - 13;
        sBox.w = 26;
        sBox.h = 26;
        spriteBoxes[spriteIdx] = sBox;
        spriteIdx += 1;

        const isSelected = entity.id === state.selectedId;
        const isHovered = entity.id === state.hoveredId;
        const isAlert = isAlertEntity(entity);

        if (!state.mapLabelsEnabled && !isSelected && !isHovered) {
          continue;
        }
        if (state.mapLabelsEnabled && zoom < 6.0 && !isSelected && !isHovered && !isAlert) {
          continue;
        }

        const cand = acquireLabelCandidate(candIdx);
        cand.entity = entity;
        cand.px = pt.x;
        cand.py = pt.y;
        cand.priority = getLabelPriority(entity, isSelected, isHovered, isAlert);
        cand.isSelected = isSelected;
        cand.isHovered = isHovered;
        cand.isAlert = isAlert;
        cand.color = resolveEntityColor(entity);
        candidates[candIdx] = cand;
        candIdx += 1;
      }

      candidates.length = candIdx;
      spriteBoxes.length = spriteIdx;

      if (candIdx === 0) return;

      if (candIdx > 1) {
        candidates.sort(compareLabelCandidatesDesc);
      }

      let autoDrawn = 0;

      ctx.save();
      ctx.font = `600 9.5px ${MONO_FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      for (let i = 0; i < candIdx; i += 1) {
        const item = candidates[i];
        const entity = item.entity;
        item.entity = null;
        if (!entity) continue;

        const mustShow = item.isSelected || item.isHovered;
        const zoomAlertBypass = state.mapLabelsEnabled && zoom < 6.0 && item.isAlert;
        if (!mustShow && !zoomAlertBypass && autoDrawn >= maxAutoLabels) {
          continue;
        }

        const rawCallsign = entity.callsign || entity.id;
        const callsignText =
          rawCallsign.length > 18 ? `${rawCallsign.slice(0, 17)}…` : rawCallsign;
        const altText = formatAltitudeCompact(entity, state.units);
        const vRate = entity.vertRateMs;
        const vRateChevron =
          Number.isFinite(vRate) && Math.abs(vRate) >= 1.5 ? (vRate > 0 ? ' ↑' : ' ↓') : '';

        const metaText = ` · ${altText}`;
        const fullText = `${callsignText}${metaText}${vRateChevron}`;
        const callsignW = ctx.measureText(callsignText).width;
        const metaW = ctx.measureText(metaText).width;
        const fullW = ctx.measureText(fullText).width;
        const boxW = Math.ceil(fullW) + 10;
        const boxH = 15;
        const offset = 14;

        slotCandidates[0].x = item.px + offset;
        slotCandidates[0].y = item.py - boxH / 2;
        slotCandidates[0].w = boxW;
        slotCandidates[0].h = boxH;

        slotCandidates[1].x = item.px - offset - boxW;
        slotCandidates[1].y = item.py - boxH / 2;
        slotCandidates[1].w = boxW;
        slotCandidates[1].h = boxH;

        slotCandidates[2].x = item.px - boxW / 2;
        slotCandidates[2].y = item.py - offset - boxH;
        slotCandidates[2].w = boxW;
        slotCandidates[2].h = boxH;

        slotCandidates[3].x = item.px - boxW / 2;
        slotCandidates[3].y = item.py + offset;
        slotCandidates[3].w = boxW;
        slotCandidates[3].h = boxH;

        let chosenSlot = findAvailableLabelSlot(
          slotCandidates,
          exposedWidth,
          exposedHeight,
          spriteBoxes,
          placedLabelBoxes,
          true
        );

        if (!chosenSlot && item.isAlert && !mustShow) {
          chosenSlot = findAvailableLabelSlot(
            slotCandidates,
            exposedWidth,
            exposedHeight,
            spriteBoxes,
            placedLabelBoxes,
            false
          );
        }

        let lx = 0;
        let ly = 0;
        if (chosenSlot) {
          lx = chosenSlot.x;
          ly = chosenSlot.y;
        } else {
          if (!mustShow) continue;
          const preferLeft = item.px + offset + boxW > exposedWidth - 6;
          const maxLx = Math.max(6, exposedWidth - boxW - 6);
          const maxLy = Math.max(6, exposedHeight - boxH - 6);
          lx = Math.max(
            6,
            Math.min(maxLx, preferLeft ? item.px - offset - boxW : item.px + offset)
          );
          ly = Math.max(6, Math.min(maxLy, item.py - boxH / 2));
        }

        const placedBox = acquirePooledBox(placedBoxPool, placedIdx);
        placedBox.x = lx;
        placedBox.y = ly;
        placedBox.w = boxW;
        placedBox.h = boxH;
        placedLabelBoxes[placedIdx] = placedBox;
        placedIdx += 1;
        placedLabelBoxes.length = placedIdx;

        if (!mustShow) {
          autoDrawn += 1;
        }

        ctx.fillStyle = mustShow
          ? 'rgba(7, 10, 17, 0.94)'
          : item.isAlert
            ? 'rgba(28, 10, 16, 0.90)'
            : 'rgba(7, 10, 17, 0.88)';
        ctx.strokeStyle = mustShow || item.isAlert ? item.color : 'rgba(255, 255, 255, 0.14)';
        ctx.lineWidth = mustShow || item.isAlert ? 1.2 : 1;
        ctx.beginPath();
        traceRoundedRect(ctx, lx, ly, boxW, boxH, 4);
        ctx.fill();
        ctx.stroke();

        const tx = lx + 5;
        const ty = ly + boxH / 2 + 0.5;
        ctx.fillStyle = mustShow
          ? '#F8FAFC'
          : entity.topocentric.belowHorizon
            ? '#94A3B8'
            : '#E2E8F0';
        ctx.fillText(callsignText, tx, ty);

        ctx.fillStyle = item.isAlert ? '#FCA5A5' : '#94A3B8';
        ctx.fillText(metaText, tx + callsignW, ty);

        if (vRateChevron) {
          ctx.fillStyle = vRate > 0 ? '#34D399' : '#F59E0B';
          ctx.fillText(vRateChevron, tx + callsignW + metaW, ty);
        }
      }

      ctx.restore();
    };

    drawMapLabelsRef.current = drawMapLabels;

    const handleCanvasContextLost = (ev: Event) => {
      ev.preventDefault();
    };

    const handleMouseMove = (
      ev: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }
    ) => {
      const store = useSkyStore.getState();
      if (store.layout === 'dome') return;
      const feat = ev.features?.[0];
      const id = feat?.properties?.id;
      if (typeof id !== 'string' || !id) return;
      map.getCanvas().style.cursor = 'pointer';
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

    const handleMapError = (ev: maplibregl.MapEventType['error']) => {
      // Swallow tile/network errors quietly without throwing uncaught exceptions.
      const msg = ev?.error?.message ?? '';
      if (!mapLoadedRef.current && /webgl/i.test(msg)) {
        setWebglError(msg || 'WebGL context initialization failed.');
      }
    };

    map.on('error', handleMapError);
    map.on('dragstart', handleDragStart);
    map.on('dragend', handleDragEnd);
    map.on('touchstart', handleDragStart);
    map.on('touchend', handleDragEnd);
    map.on('move', drawMapLabels);
    map.on('zoom', drawMapLabels);
    map.on('rotate', drawMapLabels);
    map.on('resize', drawMapLabels);

    let layersInitialized = false;
    let contextLostListenerAttached = false;
    const initMapLayers = () => {
      if (cancelled || layersInitialized) return;
      layersInitialized = true;
      mapLoadedRef.current = true;
      registerTacticalSprites(map);
      registerSourcesAndLayers(map);

      const canvas = map.getCanvas();
      canvas.addEventListener('webglcontextlost', handleCanvasContextLost);
      contextLostListenerAttached = true;

      const st = useSkyStore.getState();
      applyCameraPadding(map, st.layout, false, true);
      const isPending = st.observer.source === 'pending';
      const shiftFromMountKm = haversineDistanceKm(
        mountObserver.lat,
        mountObserver.lon,
        st.observer.lat,
        st.observer.lon
      );
      if (
        !isPending &&
        (mountPending ||
          shiftFromMountKm > 0.01 ||
          st.radiusKm !== mountRadiusKm ||
          st.recenterNonce !== mountRecenterNonce)
      ) {
        map.jumpTo({
          center: [normalizeLonDeg(st.observer.lon), st.observer.lat],
          zoom: zoomForRadiusKm(st.radiusKm, st.observer.lat),
        });
      }
      prevObserverRef.current = { lat: st.observer.lat, lon: st.observer.lon };
      prevObserverSourceRef.current = st.observer.source;
      prevRadiusRef.current = st.radiusKm;
      prevRecenterNonceRef.current = st.recenterNonce;
      prevScopeRef.current = st.atmosphericScope;

      (map.getSource(SOURCE_IDS.uasfm) as maplibregl.GeoJSONSource | undefined)?.setData(
        st.airspace.uasfm ?? EMPTY_FC
      );
      (map.getSource(SOURCE_IDS.sua) as maplibregl.GeoJSONSource | undefined)?.setData(
        st.airspace.sua ?? EMPTY_FC
      );
      (map.getSource(SOURCE_IDS.scanRing) as maplibregl.GeoJSONSource | undefined)?.setData(
        isPending ? EMPTY_FC : buildScanRingFc(st.observer.lat, st.observer.lon, st.radiusKm)
      );
      (map.getSource(SOURCE_IDS.observer) as maplibregl.GeoJSONSource | undefined)?.setData(
        isPending ? EMPTY_FC : buildObserverFc(st.observer.lat, st.observer.lon, st.observer.label)
      );

      const { entitiesFc, operatorsFc } = buildEntitiesAndOperatorsFc(
        st.layers,
        st.selectedId,
        st.hoveredId,
        performance.now()
      );
      (map.getSource(SOURCE_IDS.entities) as maplibregl.GeoJSONSource | undefined)?.setData(
        entitiesFc
      );
      (map.getSource(SOURCE_IDS.operators) as maplibregl.GeoJSONSource | undefined)?.setData(
        operatorsFc
      );
      (map.getSource(SOURCE_IDS.entityTrails) as maplibregl.GeoJSONSource | undefined)?.setData(
        buildTrailsAndVectorsFc(st.layers)
      );

      const airspaceVis = st.layers.drone && st.droneSublayers.airspace ? 'visible' : 'none';
      map.setLayoutProperty(LAYER_IDS.uasfmFill, 'visibility', airspaceVis);
      map.setLayoutProperty(LAYER_IDS.uasfmOutline, 'visibility', airspaceVis);
      map.setLayoutProperty(LAYER_IDS.suaFill, 'visibility', airspaceVis);
      map.setLayoutProperty(LAYER_IDS.suaOutline, 'visibility', airspaceVis);
      map.setLayoutProperty(LAYER_IDS.operatorsSymbol, 'visibility', airspaceVis);

      map.on('mousemove', LAYER_IDS.entitiesSymbol, handleMouseMove);
      map.on('mouseleave', LAYER_IDS.entitiesSymbol, handleMouseLeave);
      map.on('click', LAYER_IDS.entitiesSymbol, handleClick);

      drawMapLabels();
    };

    map.on('style.load', initMapLayers);
    map.on('load', initMapLayers);

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        syncLabelCanvasSize(entry.contentRect.width, entry.contentRect.height);
      }
      if (mapRef.current) {
        try {
          mapRef.current.resize();
        } catch {
          // Ignore transient resize errors during teardown
        }
        applyCameraPadding(mapRef.current, useSkyStore.getState().layout, false);
      }
      drawMapLabels();
    });
    resizeObserver.observe(container);

    const handleWindowResize = () => {
      const rect = container.getBoundingClientRect();
      syncLabelCanvasSize(rect.width, rect.height);
      if (mapRef.current) {
        applyCameraPadding(mapRef.current, useSkyStore.getState().layout, false);
      }
      drawMapLabels();
    };
    window.addEventListener('resize', handleWindowResize);

    // 60fps GeoJSON update loop reading directly from liveKinematicsRegistry
    let rafId = 0;
    let lastEntityVersion = -1;
    let lastLayerFlight = !initialState.layers.flight;
    let lastLayerMilitary = !initialState.layers.military;
    let lastLayerSatellite = !initialState.layers.satellite;
    let lastLayerBalloon = !initialState.layers.balloon;
    let lastLayerDrone = !initialState.layers.drone;
    let lastSelectedId: string | null = null;
    let lastHoveredId: string | null = null;
    let lastMapLabelsEnabled = initialState.mapLabelsEnabled;
    let lastUnits = initialState.units;
    let lastLayout = initialState.layout;
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
      if (state.layout === 'dome' && hoverCoordsRef.current !== null) {
        hoverCoordsRef.current = null;
        setHoverTip(null);
        activeMap.getCanvas().style.cursor = '';
      }

      const layoutChanged = state.layout !== lastLayout;
      lastLayout = state.layout;

      const layersChanged =
        state.layers.flight !== lastLayerFlight ||
        state.layers.military !== lastLayerMilitary ||
        state.layers.satellite !== lastLayerSatellite ||
        state.layers.balloon !== lastLayerBalloon ||
        state.layers.drone !== lastLayerDrone;
      const versionChanged = liveKinematicsRegistry.version !== lastEntityVersion;
      const stateChanged =
        layersChanged ||
        state.selectedId !== lastSelectedId ||
        state.hoveredId !== lastHoveredId;
      const labelsChanged = state.mapLabelsEnabled !== lastMapLabelsEnabled;
      const unitsChanged = state.units !== lastUnits;

      const hasHighlight = state.selectedId !== null || state.hoveredId !== null;
      const pulseTickDue = nowMs - lastPulseSyncMs >= 45;
      const minTrailInterval = liveKinematicsRegistry.entities.size > 250 ? 45 : 0;
      const trailUpdateDue =
        stateChanged || (versionChanged && nowMs - lastTrailSyncMs >= minTrailInterval);

      if (versionChanged || stateChanged || (hasHighlight && pulseTickDue)) {
        lastEntityVersion = liveKinematicsRegistry.version;
        lastLayerFlight = state.layers.flight;
        lastLayerMilitary = state.layers.military;
        lastLayerSatellite = state.layers.satellite;
        lastLayerBalloon = state.layers.balloon;
        lastLayerDrone = state.layers.drone;
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

      if (versionChanged || stateChanged || labelsChanged || unitsChanged || layoutChanged) {
        lastMapLabelsEnabled = state.mapLabelsEnabled;
        lastUnits = state.units;
        if (state.layout !== 'dome' || layoutChanged) {
          drawMapLabels();
        }
      }

      // Orbit overlay update (on overlay change, layer toggle, or every ~120ms for moving footprint)
      const overlayChanged =
        liveKinematicsRegistry.orbitOverlay !== lastOrbitOverlayRef || stateChanged;
      if (overlayChanged || (liveKinematicsRegistry.orbitOverlay && versionChanged)) {
        lastOrbitOverlayRef = liveKinematicsRegistry.orbitOverlay;
        const orbitSrc = activeMap.getSource(SOURCE_IDS.orbitOverlay) as
          | maplibregl.GeoJSONSource
          | undefined;
        orbitSrc?.setData(buildOrbitOverlayFc(state.layers.satellite));
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
        if (hoveredEntity && state.layers[hoveredEntity.category]) {
          setHoverTip(buildHoverTooltip(hoveredEntity, hc.x, hc.y, state.units));
        } else {
          hoverCoordsRef.current = null;
          setHoverTip(null);
          activeMap.getCanvas().style.cursor = '';
          if (state.hoveredId === hc.id) {
            state.setHoveredId(null);
          }
        }
      }
    };

    rafId = window.requestAnimationFrame(frameLoop);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleWindowResize);
      drawMapLabelsRef.current = null;
      syncCameraPaddingRef.current = null;
      mapLoadedRef.current = false;
      scaleControlRef.current = null;
      try {
        map.off('error', handleMapError);
        map.off('dragstart', handleDragStart);
        map.off('dragend', handleDragEnd);
        map.off('touchstart', handleDragStart);
        map.off('touchend', handleDragEnd);
        map.off('move', drawMapLabels);
        map.off('zoom', drawMapLabels);
        map.off('rotate', drawMapLabels);
        map.off('resize', drawMapLabels);
        map.off('style.load', initMapLayers);
        map.off('load', initMapLayers);
        if (layersInitialized) {
          map.off('mousemove', LAYER_IDS.entitiesSymbol, handleMouseMove);
          map.off('mouseleave', LAYER_IDS.entitiesSymbol, handleMouseLeave);
          map.off('click', LAYER_IDS.entitiesSymbol, handleClick);
        }
        if (contextLostListenerAttached) {
          map.getCanvas().removeEventListener('webglcontextlost', handleCanvasContextLost);
        }
        map.remove();
      } catch {
        // Ignore teardown issues
      }
      mapRef.current = null;
    };
  }, []);

  // Sync observer, scan ring, and recenter on observer shifts, radiusKm changes, or recenterNonce
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) return;

    if (observer.source === 'pending') {
      (map.getSource(SOURCE_IDS.scanRing) as maplibregl.GeoJSONSource | undefined)?.setData(
        EMPTY_FC
      );
      (map.getSource(SOURCE_IDS.observer) as maplibregl.GeoJSONSource | undefined)?.setData(
        EMPTY_FC
      );
      prevObserverRef.current = { lat: observer.lat, lon: observer.lon };
      prevObserverSourceRef.current = observer.source;
      prevRadiusRef.current = radiusKm;
      prevRecenterNonceRef.current = recenterNonce;
      return;
    }

    (map.getSource(SOURCE_IDS.scanRing) as maplibregl.GeoJSONSource | undefined)?.setData(
      buildScanRingFc(observer.lat, observer.lon, radiusKm)
    );
    (map.getSource(SOURCE_IDS.observer) as maplibregl.GeoJSONSource | undefined)?.setData(
      buildObserverFc(observer.lat, observer.lon, observer.label)
    );

    const wasPending = prevObserverSourceRef.current === 'pending';
    const shiftKm = haversineDistanceKm(
      prevObserverRef.current.lat,
      prevObserverRef.current.lon,
      observer.lat,
      observer.lon
    );
    const radiusChanged = radiusKm !== prevRadiusRef.current;
    const nonceChanged = recenterNonce !== prevRecenterNonceRef.current;
    const observerShifted =
      Math.abs(observer.lat - prevObserverRef.current.lat) > 1e-6 ||
      Math.abs(normalizeLonDeg(observer.lon - prevObserverRef.current.lon)) > 1e-6;

    if (wasPending || nonceChanged || radiusChanged || observerShifted) {
      if (wasPending || shiftKm > 250) {
        map.jumpTo({
          center: [normalizeLonDeg(observer.lon), observer.lat],
          zoom: zoomForRadiusKm(radiusKm, observer.lat),
        });
      } else {
        map.flyTo({
          center: [normalizeLonDeg(observer.lon), observer.lat],
          zoom: zoomForRadiusKm(radiusKm, observer.lat),
          duration: 650,
          essential: true,
        });
      }
    }

    prevObserverRef.current = { lat: observer.lat, lon: observer.lon };
    prevObserverSourceRef.current = observer.source;
    prevRadiusRef.current = radiusKm;
    prevRecenterNonceRef.current = recenterNonce;
  }, [observer.lat, observer.lon, observer.label, observer.source, radiusKm, recenterNonce]);

  // Redraw overlay labels immediately when label toggle or unit formatting changes
  useEffect(() => {
    drawMapLabelsRef.current?.();
  }, [mapLabelsEnabled, units]);

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

  // Sync UASFM, SUA & operator visibility when drone layer or airspace sublayer toggles
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) return;
    const vis = layers.drone && droneSublayers.airspace ? 'visible' : 'none';
    if (map.getLayer(LAYER_IDS.uasfmFill)) {
      map.setLayoutProperty(LAYER_IDS.uasfmFill, 'visibility', vis);
    }
    if (map.getLayer(LAYER_IDS.uasfmOutline)) {
      map.setLayoutProperty(LAYER_IDS.uasfmOutline, 'visibility', vis);
    }
    if (map.getLayer(LAYER_IDS.suaFill)) {
      map.setLayoutProperty(LAYER_IDS.suaFill, 'visibility', vis);
    }
    if (map.getLayer(LAYER_IDS.suaOutline)) {
      map.setLayoutProperty(LAYER_IDS.suaOutline, 'visibility', vis);
    }
    if (map.getLayer(LAYER_IDS.operatorsSymbol)) {
      map.setLayoutProperty(LAYER_IDS.operatorsSymbol, 'visibility', vis);
    }
  }, [layers.drone, droneSublayers.airspace]);

  // Smoothly zoom out/in when user actively switches atmospheric scope
  useEffect(() => {
    const prevScope = prevScopeRef.current;
    prevScopeRef.current = atmosphericScope;
    if (prevScope === atmosphericScope) return;

    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) return;

    const st = useSkyStore.getState();
    if (atmosphericScope === 'global' && prevScope === 'local') {
      if (!st.followSelected) {
        map.easeTo({
          zoom: Math.min(map.getZoom(), 3.6),
          duration: 750,
          essential: true,
        });
      }
    } else if (atmosphericScope === 'local' && prevScope === 'global') {
      if (st.observer.source === 'pending') return;
      if (!st.followSelected) {
        map.flyTo({
          center: [normalizeLonDeg(st.observer.lon), st.observer.lat],
          zoom: zoomForRadiusKm(st.radiusKm, st.observer.lat),
          duration: 650,
          essential: true,
        });
      } else {
        map.easeTo({
          zoom: zoomForRadiusKm(st.radiusKm, st.observer.lat),
          duration: 650,
          essential: true,
        });
      }
    }
  }, [atmosphericScope]);

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

  // Sync MapLibre camera padding and canvas dimensions when layout mode switches
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (layout === 'dome') {
      if (hoverCoordsRef.current !== null) {
        hoverCoordsRef.current = null;
        setHoverTip(null);
      }
      try {
        map.getCanvas().style.cursor = '';
      } catch {
        // Ignore if canvas unavailable
      }
    }
    const layoutChanged = prevLayoutEffectRef.current !== layout;
    prevLayoutEffectRef.current = layout;
    if (layoutChanged) {
      try {
        map.resize();
      } catch {
        // Ignore transient resize errors
      }
      syncCameraPaddingRef.current?.(layout, true);
    }
    const timer = window.setTimeout(() => {
      try {
        const rect = containerRef.current?.getBoundingClientRect();
        if (
          rect &&
          (Math.abs(rect.width - labelMetricsRef.current.width) > 0.5 ||
            Math.abs(rect.height - labelMetricsRef.current.height) > 0.5)
        ) {
          map.resize();
        }
        syncCameraPaddingRef.current?.(layout, false);
        drawMapLabelsRef.current?.();
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
  const activePad = appliedPaddingRef.current;
  const exposedTooltipWidth =
    layout === 'split' && activePad.right > 0
      ? Math.max(240, containerWidth - activePad.right)
      : containerWidth;
  const exposedTooltipHeight =
    layout === 'split' && activePad.bottom > 0
      ? Math.max(120, containerHeight - activePad.bottom)
      : containerHeight;

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
          touchAction: 'none',
        }}
      />

      <canvas
        ref={labelCanvasRef}
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: 5,
        }}
      />

      {!webglError && layout !== 'dome' && (
        <button
          type="button"
          data-testid="map-labels-toggle"
          aria-pressed={mapLabelsEnabled}
          aria-label="Toggle map callsign labels"
          onClick={() => setMapLabelsEnabled(!mapLabelsEnabled)}
          style={{
            position: 'absolute',
            top: 10,
            left: 'max(10px, env(safe-area-inset-left))',
            zIndex: 15,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 10px',
            minHeight: 30,
            borderRadius: 6,
            border: mapLabelsEnabled
              ? '1px solid rgba(34, 211, 238, 0.42)'
              : '1px solid rgba(255, 255, 255, 0.10)',
            backgroundColor: 'rgba(7, 10, 17, 0.86)',
            color: mapLabelsEnabled ? '#E0F2FE' : '#94A3B8',
            fontFamily: MONO_FONT,
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.06em',
            cursor: 'pointer',
            backdropFilter: 'blur(20px) saturate(150%)',
            WebkitBackdropFilter: 'blur(20px) saturate(150%)',
            boxShadow:
              'inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 8px 24px rgba(0, 0, 0, 0.48)',
            outline: 'none',
            touchAction: 'manipulation',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              backgroundColor: mapLabelsEnabled ? '#38BDF8' : '#475569',
              boxShadow: mapLabelsEnabled ? '0 0 6px #38BDF8' : 'none',
              flexShrink: 0,
            }}
          />
          <span>LABELS</span>
        </button>
      )}

      {webglError && (
        <div
          role="status"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 10,
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
            {observer.source === 'pending'
              ? `OBS: ${observer.label} · R=${radiusKm} km · TARGETS=${counts.total}`
              : `OBS: ${observer.label} (${observer.lat.toFixed(3)}°, ${observer.lon.toFixed(3)}°) · R=${radiusKm} km · TARGETS=${counts.total}`}
          </div>
        </div>
      )}

      {!webglError && layout !== 'dome' && hoverTip && (
        <div
          style={{
            position: 'absolute',
            left: Math.max(8, Math.min(hoverTip.x + 14, exposedTooltipWidth - 232)),
            top: Math.max(8, Math.min(hoverTip.y + 14, exposedTooltipHeight - 96)),
            width: 220,
            maxWidth: 'calc(100% - 16px)',
            pointerEvents: 'none',
            zIndex: 20,
            padding: '8px 10px',
            borderRadius: 8,
            backgroundColor: 'rgba(7, 10, 17, 0.86)',
            backdropFilter: 'blur(20px) saturate(150%)',
            WebkitBackdropFilter: 'blur(20px) saturate(150%)',
            border: hoverTip.alertTag
              ? `1px solid ${hoverTip.color}66`
              : '1px solid rgba(255, 255, 255, 0.10)',
            boxShadow:
              'inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 14px 36px rgba(0, 0, 0, 0.65)',
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
