import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type TouchEvent,
} from 'react';
import {
  BREACH_COLOR,
  CATEGORY_COLORS,
  EMERGENCY_COLOR,
  SATELLITE_ECLIPSED_COLOR,
  SATELLITE_SUNLIT_COLOR,
  type SatelliteOrbitOverlay,
  type SkyEntity,
  type UnitSystem,
} from '../../types/sky-contracts';
import { liveKinematicsRegistry, useSkyStore } from '../../store/useSkyStore';
import { tacticalAudio } from '../../audio/tacticalAudio';
import { computeTopocentricLookAngles, greatCircleDestination } from '../../math/geodesy';
import { formatAltitude } from '../../math/units';

export interface PolarSkyDomeProps {
  className?: string;
}

const EL_MAX = 90;
const EL_MIN = -5;
const EL_SPAN = EL_MAX - EL_MIN; // 95 deg linear projection
const HIT_RADIUS_PX = 13;
const TOUCH_HIT_RADIUS_PX = 20;
const TOUCH_DRAG_THRESHOLD_PX = 10;
const SWEEP_DEG_PER_MS = 0.045; // 1 revolution ~ 8s
const PULSE_WAVE_DURATION_MS = 950;
const TRAIL_SAMPLE_INTERVAL_MS = 450;
const MAX_TRAIL_SAMPLES = 10;
const MAX_FLIGHT_TRAIL_AGE_MS = 120_000;
const MAX_BALLOON_TRAIL_AGE_MS = 1_800_000;
const MAX_TRAIL_SEGMENT_RATIO = 0.45;

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

interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface CanvasMetrics {
  width: number;
  height: number;
  dpr: number;
  cx: number;
  cy: number;
  outerRadius: number;
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

function elToRadius(elDeg: number, outerRadius: number): number {
  const clamped = Math.max(EL_MIN, Math.min(EL_MAX, elDeg));
  return outerRadius * ((EL_MAX - clamped) / EL_SPAN);
}

function azElToCanvas(
  azDeg: number,
  elDeg: number,
  cx: number,
  cy: number,
  outerRadius: number
): { x: number; y: number; r: number } {
  const r = elToRadius(elDeg, outerRadius);
  const theta = ((azDeg - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(theta),
    y: cy + r * Math.sin(theta),
    r,
  };
}

function canvasToAzEl(
  px: number,
  py: number,
  cx: number,
  cy: number,
  outerRadius: number
): { azDeg: number; elDeg: number; inBounds: boolean } {
  const dx = px - cx;
  const dy = py - cy;
  const dist = Math.hypot(dx, dy);
  const azDeg = (((Math.atan2(dy, dx) * 180) / Math.PI) + 90 + 360) % 360;
  const elDeg = EL_MAX - (dist / Math.max(1, outerRadius)) * EL_SPAN;
  return { azDeg, elDeg, inBounds: dist <= outerRadius };
}

function projectHeadingAngle(
  entity: SkyEntity,
  obsLat: number,
  obsLon: number,
  obsAltM: number,
  cx: number,
  cy: number,
  outerRadius: number,
  baseX: number,
  baseY: number
): number {
  const headingDeg = Number.isFinite(entity.headingDeg) ? entity.headingDeg : 0;
  const fallbackAngle = ((headingDeg - 90) * Math.PI) / 180;

  if (entity.topocentric.elevationDeg >= 87) {
    return fallbackAngle;
  }

  const stepKm = entity.category === 'satellite' ? 18 : 2;
  const fwd = greatCircleDestination(entity.lat, entity.lon, headingDeg, stepKm);
  const look = computeTopocentricLookAngles(
    { lat: obsLat, lon: obsLon, altM: obsAltM },
    { lat: fwd.lat, lon: fwd.lon, altM: entity.altM },
    false
  );
  const pt = azElToCanvas(look.azimuthDeg, look.elevationDeg, cx, cy, outerRadius);
  const dx = pt.x - baseX;
  const dy = pt.y - baseY;
  if (Math.hypot(dx, dy) < 0.25) return fallbackAngle;
  return Math.atan2(dy, dx);
}

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
      ctx.beginPath();
      ctx.arc(0, -1.2, 3.6, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#ECFDF5';
      ctx.lineWidth = 0.8;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, 2.4);
      ctx.lineTo(0, 6.4);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.1;
      ctx.stroke();
      break;
    }
    case 'drone': {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.45;
      ctx.beginPath();
      ctx.moveTo(-4, -4);
      ctx.lineTo(4, 4);
      ctx.moveTo(-4, 4);
      ctx.lineTo(4, -4);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(0, 0, 2.1, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
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
  outerRadius: number
): void {
  if (!selectedId || overlay.passArcAzEl.length < 2) return;
  const selectedEntity = liveKinematicsRegistry.entities.get(selectedId);
  const matchesSelected =
    selectedId === `sat-${overlay.noradId}` ||
    (selectedEntity?.category === 'satellite' && selectedEntity.noradId === overlay.noradId);
  if (!matchesSelected) return;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, outerRadius + 1, 0, Math.PI * 2);
  ctx.clip();

  const interpolateEdgeAz = (
    a: { azDeg: number; elDeg: number },
    b: { azDeg: number; elDeg: number }
  ): number => {
    let dAz = b.azDeg - a.azDeg;
    if (dAz > 180) dAz -= 360;
    if (dAz < -180) dAz += 360;
    const denom = b.elDeg - a.elDeg;
    const t = Math.abs(denom) > 1e-6 ? (EL_MIN - a.elDeg) / denom : 0;
    return (a.azDeg + dAz * t + 360) % 360;
  };

  const drawPassPath = () => {
    ctx.beginPath();
    let penDown = false;
    let prevPt: { azDeg: number; elDeg: number } | null = null;
    for (const pt of overlay.passArcAzEl) {
      if (!Number.isFinite(pt.azDeg) || !Number.isFinite(pt.elDeg)) {
        penDown = false;
        prevPt = null;
        continue;
      }

      if (pt.elDeg < EL_MIN) {
        if (penDown && prevPt && prevPt.elDeg >= EL_MIN) {
          const crossAz = interpolateEdgeAz(prevPt, pt);
          const edgePos = azElToCanvas(crossAz, EL_MIN, cx, cy, outerRadius);
          ctx.lineTo(edgePos.x, edgePos.y);
        }
        penDown = false;
        prevPt = pt;
        continue;
      }

      if (!penDown && prevPt && prevPt.elDeg < EL_MIN) {
        const crossAz = interpolateEdgeAz(prevPt, pt);
        const edgePos = azElToCanvas(crossAz, EL_MIN, cx, cy, outerRadius);
        ctx.moveTo(edgePos.x, edgePos.y);
        penDown = true;
      }

      const { x, y } = azElToCanvas(pt.azDeg, pt.elDeg, cx, cy, outerRadius);
      if (!penDown) {
        ctx.moveTo(x, y);
        penDown = true;
      } else {
        ctx.lineTo(x, y);
      }
      prevPt = pt;
    }
  };

  // Ambient orbital arc glow
  drawPassPath();
  ctx.strokeStyle = 'rgba(192, 132, 252, 0.26)';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Dashed orbital pass arc
  drawPassPath();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = CATEGORY_COLORS.satellite;
  ctx.lineWidth = 1.85;
  ctx.stroke();
  ctx.setLineDash([]);

  // Find TCA peak marker
  let peak = overlay.passArcAzEl.find((pt) => pt.isPeak);
  if (!peak) {
    let bestEl = -999;
    for (const pt of overlay.passArcAzEl) {
      if (pt.elDeg > bestEl) {
        bestEl = pt.elDeg;
        peak = pt;
      }
    }
  }

  if (peak && Number.isFinite(peak.azDeg) && Number.isFinite(peak.elDeg) && peak.elDeg >= EL_MIN) {
    const peakPos = azElToCanvas(peak.azDeg, peak.elDeg, cx, cy, outerRadius);
    drawTcaStar(ctx, peakPos.x, peakPos.y);

    const tcaText = `TCA ${peak.elDeg.toFixed(0)}°`;
    ctx.font = `600 9.5px ${MONO_FONT}`;
    const textW = ctx.measureText(tcaText).width;
    const tx = Math.min(cx + outerRadius - textW - 10, peakPos.x + 10);
    const ty = Math.max(cy - outerRadius + 14, peakPos.y - 8);

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

function drawRadarGrid(
  ctx: CanvasRenderingContext2D,
  metrics: CanvasMetrics,
  sweepEnabled: boolean,
  sweepAzDeg: number,
  pulseWaveStartMs: number | null,
  nowMs: number
): void {
  const { cx, cy, outerRadius, width, height } = metrics;
  const horizonR = elToRadius(0, outerRadius);
  const el30R = elToRadius(30, outerRadius);
  const el60R = elToRadius(60, outerRadius);
  const innerSpokeR = elToRadius(78, outerRadius);
  const compact = Math.min(width, height) < 360;

  // Outer backdrop wash
  const bgGrad = ctx.createRadialGradient(cx, cy, 4, cx, cy, outerRadius * 1.08);
  bgGrad.addColorStop(0, '#0D192B');
  bgGrad.addColorStop(0.75, '#070E1A');
  bgGrad.addColorStop(1, '#050810');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Over-The-Horizon (-5 deg to 0 deg) annular skirt shading
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, outerRadius, 0, Math.PI * 2);
  ctx.arc(cx, cy, horizonR, 0, Math.PI * 2, true);
  ctx.fillStyle = 'rgba(245, 158, 11, 0.04)';
  ctx.fill();
  ctx.restore();

  // Above-horizon inner dome fill
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, horizonR, 0, Math.PI * 2);
  const dishGrad = ctx.createRadialGradient(cx, cy, 2, cx, cy, horizonR);
  dishGrad.addColorStop(0, 'rgba(34, 211, 238, 0.055)');
  dishGrad.addColorStop(0.55, 'rgba(15, 29, 52, 0.35)');
  dishGrad.addColorStop(1, 'rgba(6, 11, 20, 0.55)');
  ctx.fillStyle = dishGrad;
  ctx.fill();
  ctx.restore();

  // Rotating phosphor sweep wedge
  if (sweepEnabled) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, outerRadius, 0, Math.PI * 2);
    ctx.clip();

    const beamAngleRad = ((sweepAzDeg - 90) * Math.PI) / 180;
    const sweepArcRad = (46 * Math.PI) / 180;

    if (typeof ctx.createConicGradient === 'function') {
      const startAngle = beamAngleRad - sweepArcRad;
      const conic = ctx.createConicGradient(startAngle, cx, cy);
      const frac = sweepArcRad / (Math.PI * 2);
      conic.addColorStop(0, 'rgba(34, 211, 238, 0)');
      conic.addColorStop(frac * 0.72, 'rgba(34, 211, 238, 0.06)');
      conic.addColorStop(frac, 'rgba(34, 211, 238, 0.21)');
      conic.addColorStop(Math.min(1, frac + 0.002), 'rgba(34, 211, 238, 0)');
      conic.addColorStop(1, 'rgba(34, 211, 238, 0)');

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, horizonR, startAngle, beamAngleRad);
      ctx.closePath();
      ctx.fillStyle = conic;
      ctx.fill();
    } else {
      const slices = 10;
      for (let i = 0; i < slices; i += 1) {
        const a0 = beamAngleRad - ((slices - i) / slices) * sweepArcRad;
        const a1 = beamAngleRad - ((slices - i - 1) / slices) * sweepArcRad;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, horizonR, a0, a1);
        ctx.closePath();
        ctx.fillStyle = `rgba(34, 211, 238, ${(i + 1) * 0.018})`;
        ctx.fill();
      }
    }

    // Crisp leading phosphor sweep beam
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + horizonR * Math.cos(beamAngleRad), cy + horizonR * Math.sin(beamAngleRad));
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.72)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  // Manual sweep pulse expanding wave
  if (pulseWaveStartMs !== null) {
    const elapsed = nowMs - pulseWaveStartMs;
    if (elapsed >= 0 && elapsed < PULSE_WAVE_DURATION_MS) {
      const progress = elapsed / PULSE_WAVE_DURATION_MS;
      const waveR = progress * outerRadius;
      const alpha = (1 - progress) * 0.75;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, waveR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(34, 211, 238, ${alpha.toFixed(3)})`;
      ctx.lineWidth = 2.2 * (1 - progress * 0.5);
      ctx.stroke();
      ctx.restore();
    }
  }

  // 15° radial azimuth spokes
  for (let az = 0; az < 360; az += 15) {
    const theta = ((az - 90) * Math.PI) / 180;
    const isCardinal = az % 90 === 0;
    const isIntercardinal = az % 45 === 0 && !isCardinal;
    const startR = isCardinal ? 5 : isIntercardinal ? 12 : innerSpokeR;

    ctx.beginPath();
    ctx.moveTo(cx + startR * Math.cos(theta), cy + startR * Math.sin(theta));
    ctx.lineTo(cx + outerRadius * Math.cos(theta), cy + outerRadius * Math.sin(theta));
    ctx.strokeStyle = isCardinal
      ? 'rgba(56, 189, 248, 0.24)'
      : isIntercardinal
      ? 'rgba(120, 190, 255, 0.14)'
      : 'rgba(120, 190, 255, 0.075)';
    ctx.lineWidth = isCardinal ? 1 : 0.75;
    ctx.stroke();
  }

  // 5° perimeter bezel ticks on 0° Horizon ring
  for (let az = 0; az < 360; az += 5) {
    const theta = ((az - 90) * Math.PI) / 180;
    const major = az % 15 === 0;
    const tIn = horizonR - (major ? 4.5 : 2.2);
    const tOut = horizonR;
    ctx.beginPath();
    ctx.moveTo(cx + tIn * Math.cos(theta), cy + tIn * Math.sin(theta));
    ctx.lineTo(cx + tOut * Math.cos(theta), cy + tOut * Math.sin(theta));
    ctx.strokeStyle = major ? 'rgba(34, 211, 238, 0.45)' : 'rgba(148, 163, 184, 0.22)';
    ctx.lineWidth = major ? 1 : 0.65;
    ctx.stroke();
  }

  // Elevation concentric rings: 60° and 30°
  ctx.save();
  ctx.setLineDash([4, 4]);
  for (const r of [el60R, el30R]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(120, 190, 255, 0.22)';
    ctx.lineWidth = 0.9;
    ctx.stroke();
  }
  ctx.restore();

  // 0° Horizon ring (bright crisp cyan ring)
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, horizonR, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(34, 211, 238, 0.18)';
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, horizonR, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(34, 211, 238, 0.65)';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.restore();

  // -5° Over-The-Horizon outer skirt boundary
  ctx.save();
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  ctx.arc(cx, cy, outerRadius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.34)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  // Zenith 90° precision center crosshair
  ctx.save();
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
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
  ctx.restore();

  // Elevation ring annotations slightly offset from North spoke
  const ringLabels: Array<{ text: string; r: number; color: string }> = [
    { text: '60°', r: el60R, color: 'rgba(148, 163, 184, 0.78)' },
    { text: '30°', r: el30R, color: 'rgba(148, 163, 184, 0.78)' },
    { text: '0°', r: horizonR, color: 'rgba(34, 211, 238, 0.9)' },
  ];
  if (!compact) {
    ringLabels.push({ text: '-5°', r: outerRadius, color: 'rgba(245, 158, 11, 0.72)' });
  }

  ctx.save();
  ctx.font = `600 ${compact ? 8.5 : 9.5}px ${MONO_FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const labelTheta = ((-90 + 8) * Math.PI) / 180;
  for (const item of ringLabels) {
    const lx = cx + item.r * Math.cos(labelTheta);
    const ly = cy + item.r * Math.sin(labelTheta);
    ctx.fillStyle = 'rgba(6, 11, 20, 0.78)';
    ctx.fillRect(lx - 2, ly - 5, 20, 10);
    ctx.fillStyle = item.color;
    ctx.fillText(item.text, lx, ly);
  }
  ctx.restore();

  // Cardinal and intercardinal compass labels outside outerRadius
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const labelDist = outerRadius + (compact ? 11 : 14);
  for (const beacon of COMPASS_BEACONS) {
    const theta = ((beacon.azDeg - 90) * Math.PI) / 180;
    const bx = cx + labelDist * Math.cos(theta);
    const by = cy + labelDist * Math.sin(theta);

    if (beacon.cardinal) {
      ctx.font = `700 ${compact ? 10 : 11.5}px ${MONO_FONT}`;
      ctx.fillStyle = beacon.azDeg === 0 ? '#22D3EE' : '#CBD5E1';
    } else {
      ctx.font = `600 ${compact ? 8 : 9}px ${MONO_FONT}`;
      ctx.fillStyle = '#64748B';
    }
    ctx.fillText(beacon.label, bx, by);
  }
  ctx.restore();
}

function overlapsExistingLabel(box: LabelBox, existing: LabelBox[]): boolean {
  for (const other of existing) {
    if (
      box.x < other.x + other.w &&
      box.x + box.w > other.x &&
      box.y < other.y + other.h &&
      box.y + box.h > other.y
    ) {
      return true;
    }
  }
  return false;
}

function formatCompactDomeAltitude(entity: SkyEntity, units: UnitSystem): string {
  if (!Number.isFinite(entity.altM)) return '';
  if (entity.category === 'satellite') {
    return `${Math.round(entity.altM / 1000)} km`;
  }
  const formatted = formatAltitude(entity.altM, units);
  return formatted === '---' ? '' : formatted;
}

function resolveLabelBox(
  x: number,
  y: number,
  boxW: number,
  boxH: number,
  canvasW: number,
  canvasH: number,
  placed: LabelBox[],
  mustShow: boolean
): LabelBox | null {
  const clampX = (rawX: number) => Math.max(6, Math.min(canvasW - boxW - 6, rawX));
  const clampY = (rawY: number) => Math.max(6, Math.min(canvasH - boxH - 6, rawY));

  const candidates: LabelBox[] = [
    { x: clampX(x + 10), y: clampY(y - boxH / 2), w: boxW, h: boxH },
    { x: clampX(x - boxW - 10), y: clampY(y - boxH / 2), w: boxW, h: boxH },
    { x: clampX(x - boxW / 2), y: clampY(y - boxH - 10), w: boxW, h: boxH },
    { x: clampX(x - boxW / 2), y: clampY(y + 10), w: boxW, h: boxH },
  ];

  for (const candidate of candidates) {
    if (!overlapsExistingLabel(candidate, placed)) {
      return candidate;
    }
  }
  return mustShow ? candidates[0] : null;
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

  const renderedHitsRef = useRef<RenderedTargetHit[]>([]);
  const polarTrailsRef = useRef<Map<string, PolarPoint[]>>(new Map());
  const lastTrailSampleRef = useRef<Map<string, number>>(new Map());
  const lastObserverKeyRef = useRef<string>('');
  const pointerInsideRef = useRef<boolean>(false);
  const touchStartRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const lastTouchEndMsRef = useRef<number>(-Infinity);
  const sweepAzRef = useRef<number>(0);
  const lastFrameMsRef = useRef<number>(0);
  const pulseWaveStartRef = useRef<number | null>(null);

  const [isCompact, setIsCompact] = useState(false);

  const layout = useSkyStore((s) => s.layout);
  const units = useSkyStore((s) => s.units);
  const sweepEnabled = useSkyStore((s) => s.sweepEnabled);
  const setSweepEnabled = useSkyStore((s) => s.setSweepEnabled);
  const domeLabelsEnabled = useSkyStore((s) => s.domeLabelsEnabled);
  const setDomeLabelsEnabled = useSkyStore((s) => s.setDomeLabelsEnabled);
  const orbitalScope = useSkyStore((s) => s.orbitalScope);
  const sweepPulseCounter = useSkyStore((s) => s.sweepPulseCounter);

  const unitsRef = useRef<UnitSystem>(units);
  unitsRef.current = units;

  const prevPulseCounterRef = useRef<number>(sweepPulseCounter);

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
    const padding = Math.max(24, Math.min(44, minDim * 0.1));
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
  }, [layout, updateCanvasSize]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    canvas.style.cursor = 'crosshair';

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
      if (state.layout === 'map') return;

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

      // Reset trail caches on observer change
      const obsKey = `${state.observer.lat.toFixed(4)},${state.observer.lon.toFixed(4)}`;
      if (obsKey !== lastObserverKeyRef.current) {
        lastObserverKeyRef.current = obsKey;
        polarTrailsRef.current.clear();
        lastTrailSampleRef.current.clear();
      }

      if (pulseWaveStartMsExpired(pulseWaveStartRef.current, nowMs)) {
        pulseWaveStartRef.current = null;
      }

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
      ctx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);

      // 1. Radar background, OTH skirt, sweep beam, spokes, elevation rings, beacons
      drawRadarGrid(
        ctx,
        metrics,
        state.sweepEnabled,
        sweepAzRef.current,
        pulseWaveStartRef.current,
        nowMs
      );

      // 2. Selected satellite pass arc & TCA star (gated on satellite layer visibility)
      if (state.layers.satellite && liveKinematicsRegistry.orbitOverlay) {
        drawOrbitPassArc(
          ctx,
          liveKinematicsRegistry.orbitOverlay,
          state.selectedId,
          metrics.cx,
          metrics.cy,
          metrics.outerRadius
        );
      }

      // 3. Collect and prioritize visible entities
      const visible: Array<{
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
      }> = [];

      const activeIds = new Set<string>();
      const epochNowMs = Date.now();

      liveKinematicsRegistry.entities.forEach((entity) => {
        if (!state.layers[entity.category]) return;
        if (entity.category === 'satellite' && !state.satGroups[entity.group]) return;

        const { azimuthDeg: azDeg, elevationDeg: elDeg } = entity.topocentric;
        if (!Number.isFinite(azDeg) || !Number.isFinite(elDeg) || elDeg < -15) return;

        activeIds.add(entity.id);

        const isSelected = entity.id === state.selectedId;
        const isHovered = entity.id === state.hoveredId;
        const isEmergency = Boolean(entity.emergencyFlag);
        const isBreach =
          entity.category === 'drone' && (entity.ceilingBreach || entity.tfrBreach);

        const pos = azElToCanvas(azDeg, elDeg, metrics.cx, metrics.cy, metrics.outerRadius);
        const color = getEntityColor(entity);
        const priority = getEntityPriority(entity, isSelected, isHovered);

        // Update fallback polar trail cache when entity lacks geographic trail points
        if (entity.trail.length === 0) {
          const lastSample = lastTrailSampleRef.current.get(entity.id) ?? -Infinity;
          if (nowMs - lastSample >= TRAIL_SAMPLE_INTERVAL_MS) {
            lastTrailSampleRef.current.set(entity.id, nowMs);
            let pts = polarTrailsRef.current.get(entity.id);
            if (!pts) {
              pts = [];
              polarTrailsRef.current.set(entity.id, pts);
            }
            pts.push({ azDeg, elDeg, ts: nowMs });
            const maxAge =
              entity.category === 'balloon' ? MAX_BALLOON_TRAIL_AGE_MS : MAX_FLIGHT_TRAIL_AGE_MS;
            while (pts.length > MAX_TRAIL_SAMPLES || (pts.length > 0 && nowMs - pts[0].ts > maxAge)) {
              pts.shift();
            }
          }
        } else {
          polarTrailsRef.current.delete(entity.id);
          lastTrailSampleRef.current.delete(entity.id);
        }

        visible.push({
          entity,
          azDeg,
          elDeg,
          x: pos.x,
          y: pos.y,
          color,
          priority,
          isSelected,
          isHovered,
          isEmergency,
          isBreach,
        });
      });

      // Immediately prune stale trail cache entries for dead or hidden targets
      for (const key of polarTrailsRef.current.keys()) {
        if (!activeIds.has(key)) {
          polarTrailsRef.current.delete(key);
        }
      }
      for (const key of lastTrailSampleRef.current.keys()) {
        if (!activeIds.has(key)) {
          lastTrailSampleRef.current.delete(key);
        }
      }

      // Draw lowest priority first so selected/hovered/alerts sit on top
      visible.sort((a, b) => a.priority - b.priority);

      const nextHits: RenderedTargetHit[] = [];
      const maxTrailJumpPx = metrics.outerRadius * MAX_TRAIL_SEGMENT_RATIO;

      for (const item of visible) {
        const {
          entity,
          azDeg,
          elDeg,
          x,
          y,
          color,
          priority,
          isSelected,
          isHovered,
          isEmergency,
          isBreach,
        } = item;

        const belowHorizon = elDeg < 0;
        const baseAlpha =
          isSelected || isHovered
            ? belowHorizon
              ? 0.88
              : 1
            : belowHorizon
            ? elDeg < -5
              ? 0.3
              : 0.44
            : entity.category === 'satellite' && !entity.sunlit
            ? 0.72
            : 0.94;

        ctx.save();
        ctx.globalAlpha = baseAlpha;

        const maxTrailAgeMs =
          entity.category === 'balloon' ? MAX_BALLOON_TRAIL_AGE_MS : MAX_FLIGHT_TRAIL_AGE_MS;

        // Polar breadcrumb trail segment (bounded to last few fresh samples)
        if (entity.trail.length > 0) {
          const slice = entity.trail.slice(-MAX_TRAIL_SAMPLES);
          const projected: Array<{ x: number; y: number }> = [];
          for (const tp of slice) {
            if (!Number.isFinite(tp.ts) || epochNowMs - tp.ts > maxTrailAgeMs) {
              continue;
            }
            const look = computeTopocentricLookAngles(
              state.observer,
              { lat: tp.lat, lon: tp.lon, altM: tp.altM },
              false
            );
            if (look.elevationDeg >= -15) {
              const p = azElToCanvas(
                look.azimuthDeg,
                look.elevationDeg,
                metrics.cx,
                metrics.cy,
                metrics.outerRadius
              );
              projected.push({ x: p.x, y: p.y });
            }
          }
          projected.push({ x, y });
          drawPolarTrail(ctx, projected, color, maxTrailJumpPx);
        } else {
          const cached = polarTrailsRef.current.get(entity.id);
          if (cached && cached.length > 0) {
            const fresh = cached.filter((pt) => nowMs - pt.ts <= maxTrailAgeMs);
            if (fresh.length !== cached.length) {
              if (fresh.length === 0) {
                polarTrailsRef.current.delete(entity.id);
              } else {
                polarTrailsRef.current.set(entity.id, fresh);
              }
            }
            if (fresh.length > 1) {
              const projected = fresh.map((pt) => {
                const p = azElToCanvas(
                  pt.azDeg,
                  pt.elDeg,
                  metrics.cx,
                  metrics.cy,
                  metrics.outerRadius
                );
                return { x: p.x, y: p.y };
              });
              projected.push({ x, y });
              drawPolarTrail(ctx, projected, color, maxTrailJumpPx);
            }
          }
        }

        // Sweep beam phosphor afterglow highlight
        if (state.sweepEnabled && !belowHorizon) {
          const sweepLag = (sweepAzRef.current - azDeg + 360) % 360;
          if (sweepLag >= 0 && sweepLag < 24) {
            const boost = 1 - sweepLag / 24;
            ctx.beginPath();
            ctx.arc(x, y, 7 + (1 - boost) * 4, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(34, 211, 238, ${(boost * 0.45).toFixed(3)})`;
            ctx.lineWidth = 1.1;
            ctx.stroke();
          }
        }

        // Heading vector tick projected cleanly in topocentric dome space
        const headingAngle = projectHeadingAngle(
          entity,
          state.observer.lat,
          state.observer.lon,
          state.observer.altM,
          metrics.cx,
          metrics.cy,
          metrics.outerRadius,
          x,
          y
        );

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

        if (entity.headingValid !== false && tickLen > 0) {
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + Math.cos(headingAngle) * tickLen, y + Math.sin(headingAngle) * tickLen);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.25;
          ctx.stroke();
        }

        // Emergency or UASFM/TFR breach pulsing warning halo
        if (isEmergency || isBreach) {
          const ringR = 8.5 + 3.2 * Math.sin(nowMs * 0.0085);
          ctx.beginPath();
          ctx.arc(x, y, ringR, 0, Math.PI * 2);
          ctx.strokeStyle = isEmergency ? EMERGENCY_COLOR : BREACH_COLOR;
          ctx.lineWidth = 1.35;
          ctx.stroke();
        }

        // Category glyph
        const glyphScale =
          (belowHorizon ? 0.84 : 1) *
          (isSelected ? 1.22 : isHovered ? 1.15 : entity.category === 'satellite' && entity.group === 'starlink' ? 0.82 : 1);
        drawGlyph(ctx, entity, x, y, headingAngle, color, glyphScale);

        // Hover ring
        if (isHovered && !isSelected) {
          ctx.beginPath();
          ctx.arc(x, y, 10.5, 0, Math.PI * 2);
          ctx.strokeStyle = '#E2E8F0';
          ctx.lineWidth = 1.3;
          ctx.stroke();
        }

        // Target-lock reticle
        if (isSelected) {
          drawTargetLockReticle(ctx, x, y, color, nowMs);
        }

        ctx.restore();

        nextHits.push({ id: entity.id, x, y, priority });
      }

      renderedHitsRef.current = nextHits;

      if (
        pointerInsideRef.current &&
        state.hoveredId !== null &&
        !nextHits.some((h) => h.id === state.hoveredId)
      ) {
        canvas.style.cursor = 'crosshair';
        state.setHoveredId(null);
      }

      // 4. Target callsign labels (highest priority first with non-overlapping collision boxes)
      const placedLabels: LabelBox[] = [];
      ctx.save();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      let labelsDrawn = 0;
      const compactDome = metrics.width < 420 || metrics.height < 360;
      const maxAutoLabels = metrics.width < 420 ? 12 : 26;
      const activeUnits = state.units ?? unitsRef.current;

      for (let i = visible.length - 1; i >= 0; i -= 1) {
        const item = visible[i];
        const mustShow = item.isSelected || item.isHovered;
        if (!mustShow && !state.domeLabelsEnabled) continue;
        if (!mustShow && labelsDrawn >= maxAutoLabels) continue;

        const isHighPriority =
          mustShow || item.isEmergency || item.isBreach || item.priority >= 58;
        const elRounded = Math.round(item.elDeg);
        const elStr = `${elRounded === 0 ? 0 : elRounded}°`;
        const altStr = isHighPriority ? formatCompactDomeAltitude(item.entity, activeUnits) : '';
        const labelText = isHighPriority
          ? altStr
            ? `${item.entity.callsign} · ${altStr} · ${elStr}`
            : `${item.entity.callsign} · ${elStr}`
          : item.entity.callsign;

        ctx.font = mustShow
          ? `700 ${compactDome ? 9.5 : 10}px ${MONO_FONT}`
          : `600 ${compactDome ? 9 : 9.5}px ${MONO_FONT}`;

        const textW = ctx.measureText(labelText).width;
        const boxW = textW + 10;
        const boxH = 15;

        const box = resolveLabelBox(
          item.x,
          item.y,
          boxW,
          boxH,
          metrics.width,
          metrics.height,
          placedLabels,
          mustShow
        );
        if (!box) continue;

        placedLabels.push(box);
        if (!mustShow) labelsDrawn += 1;

        ctx.fillStyle = mustShow ? 'rgba(9, 15, 28, 0.94)' : 'rgba(6, 11, 20, 0.84)';
        ctx.strokeStyle = mustShow
          ? item.color
          : isHighPriority
          ? 'rgba(148, 163, 184, 0.36)'
          : 'rgba(120, 190, 255, 0.24)';
        ctx.lineWidth = mustShow ? 1.1 : 0.75;
        ctx.beginPath();
        traceRoundedRect(ctx, box.x, box.y, box.w, box.h, 3);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = mustShow
          ? '#F8FAFC'
          : item.elDeg < 0
          ? '#94A3B8'
          : isHighPriority
          ? '#E2E8F0'
          : '#CBD5E1';
        ctx.fillText(labelText, box.x + 5, box.y + box.h / 2 + 0.5);
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

  const findNearestHit = (px: number, py: number, radiusPx = HIT_RADIUS_PX): string | null => {
    const hits = renderedHitsRef.current;
    let bestId: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let i = 0; i < hits.length; i += 1) {
      const hit = hits[i];
      const dist = Math.hypot(px - hit.x, py - hit.y);
      if (dist <= radiusPx) {
        // Prefer closer hit, slightly biasing higher priority targets when right on top of each other
        const score = dist - hit.priority * 0.025;
        if (score < bestScore) {
          bestScore = score;
          bestId = hit.id;
        }
      }
    }
    return bestId;
  };

  const getClientCanvasPoint = (
    clientX: number,
    clientY: number
  ): { px: number; py: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      px: clientX - rect.left,
      py: clientY - rect.top,
    };
  };

  const updateCursorReadout = (px: number, py: number) => {
    const metrics = metricsRef.current;
    if (!cursorReadoutRef.current || metrics.outerRadius <= 0) return;
    const { azDeg, elDeg, inBounds } = canvasToAzEl(
      px,
      py,
      metrics.cx,
      metrics.cy,
      metrics.outerRadius
    );
    if (inBounds) {
      const azStr = azDeg.toFixed(1).padStart(5, '0');
      const elStr = `${elDeg >= 0 ? ' ' : ''}${elDeg.toFixed(1)}°`;
      cursorReadoutRef.current.textContent = `AZ ${azStr}° · EL ${elStr}`;
    } else {
      cursorReadoutRef.current.textContent = 'AZ ---.-° · EL --.-°';
    }
  };

  const handleMouseMove = (e: MouseEvent<HTMLCanvasElement>) => {
    const pt = getClientCanvasPoint(e.clientX, e.clientY);
    if (!pt) return;

    updateCursorReadout(pt.px, pt.py);

    pointerInsideRef.current = true;
    const hitId = findNearestHit(pt.px, pt.py, HIT_RADIUS_PX);
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.cursor = hitId ? 'pointer' : 'crosshair';
    }

    const store = useSkyStore.getState();
    if (store.hoveredId !== hitId) {
      store.setHoveredId(hitId);
    }
  };

  const handleClick = (e: MouseEvent<HTMLCanvasElement>) => {
    if (performance.now() - lastTouchEndMsRef.current < 450) {
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

  const handleTouchStart = (e: TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length !== 1) {
      touchStartRef.current = null;
      return;
    }
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, moved: false };
    const pt = getClientCanvasPoint(touch.clientX, touch.clientY);
    if (pt) {
      updateCursorReadout(pt.px, pt.py);
    }
  };

  const handleTouchMove = (e: TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length !== 1) {
      touchStartRef.current = null;
      return;
    }
    const touch = e.touches[0];
    if (touchStartRef.current) {
      const dist = Math.hypot(
        touch.clientX - touchStartRef.current.x,
        touch.clientY - touchStartRef.current.y
      );
      if (dist >= TOUCH_DRAG_THRESHOLD_PX) {
        touchStartRef.current.moved = true;
      }
    }
    const pt = getClientCanvasPoint(touch.clientX, touch.clientY);
    if (pt) {
      updateCursorReadout(pt.px, pt.py);
    }
  };

  const handleTouchEnd = (e: TouchEvent<HTMLCanvasElement>) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || e.changedTouches.length === 0) return;

    const touch = e.changedTouches[0];
    const dragDist = Math.hypot(touch.clientX - start.x, touch.clientY - start.y);
    if (start.moved || dragDist >= TOUCH_DRAG_THRESHOLD_PX) {
      return;
    }

    lastTouchEndMsRef.current = performance.now();
    const pt = getClientCanvasPoint(touch.clientX, touch.clientY);
    if (!pt) return;

    updateCursorReadout(pt.px, pt.py);
    const hitId = findNearestHit(pt.px, pt.py, TOUCH_HIT_RADIUS_PX);
    if (!hitId) return;

    const store = useSkyStore.getState();
    if (store.audioEnabled) {
      void tacticalAudio.unlock();
    }
    store.selectEntity(hitId, true);
  };

  const handleTouchCancel = () => {
    touchStartRef.current = null;
  };

  const handleMouseLeave = () => {
    pointerInsideRef.current = false;
    if (cursorReadoutRef.current) {
      cursorReadoutRef.current.textContent = 'AZ ---.-° · EL --.-°';
    }
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.cursor = 'crosshair';
    }
    const store = useSkyStore.getState();
    if (store.hoveredId !== null) {
      store.setHoveredId(null);
    }
  };

  const rootStyle: CSSProperties = {
    position: 'relative',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    backgroundColor: '#06090F',
    userSelect: 'none',
    fontFamily: MONO_FONT,
  };

  const cornerTitleStyle: CSSProperties = {
    position: 'absolute',
    top: layout === 'dome' && isCompact ? 46 : isCompact ? 8 : 12,
    left: layout === 'dome' && !isCompact ? 340 : isCompact ? 8 : 12,
    pointerEvents: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: isCompact ? '4px 7px' : '5px 9px',
    borderRadius: 6,
    backgroundColor: 'rgba(11, 17, 30, 0.76)',
    border: '1px solid rgba(120, 190, 255, 0.14)',
    backdropFilter: 'blur(8px)',
  };

  const readoutStyle: CSSProperties = {
    position: 'absolute',
    top: isCompact ? 8 : 12,
    right: isCompact ? 8 : 12,
    pointerEvents: 'none',
    padding: isCompact ? '4px 7px' : '5px 9px',
    borderRadius: 6,
    backgroundColor: 'rgba(11, 17, 30, 0.78)',
    border: '1px solid rgba(120, 190, 255, 0.14)',
    backdropFilter: 'blur(8px)',
    color: '#94A3B8',
    fontSize: isCompact ? 9.5 : 10.5,
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: '0.04em',
  };

  const bezelControlsStyle: CSSProperties = {
    position: 'absolute',
    bottom: isCompact ? 'max(8px, env(safe-area-inset-bottom))' : 'max(12px, env(safe-area-inset-bottom))',
    left:
      layout === 'dome' && !isCompact
        ? 340
        : isCompact
          ? 'max(8px, env(safe-area-inset-left))'
          : 'max(12px, env(safe-area-inset-left))',
    display: 'flex',
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
    backgroundColor: 'rgba(11, 17, 30, 0.76)',
    border: '1px solid rgba(120, 190, 255, 0.14)',
    backdropFilter: 'blur(8px)',
    fontSize: isCompact ? 8.5 : 9.5,
    color: '#94A3B8',
    fontVariantNumeric: 'tabular-nums',
  };

  const bezelButtonStyle = (active: boolean): CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    minHeight: 30,
    padding: isCompact ? '4px 9px' : '5px 10px',
    borderRadius: 6,
    border: active
      ? '1px solid rgba(34, 211, 238, 0.5)'
      : '1px solid rgba(120, 190, 255, 0.16)',
    backgroundColor: active ? 'rgba(34, 211, 238, 0.12)' : 'rgba(11, 17, 30, 0.82)',
    color: active ? '#E0F2FE' : '#94A3B8',
    fontFamily: MONO_FONT,
    fontSize: isCompact ? 9.5 : 10,
    fontWeight: 600,
    letterSpacing: '0.06em',
    cursor: 'pointer',
    touchAction: 'manipulation',
    backdropFilter: 'blur(8px)',
    outline: 'none',
  });

  const ledStyle = (active: boolean, color: string): CSSProperties => ({
    width: 6,
    height: 6,
    borderRadius: '50%',
    backgroundColor: active ? color : '#475569',
    boxShadow: active ? `0 0 6px ${color}` : 'none',
    flexShrink: 0,
  });

  return (
    <div ref={containerRef} className={className ? `skydome-root ${className}` : 'skydome-root'} style={rootStyle}>
      <canvas
        ref={canvasRef}
        aria-label="Polar Sky-Dome Topocentric Hemisphere Radar"
        onMouseMove={handleMouseMove}
        onClick={handleClick}
        onMouseLeave={handleMouseLeave}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
        style={{ display: 'block', width: '100%', height: '100%', touchAction: 'none' }}
      />

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
              color: '#64748B',
              letterSpacing: '0.05em',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            90° ZEN · 0° HRZ · {orbitalScope === 'cylinder' ? 'CYLINDER' : 'HEMISPHERE'}
          </div>
        )}
      </div>

      {/* Top-Right Live Cursor AZ / EL Readout */}
      <div style={readoutStyle}>
        <span ref={cursorReadoutRef}>AZ ---.-° · EL --.-°</span>
      </div>

      {/* Bottom-Left Bezel Micro-Controls */}
      <div className="skydome-bezel-controls" style={bezelControlsStyle}>
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
      </div>

      {/* Bottom-Right Horizon & Orbital Legend */}
      <div style={legendStyle}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 8, height: 2, backgroundColor: '#22D3EE', display: 'inline-block' }} />
          <span>0° HRZ</span>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span
            style={{
              width: 8,
              height: 2,
              borderTop: '1px dashed rgba(245, 158, 11, 0.75)',
              display: 'inline-block',
            }}
          />
          <span>-5° OTH</span>
        </span>
        {!isCompact && (
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
    </div>
  );
}

function pulseWaveStartMsExpired(startMs: number | null, nowMs: number): boolean {
  return startMs !== null && nowMs - startMs >= PULSE_WAVE_DURATION_MS;
}

function drawPolarTrail(
  ctx: CanvasRenderingContext2D,
  points: Array<{ x: number; y: number }>,
  color: string,
  maxSegmentLengthPx: number
): void {
  if (points.length < 2) return;
  for (let i = 1; i < points.length; i += 1) {
    const p0 = points[i - 1];
    const p1 = points[i];
    if (
      !Number.isFinite(p0.x) ||
      !Number.isFinite(p0.y) ||
      !Number.isFinite(p1.x) ||
      !Number.isFinite(p1.y)
    ) {
      continue;
    }
    if (Math.hypot(p1.x - p0.x, p1.y - p0.y) > maxSegmentLengthPx) {
      continue;
    }
    const segAlpha = (i / points.length) * 0.5;
    ctx.save();
    ctx.globalAlpha *= segAlpha;
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }
}

export default PolarSkyDome;
