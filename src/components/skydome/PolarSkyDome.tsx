import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import {
  BREACH_COLOR,
  CATEGORY_COLORS,
  EMERGENCY_COLOR,
  SATELLITE_ECLIPSED_COLOR,
  SATELLITE_SUNLIT_COLOR,
  type CelestialPositions,
  type SatelliteOrbitOverlay,
  type SkyDomeZoomMode,
  type SkyEntity,
  type UnitSystem,
} from '../../types/sky-contracts';
import { liveKinematicsRegistry, useSkyStore } from '../../store/useSkyStore';
import { tacticalAudio } from '../../audio/tacticalAudio';
import {
  computeClosestApproach,
  computeSkyDomeTrajectoryTangent,
  computeSolarLunarTopocentric,
  computeTopocentricLookAngles,
  elevationToVaultNormR,
  extrapolateDeadReckoning,
  normalizeAzimuthDeg,
  projectToSkyDome,
  shortestAngleDeltaDeg,
  smoothCompassHeadingDeg,
  unprojectFromSkyDome,
} from '../../math/geodesy';
import { formatAltitude, formatDistance } from '../../math/units';

export interface PolarSkyDomeProps {
  className?: string;
}

const HIT_RADIUS_PX = 13;
const TOUCH_HIT_RADIUS_PX = 20;
const DRAG_THRESHOLD_PX = 6;
const DRAG_CENTER_DEADZONE_PX = 6;
const COMPASS_SMOOTH_ALPHA = 0.18;
const COMPASS_PROBE_TIMEOUT_MS = 1500;
const COMPASS_STATUS_DURATION_MS = 4500;
const SWEEP_DEG_PER_MS = 0.045; // 1 revolution ~ 8s
const PULSE_WAVE_DURATION_MS = 950;
const TRAIL_SAMPLE_INTERVAL_MS = 450;
const MAX_TRAIL_SAMPLES = 10;
const MAX_FLIGHT_TRAIL_AGE_MS = 120_000;
const MAX_BALLOON_TRAIL_AGE_MS = 1_800_000;
const MAX_TRAIL_SEGMENT_RATIO = 0.45;
const CELESTIAL_REFRESH_MS = 10_000;
const TCA_REFRESH_MS = 500;
const FORWARD_ARC_DTS: readonly number[] = [0, 15, 30, 45, 60];
const TCA_ARC_STEPS = 6;
const LIMB_FADE_DEG = 4;

export type CompassOrientationEvent = Partial<
  Pick<DeviceOrientationEvent, 'alpha' | 'absolute' | 'type'>
> & {
  webkitCompassHeading?: number;
};

/**
 * Extract true North-referenced compass heading [0, 360) from a DeviceOrientationEvent.
 * Supports iOS WebKit `webkitCompassHeading` and Android/Chromium absolute `alpha` with
 * screen-orientation compensation. Returns null for relative/invalid readings.
 */
export function extractCompassHeadingDeg(
  event: CompassOrientationEvent,
  screenOrientationAngle?: number
): number | null {
  if (!event) return null;

  if (
    typeof event.webkitCompassHeading === 'number' &&
    Number.isFinite(event.webkitCompassHeading) &&
    event.webkitCompassHeading >= 0
  ) {
    return normalizeAzimuthDeg(event.webkitCompassHeading);
  }

  const isAbsolute =
    event.absolute === true || event.type === 'deviceorientationabsolute';
  if (isAbsolute && typeof event.alpha === 'number' && Number.isFinite(event.alpha)) {
    let screenAngle = 0;
    if (typeof screenOrientationAngle === 'number' && Number.isFinite(screenOrientationAngle)) {
      screenAngle = screenOrientationAngle;
    } else if (typeof window !== 'undefined') {
      const soAngle = window.screen?.orientation?.angle;
      const legacyAngle = (window as unknown as { orientation?: number }).orientation;
      if (typeof soAngle === 'number' && Number.isFinite(soAngle)) {
        screenAngle = soAngle;
      } else if (typeof legacyAngle === 'number' && Number.isFinite(legacyAngle)) {
        screenAngle = legacyAngle;
      }
    }
    return normalizeAzimuthDeg(360 - event.alpha + screenAngle);
  }

  return null;
}

function resolveCanvasCursor(
  hitId: string | null,
  locked: boolean,
  dragging: boolean
): string {
  if (dragging && !locked) return 'grabbing';
  if (hitId) return 'pointer';
  return locked ? 'crosshair' : 'grab';
}

function minElevationFor(zoom: SkyDomeZoomMode): number {
  return zoom === 'zenith' ? 30 : 0;
}

interface PolarPoint {
  azDeg: number;
  elDeg: number;
  ts: number;
}

interface RenderedTargetHit {
  id: string;
  x: number;
  y: number;
  priority: number;
}

interface HitPool {
  items: RenderedTargetHit[];
  count: number;
}

interface VisItem {
  entity: SkyEntity;
  azDeg: number;
  elDeg: number;
  x: number;
  y: number;
  color: string;
  priority: number;
  isSelected: boolean;
  isHovered: boolean;
  isEmergency: boolean;
  isBreach: boolean;
  fade: number;
}

interface CanvasMetrics {
  width: number;
  height: number;
  dpr: number;
  cx: number;
  cy: number;
  outerRadius: number;
}

interface VaultCache {
  key: string;
  vault: CanvasGradient | null;
  bezel: CanvasGradient | null;
  sweep: CanvasGradient | null;
  glow: CanvasGradient | null;
}

interface CelestialCache {
  key: string;
  ts: number;
  pos: CelestialPositions | null;
}

interface TcaCacheEntry {
  ts: number;
  isApproaching: boolean;
  tcaSeconds: number;
  peakAzimuthDeg: number;
  peakElevationDeg: number;
}

const MONO_FONT =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace";

const COMPASS_BEACONS: Array<{ label: string; azDeg: number; cardinal: boolean }> = [
  { label: 'N', azDeg: 0, cardinal: true },
  { label: 'NE', azDeg: 45, cardinal: false },
  { label: 'E', azDeg: 90, cardinal: true },
  { label: 'SE', azDeg: 135, cardinal: false },
  { label: 'S', azDeg: 180, cardinal: true },
  { label: 'SW', azDeg: 225, cardinal: false },
  { label: 'W', azDeg: 270, cardinal: true },
  { label: 'NW', azDeg: 315, cardinal: false },
];

const DEG2RAD = Math.PI / 180;

/* ------------------------------------------------------------------ */
/* Pure label layout solver                                            */
/* ------------------------------------------------------------------ */

export type DomeLabelMode = 'dome' | 'split' | 'pip';

export interface DomeLabelCandidate {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  elDeg: number;
  slantRangeKm: number;
  isSelected: boolean;
  isHovered: boolean;
  isEmergency: boolean;
  isBreach: boolean;
  text: string;
  color: string;
}

export interface PlacedDomeLabel {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  anchorX: number;
  anchorY: number;
  leaderX: number;
  leaderY: number;
  mustShow: boolean;
  text: string;
  color: string;
}

export interface DomeLabelLayoutOptions {
  candidates: readonly DomeLabelCandidate[];
  count?: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
  radius: number;
  mode: DomeLabelMode;
  zoomMode: SkyDomeZoomMode;
  labelsEnabled: boolean;
  /** Reusable output pool; objects are mutated in place. */
  out?: PlacedDomeLabel[];
  /** Reusable index scratch array. */
  order?: number[];
}

export interface DomeLabelLayoutResult {
  labels: PlacedDomeLabel[];
  count: number;
}

const LABEL_EDGE_MARGIN = 8;
const LABEL_PAD = 2;
const LABEL_GAP = 9;

let rankCandidates: readonly DomeLabelCandidate[] = [];

function rankCompare(ia: number, ib: number): number {
  const a = rankCandidates[ia];
  const b = rankCandidates[ib];
  const pa = a.isSelected ? 2 : a.isHovered ? 1 : 0;
  const pb = b.isSelected ? 2 : b.isHovered ? 1 : 0;
  if (pa !== pb) return pb - pa;
  const aa = a.isEmergency || a.isBreach ? 1 : 0;
  const ab = b.isEmergency || b.isBreach ? 1 : 0;
  if (aa !== ab) return ab - aa;
  if (a.elDeg !== b.elDeg) return b.elDeg - a.elDeg;
  if (a.slantRangeKm !== b.slantRangeKm) return a.slantRangeKm - b.slantRangeKm;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function labelBoxValid(
  x: number,
  y: number,
  w: number,
  h: number,
  o: DomeLabelLayoutOptions
): boolean {
  const m = LABEL_EDGE_MARGIN;
  if (x < m || y < m || x + w > o.width - m || y + h > o.height - m) return false;
  const lim = o.radius - 8;
  if (lim <= 0) return false;
  const l2 = lim * lim;
  const dx0 = x - o.cx;
  const dx1 = x + w - o.cx;
  const dy0 = y - o.cy;
  const dy1 = y + h - o.cy;
  return (
    dx0 * dx0 + dy0 * dy0 <= l2 &&
    dx1 * dx1 + dy0 * dy0 <= l2 &&
    dx0 * dx0 + dy1 * dy1 <= l2 &&
    dx1 * dx1 + dy1 * dy1 <= l2
  );
}

function labelOverlaps(
  x: number,
  y: number,
  w: number,
  h: number,
  placed: PlacedDomeLabel[],
  count: number
): boolean {
  for (let i = 0; i < count; i += 1) {
    const p = placed[i];
    if (
      x < p.x + p.w + LABEL_PAD &&
      x + w + LABEL_PAD > p.x &&
      y < p.y + p.h + LABEL_PAD &&
      y + h + LABEL_PAD > p.y
    ) {
      return true;
    }
  }
  return false;
}

export function solveDomeLabelLayout(o: DomeLabelLayoutOptions): DomeLabelLayoutResult {
  const labels = o.out ?? [];
  const n = Math.min(o.count ?? o.candidates.length, o.candidates.length);
  const order = o.order ?? [];
  order.length = 0;
  for (let i = 0; i < n; i += 1) order.push(i);
  rankCandidates = o.candidates;
  order.sort(rankCompare);

  const cap = o.mode === 'pip' ? 0 : o.mode === 'split' ? 7 : 12;
  const minPassiveEl = o.zoomMode === 'zenith' ? 34 : 8;
  let placedCount = 0;
  let passive = 0;

  for (let oi = 0; oi < n; oi += 1) {
    const c = o.candidates[order[oi]];
    const mustShow = c.isSelected || c.isHovered;
    if (!mustShow) {
      if (o.mode === 'pip' || !o.labelsEnabled) continue;
      if (c.elDeg < minPassiveEl) continue;
      if (passive >= cap) continue;
    }
    const w = c.w;
    const h = c.h;
    let bx = 0;
    let by = 0;
    let found = false;
    for (let k = 0; k < 8 && !found; k += 1) {
      switch (k) {
        case 0:
          bx = c.x + LABEL_GAP;
          by = c.y - h / 2;
          break;
        case 1:
          bx = c.x - w - LABEL_GAP;
          by = c.y - h / 2;
          break;
        case 2:
          bx = c.x - w / 2;
          by = c.y - h - LABEL_GAP;
          break;
        case 3:
          bx = c.x - w / 2;
          by = c.y + LABEL_GAP;
          break;
        case 4:
          bx = c.x + LABEL_GAP * 0.7;
          by = c.y - h - LABEL_GAP * 0.7;
          break;
        case 5:
          bx = c.x - w - LABEL_GAP * 0.7;
          by = c.y - h - LABEL_GAP * 0.7;
          break;
        case 6:
          bx = c.x + LABEL_GAP * 0.7;
          by = c.y + LABEL_GAP * 0.7;
          break;
        default:
          bx = c.x - w - LABEL_GAP * 0.7;
          by = c.y + LABEL_GAP * 0.7;
          break;
      }
      if (labelBoxValid(bx, by, w, h, o) && !labelOverlaps(bx, by, w, h, labels, placedCount)) {
        found = true;
      }
    }
    if (!found && mustShow) {
      // Pull the pill toward the dome center until it satisfies the aperture constraints.
      for (let s = 1; s <= 12 && !found; s += 1) {
        const t = s / 12;
        bx = c.x + (o.cx - c.x) * t - w / 2;
        by = c.y + (o.cy - c.y) * t - h / 2;
        if (labelBoxValid(bx, by, w, h, o)) found = true;
      }
    }
    if (!found) continue;

    let slot = labels[placedCount];
    if (!slot) {
      slot = {
        id: '',
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        anchorX: 0,
        anchorY: 0,
        leaderX: 0,
        leaderY: 0,
        mustShow: false,
        text: '',
        color: '',
      };
      labels.push(slot);
    }
    slot.id = c.id;
    slot.x = bx;
    slot.y = by;
    slot.w = w;
    slot.h = h;
    slot.anchorX = c.x;
    slot.anchorY = c.y;
    slot.leaderX = Math.max(bx, Math.min(bx + w, c.x));
    slot.leaderY = Math.max(by, Math.min(by + h, c.y));
    slot.mustShow = mustShow;
    slot.text = c.text;
    slot.color = c.color;
    placedCount += 1;
    if (!mustShow) passive += 1;
  }
  return { labels, count: placedCount };
}

/* ------------------------------------------------------------------ */
/* Entity helpers                                                      */
/* ------------------------------------------------------------------ */

function getEntityColor(entity: SkyEntity): string {
  if (entity.emergencyFlag) return EMERGENCY_COLOR;
  if (entity.category === 'drone' && (entity.ceilingBreach || entity.tfrBreach)) {
    return BREACH_COLOR;
  }
  if (entity.category === 'satellite') {
    return entity.sunlit ? SATELLITE_SUNLIT_COLOR : SATELLITE_ECLIPSED_COLOR;
  }
  return CATEGORY_COLORS[entity.category];
}

function getEntityPriority(entity: SkyEntity, isSelected: boolean, isHovered: boolean): number {
  if (isSelected) return 100;
  if (isHovered) return 95;
  if (entity.emergencyFlag) return 90;
  if (entity.category === 'drone' && (entity.ceilingBreach || entity.tfrBreach)) return 88;
  switch (entity.category) {
    case 'military':
      return 68;
    case 'balloon':
      return 60;
    case 'drone':
      return 55;
    case 'satellite':
      if (entity.group === 'stations') return 58;
      if (entity.group === 'visual') return 42;
      return 16;
    case 'flight':
      return 36;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Smooth limb fade 0→1 across minEl→minEl+4°. */
function limbFade(elDeg: number, minEl: number): number {
  const t = clamp01((elDeg - minEl) / LIMB_FADE_DEG);
  return t * t * (3 - 2 * t);
}

/** Atmospheric depth: 0.38 near horizon → 1.0 above 35°. */
function atmosphericDepth(elDeg: number): number {
  return 0.38 + 0.62 * clamp01(elDeg / 35);
}

function drawGlyph(
  ctx: CanvasRenderingContext2D,
  entity: SkyEntity,
  x: number,
  y: number,
  headingAngle: number,
  color: string,
  scale: number
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  switch (entity.category) {
    case 'flight': {
      ctx.rotate(headingAngle);
      ctx.beginPath();
      ctx.moveTo(6.2, 0);
      ctx.lineTo(-4.4, -3.9);
      ctx.lineTo(-2.1, 0);
      ctx.lineTo(-4.4, 3.9);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      break;
    }
    case 'military': {
      ctx.rotate(headingAngle);
      ctx.beginPath();
      ctx.moveTo(6.8, 0);
      ctx.lineTo(-4.2, -4.4);
      ctx.lineTo(-1.6, 0);
      ctx.lineTo(-4.2, 4.4);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#FEF3C7';
      ctx.lineWidth = 0.75;
      ctx.stroke();
      break;
    }
    case 'satellite': {
      // Solar wings perpendicular to heading + illuminated core diamond
      ctx.rotate(headingAngle);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(0, -6.2);
      ctx.lineTo(0, 6.2);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(3.6, 0);
      ctx.lineTo(0, -2.7);
      ctx.lineTo(-3.6, 0);
      ctx.lineTo(0, 2.7);
      ctx.closePath();
      ctx.fillStyle = entity.sunlit ? '#FDF4FF' : color;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.1;
      ctx.stroke();
      break;
    }
    case 'balloon': {
      if (entity.subSource === 'windborne') {
        // WindBorne Systems superpressure tear-drop stratospheric sounding envelope
        ctx.beginPath();
        ctx.moveTo(0, 2.8);
        ctx.bezierCurveTo(-4.1, 0.2, -4.1, -5.4, 0, -5.6);
        ctx.bezierCurveTo(4.1, -5.4, 4.1, 0.2, 0, 2.8);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#A7F3D0';
        ctx.lineWidth = 0.9;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(-1.1, -2.5, 1.4, Math.PI * 1.05, Math.PI * 1.65);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.78)';
        ctx.lineWidth = 0.85;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(0, 2.8);
        ctx.lineTo(0, 4.7);
        ctx.strokeStyle = '#D1FAE5';
        ctx.lineWidth = 0.9;
        ctx.stroke();

        ctx.fillStyle = '#ECFDF5';
        ctx.fillRect(-1.3, 4.6, 2.6, 1.9);
      } else {
        // SondeHub / ADS-B LTA spherical balloon envelope + radiosonde diamond payload
        ctx.beginPath();
        ctx.arc(0, -1.4, 3.4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#ECFDF5';
        ctx.lineWidth = 0.8;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(0, 2.0);
        ctx.lineTo(0, 4.8);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.05;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(0, 4.6);
        ctx.lineTo(1.4, 6.0);
        ctx.lineTo(0, 7.2);
        ctx.lineTo(-1.4, 6.0);
        ctx.closePath();
        ctx.fillStyle = '#ECFDF5';
        ctx.fill();
      }
      break;
    }
    case 'drone': {
      if (entity.subSource === 'adsb-uas' || entity.uaType === 'fixed-wing') {
        // High-aspect-ratio swept-wing / V-tail HALE fixed-wing UAV
        ctx.rotate(headingAngle);
        ctx.beginPath();
        ctx.moveTo(6.4, 0);
        ctx.lineTo(3.2, -1.1);
        ctx.lineTo(1.1, -1.1);
        ctx.lineTo(-1.0, -7.2);
        ctx.lineTo(-2.3, -7.2);
        ctx.lineTo(-1.4, -1.0);
        ctx.lineTo(-4.4, -0.7);
        ctx.lineTo(-6.1, -2.9);
        ctx.lineTo(-6.7, -2.4);
        ctx.lineTo(-5.2, 0);
        ctx.lineTo(-6.7, 2.4);
        ctx.lineTo(-6.1, 2.9);
        ctx.lineTo(-4.4, 0.7);
        ctx.lineTo(-1.4, 1.0);
        ctx.lineTo(-2.3, 7.2);
        ctx.lineTo(-1.0, 7.2);
        ctx.lineTo(1.1, 1.1);
        ctx.lineTo(3.2, 1.1);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = entity.isMilitary ? '#F59E0B' : '#ECFCCB';
        ctx.lineWidth = 0.85;
        ctx.stroke();
      } else {
        // Quadrotor X-frame multirotor UAV
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.35;
        ctx.beginPath();
        ctx.moveTo(-3.8, -3.8);
        ctx.lineTo(3.8, 3.8);
        ctx.moveTo(-3.8, 3.8);
        ctx.lineTo(3.8, -3.8);
        ctx.stroke();

        const rotors: Array<[number, number]> = [
          [-3.8, -3.8],
          [3.8, -3.8],
          [-3.8, 3.8],
          [3.8, 3.8],
        ];
        ctx.lineWidth = 0.9;
        for (const [rx, ry] of rotors) {
          ctx.beginPath();
          ctx.arc(rx, ry, 1.35, 0, Math.PI * 2);
          ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(0, 0, 2.0, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
      break;
    }
  }

  ctx.restore();
}

function drawTcaStar(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save();
  ctx.translate(x, y);

  // Soft outer glow halo
  const glow = ctx.createRadialGradient(0, 0, 1, 0, 0, 13);
  glow.addColorStop(0, 'rgba(240, 171, 252, 0.72)');
  glow.addColorStop(0.5, 'rgba(192, 132, 252, 0.25)');
  glow.addColorStop(1, 'rgba(192, 132, 252, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, 13, 0, Math.PI * 2);
  ctx.fill();

  // 4-point crisp diamond star
  ctx.beginPath();
  for (let i = 0; i < 8; i += 1) {
    const angle = (i * Math.PI) / 4;
    const radius = i % 2 === 0 ? 7.2 : 2.3;
    const px = Math.cos(angle) * radius;
    const py = Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = '#F5D0FE';
  ctx.fill();
  ctx.strokeStyle = '#E879F9';
  ctx.lineWidth = 1.1;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(0, 0, 1.8, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.restore();
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

function drawOrbitPassArc(
  ctx: CanvasRenderingContext2D,
  overlay: SatelliteOrbitOverlay,
  selectedId: string | null,
  cx: number,
  cy: number,
  outerRadius: number,
  zoom: SkyDomeZoomMode,
  rotationDeg = 0
): void {
  if (!selectedId || overlay.passArcAzEl.length < 2) return;
  const selectedEntity = liveKinematicsRegistry.entities.get(selectedId);
  const matchesSelected =
    selectedId === `sat-${overlay.noradId}` ||
    (selectedEntity?.category === 'satellite' && selectedEntity.noradId === overlay.noradId);
  if (!matchesSelected) return;

  const minEl = minElevationFor(zoom);
  const pts = overlay.passArcAzEl;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, outerRadius, 0, Math.PI * 2);
  ctx.clip();

  const crossAzimuth = (
    a: { azDeg: number; elDeg: number },
    b: { azDeg: number; elDeg: number }
  ): number => {
    let dAz = b.azDeg - a.azDeg;
    if (dAz > 180) dAz -= 360;
    if (dAz < -180) dAz += 360;
    const denom = b.elDeg - a.elDeg;
    const t = Math.abs(denom) > 1e-6 ? (minEl - a.elDeg) / denom : 0;
    return (a.azDeg + dAz * t + 360) % 360;
  };

  const drawPassPath = () => {
    ctx.beginPath();
    let penDown = false;
    let prev: { azDeg: number; elDeg: number } | null = null;
    for (let i = 0; i < pts.length; i += 1) {
      const pt = pts[i];
      if (!Number.isFinite(pt.azDeg) || !Number.isFinite(pt.elDeg)) {
        penDown = false;
        prev = null;
        continue;
      }
      if (pt.elDeg < minEl) {
        if (penDown && prev && prev.elDeg >= minEl) {
          const e = projectToSkyDome(
            crossAzimuth(prev, pt),
            minEl,
            cx,
            cy,
            outerRadius,
            zoom,
            rotationDeg
          );
          ctx.lineTo(e.x, e.y);
        }
        penDown = false;
        prev = pt;
        continue;
      }
      if (!penDown && prev && prev.elDeg < minEl) {
        const e = projectToSkyDome(
          crossAzimuth(prev, pt),
          minEl,
          cx,
          cy,
          outerRadius,
          zoom,
          rotationDeg
        );
        ctx.moveTo(e.x, e.y);
        penDown = true;
      }
      const p = projectToSkyDome(pt.azDeg, pt.elDeg, cx, cy, outerRadius, zoom, rotationDeg);
      if (!penDown) {
        ctx.moveTo(p.x, p.y);
        penDown = true;
      } else {
        ctx.lineTo(p.x, p.y);
      }
      prev = pt;
    }
  };

  drawPassPath();
  ctx.strokeStyle = 'rgba(192, 132, 252, 0.26)';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  drawPassPath();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = CATEGORY_COLORS.satellite;
  ctx.lineWidth = 1.85;
  ctx.stroke();
  ctx.setLineDash([]);

  let peak: { azDeg: number; elDeg: number; isPeak?: boolean } | undefined;
  let bestEl = -999;
  for (let i = 0; i < pts.length; i += 1) {
    const pt = pts[i];
    if (pt.isPeak) {
      peak = pt;
      break;
    }
    if (pt.elDeg > bestEl) {
      bestEl = pt.elDeg;
      peak = pt;
    }
  }

  if (peak && Number.isFinite(peak.azDeg) && Number.isFinite(peak.elDeg) && peak.elDeg >= minEl) {
    const pp = projectToSkyDome(peak.azDeg, peak.elDeg, cx, cy, outerRadius, zoom, rotationDeg);
    drawTcaStar(ctx, pp.x, pp.y);

    const tcaText = `TCA ${peak.elDeg.toFixed(0)}°`;
    ctx.font = `600 9.5px ${MONO_FONT}`;
    const textW = ctx.measureText(tcaText).width;
    const tx = Math.min(cx + outerRadius - textW - 10, pp.x + 10);
    const ty = Math.max(cy - outerRadius + 14, pp.y - 8);

    ctx.fillStyle = 'rgba(15, 10, 30, 0.85)';
    ctx.strokeStyle = 'rgba(232, 121, 249, 0.55)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    traceRoundedRect(ctx, tx - 4, ty - 9, textW + 8, 13, 3);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#F5D0FE';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(tcaText, tx, ty - 2);
  }

  ctx.restore();
}

function drawTargetLockReticle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  nowMs: number
): void {
  const pulse = 13.5 + Math.sin(nowMs * 0.006) * 1.4;
  const bracket = 5;

  ctx.save();
  ctx.translate(x, y);

  // Subtle glow ring
  ctx.beginPath();
  ctx.arc(0, 0, pulse - 2, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(34, 211, 238, 0.22)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // 4 corner tactical lock brackets
  ctx.strokeStyle = color === SATELLITE_ECLIPSED_COLOR ? '#E879F9' : color;
  ctx.lineWidth = 1.65;
  ctx.beginPath();
  // Top-left
  ctx.moveTo(-pulse, -pulse + bracket);
  ctx.lineTo(-pulse, -pulse);
  ctx.lineTo(-pulse + bracket, -pulse);
  // Top-right
  ctx.moveTo(pulse - bracket, -pulse);
  ctx.lineTo(pulse, -pulse);
  ctx.lineTo(pulse, -pulse + bracket);
  // Bottom-right
  ctx.moveTo(pulse, pulse - bracket);
  ctx.lineTo(pulse, pulse);
  ctx.lineTo(pulse - bracket, pulse);
  // Bottom-left
  ctx.moveTo(-pulse + bracket, pulse);
  ctx.lineTo(-pulse, pulse);
  ctx.lineTo(-pulse, pulse - bracket);
  ctx.stroke();

  ctx.restore();
}

function ensureVaultCache(
  ctx: CanvasRenderingContext2D,
  m: CanvasMetrics,
  zoom: SkyDomeZoomMode,
  cache: VaultCache
): VaultCache {
  const key = `${m.width}x${m.height}@${m.dpr}:${zoom}:${m.outerRadius.toFixed(2)}`;
  if (cache.key === key && cache.vault) return cache;
  const { cx, cy, outerRadius: R } = m;
  cache.key = key;

  // Translucent glass dome wash (0.24–0.38 alpha) so live MapLibre traffic stays visible underneath
  const vault = ctx.createRadialGradient(cx - R * 0.22, cy - R * 0.3, R * 0.04, cx, cy, R);
  vault.addColorStop(0, 'rgba(24, 58, 92, 0.24)');
  vault.addColorStop(0.4, 'rgba(12, 28, 48, 0.30)');
  vault.addColorStop(0.82, 'rgba(6, 13, 24, 0.36)');
  vault.addColorStop(1, 'rgba(4, 8, 16, 0.38)');
  cache.vault = vault;

  const bezel = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  bezel.addColorStop(0, 'rgba(255, 255, 255, 0.84)');
  bezel.addColorStop(0.3, 'rgba(180, 225, 255, 0.28)');
  bezel.addColorStop(0.62, 'rgba(70, 110, 150, 0.12)');
  bezel.addColorStop(1, 'rgba(255, 255, 255, 0.44)');
  cache.bezel = bezel;

  if (typeof ctx.createConicGradient === 'function') {
    const arc = 46 * DEG2RAD;
    const sweep = ctx.createConicGradient(-arc, 0, 0);
    const frac = arc / (Math.PI * 2);
    sweep.addColorStop(0, 'rgba(34, 211, 238, 0)');
    sweep.addColorStop(frac * 0.7, 'rgba(34, 211, 238, 0.045)');
    sweep.addColorStop(frac, 'rgba(34, 211, 238, 0.16)');
    sweep.addColorStop(Math.min(1, frac + 0.002), 'rgba(34, 211, 238, 0)');
    sweep.addColorStop(1, 'rgba(34, 211, 238, 0)');
    cache.sweep = sweep;
  } else {
    cache.sweep = null;
  }

  // Twilight glow in a local frame whose +X axis points at the sun azimuth on the bezel.
  const glow = ctx.createRadialGradient(R, 0, 0, R, 0, R * 0.62);
  glow.addColorStop(0, 'rgba(255, 176, 96, 0.5)');
  glow.addColorStop(0.45, 'rgba(236, 110, 140, 0.2)');
  glow.addColorStop(1, 'rgba(120, 80, 200, 0)');
  cache.glow = glow;
  return cache;
}

function drawVault(
  ctx: CanvasRenderingContext2D,
  m: CanvasMetrics,
  zoom: SkyDomeZoomMode,
  cache: VaultCache,
  sweepEnabled: boolean,
  sweepAzDeg: number,
  pulseWaveStartMs: number | null,
  nowMs: number,
  twilightK: number,
  sunAzDeg: number,
  rotationDeg: number,
  isPipFrame: boolean
): void {
  const { cx, cy, outerRadius: R, width, height } = m;
  const minDim = Math.min(width, height);
  const isPipGrid = isPipFrame;
  const compact = minDim < 360;
  const minEl = minElevationFor(zoom);
  ensureVaultCache(ctx, m, zoom, cache);

  ctx.globalAlpha = 1;

  // Translucent spherical vault glass only inside the aperture (outside pixels stay 100% transparent)
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = cache.vault as CanvasGradient;
  ctx.fill();

  // Directional twilight glow along the bezel
  if (twilightK > 0.01) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R + 6, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate((sunAzDeg - rotationDeg - 90) * DEG2RAD);
    ctx.globalAlpha = Math.min(1, twilightK);
    ctx.fillStyle = cache.glow as CanvasGradient;
    ctx.beginPath();
    ctx.arc(R, 0, R * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Subtle sweep cone (rotated cohesively with dome heading)
  if (sweepEnabled) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate((sweepAzDeg - rotationDeg - 90) * DEG2RAD);
    const arc = 46 * DEG2RAD;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R, -arc, 0);
    ctx.closePath();
    ctx.fillStyle = cache.sweep ?? 'rgba(34, 211, 238, 0.05)';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(R, 0);
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.62)';
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.restore();
  }

  // Manual sweep pulse wave
  if (pulseWaveStartMs !== null) {
    const elapsed = nowMs - pulseWaveStartMs;
    if (elapsed >= 0 && elapsed < PULSE_WAVE_DURATION_MS) {
      const progress = elapsed / PULSE_WAVE_DURATION_MS;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, progress * R, 0, Math.PI * 2);
      ctx.globalAlpha = (1 - progress) * 0.78;
      ctx.strokeStyle = '#22D3EE';
      ctx.lineWidth = 2.2 * (1 - progress * 0.5);
      ctx.stroke();
      ctx.restore();
    }
  }

  ctx.globalAlpha = 1;

  // 15° spokes, fading out toward center above 70° elevation
  const spokeInnerR = elevationToVaultNormR(70, zoom) * R;
  const SPOKE_SEGS = 4;
  for (let s = 0; s < SPOKE_SEGS; s += 1) {
    const r0 = spokeInnerR + ((R - spokeInnerR) * s) / SPOKE_SEGS;
    const r1 = spokeInnerR + ((R - spokeInnerR) * (s + 1)) / SPOKE_SEGS;
    const fade = (s + 1) / SPOKE_SEGS;
    ctx.beginPath();
    for (let az = 0; az < 360; az += 15) {
      const th = (az - rotationDeg - 90) * DEG2RAD;
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      ctx.moveTo(cx + r0 * cs, cy + r0 * sn);
      ctx.lineTo(cx + r1 * cs, cy + r1 * sn);
    }
    ctx.strokeStyle = `rgba(120, 190, 255, ${(0.24 * fade * fade).toFixed(3)})`;
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }

  // Recessed elevation rings (100% opaque foreground contrast)
  const rings = zoom === 'zenith' ? [75, 60, 45] : [60, 30];
  ctx.beginPath();
  for (let i = 0; i < rings.length; i += 1) {
    const r = elevationToVaultNormR(rings[i], zoom) * R + 0.8;
    ctx.moveTo(cx + r, cy);
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.58)';
  ctx.lineWidth = 1.05;
  ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < rings.length; i += 1) {
    const r = elevationToVaultNormR(rings[i], zoom) * R;
    ctx.moveTo(cx + r, cy);
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }
  ctx.strokeStyle = 'rgba(120, 190, 255, 0.30)';
  ctx.lineWidth = 0.9;
  ctx.stroke();

  // Bezel: dark seat, limb ring, 1px specular glass edge
  ctx.beginPath();
  ctx.arc(cx, cy, R + 1.5, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(2, 5, 10, 0.92)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(34, 211, 238, 0.62)';
  ctx.lineWidth = 1.3;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, R + 0.5, 0, Math.PI * 2);
  ctx.strokeStyle = cache.bezel as CanvasGradient;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Exterior 15° ticks (5° minors outside PIP), rotated cohesively with dome heading
  ctx.beginPath();
  for (let az = 0; az < 360; az += 5) {
    const major = az % 15 === 0;
    if (!major) continue;
    const th = (az - rotationDeg - 90) * DEG2RAD;
    const cs = Math.cos(th);
    const sn = Math.sin(th);
    ctx.moveTo(cx + (R + 3) * cs, cy + (R + 3) * sn);
    ctx.lineTo(cx + (R + 7) * cs, cy + (R + 7) * sn);
  }
  ctx.strokeStyle = 'rgba(34, 211, 238, 0.65)';
  ctx.lineWidth = 1.05;
  ctx.stroke();
  if (!isPipGrid) {
    ctx.beginPath();
    for (let az = 0; az < 360; az += 5) {
      if (az % 15 === 0) continue;
      const th = (az - rotationDeg - 90) * DEG2RAD;
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      ctx.moveTo(cx + (R + 3) * cs, cy + (R + 3) * sn);
      ctx.lineTo(cx + (R + 5) * cs, cy + (R + 5) * sn);
    }
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.32)';
    ctx.lineWidth = 0.7;
    ctx.stroke();
  }

  // Fixed 12-o'clock heading lubber triangle tick on outer bezel
  ctx.save();
  ctx.globalAlpha = 1;
  const lubberHalfW = isPipGrid ? 3.8 : compact ? 4.4 : 5.0;
  const lubberTipY = cy - R + 1.5;
  const lubberBaseY = cy - R - (isPipGrid ? 5.2 : 6.4);
  ctx.beginPath();
  ctx.moveTo(cx, lubberTipY);
  ctx.lineTo(cx - lubberHalfW, lubberBaseY);
  ctx.lineTo(cx + lubberHalfW, lubberBaseY);
  ctx.closePath();
  ctx.fillStyle = '#38BDF8';
  ctx.fill();
  ctx.strokeStyle = 'rgba(4, 8, 16, 0.92)';
  ctx.lineWidth = 1.1;
  ctx.stroke();
  ctx.restore();

  // Center overhead crosshair
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.65)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - 5, cy);
  ctx.lineTo(cx + 5, cy);
  ctx.moveTo(cx, cy - 5);
  ctx.lineTo(cx, cy + 5);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 1.8, 0, Math.PI * 2);
  ctx.fillStyle = '#38BDF8';
  ctx.fill();

  // Elevation ring annotations at fixed top-right-of-center angle (always upright)
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.font = `600 ${isPipGrid ? 8 : compact ? 8.5 : 9.5}px ${MONO_FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const labelTheta = (-90 + 12) * DEG2RAD;
  const lcs = Math.cos(labelTheta);
  const lsn = Math.sin(labelTheta);
  const ringLabelEls = zoom === 'zenith' ? [75, 60, 45, 30] : [60, 30, 0];
  for (let i = 0; i < ringLabelEls.length; i += 1) {
    const el = ringLabelEls[i];
    const r = elevationToVaultNormR(el, zoom) * R;
    const lx = cx + r * lcs;
    const ly = cy + r * lsn;
    ctx.fillStyle = 'rgba(6, 11, 20, 0.86)';
    ctx.fillRect(lx - 2, ly - 5, isPipGrid ? 16 : 20, 10);
    ctx.fillStyle = el === minEl ? 'rgba(34, 211, 238, 0.96)' : 'rgba(203, 213, 225, 0.88)';
    ctx.fillText(`${el}°`, lx, ly);
  }
  ctx.restore();

  // N/E/S/W badges and intercardinal captions outside the bezel (orbit with rotationDeg, text upright)
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const badgeR = isPipGrid ? 6.5 : compact ? 8 : 9;
  for (let i = 0; i < COMPASS_BEACONS.length; i += 1) {
    const beacon = COMPASS_BEACONS[i];
    if (isPipGrid && !beacon.cardinal) continue;
    const th = (beacon.azDeg - rotationDeg - 90) * DEG2RAD;
    if (beacon.cardinal) {
      const dist = R + 8 + badgeR;
      const bx = cx + dist * Math.cos(th);
      const by = cy + dist * Math.sin(th);
      ctx.beginPath();
      ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(7, 12, 22, 0.95)';
      ctx.fill();
      ctx.strokeStyle =
        beacon.azDeg === 0 ? 'rgba(34, 211, 238, 0.92)' : 'rgba(148, 163, 184, 0.58)';
      ctx.lineWidth = 1.1;
      ctx.stroke();
      ctx.font = `700 ${isPipGrid ? 8 : compact ? 9.5 : 11}px ${MONO_FONT}`;
      ctx.fillStyle = beacon.azDeg === 0 ? '#22D3EE' : '#E2E8F0';
      ctx.fillText(beacon.label, bx, by + 0.5);
    } else {
      const dist = R + 13;
      ctx.font = `600 ${compact ? 8 : 9}px ${MONO_FONT}`;
      ctx.fillStyle = '#94A3B8';
      ctx.fillText(beacon.label, cx + dist * Math.cos(th), cy + dist * Math.sin(th));
    }
  }
  ctx.restore();
}

function formatCompactDomeAltitude(entity: SkyEntity, units: UnitSystem): string {
  if (!Number.isFinite(entity.altM)) return '';
  if (entity.category === 'satellite') {
    return `${Math.round(entity.altM / 1000)} km`;
  }
  const formatted = formatAltitude(entity.altM, units);
  return formatted === '---' ? '' : formatted;
}

const DEFAULT_CURSOR_READOUT = 'AZ ---.-° · EL --.-° · RNG ---';

function findNearestHitInList(
  pool: HitPool,
  px: number,
  py: number,
  radiusPx: number
): string | null {
  let bestId: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let i = 0; i < pool.count; i += 1) {
    const hit = pool.items[i];
    const dist = Math.hypot(px - hit.x, py - hit.y);
    if (dist <= radiusPx) {
      const score = dist - hit.priority * 0.025;
      if (score < bestScore) {
        bestScore = score;
        bestId = hit.id;
      }
    }
  }
  return bestId;
}

function formatReadoutAngles(azDeg: number, elDeg: number): { azStr: string; elStr: string } {
  const az = normalizeAzimuthDeg(azDeg);
  const azRounded = Number(az.toFixed(1)) >= 360 ? 0 : az;
  const azStr = azRounded.toFixed(1).padStart(5, '0');
  const clampedEl = Math.max(-90, Math.min(90, elDeg));
  const cleanEl = Math.abs(clampedEl) < 0.05 ? 0 : clampedEl;
  const elSign = cleanEl >= 0 ? '+' : '';
  const elStr = `${elSign}${cleanEl.toFixed(1)}°`;
  return { azStr, elStr };
}

function formatCursorReadoutText(
  px: number,
  py: number,
  metrics: CanvasMetrics,
  hitId: string | null,
  units: UnitSystem,
  zoom: SkyDomeZoomMode,
  rotationDeg = 0
): string {
  if (hitId) {
    const entity = liveKinematicsRegistry.entities.get(hitId);
    if (entity) {
      const { azStr, elStr } = formatReadoutAngles(
        entity.topocentric.azimuthDeg,
        entity.topocentric.elevationDeg
      );
      const rngStr = formatDistance(entity.topocentric.slantRangeKm, units);
      return `AZ ${azStr}° · EL ${elStr} · RNG ${rngStr}`;
    }
  }

  if (metrics.outerRadius <= 0) {
    return DEFAULT_CURSOR_READOUT;
  }

  const un = unprojectFromSkyDome(
    px,
    py,
    metrics.cx,
    metrics.cy,
    metrics.outerRadius,
    zoom,
    rotationDeg
  );
  if (un.inBounds) {
    const { azStr, elStr } = formatReadoutAngles(un.azimuthDeg, un.elevationDeg);
    return `AZ ${azStr}° · EL ${elStr} · RNG ---`;
  }

  return DEFAULT_CURSOR_READOUT;
}

/* Module-level scratch buffers (zero per-frame allocation). */
const SC_X = new Float64Array(24);
const SC_Y = new Float64Array(24);
const SC_V = new Uint8Array(24);

function projectForwardPoint(
  entity: SkyEntity,
  observer: { lat: number; lon: number; altM: number },
  dtSec: number,
  idx: number,
  cx: number,
  cy: number,
  R: number,
  zoom: SkyDomeZoomMode,
  minEl: number,
  rotationDeg = 0
): void {
  const ext = extrapolateDeadReckoning(
    entity.lat,
    entity.lon,
    entity.speedMs,
    entity.headingDeg,
    dtSec,
    entity.altM,
    Number.isFinite(entity.vertRateMs) ? (entity.vertRateMs as number) : 0
  );
  const look = computeTopocentricLookAngles(observer, ext, false);
  const p = projectToSkyDome(look.azimuthDeg, look.elevationDeg, cx, cy, R, zoom, rotationDeg);
  SC_X[idx] = p.x;
  SC_Y[idx] = p.y;
  SC_V[idx] = p.visible && look.elevationDeg >= minEl ? 1 : 0;
}

function drawTaperedWake(
  ctx: CanvasRenderingContext2D,
  n: number,
  color: string,
  baseAlpha: number,
  maxJump: number
): void {
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  const denom = Math.max(1, n - 1);
  for (let i = 1; i < n; i += 1) {
    if (!SC_V[i - 1] || !SC_V[i]) continue;
    if (Math.hypot(SC_X[i] - SC_X[i - 1], SC_Y[i] - SC_Y[i - 1]) > maxJump) continue;
    const t = i / denom;
    ctx.globalAlpha = baseAlpha * (0.1 + 0.62 * t);
    ctx.lineWidth = 0.6 + 1.5 * t;
    ctx.beginPath();
    ctx.moveTo(SC_X[i - 1], SC_Y[i - 1]);
    ctx.lineTo(SC_X[i], SC_Y[i]);
    ctx.stroke();
  }
}

function drawScratchArc(
  ctx: CanvasRenderingContext2D,
  n: number,
  color: string,
  alpha: number,
  dash: number[] | null
): void {
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < n; i += 1) {
    if (!SC_V[i]) {
      pen = false;
      continue;
    }
    if (!pen) {
      ctx.moveTo(SC_X[i], SC_Y[i]);
      pen = true;
    } else {
      ctx.lineTo(SC_X[i], SC_Y[i]);
    }
  }
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.1;
  if (dash) ctx.setLineDash(dash);
  ctx.stroke();
  if (dash) ctx.setLineDash([]);
}

function createVisItem(entity: SkyEntity): VisItem {
  return {
    entity,
    azDeg: 0,
    elDeg: 0,
    x: 0,
    y: 0,
    color: '',
    priority: 0,
    isSelected: false,
    isHovered: false,
    isEmergency: false,
    isBreach: false,
    fade: 1,
  };
}

function comparePriority(a: VisItem, b: VisItem): number {
  return a.priority - b.priority;
}

export function PolarSkyDome({ className }: PolarSkyDomeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cursorReadoutRef = useRef<HTMLSpanElement | null>(null);

  const metricsRef = useRef<CanvasMetrics>({
    width: 0,
    height: 0,
    dpr: 1,
    cx: 0,
    cy: 0,
    outerRadius: 100,
  });

  const renderedHitsRef = useRef<HitPool>({ items: [], count: 0 });
  const zoomRef = useRef<SkyDomeZoomMode>('hemisphere');
  const polarTrailsRef = useRef<Map<string, PolarPoint[]>>(new Map());
  const lastTrailSampleRef = useRef<Map<string, number>>(new Map());
  const lastObserverKeyRef = useRef<string>('');
  const pointerInsideRef = useRef<boolean>(false);
  const lastPointerRef = useRef<{ px: number; py: number } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    pointerType: string;
    startX: number;
    startY: number;
    lastAngleDeg: number;
    hasValidAngle: boolean;
    moved: boolean;
  } | null>(null);
  const isDraggingRef = useRef<boolean>(false);
  const lastPointerActionMsRef = useRef<number>(-Infinity);
  const compassTargetDegRef = useRef<number | null>(null);
  const compassStatusTimerRef = useRef<number | null>(null);
  const sweepAzRef = useRef<number>(0);
  const lastFrameMsRef = useRef<number>(0);
  const pulseWaveStartRef = useRef<number | null>(null);

  const [isCompact, setIsCompact] = useState(false);
  const [showFullLegend, setShowFullLegend] = useState(true);
  const [compassStatusMsg, setCompassStatusMsg] = useState<string | null>(null);

  const layout = useSkyStore((s) => s.layout);
  const setLayout = useSkyStore((s) => s.setLayout);
  const skyDomePip = useSkyStore((s) => s.skyDomePip);
  const setSkyDomePip = useSkyStore((s) => s.setSkyDomePip);
  const units = useSkyStore((s) => s.units);
  const sweepEnabled = useSkyStore((s) => s.sweepEnabled);
  const setSweepEnabled = useSkyStore((s) => s.setSweepEnabled);
  const domeLabelsEnabled = useSkyStore((s) => s.domeLabelsEnabled);
  const setDomeLabelsEnabled = useSkyStore((s) => s.setDomeLabelsEnabled);
  const orbitalScope = useSkyStore((s) => s.orbitalScope);
  const skyDomeZoom = useSkyStore((s) => s.skyDomeZoom);
  const toggleSkyDomeZoom = useSkyStore((s) => s.toggleSkyDomeZoom);
  const domeRotationDeg = useSkyStore((s) => s.domeRotationDeg);
  const domeRotationLocked = useSkyStore((s) => s.domeRotationLocked);
  const domeCompassActive = useSkyStore((s) => s.domeCompassActive);
  const domeCompassSupported = useSkyStore((s) => s.domeCompassSupported);
  const setDomeRotationDeg = useSkyStore((s) => s.setDomeRotationDeg);
  const toggleDomeRotationLock = useSkyStore((s) => s.toggleDomeRotationLock);
  const setDomeCompassActive = useSkyStore((s) => s.setDomeCompassActive);
  const setDomeCompassSupported = useSkyStore((s) => s.setDomeCompassSupported);
  const resetDomeNorth = useSkyStore((s) => s.resetDomeNorth);
  const sweepPulseCounter = useSkyStore((s) => s.sweepPulseCounter);

  const isPip = layout === 'map' && skyDomePip;
  const isPipRef = useRef<boolean>(isPip);
  isPipRef.current = isPip;

  const unitsRef = useRef<UnitSystem>(units);
  unitsRef.current = units;

  const prevPulseCounterRef = useRef<number>(sweepPulseCounter);

  const showCompassStatus = useCallback((msg: string) => {
    setCompassStatusMsg(msg);
    if (compassStatusTimerRef.current !== null) {
      window.clearTimeout(compassStatusTimerRef.current);
    }
    compassStatusTimerRef.current = window.setTimeout(() => {
      compassStatusTimerRef.current = null;
      setCompassStatusMsg(null);
    }, COMPASS_STATUS_DURATION_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (compassStatusTimerRef.current !== null) {
        window.clearTimeout(compassStatusTimerRef.current);
        compassStatusTimerRef.current = null;
      }
    };
  }, []);

  const updateCanvasSize = useCallback((width: number, height: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (width <= 0 || height <= 0) {
      metricsRef.current = { ...metricsRef.current, width: 0, height: 0 };
      return;
    }
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const targetW = Math.round(width * dpr);
    const targetH = Math.round(height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const minDim = Math.min(width, height);
    const padding = isPipRef.current ? 24 : Math.max(32, Math.min(48, minDim * 0.1));
    const outerRadius = Math.max(36, minDim / 2 - padding);
    metricsRef.current = {
      width,
      height,
      dpr,
      cx: width / 2,
      cy: height / 2,
      outerRadius,
    };
    setIsCompact(minDim < 360 || width < 420);
    setShowFullLegend(width >= 680);
  }, []);

  useEffect(() => {
    if (sweepPulseCounter > prevPulseCounterRef.current) {
      prevPulseCounterRef.current = sweepPulseCounter;
      pulseWaveStartRef.current = performance.now();
    } else {
      prevPulseCounterRef.current = sweepPulseCounter;
    }
  }, [sweepPulseCounter]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const syncLayoutSize = () => {
      const rect = container.getBoundingClientRect();
      updateCanvasSize(rect.width, rect.height);
    };
    syncLayoutSize();
    const rafId = requestAnimationFrame(syncLayoutSize);
    return () => cancelAnimationFrame(rafId);
  }, [layout, skyDomePip, updateCanvasSize]);

  useEffect(() => {
    if (layout === 'map' && !skyDomePip && pointerInsideRef.current) {
      pointerInsideRef.current = false;
      lastPointerRef.current = null;
      dragRef.current = null;
      isDraggingRef.current = false;
      if (cursorReadoutRef.current) {
        cursorReadoutRef.current.textContent = DEFAULT_CURSOR_READOUT;
      }
      const st = useSkyStore.getState();
      if (st.hoveredId !== null) {
        st.setHoveredId(null);
      }
    }
  }, [layout, skyDomePip]);

  // Hardware DeviceOrientation compass sensor subscription & probe timeout
  useEffect(() => {
    if (!domeCompassActive) {
      compassTargetDegRef.current = null;
      return;
    }
    if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) {
      useSkyStore.getState().setDomeCompassSupported(false);
      useSkyStore.getState().setDomeCompassActive(false);
      showCompassStatus('No device compass detected — drag dome to rotate');
      return;
    }

    let receivedValidReading = false;
    let seenAbsoluteEvent = false;
    let probeTimer: number | null = window.setTimeout(() => {
      probeTimer = null;
      if (!receivedValidReading) {
        useSkyStore.getState().setDomeCompassSupported(false);
        useSkyStore.getState().setDomeCompassActive(false);
        showCompassStatus('No device compass detected — drag dome to rotate');
      }
    }, COMPASS_PROBE_TIMEOUT_MS);

    const handleDeviceOrientation = (ev: Event) => {
      const orientationEv = ev as DeviceOrientationEvent & { webkitCompassHeading?: number };
      if (ev.type === 'deviceorientationabsolute') {
        seenAbsoluteEvent = true;
      } else if (seenAbsoluteEvent && typeof orientationEv.webkitCompassHeading !== 'number') {
        return;
      }
      const heading = extractCompassHeadingDeg(orientationEv);
      if (heading === null) return;
      receivedValidReading = true;
      compassTargetDegRef.current = heading;
      if (probeTimer !== null) {
        window.clearTimeout(probeTimer);
        probeTimer = null;
      }
      const st = useSkyStore.getState();
      if (st.domeCompassSupported !== true) {
        st.setDomeCompassSupported(true);
      }
    };

    window.addEventListener('deviceorientationabsolute', handleDeviceOrientation);
    window.addEventListener('deviceorientation', handleDeviceOrientation);

    return () => {
      if (probeTimer !== null) {
        window.clearTimeout(probeTimer);
      }
      window.removeEventListener('deviceorientationabsolute', handleDeviceOrientation);
      window.removeEventListener('deviceorientation', handleDeviceOrientation);
      compassTargetDegRef.current = null;
    };
  }, [domeCompassActive, showCompassStatus]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    canvas.style.cursor = resolveCanvasCursor(
      null,
      useSkyStore.getState().domeRotationLocked,
      false
    );

    const initialRect = container.getBoundingClientRect();
    updateCanvasSize(initialRect.width, initialRect.height);

    let observerRO: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observerRO = new ResizeObserver((entries) => {
        for (const entry of entries) {
          updateCanvasSize(entry.contentRect.width, entry.contentRect.height);
        }
      });
      observerRO.observe(container);
    }

    const onWinResize = () => {
      const rect = container.getBoundingClientRect();
      updateCanvasSize(rect.width, rect.height);
    };
    window.addEventListener('resize', onWinResize);

    let rafId = 0;

    // Persistent per-effect scratch state (zero per-frame allocation)
    const vaultCache: VaultCache = { key: '', vault: null, bezel: null, sweep: null, glow: null };
    const celestial: CelestialCache = { key: '', ts: -Infinity, pos: null };
    const tcaCache = new Map<string, TcaCacheEntry>();
    const visPool: VisItem[] = [];
    const sorted: VisItem[] = [];
    const activeIds = new Set<string>();
    const candPool: DomeLabelCandidate[] = [];
    const placedPool: PlacedDomeLabel[] = [];
    const labelOrder: number[] = [];
    let candCount = 0;
    let visCount = 0;
    let stateRef: ReturnType<typeof useSkyStore.getState> | null = null;
    let frameNowMs = 0;
    let frameEpochMs = 0;
    let frameZoom: SkyDomeZoomMode = 'hemisphere';
    let frameMinEl = 0;
    let frameRotationDeg = 0;
    let frameMetrics: CanvasMetrics = metricsRef.current;

    const collectEntity = (entity: SkyEntity): void => {
      const state = stateRef as ReturnType<typeof useSkyStore.getState>;
      if (!state.layers[entity.category]) return;
      if (entity.category === 'satellite' && !state.satGroups[entity.group]) return;
      const { azimuthDeg: azDeg, elevationDeg: elDeg } = entity.topocentric;
      if (!Number.isFinite(azDeg) || !Number.isFinite(elDeg) || elDeg < frameMinEl) return;
      const p = projectToSkyDome(
        azDeg,
        elDeg,
        frameMetrics.cx,
        frameMetrics.cy,
        frameMetrics.outerRadius,
        frameZoom,
        frameRotationDeg
      );
      if (!p.visible) return;

      activeIds.add(entity.id);
      const isSelected = entity.id === state.selectedId;
      const isHovered = entity.id === state.hoveredId;

      if (entity.trail.length === 0) {
        const lastSample = lastTrailSampleRef.current.get(entity.id) ?? -Infinity;
        if (frameNowMs - lastSample >= TRAIL_SAMPLE_INTERVAL_MS) {
          lastTrailSampleRef.current.set(entity.id, frameNowMs);
          let pts = polarTrailsRef.current.get(entity.id);
          if (!pts) {
            pts = [];
            polarTrailsRef.current.set(entity.id, pts);
          }
          let rec: PolarPoint | undefined;
          if (pts.length >= MAX_TRAIL_SAMPLES) rec = pts.shift();
          if (!rec) rec = { azDeg: 0, elDeg: 0, ts: 0 };
          rec.azDeg = azDeg;
          rec.elDeg = elDeg;
          rec.ts = frameNowMs;
          pts.push(rec);
          const maxAge =
            entity.category === 'balloon' ? MAX_BALLOON_TRAIL_AGE_MS : MAX_FLIGHT_TRAIL_AGE_MS;
          while (pts.length > 0 && frameNowMs - pts[0].ts > maxAge) pts.shift();
        }
      } else {
        polarTrailsRef.current.delete(entity.id);
        lastTrailSampleRef.current.delete(entity.id);
      }

      let item = visPool[visCount];
      if (!item) {
        item = createVisItem(entity);
        visPool[visCount] = item;
      }
      visCount += 1;
      item.entity = entity;
      item.azDeg = azDeg;
      item.elDeg = elDeg;
      item.x = p.x;
      item.y = p.y;
      item.color = getEntityColor(entity);
      item.isSelected = isSelected;
      item.isHovered = isHovered;
      item.isEmergency = Boolean(entity.emergencyFlag);
      item.isBreach =
        entity.category === 'drone' && Boolean(entity.ceilingBreach || entity.tfrBreach);
      item.priority = getEntityPriority(entity, isSelected, isHovered);
      item.fade = limbFade(elDeg, frameMinEl);
    };

    const renderFrame = (nowMs: number) => {
      rafId = requestAnimationFrame(renderFrame);

      if (typeof document !== 'undefined' && document.hidden) {
        lastFrameMsRef.current = nowMs;
        return;
      }

      const metrics = metricsRef.current;
      if (metrics.width <= 0 || metrics.height <= 0) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dtMs = lastFrameMsRef.current > 0 ? Math.min(100, nowMs - lastFrameMsRef.current) : 16.67;
      lastFrameMsRef.current = nowMs;

      const state = useSkyStore.getState();
      if (state.layout === 'map' && !state.skyDomePip) return;

      const currentDpr = Math.max(1, window.devicePixelRatio || 1);
      if (metrics.dpr !== currentDpr) {
        const targetW = Math.round(metrics.width * currentDpr);
        const targetH = Math.round(metrics.height * currentDpr);
        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }
        metrics.dpr = currentDpr;
      }

      if (state.sweepEnabled) {
        sweepAzRef.current = (sweepAzRef.current + dtMs * SWEEP_DEG_PER_MS) % 360;
      }

      // Wrap-safe 60fps angular smoothing when hardware compass is active, unlocked, and not dragging
      let rotationDeg = state.domeRotationDeg;
      if (
        state.domeCompassActive &&
        !state.domeRotationLocked &&
        !isDraggingRef.current &&
        compassTargetDegRef.current !== null
      ) {
        const targetDeg = compassTargetDegRef.current;
        if (Math.abs(shortestAngleDeltaDeg(rotationDeg, targetDeg)) >= 0.02) {
          rotationDeg = smoothCompassHeadingDeg(rotationDeg, targetDeg, COMPASS_SMOOTH_ALPHA);
          state.setDomeRotationDeg(rotationDeg);
        }
      }

      const zoom: SkyDomeZoomMode = state.skyDomeZoom === 'zenith' ? 'zenith' : 'hemisphere';
      const minEl = minElevationFor(zoom);
      zoomRef.current = zoom;
      stateRef = state;
      frameNowMs = nowMs;
      frameEpochMs = Date.now();
      frameZoom = zoom;
      frameMinEl = minEl;
      frameRotationDeg = rotationDeg;
      frameMetrics = metrics;
      const { cx, cy, outerRadius: R } = metrics;
      const observer = state.observer;
      const isPipFrame = state.layout === 'map' && state.skyDomePip;

      const obsKey = `${observer.lat.toFixed(4)},${observer.lon.toFixed(4)}`;
      if (obsKey !== lastObserverKeyRef.current) {
        lastObserverKeyRef.current = obsKey;
        polarTrailsRef.current.clear();
        lastTrailSampleRef.current.clear();
        tcaCache.clear();
        celestial.key = '';
      }

      if (pulseWaveStartMsExpired(pulseWaveStartRef.current, nowMs)) {
        pulseWaveStartRef.current = null;
      }

      // Celestial positions (throttled)
      if (celestial.key !== obsKey || frameNowMs - celestial.ts >= CELESTIAL_REFRESH_MS) {
        celestial.key = obsKey;
        celestial.ts = frameNowMs;
        celestial.pos =
          observer.source === 'pending' ? null : computeSolarLunarTopocentric(observer, frameEpochMs);
      }
      const cel = celestial.pos;
      let twilightK = 0;
      let sunAz = 0;
      if (cel && cel.sun.elevationDeg >= -12 && cel.sun.elevationDeg <= 20) {
        const se = cel.sun.elevationDeg;
        twilightK = se < 0 ? (se + 12) / 12 : 1 - se / 20;
        sunAz = cel.sun.azimuthDeg;
      }

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
      ctx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);

      drawVault(
        ctx,
        metrics,
        zoom,
        vaultCache,
        state.sweepEnabled,
        sweepAzRef.current,
        pulseWaveStartRef.current,
        nowMs,
        twilightK,
        sunAz,
        rotationDeg,
        isPipFrame
      );

      const labelMode: DomeLabelMode = isPipFrame
        ? 'pip'
        : state.layout === 'split'
        ? 'split'
        : 'dome';

      // Collect visible entities (strict culling below minEl)
      activeIds.clear();
      visCount = 0;
      liveKinematicsRegistry.entities.forEach(collectEntity);

      for (const key of polarTrailsRef.current.keys()) {
        if (!activeIds.has(key)) polarTrailsRef.current.delete(key);
      }
      for (const key of lastTrailSampleRef.current.keys()) {
        if (!activeIds.has(key)) lastTrailSampleRef.current.delete(key);
      }

      sorted.length = 0;
      for (let i = 0; i < visCount; i += 1) sorted.push(visPool[i]);
      sorted.sort(comparePriority);

      const hitPool = renderedHitsRef.current;
      hitPool.count = 0;
      const maxTrailJumpPx = R * MAX_TRAIL_SEGMENT_RATIO;

      // Everything below is hard-clipped to the aperture
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.clip();

      // Celestial markers
      if (cel) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (cel.sun.elevationDeg >= minEl) {
          const sp = projectToSkyDome(
            cel.sun.azimuthDeg,
            cel.sun.elevationDeg,
            cx,
            cy,
            R,
            zoom,
            rotationDeg
          );
          ctx.globalAlpha = 0.5 + 0.5 * limbFade(cel.sun.elevationDeg, minEl);
          ctx.font = `600 14px ${MONO_FONT}`;
          ctx.fillStyle = '#FBBF24';
          ctx.fillText('☀', sp.x, sp.y);
          if (!isPipFrame) {
            ctx.font = `600 7px ${MONO_FONT}`;
            ctx.fillStyle = 'rgba(251, 191, 36, 0.85)';
            ctx.fillText('SUN', sp.x, sp.y + 11);
          }
        }
        if (cel.moon.elevationDeg >= minEl) {
          const mp = projectToSkyDome(
            cel.moon.azimuthDeg,
            cel.moon.elevationDeg,
            cx,
            cy,
            R,
            zoom,
            rotationDeg
          );
          const illum = Number.isFinite(cel.moon.illuminationFraction)
            ? cel.moon.illuminationFraction
            : 0.5;
          ctx.globalAlpha = (0.4 + 0.6 * illum) * (0.5 + 0.5 * limbFade(cel.moon.elevationDeg, minEl));
          ctx.font = `600 13px ${MONO_FONT}`;
          ctx.fillStyle = '#E2E8F0';
          ctx.fillText('☾', mp.x, mp.y);
          if (!isPipFrame) {
            ctx.font = `600 7px ${MONO_FONT}`;
            ctx.fillStyle = 'rgba(226, 232, 240, 0.8)';
            ctx.fillText('MOON', mp.x, mp.y + 11);
          }
        }
        ctx.globalAlpha = 1;
      }

      // Selected satellite pass arc
      if (state.layers.satellite && liveKinematicsRegistry.orbitOverlay) {
        drawOrbitPassArc(
          ctx,
          liveKinematicsRegistry.orbitOverlay,
          state.selectedId,
          cx,
          cy,
          R,
          zoom,
          rotationDeg
        );
      }

      let peakMarkerX = NaN;
      let peakMarkerY = NaN;
      let peakMarkerEl = 0;

      for (let si = 0; si < sorted.length; si += 1) {
        const item = sorted[si];
        const entity = item.entity;
        const { azDeg, elDeg, x, y, color, isSelected, isHovered, isEmergency, isBreach } = item;
        const focused = isSelected || isHovered;
        const sinEl = Math.max(0, Math.sin(elDeg * DEG2RAD));

        const depth = atmosphericDepth(elDeg);
        const baseAlpha =
          (focused ? item.fade : item.fade * depth) *
          (entity.category === 'satellite' && !entity.sunlit && !focused ? 0.8 : 1.0);
        if (baseAlpha <= 0.003) continue;

        ctx.save();
        ctx.globalAlpha = baseAlpha;

        // Curved wake
        const maxTrailAgeMs =
          entity.category === 'balloon' ? MAX_BALLOON_TRAIL_AGE_MS : MAX_FLIGHT_TRAIL_AGE_MS;
        let wakeN = 0;
        if (entity.trail.length > 0) {
          const start = Math.max(0, entity.trail.length - MAX_TRAIL_SAMPLES);
          for (let ti = start; ti < entity.trail.length; ti += 1) {
            const tp = entity.trail[ti];
            if (!Number.isFinite(tp.ts) || frameEpochMs - tp.ts > maxTrailAgeMs) continue;
            const look = computeTopocentricLookAngles(
              observer,
              { lat: tp.lat, lon: tp.lon, altM: tp.altM },
              false
            );
            const pp = projectToSkyDome(
              look.azimuthDeg,
              look.elevationDeg,
              cx,
              cy,
              R,
              zoom,
              rotationDeg
            );
            SC_X[wakeN] = pp.x;
            SC_Y[wakeN] = pp.y;
            SC_V[wakeN] = pp.visible && look.elevationDeg >= minEl ? 1 : 0;
            wakeN += 1;
          }
        } else {
          const cached = polarTrailsRef.current.get(entity.id);
          if (cached) {
            for (let ti = 0; ti < cached.length && wakeN < MAX_TRAIL_SAMPLES; ti += 1) {
              const pt = cached[ti];
              if (frameNowMs - pt.ts > maxTrailAgeMs || pt.elDeg < minEl) continue;
              const pp = projectToSkyDome(pt.azDeg, pt.elDeg, cx, cy, R, zoom, rotationDeg);
              SC_X[wakeN] = pp.x;
              SC_Y[wakeN] = pp.y;
              SC_V[wakeN] = pp.visible ? 1 : 0;
              wakeN += 1;
            }
          }
        }
        if (wakeN > 0) {
          SC_X[wakeN] = x;
          SC_Y[wakeN] = y;
          SC_V[wakeN] = 1;
          wakeN += 1;
          if (wakeN > 1) drawTaperedWake(ctx, wakeN, color, baseAlpha, maxTrailJumpPx);
          ctx.globalAlpha = baseAlpha;
        }

        // 60s forward arc for moving airborne targets
        const movingAirborne =
          entity.category !== 'satellite' &&
          entity.speedMs > 2 &&
          entity.headingValid !== false &&
          Number.isFinite(entity.headingDeg);
        if (movingAirborne) {
          for (let k = 0; k < FORWARD_ARC_DTS.length; k += 1) {
            if (k === 0) {
              SC_X[0] = x;
              SC_Y[0] = y;
              SC_V[0] = 1;
            } else {
              projectForwardPoint(
                entity,
                observer,
                FORWARD_ARC_DTS[k],
                k,
                cx,
                cy,
                R,
                zoom,
                minEl,
                rotationDeg
              );
            }
          }
          drawScratchArc(ctx, FORWARD_ARC_DTS.length, color, baseAlpha * 0.48, [2, 3]);
          ctx.globalAlpha = baseAlpha;

          // Closest-approach extension for focused targets
          if (focused) {
            let tca = tcaCache.get(entity.id);
            if (!tca || frameNowMs - tca.ts >= TCA_REFRESH_MS) {
              const res = computeClosestApproach(observer, entity, 600);
              if (!tca) {
                if (tcaCache.size > 6) tcaCache.clear();
                tca = {
                  ts: 0,
                  isApproaching: false,
                  tcaSeconds: 0,
                  peakAzimuthDeg: 0,
                  peakElevationDeg: 0,
                };
                tcaCache.set(entity.id, tca);
              }
              tca.ts = frameNowMs;
              tca.isApproaching = res.isApproaching;
              tca.tcaSeconds = res.tcaSeconds;
              tca.peakAzimuthDeg = res.peakAzimuthDeg;
              tca.peakElevationDeg = res.peakElevationDeg;
            }
            if (tca.isApproaching && Number.isFinite(tca.tcaSeconds)) {
              const limit = Math.min(tca.tcaSeconds, 300);
              if (limit > 1) {
                SC_X[0] = x;
                SC_Y[0] = y;
                SC_V[0] = 1;
                for (let k = 1; k <= TCA_ARC_STEPS; k += 1) {
                  projectForwardPoint(
                    entity,
                    observer,
                    (limit * k) / TCA_ARC_STEPS,
                    k,
                    cx,
                    cy,
                    R,
                    zoom,
                    minEl,
                    rotationDeg
                  );
                }
                drawScratchArc(ctx, TCA_ARC_STEPS + 1, '#E879F9', baseAlpha * 0.85, [5, 4]);
                ctx.globalAlpha = baseAlpha;
              }
              if (
                isSelected &&
                Number.isFinite(tca.peakElevationDeg) &&
                tca.peakElevationDeg >= minEl
              ) {
                const pk = projectToSkyDome(
                  tca.peakAzimuthDeg,
                  tca.peakElevationDeg,
                  cx,
                  cy,
                  R,
                  zoom,
                  rotationDeg
                );
                if (pk.visible) {
                  peakMarkerX = pk.x;
                  peakMarkerY = pk.y;
                  peakMarkerEl = tca.peakElevationDeg;
                }
              }
            }
          }
        }

        // Sweep afterglow (rotation-aware screen azimuth lag)
        if (state.sweepEnabled) {
          const displaySweepAz = normalizeAzimuthDeg(sweepAzRef.current - rotationDeg);
          const displayEntityAz = normalizeAzimuthDeg(azDeg - rotationDeg);
          const sweepLag = (displaySweepAz - displayEntityAz + 360) % 360;
          if (sweepLag < 24) {
            const boost = 1 - sweepLag / 24;
            ctx.beginPath();
            ctx.arc(x, y, 7 + (1 - boost) * 4, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(34, 211, 238, ${(boost * 0.5).toFixed(3)})`;
            ctx.lineWidth = 1.15;
            ctx.stroke();
          }
        }

        // 3D scaling
        let elScale = 0.55 + 0.8 * Math.pow(sinEl, 0.8);
        const slant = entity.topocentric.slantRangeKm;
        if (Number.isFinite(slant) && slant < 40) {
          elScale += 0.12 * clamp01((40 - Math.max(0, slant)) / 40);
        }
        const radialSquash = 0.56 + 0.44 * Math.pow(sinEl, 0.65);
        const glyphScale =
          elScale *
          (isSelected
            ? 1.22
            : isHovered
            ? 1.15
            : entity.category === 'satellite' && entity.group === 'starlink'
            ? 0.82
            : 1);

        // Soft float shadow / glow for high-elevation targets
        if (elDeg > 45) {
          const k = clamp01((elDeg - 45) / 45);
          ctx.beginPath();
          ctx.ellipse(x + 1.5, y + 5 * glyphScale, 6 * glyphScale, 2.4 * glyphScale, 0, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(0, 0, 0, ${(0.22 + 0.14 * k).toFixed(3)})`;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(x, y, 9 * glyphScale, 0, Math.PI * 2);
          ctx.strokeStyle = color;
          ctx.globalAlpha = baseAlpha * 0.12 * (0.5 + k);
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.globalAlpha = baseAlpha;
        }

        // Tangent-oriented glyph rotated cohesively with dome heading
        let headingAngle = computeSkyDomeTrajectoryTangent(
          observer,
          entity,
          cx,
          cy,
          R,
          zoom,
          rotationDeg
        );
        if (!Number.isFinite(headingAngle)) {
          headingAngle =
            (((Number.isFinite(entity.headingDeg) ? entity.headingDeg : 0) - rotationDeg - 90) *
              Math.PI) /
            180;
        }

        const tickLen =
          entity.headingValid === false
            ? 0
            : entity.category === 'drone' || entity.category === 'balloon'
            ? entity.speedMs > 1
              ? 8.5
              : 0
            : entity.category === 'satellite'
            ? 11.5
            : 10;

        const theta = (azDeg - rotationDeg - 90) * DEG2RAD;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(theta);
        ctx.scale(radialSquash, 1);
        ctx.rotate(-theta);
        if (tickLen > 0) {
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(Math.cos(headingAngle) * tickLen * elScale, Math.sin(headingAngle) * tickLen * elScale);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.25;
          ctx.stroke();
        }
        drawGlyph(ctx, entity, 0, 0, headingAngle, color, glyphScale);
        ctx.restore();

        if (isEmergency || isBreach) {
          const ringR = (8.5 + 3.2 * Math.sin(nowMs * 0.0085)) * Math.min(1.3, elScale);
          ctx.beginPath();
          ctx.arc(x, y, ringR, 0, Math.PI * 2);
          ctx.strokeStyle = isEmergency ? EMERGENCY_COLOR : BREACH_COLOR;
          ctx.lineWidth = 1.35;
          ctx.stroke();
        }

        if (isHovered && !isSelected) {
          ctx.beginPath();
          ctx.arc(x, y, 10.5, 0, Math.PI * 2);
          ctx.strokeStyle = '#E2E8F0';
          ctx.lineWidth = 1.3;
          ctx.stroke();
        }

        if (isSelected) {
          drawTargetLockReticle(ctx, x, y, color, nowMs);
        }

        ctx.restore();

        let hit = hitPool.items[hitPool.count];
        if (!hit) {
          hit = { id: '', x: 0, y: 0, priority: 0 };
          hitPool.items[hitPool.count] = hit;
        }
        hit.id = entity.id;
        hit.x = x;
        hit.y = y;
        hit.priority = item.priority;
        hitPool.count += 1;
      }

      // Predicted peak-elevation marker (crisp, inside the aperture)
      if (Number.isFinite(peakMarkerX)) {
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.translate(peakMarkerX, peakMarkerY);
        ctx.beginPath();
        ctx.moveTo(0, -5);
        ctx.lineTo(4, 0);
        ctx.lineTo(0, 5);
        ctx.lineTo(-4, 0);
        ctx.closePath();
        ctx.fillStyle = '#F5D0FE';
        ctx.fill();
        ctx.strokeStyle = '#E879F9';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }

      ctx.restore(); // aperture clip

      if (Number.isFinite(peakMarkerX)) {
        ctx.save();
        ctx.globalAlpha = 1;
        const text = `◆ MAX EL ${Math.round(peakMarkerEl)}°`;
        ctx.font = `700 9px ${MONO_FONT}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(text).width + 8;
        const px = Math.max(8, Math.min(metrics.width - tw - 8, peakMarkerX + 8));
        const py = Math.max(8, Math.min(metrics.height - 21, peakMarkerY - 18));
        ctx.fillStyle = 'rgba(15, 10, 30, 0.9)';
        ctx.strokeStyle = 'rgba(232, 121, 249, 0.72)';
        ctx.lineWidth = 0.85;
        ctx.beginPath();
        traceRoundedRect(ctx, px, py, tw, 13, 3);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#F5D0FE';
        ctx.fillText(text, px + 4, py + 6.8);
        ctx.restore();
      }

      // Pointer hover resolution & cursor sync
      const activeUnits = state.units ?? unitsRef.current;
      if (pointerInsideRef.current && lastPointerRef.current && !isDraggingRef.current) {
        const pt = lastPointerRef.current;
        const liveHitId = findNearestHitInList(hitPool, pt.px, pt.py, HIT_RADIUS_PX);
        const nextCursor = resolveCanvasCursor(liveHitId, state.domeRotationLocked, false);
        if (canvas.style.cursor !== nextCursor) {
          canvas.style.cursor = nextCursor;
        }
        if (state.hoveredId !== liveHitId) {
          state.setHoveredId(liveHitId);
        }
        const nextText = formatCursorReadoutText(
          pt.px,
          pt.py,
          metrics,
          liveHitId,
          activeUnits,
          zoom,
          rotationDeg
        );
        if (cursorReadoutRef.current && cursorReadoutRef.current.textContent !== nextText) {
          cursorReadoutRef.current.textContent = nextText;
        }
      } else if (!isDraggingRef.current) {
        const idleCursor = resolveCanvasCursor(null, state.domeRotationLocked, false);
        if (canvas.style.cursor !== idleCursor) {
          canvas.style.cursor = idleCursor;
        }
        if (pointerInsideRef.current && state.hoveredId !== null) {
          let present = false;
          for (let i = 0; i < hitPool.count; i += 1) {
            if (hitPool.items[i].id === state.hoveredId) {
              present = true;
              break;
            }
          }
          if (!present) {
            state.setHoveredId(null);
          }
        }
      }

      // Labels: build candidates from highest priority downward, then solve layout
      const compactDome = metrics.width < 420 || metrics.height < 360;
      candCount = 0;
      for (let i = sorted.length - 1; i >= 0 && candCount < 40; i -= 1) {
        const item = sorted[i];
        const mustShow = item.isSelected || item.isHovered;
        if (!mustShow && (isPipFrame || !state.domeLabelsEnabled)) continue;
        if (!mustShow && item.elDeg < (zoom === 'zenith' ? 34 : 8)) continue;
        const isHigh = mustShow || item.isEmergency || item.isBreach || item.priority >= 58;
        const elRounded = Math.round(item.elDeg);
        let text: string;
        if (isPipFrame) {
          text = item.entity.callsign;
        } else if (isHigh) {
          const altStr = formatCompactDomeAltitude(item.entity, activeUnits);
          text = altStr
            ? `${item.entity.callsign} · ${altStr} · ${elRounded}°`
            : `${item.entity.callsign} · ${elRounded}°`;
        } else {
          text = item.entity.callsign;
        }
        ctx.font = mustShow
          ? `700 ${compactDome ? 9.5 : 10}px ${MONO_FONT}`
          : `600 ${compactDome ? 9 : 9.5}px ${MONO_FONT}`;
        let cand = candPool[candCount];
        if (!cand) {
          cand = {
            id: '',
            x: 0,
            y: 0,
            w: 0,
            h: 15,
            elDeg: 0,
            slantRangeKm: 0,
            isSelected: false,
            isHovered: false,
            isEmergency: false,
            isBreach: false,
            text: '',
            color: '',
          };
          candPool[candCount] = cand;
        }
        candCount += 1;
        cand.id = item.entity.id;
        cand.x = item.x;
        cand.y = item.y;
        cand.w = ctx.measureText(text).width + 10;
        cand.h = 15;
        cand.elDeg = item.elDeg;
        cand.slantRangeKm = item.entity.topocentric.slantRangeKm;
        cand.isSelected = item.isSelected;
        cand.isHovered = item.isHovered;
        cand.isEmergency = item.isEmergency;
        cand.isBreach = item.isBreach;
        cand.text = text;
        cand.color = item.color;
      }

      const layoutResult = solveDomeLabelLayout({
        candidates: candPool,
        count: candCount,
        width: metrics.width,
        height: metrics.height,
        cx,
        cy,
        radius: R,
        mode: labelMode,
        zoomMode: zoom,
        labelsEnabled: state.domeLabelsEnabled,
        out: placedPool,
        order: labelOrder,
      });

      ctx.save();
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < layoutResult.count; i += 1) {
        const lb = layoutResult.labels[i];
        const dx = lb.leaderX - lb.anchorX;
        const dy = lb.leaderY - lb.anchorY;
        const len = Math.hypot(dx, dy);
        if (len > 6) {
          const sx = lb.anchorX + (dx / len) * 5;
          const sy = lb.anchorY + (dy / len) * 5;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(lb.leaderX, lb.leaderY);
          ctx.strokeStyle = 'rgba(203, 213, 225, 0.55)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.font = lb.mustShow
          ? `700 ${compactDome ? 9.5 : 10}px ${MONO_FONT}`
          : `600 ${compactDome ? 9 : 9.5}px ${MONO_FONT}`;
        ctx.fillStyle = lb.mustShow ? 'rgba(7, 10, 17, 0.94)' : 'rgba(7, 10, 17, 0.88)';
        ctx.strokeStyle = lb.mustShow ? lb.color : 'rgba(255, 255, 255, 0.18)';
        ctx.lineWidth = lb.mustShow ? 1.15 : 0.8;
        ctx.beginPath();
        traceRoundedRect(ctx, lb.x, lb.y, lb.w, lb.h, 3);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = lb.mustShow ? '#F8FAFC' : '#E2E8F0';
        ctx.fillText(lb.text, lb.x + 5, lb.y + lb.h / 2 + 0.5);
      }
      ctx.restore();
    };

    rafId = requestAnimationFrame(renderFrame);

    return () => {
      cancelAnimationFrame(rafId);
      observerRO?.disconnect();
      window.removeEventListener('resize', onWinResize);
    };
  }, [updateCanvasSize]);

  const findNearestHit = (px: number, py: number, radiusPx = HIT_RADIUS_PX): string | null =>
    findNearestHitInList(renderedHitsRef.current, px, py, radiusPx);

  const getClientCanvasPoint = (
    clientX: number,
    clientY: number
  ): { px: number; py: number; rectW: number; rectH: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      px: clientX - rect.left,
      py: clientY - rect.top,
      rectW: rect.width,
      rectH: rect.height,
    };
  };

  const updateCursorReadout = (px: number, py: number, hitId: string | null) => {
    if (!cursorReadoutRef.current) return;
    const store = useSkyStore.getState();
    const activeUnits = store.units ?? unitsRef.current;
    const nextText = formatCursorReadoutText(
      px,
      py,
      metricsRef.current,
      hitId,
      activeUnits,
      zoomRef.current,
      store.domeRotationDeg
    );
    if (cursorReadoutRef.current.textContent !== nextText) {
      cursorReadoutRef.current.textContent = nextText;
    }
  };

  const handleCompassToggle = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (domeCompassActive) {
      setDomeCompassActive(false);
      setCompassStatusMsg(null);
      return;
    }

    if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) {
      setDomeCompassSupported(false);
      setDomeCompassActive(false);
      showCompassStatus('No device compass detected — drag dome to rotate');
      return;
    }

    const DevOrientCtor = window.DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    if (typeof DevOrientCtor?.requestPermission === 'function') {
      let permPromise: Promise<'granted' | 'denied'>;
      try {
        permPromise = Promise.resolve(DevOrientCtor.requestPermission());
      } catch {
        setDomeCompassActive(false);
        showCompassStatus('Compass permission denied — drag dome to rotate');
        return;
      }
      void permPromise
        .then((permission) => {
          if (permission === 'granted') {
            setDomeCompassSupported(true);
            setDomeCompassActive(true);
            if (useSkyStore.getState().domeRotationLocked) {
              showCompassStatus('Compass active — unlock rotation to follow');
            } else {
              setCompassStatusMsg(null);
            }
          } else {
            setDomeCompassActive(false);
            showCompassStatus('Compass permission denied — drag dome to rotate');
          }
        })
        .catch(() => {
          setDomeCompassActive(false);
          showCompassStatus('Compass permission denied — drag dome to rotate');
        });
      return;
    }

    setDomeCompassActive(true);
    if (useSkyStore.getState().domeRotationLocked) {
      showCompassStatus('Compass active — unlock rotation to follow');
    } else {
      setCompassStatusMsg(null);
    }
  };

  const handlePointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    if (e.isPrimary === false) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const pt = getClientCanvasPoint(e.clientX, e.clientY);
    if (!pt) return;

    const canvas = canvasRef.current;
    try {
      canvas?.setPointerCapture?.(e.pointerId);
    } catch {
      // Ignore synthetic pointer capture failures
    }

    const metrics = metricsRef.current;
    const cx = metrics.width > 0 ? metrics.cx : pt.rectW / 2;
    const cy = metrics.height > 0 ? metrics.cy : pt.rectH / 2;
    const rad = Math.hypot(pt.px - cx, pt.py - cy);
    const hasValidAngle = rad >= DRAG_CENTER_DEADZONE_PX;
    const lastAngleDeg = hasValidAngle
      ? Math.atan2(pt.py - cy, pt.px - cx) * (180 / Math.PI)
      : 0;

    dragRef.current = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      startX: pt.px,
      startY: pt.py,
      lastAngleDeg,
      hasValidAngle,
      moved: false,
    };
    isDraggingRef.current = false;

    if (e.pointerType === 'mouse') {
      pointerInsideRef.current = true;
      lastPointerRef.current = pt;
    } else {
      const hitId = findNearestHit(pt.px, pt.py, TOUCH_HIT_RADIUS_PX);
      updateCursorReadout(pt.px, pt.py, hitId);
    }
  };

  const handlePointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    const pt = getClientCanvasPoint(e.clientX, e.clientY);
    if (!pt) return;

    const store = useSkyStore.getState();
    const canvas = canvasRef.current;
    const drag = dragRef.current;

    if (drag && drag.pointerId === e.pointerId) {
      const distFromStart = Math.hypot(pt.px - drag.startX, pt.py - drag.startY);
      if (!drag.moved && distFromStart >= DRAG_THRESHOLD_PX) {
        drag.moved = true;
        isDraggingRef.current = true;
      }

      if (drag.moved) {
        if (store.domeRotationLocked) {
          // Locked: ignore drag rotation completely
          if (canvas) {
            canvas.style.cursor = 'crosshair';
          }
          updateCursorReadout(pt.px, pt.py, null);
          return;
        }

        if (store.domeCompassActive) {
          store.setDomeCompassActive(false);
        }

        const metrics = metricsRef.current;
        const cx = metrics.width > 0 ? metrics.cx : pt.rectW / 2;
        const cy = metrics.height > 0 ? metrics.cy : pt.rectH / 2;
        const rad = Math.hypot(pt.px - cx, pt.py - cy);
        if (rad >= DRAG_CENTER_DEADZONE_PX) {
          const currAngleDeg =
            Math.atan2(pt.py - cy, pt.px - cx) * (180 / Math.PI);
          if (drag.hasValidAngle) {
            const deltaDeg = shortestAngleDeltaDeg(drag.lastAngleDeg, currAngleDeg);
            if (Math.abs(deltaDeg) > 1e-6) {
              setDomeRotationDeg(useSkyStore.getState().domeRotationDeg - deltaDeg);
            }
          }
          drag.lastAngleDeg = currAngleDeg;
          drag.hasValidAngle = true;
        }

        if (store.hoveredId !== null) {
          store.setHoveredId(null);
        }
        if (canvas) {
          canvas.style.cursor = 'grabbing';
        }
        updateCursorReadout(pt.px, pt.py, null);
        return;
      }
    }

    const hitRadius = e.pointerType === 'mouse' ? HIT_RADIUS_PX : TOUCH_HIT_RADIUS_PX;
    const hitId = findNearestHit(pt.px, pt.py, hitRadius);
    if (e.pointerType === 'mouse') {
      pointerInsideRef.current = true;
      lastPointerRef.current = pt;
      if (store.hoveredId !== hitId) {
        store.setHoveredId(hitId);
      }
    }
    updateCursorReadout(pt.px, pt.py, hitId);

    if (canvas) {
      canvas.style.cursor = resolveCanvasCursor(hitId, store.domeRotationLocked, false);
    }
  };

  const finishPointerGesture = (e: PointerEvent<HTMLCanvasElement>, cancelled: boolean) => {
    e.stopPropagation();
    const canvas = canvasRef.current;
    try {
      if (canvas?.hasPointerCapture?.(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore if pointer capture already released
    }

    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;

    const wasMoved = drag.moved;
    const pointerType = drag.pointerType;
    dragRef.current = null;
    isDraggingRef.current = false;
    lastPointerActionMsRef.current = performance.now();

    const store = useSkyStore.getState();
    const pt = getClientCanvasPoint(e.clientX, e.clientY);
    const hitRadius = pointerType === 'mouse' ? HIT_RADIUS_PX : TOUCH_HIT_RADIUS_PX;
    const hitId = pt ? findNearestHit(pt.px, pt.py, hitRadius) : null;

    if (!cancelled && !wasMoved && pt) {
      updateCursorReadout(pt.px, pt.py, hitId);
      if (hitId) {
        if (store.audioEnabled) {
          void tacticalAudio.unlock();
        }
        store.selectEntity(hitId, true);
      }
    }

    if (pointerType !== 'mouse') {
      pointerInsideRef.current = false;
      lastPointerRef.current = null;
    }

    if (canvas) {
      canvas.style.cursor = resolveCanvasCursor(
        pointerType === 'mouse' ? hitId : null,
        store.domeRotationLocked,
        false
      );
    }
  };

  const handlePointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    finishPointerGesture(e, false);
  };

  const handlePointerCancel = (e: PointerEvent<HTMLCanvasElement>) => {
    finishPointerGesture(e, true);
  };

  const handlePointerLeave = () => {
    if (isDraggingRef.current) return;
    pointerInsideRef.current = false;
    lastPointerRef.current = null;
    if (cursorReadoutRef.current) {
      cursorReadoutRef.current.textContent = DEFAULT_CURSOR_READOUT;
    }
    const store = useSkyStore.getState();
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.cursor = resolveCanvasCursor(null, store.domeRotationLocked, false);
    }
    if (store.hoveredId !== null) {
      store.setHoveredId(null);
    }
  };

  const handleCanvasClick = (e: MouseEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    if (performance.now() - lastPointerActionMsRef.current < 450) {
      return;
    }
    const pt = getClientCanvasPoint(e.clientX, e.clientY);
    if (!pt) return;
    const hitId = findNearestHit(pt.px, pt.py, HIT_RADIUS_PX);
    if (!hitId) return;
    const store = useSkyStore.getState();
    if (store.audioEnabled) {
      void tacticalAudio.unlock();
    }
    store.selectEntity(hitId, true);
  };

  const displayHeadingInt = ((Math.round(domeRotationDeg) % 360) + 360) % 360;
  const headingStr = String(displayHeadingInt).padStart(3, '0');
  const showNorthReset =
    Math.abs(shortestAngleDeltaDeg(0, domeRotationDeg)) >= 0.5 || domeCompassActive;

  const rootStyle: CSSProperties = {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    backgroundColor: 'transparent',
    userSelect: 'none',
    fontFamily: MONO_FONT,
  };

  const canvasStageStyle: CSSProperties = {
    position: 'relative',
    flex: '1 1 auto',
    minHeight: 0,
    width: '100%',
    overflow: 'hidden',
  };

  const pipHeaderStyle: CSSProperties = {
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '5px 7px 4px',
    backgroundColor: 'rgba(7, 10, 17, 0.88)',
    borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.08)',
    zIndex: 12,
  };

  const pipActionBtnStyle = (active = false, tone: 'cyan' | 'amber' = 'cyan'): CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 21,
    height: 21,
    padding: 0,
    borderRadius: 4,
    border: active
      ? tone === 'amber'
        ? '1px solid rgba(245, 158, 11, 0.62)'
        : '1px solid rgba(34, 211, 238, 0.62)'
      : '1px solid rgba(255, 255, 255, 0.14)',
    backgroundColor: active
      ? tone === 'amber'
        ? 'rgba(245, 158, 11, 0.18)'
        : 'rgba(34, 211, 238, 0.18)'
      : 'rgba(15, 23, 42, 0.72)',
    color: active ? (tone === 'amber' ? '#FDE68A' : '#E0F2FE') : '#CBD5E1',
    fontSize: 10.5,
    lineHeight: 1,
    cursor: 'pointer',
    touchAction: 'manipulation',
    outline: 'none',
    flexShrink: 0,
  });

  const cornerTitleStyle: CSSProperties = {
    position: 'absolute',
    top: isCompact ? 8 : 12,
    left: isCompact ? 8 : 12,
    pointerEvents: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: isCompact ? '4px 7px' : '5px 9px',
    borderRadius: 6,
    backgroundColor: 'rgba(7, 10, 17, 0.84)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  };

  const readoutStyle: CSSProperties = {
    position: 'absolute',
    top: isCompact ? 8 : 12,
    right: isCompact ? 8 : 12,
    pointerEvents: 'none',
    padding: isCompact ? '4px 7px' : '5px 9px',
    borderRadius: 6,
    backgroundColor: 'rgba(7, 10, 17, 0.84)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    color: '#CBD5E1',
    fontSize: isCompact ? 9.5 : 10.5,
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap',
  };

  const bezelControlsStyle: CSSProperties = {
    position: 'absolute',
    bottom: isCompact ? 'max(8px, env(safe-area-inset-bottom))' : 'max(12px, env(safe-area-inset-bottom))',
    left: isCompact ? 'max(8px, env(safe-area-inset-left))' : 'max(12px, env(safe-area-inset-left))',
    maxWidth: showFullLegend && !isCompact ? 'calc(100% - 230px)' : 'calc(100% - 96px)',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    pointerEvents: 'auto',
    zIndex: 10,
  };

  const legendStyle: CSSProperties = {
    position: 'absolute',
    bottom: isCompact ? 'max(8px, env(safe-area-inset-bottom))' : 'max(12px, env(safe-area-inset-bottom))',
    right: isCompact ? 'max(8px, env(safe-area-inset-right))' : 'max(12px, env(safe-area-inset-right))',
    pointerEvents: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: isCompact ? 6 : 9,
    padding: isCompact ? '4px 7px' : '5px 9px',
    borderRadius: 6,
    backgroundColor: 'rgba(7, 10, 17, 0.84)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    fontSize: isCompact ? 8.5 : 9.5,
    color: '#94A3B8',
    fontVariantNumeric: 'tabular-nums',
  };

  const bezelButtonStyle = (
    active: boolean,
    tone: 'cyan' | 'amber' | 'emerald' = 'cyan'
  ): CSSProperties => {
    const activeBorder =
      tone === 'amber'
        ? '1px solid rgba(245, 158, 11, 0.56)'
        : tone === 'emerald'
        ? '1px solid rgba(52, 211, 153, 0.56)'
        : '1px solid rgba(34, 211, 238, 0.52)';
    const activeBg =
      tone === 'amber'
        ? 'rgba(245, 158, 11, 0.16)'
        : tone === 'emerald'
        ? 'rgba(52, 211, 153, 0.16)'
        : 'rgba(34, 211, 238, 0.16)';
    const activeColor =
      tone === 'amber' ? '#FDE68A' : tone === 'emerald' ? '#D1FAE5' : '#E0F2FE';

    return {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 5,
      minHeight: 32,
      padding: isCompact ? '4px 8px' : '5px 10px',
      borderRadius: 6,
      border: active ? activeBorder : '1px solid rgba(255, 255, 255, 0.1)',
      backgroundColor: active ? activeBg : 'rgba(7, 10, 17, 0.84)',
      color: active ? activeColor : '#CBD5E1',
      fontFamily: MONO_FONT,
      fontSize: isCompact ? 9.5 : 10,
      fontWeight: 600,
      fontVariantNumeric: 'tabular-nums',
      letterSpacing: '0.05em',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      touchAction: 'manipulation',
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      outline: 'none',
    };
  };

  const ledStyle = (active: boolean, color: string): CSSProperties => ({
    width: 6,
    height: 6,
    borderRadius: '50%',
    backgroundColor: active ? color : '#475569',
    boxShadow: active ? `0 0 6px ${color}` : 'none',
    flexShrink: 0,
  });

  const compassStatusStyle: CSSProperties = isPip
    ? {
        position: 'absolute',
        left: 6,
        right: 6,
        bottom: showNorthReset ? 30 : 6,
        pointerEvents: 'none',
        padding: '3px 6px',
        borderRadius: 5,
        backgroundColor: 'rgba(7, 10, 17, 0.92)',
        border: '1px solid rgba(245, 158, 11, 0.45)',
        color: '#FDE68A',
        fontSize: 8.5,
        lineHeight: 1.25,
        textAlign: 'center',
        zIndex: 14,
      }
    : {
        position: 'absolute',
        left: isCompact ? 8 : 12,
        top: isCompact ? 42 : 58,
        maxWidth: 'calc(100% - 24px)',
        pointerEvents: 'none',
        padding: '4px 9px',
        borderRadius: 6,
        backgroundColor: 'rgba(7, 10, 17, 0.92)',
        border: '1px solid rgba(245, 158, 11, 0.45)',
        color: '#FDE68A',
        fontSize: isCompact ? 9 : 10,
        letterSpacing: '0.03em',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        zIndex: 14,
      };

  const pipNorthResetStyle: CSSProperties = {
    position: 'absolute',
    left: 6,
    bottom: 6,
    zIndex: 12,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    minHeight: 22,
    padding: '2px 7px',
    borderRadius: 5,
    border: '1px solid rgba(34, 211, 238, 0.48)',
    backgroundColor: 'rgba(7, 10, 17, 0.88)',
    color: '#E0F2FE',
    fontFamily: MONO_FONT,
    fontSize: 9,
    fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    touchAction: 'manipulation',
    outline: 'none',
  };

  return (
    <div
      className={className ? `skydome-root ${className}` : 'skydome-root'}
      style={rootStyle}
      data-pip={isPip ? 'true' : 'false'}
    >
      {isPip && (
        <div
          className="skydome-pip-header"
          style={pipHeaderStyle}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 4,
              minWidth: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
              <span style={ledStyle(true, '#22D3EE')} />
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  color: '#E2E8F0',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                SKY-DOME PIP
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
              <button
                type="button"
                data-testid="skydome-compass-toggle"
                aria-pressed={domeCompassActive}
                title={
                  domeCompassActive
                    ? 'Disable Device Compass'
                    : domeCompassSupported === false
                    ? 'No device compass detected — click to retry or drag dome'
                    : 'Align Sky-Dome with Device Compass'
                }
                aria-label="Toggle Device Compass"
                style={{
                  ...pipActionBtnStyle(domeCompassActive, 'cyan'),
                  opacity: !domeCompassActive && domeCompassSupported === false ? 0.65 : 1,
                }}
                onClick={handleCompassToggle}
              >
                🧭
              </button>
              <button
                type="button"
                data-testid="skydome-lock-toggle"
                aria-pressed={domeRotationLocked}
                title={
                  domeRotationLocked
                    ? 'Dome Rotation Locked — click to unlock'
                    : 'Dome Rotation Unlocked — click to lock'
                }
                aria-label={domeRotationLocked ? 'Unlock Sky-Dome Rotation' : 'Lock Sky-Dome Rotation'}
                style={pipActionBtnStyle(domeRotationLocked, 'amber')}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleDomeRotationLock();
                }}
              >
                {domeRotationLocked ? '🔒' : '🔓'}
              </button>
              <button
                type="button"
                data-testid="skydome-pip-expand"
                title="Expand to Split View"
                aria-label="Expand to Split View"
                style={pipActionBtnStyle()}
                onClick={(e) => {
                  e.stopPropagation();
                  setLayout('split');
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M7.5 1.5h3v3M10.5 1.5L6.8 5.2M4.5 10.5h-3v-3M1.5 10.5l3.7-3.7" />
                </svg>
              </button>
              <button
                type="button"
                data-testid="skydome-pip-close"
                title="Hide Sky-Dome PIP"
                aria-label="Hide Sky-Dome PIP"
                style={pipActionBtnStyle()}
                onClick={(e) => {
                  e.stopPropagation();
                  setSkyDomePip(false);
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
                </svg>
              </button>
            </div>
          </div>
          <span
            ref={cursorReadoutRef}
            style={{
              display: 'block',
              fontSize: 8.5,
              lineHeight: 1.2,
              color: '#94A3B8',
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '0.02em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {DEFAULT_CURSOR_READOUT}
          </span>
        </div>
      )}

      <div key="skydome-canvas-stage" ref={containerRef} style={canvasStageStyle}>
        <canvas
          ref={canvasRef}
          aria-label="Polar Sky-Dome Topocentric Hemisphere Radar"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onPointerLeave={handlePointerLeave}
          onClick={handleCanvasClick}
          style={{ display: 'block', width: '100%', height: '100%', touchAction: 'none' }}
        />

        {compassStatusMsg && (
          <div
            role="status"
            aria-live="polite"
            data-testid="skydome-compass-status"
            style={compassStatusStyle}
          >
            {compassStatusMsg}
          </div>
        )}

        {isPip && showNorthReset && (
          <button
            type="button"
            data-testid="skydome-north-reset"
            title="Reset Sky-Dome to North-Up (000°)"
            style={pipNorthResetStyle}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              resetDomeNorth();
            }}
          >
            {`HDG ${headingStr}° · N▲`}
          </button>
        )}

        {!isPip && (
          <>
            {/* Top-Left Scope Header */}
            <div style={cornerTitleStyle}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: isCompact ? 9.5 : 10.5,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  color: '#E2E8F0',
                }}
              >
                <span style={ledStyle(true, '#22D3EE')} />
                <span>POLAR SKY-DOME</span>
              </div>
              {!isCompact && (
                <div
                  style={{
                    fontSize: 9,
                    color: '#94A3B8',
                    letterSpacing: '0.05em',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {skyDomeZoom === 'zenith'
                    ? '90° TOP · 30° LIMB · OVERHEAD 2×'
                    : '90° TOP · 0° HRZ · FULL SKY'}
                  {orbitalScope === 'cylinder' ? ' · CYL' : ''}
                </div>
              )}
            </div>

            {/* Top-Right Live Cursor AZ / EL / RNG Readout */}
            <div style={readoutStyle}>
              <span ref={cursorReadoutRef}>{DEFAULT_CURSOR_READOUT}</span>
            </div>

            {/* Bottom-Left Bezel Micro-Controls & Orientation Suite */}
            <div
              className="skydome-bezel-controls"
              style={bezelControlsStyle}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                aria-pressed={sweepEnabled}
                style={bezelButtonStyle(sweepEnabled)}
                onClick={(e) => {
                  e.stopPropagation();
                  setSweepEnabled(!sweepEnabled);
                }}
              >
                <span style={ledStyle(sweepEnabled, '#22D3EE')} />
                <span>SWEEP</span>
              </button>
              <button
                type="button"
                aria-pressed={domeLabelsEnabled}
                style={bezelButtonStyle(domeLabelsEnabled)}
                onClick={(e) => {
                  e.stopPropagation();
                  setDomeLabelsEnabled(!domeLabelsEnabled);
                }}
              >
                <span style={ledStyle(domeLabelsEnabled, '#38BDF8')} />
                <span>LABELS</span>
              </button>
              <button
                type="button"
                data-testid="skydome-zoom-toggle"
                aria-pressed={skyDomeZoom === 'zenith'}
                title={
                  skyDomeZoom === 'zenith'
                    ? 'Overhead 2× lens (30°–90°) — click for Full Sky'
                    : 'Full Sky hemisphere (0°–90°) — click for Overhead 2×'
                }
                style={bezelButtonStyle(skyDomeZoom === 'zenith')}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleSkyDomeZoom();
                }}
              >
                <span>{skyDomeZoom === 'zenith' ? 'OVERHEAD 2×' : 'FULL SKY'}</span>
              </button>
              <button
                type="button"
                data-testid="skydome-compass-toggle"
                aria-pressed={domeCompassActive}
                title={
                  domeCompassActive
                    ? 'Disable live device compass'
                    : domeCompassSupported === false
                    ? 'No device compass detected — drag dome to rotate'
                    : 'Align Sky-Dome with hardware device compass'
                }
                style={{
                  ...bezelButtonStyle(
                    domeCompassActive,
                    domeCompassSupported === true ? 'emerald' : 'cyan'
                  ),
                  opacity: !domeCompassActive && domeCompassSupported === false ? 0.72 : 1,
                }}
                onClick={handleCompassToggle}
              >
                <span
                  style={ledStyle(
                    domeCompassActive,
                    domeCompassSupported === true ? '#34D399' : '#22D3EE'
                  )}
                />
                <span aria-hidden="true">🧭</span>
                <span>COMPASS</span>
              </button>
              <button
                type="button"
                data-testid="skydome-lock-toggle"
                aria-pressed={domeRotationLocked}
                title={
                  domeRotationLocked
                    ? 'Rotation locked — click to unlock drag & compass rotation'
                    : 'Rotation unlocked — drag dome to rotate, or click to lock'
                }
                style={bezelButtonStyle(domeRotationLocked, 'amber')}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleDomeRotationLock();
                }}
              >
                <span aria-hidden="true">{domeRotationLocked ? '🔒' : '🔓'}</span>
                <span>{domeRotationLocked ? 'LOCKED' : 'UNLOCKED'}</span>
              </button>
              {showNorthReset && (
                <button
                  type="button"
                  data-testid="skydome-north-reset"
                  title="Reset Sky-Dome to North-Up (000°)"
                  style={bezelButtonStyle(true, 'cyan')}
                  onClick={(e) => {
                    e.stopPropagation();
                    resetDomeNorth();
                  }}
                >
                  <span>{`HDG ${headingStr}° · N▲`}</span>
                </button>
              )}
            </div>

            {/* Bottom-Right Horizon & Orbital Legend */}
            <div className="skydome-legend" style={legendStyle}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 8, height: 2, backgroundColor: '#22D3EE', display: 'inline-block' }} />
                <span>{skyDomeZoom === 'zenith' ? '30° LIMB' : '0° HRZ'}</span>
              </span>
              {showFullLegend && !isCompact && (
                <>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={ledStyle(true, SATELLITE_SUNLIT_COLOR)} />
                    <span>SUNLIT</span>
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={ledStyle(true, SATELLITE_ECLIPSED_COLOR)} />
                    <span>ECLIPSED</span>
                  </span>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function pulseWaveStartMsExpired(startMs: number | null, nowMs: number): boolean {
  return startMs !== null && nowMs - startMs >= PULSE_WAVE_DURATION_MS;
}

export default PolarSkyDome;
