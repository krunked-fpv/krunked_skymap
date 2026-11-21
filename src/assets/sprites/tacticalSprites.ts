import type maplibregl from 'maplibre-gl';
import type { SkyEntity } from '../../types/sky-contracts';

export type TacticalSpriteId =
  | 'sprite-jet-civil'
  | 'sprite-heavy-civil'
  | 'sprite-prop-civil'
  | 'sprite-heli-civil'
  | 'sprite-fast-military'
  | 'sprite-heli-military'
  | 'sprite-emergency'
  | 'sprite-satellite'
  | 'sprite-satellite-eclipsed'
  | 'sprite-balloon'
  | 'sprite-drone'
  | 'sprite-drone-breach'
  | 'sprite-operator'
  | 'sprite-observer'
  | 'sprite-reticle';

const SPRITE_SIZE = 64;
const HALO_COLOR = 'rgba(6, 9, 15, 0.92)';

function createSpriteCanvas(): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_SIZE;
  canvas.height = SPRITE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  return { canvas, ctx };
}

function registerCanvasSprite(
  map: maplibregl.Map,
  id: TacticalSpriteId,
  draw: (ctx: CanvasRenderingContext2D) => void
): void {
  const created = createSpriteCanvas();
  if (!created) return;
  const { ctx } = created;
  draw(ctx);
  const imgData = ctx.getImageData(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  if (map.hasImage(id)) {
    map.removeImage(id);
  }
  map.addImage(id, imgData, { pixelRatio: 2 });
}

function fillAndHalo(
  ctx: CanvasRenderingContext2D,
  fill: string,
  haloWidth = 3.2,
  edgeStroke?: string
): void {
  ctx.save();
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = haloWidth;
  ctx.stroke();
  ctx.fillStyle = fill;
  ctx.fill();
  if (edgeStroke) {
    ctx.strokeStyle = edgeStroke;
    ctx.lineWidth = 0.9;
    ctx.stroke();
  }
  ctx.restore();
}

function drawJetCivil(ctx: CanvasRenderingContext2D, color: string): void {
  // Sleek twin-engine commercial jet facing North (up)
  ctx.beginPath();
  ctx.moveTo(32, 7);
  ctx.lineTo(35.2, 16);
  ctx.lineTo(35.4, 24);
  ctx.lineTo(56, 36.5);
  ctx.lineTo(56, 40.5);
  ctx.lineTo(35.4, 34.5);
  ctx.lineTo(34.6, 47.5);
  ctx.lineTo(43.5, 53.5);
  ctx.lineTo(43.5, 56.5);
  ctx.lineTo(33.2, 53.5);
  ctx.lineTo(32, 57);
  ctx.lineTo(30.8, 53.5);
  ctx.lineTo(20.5, 56.5);
  ctx.lineTo(20.5, 53.5);
  ctx.lineTo(29.4, 47.5);
  ctx.lineTo(28.6, 34.5);
  ctx.lineTo(8, 40.5);
  ctx.lineTo(8, 36.5);
  ctx.lineTo(28.6, 24);
  ctx.lineTo(28.8, 16);
  ctx.closePath();
  fillAndHalo(ctx, color, 3.4, 'rgba(248, 250, 252, 0.45)');

  // Crisp centerline highlight
  ctx.beginPath();
  ctx.moveTo(32, 11);
  ctx.lineTo(32, 48);
  ctx.strokeStyle = 'rgba(248, 250, 252, 0.55)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

function drawHeavyCivil(ctx: CanvasRenderingContext2D, color: string): void {
  // Widebody four-engine airliner facing North (up)
  ctx.beginPath();
  ctx.moveTo(32, 5);
  ctx.lineTo(36, 14);
  ctx.lineTo(36.2, 22);
  ctx.lineTo(58, 35);
  ctx.lineTo(58, 39.5);
  ctx.lineTo(36.2, 33.5);
  ctx.lineTo(35.4, 47.5);
  ctx.lineTo(45.5, 54);
  ctx.lineTo(45.5, 57.5);
  ctx.lineTo(33.5, 54);
  ctx.lineTo(32, 58.5);
  ctx.lineTo(30.5, 54);
  ctx.lineTo(18.5, 57.5);
  ctx.lineTo(18.5, 54);
  ctx.lineTo(28.6, 47.5);
  ctx.lineTo(27.8, 33.5);
  ctx.lineTo(6, 39.5);
  ctx.lineTo(6, 35);
  ctx.lineTo(27.8, 22);
  ctx.lineTo(28, 14);
  ctx.closePath();
  fillAndHalo(ctx, color, 3.6, 'rgba(248, 250, 252, 0.55)');

  // Four wing-mounted nacelles
  const nacelles: Array<[number, number]> = [
    [20, 29.5],
    [13.5, 33.5],
    [44, 29.5],
    [50.5, 33.5],
  ];
  for (const [nx, ny] of nacelles) {
    ctx.beginPath();
    ctx.moveTo(nx, ny - 4);
    ctx.lineTo(nx, ny + 2.5);
    ctx.strokeStyle = '#F8FAFC';
    ctx.lineWidth = 2.4;
    ctx.stroke();
  }
}

function drawPropCivil(ctx: CanvasRenderingContext2D, color: string): void {
  // High-wing / straight-wing propeller aircraft facing North (up)
  ctx.beginPath();
  ctx.moveTo(32, 11);
  ctx.lineTo(34.5, 19);
  ctx.lineTo(34.5, 25);
  ctx.lineTo(55, 27);
  ctx.lineTo(55, 32);
  ctx.lineTo(34.5, 32);
  ctx.lineTo(33.5, 48);
  ctx.lineTo(42, 52.5);
  ctx.lineTo(42, 55.5);
  ctx.lineTo(32, 53.5);
  ctx.lineTo(22, 55.5);
  ctx.lineTo(22, 52.5);
  ctx.lineTo(30.5, 48);
  ctx.lineTo(29.5, 32);
  ctx.lineTo(9, 32);
  ctx.lineTo(9, 27);
  ctx.lineTo(29.5, 25);
  ctx.lineTo(29.5, 19);
  ctx.closePath();
  fillAndHalo(ctx, color, 3.2, 'rgba(248, 250, 252, 0.45)');

  // Spinning nose prop bar
  ctx.beginPath();
  ctx.moveTo(23.5, 9.5);
  ctx.lineTo(40.5, 9.5);
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 3.5;
  ctx.stroke();
  ctx.strokeStyle = '#E0F2FE';
  ctx.lineWidth = 1.6;
  ctx.stroke();
}

function drawHelicopter(ctx: CanvasRenderingContext2D, color: string, military: boolean): void {
  // Rotor disc aura
  ctx.beginPath();
  ctx.arc(32, 27, 21, 0, Math.PI * 2);
  ctx.strokeStyle = military ? 'rgba(245, 158, 11, 0.34)' : 'rgba(34, 211, 238, 0.32)';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // Fuselage + tailboom facing North
  ctx.beginPath();
  ctx.moveTo(32, 13);
  ctx.quadraticCurveTo(38, 16, 37.5, 28);
  ctx.lineTo(34.2, 36);
  ctx.lineTo(33.6, 54);
  ctx.lineTo(39, 55.5);
  ctx.lineTo(39, 57.5);
  ctx.lineTo(30.5, 56.5);
  ctx.lineTo(30.5, 36);
  ctx.lineTo(26.5, 28);
  ctx.quadraticCurveTo(26, 16, 32, 13);
  ctx.closePath();
  fillAndHalo(ctx, color, 3.2, 'rgba(248, 250, 252, 0.4)');

  if (military) {
    // Stubby ordnance pylons
    ctx.beginPath();
    ctx.moveTo(21, 27);
    ctx.lineTo(43, 27);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3.4;
    ctx.stroke();
  }

  // Crisp X-blade main rotor
  ctx.beginPath();
  ctx.moveTo(15, 10);
  ctx.lineTo(49, 44);
  ctx.moveTo(49, 10);
  ctx.lineTo(15, 44);
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 4.2;
  ctx.stroke();
  ctx.strokeStyle = '#F8FAFC';
  ctx.lineWidth = 1.9;
  ctx.stroke();

  // Rotor hub
  ctx.beginPath();
  ctx.arc(32, 27, 3.2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#F8FAFC';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawFastMilitary(ctx: CanvasRenderingContext2D, color: string): void {
  // Delta-wing supersonic fighter facing North (up)
  ctx.beginPath();
  ctx.moveTo(32, 6);
  ctx.lineTo(35.5, 18);
  ctx.lineTo(37.5, 24);
  ctx.lineTo(56, 42);
  ctx.lineTo(54, 46);
  ctx.lineTo(37.5, 42.5);
  ctx.lineTo(39, 52);
  ctx.lineTo(43.5, 56.5);
  ctx.lineTo(35, 55);
  ctx.lineTo(32, 51);
  ctx.lineTo(29, 55);
  ctx.lineTo(20.5, 56.5);
  ctx.lineTo(25, 52);
  ctx.lineTo(26.5, 42.5);
  ctx.lineTo(10, 46);
  ctx.lineTo(8, 42);
  ctx.lineTo(26.5, 24);
  ctx.lineTo(28.5, 18);
  ctx.closePath();
  fillAndHalo(ctx, color, 3.4, 'rgba(254, 243, 199, 0.7)');

  // Canopy glass highlight
  ctx.beginPath();
  ctx.ellipse(32, 18, 2.1, 5.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#FEF3C7';
  ctx.fill();
}

function drawEmergency(ctx: CanvasRenderingContext2D, color: string): void {
  // Alert outer octagon beacon
  ctx.beginPath();
  const r = 26;
  for (let i = 0; i < 8; i++) {
    const a = ((i * 45 + 22.5) * Math.PI) / 180;
    const x = 32 + Math.cos(a) * r;
    const y = 32 + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(239, 68, 68, 0.16)';
  ctx.fill();
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Inner sharp aircraft pointing North
  ctx.beginPath();
  ctx.moveTo(32, 12);
  ctx.lineTo(35, 22);
  ctx.lineTo(50, 34);
  ctx.lineTo(50, 38);
  ctx.lineTo(35, 33);
  ctx.lineTo(34.5, 44);
  ctx.lineTo(41, 49);
  ctx.lineTo(41, 52);
  ctx.lineTo(32, 49.5);
  ctx.lineTo(23, 52);
  ctx.lineTo(23, 49);
  ctx.lineTo(29.5, 44);
  ctx.lineTo(29, 33);
  ctx.lineTo(14, 38);
  ctx.lineTo(14, 34);
  ctx.lineTo(29, 22);
  ctx.closePath();
  fillAndHalo(ctx, color, 2.8, '#FEE2E2');
}

function drawSatellite(ctx: CanvasRenderingContext2D, color: string): void {
  // Solar array wings (left & right)
  ctx.beginPath();
  ctx.rect(6, 24, 17, 16);
  ctx.rect(41, 24, 17, 16);
  fillAndHalo(ctx, color, 3, 'rgba(250, 232, 255, 0.75)');

  // Solar panel cell lines
  ctx.beginPath();
  ctx.moveTo(11.5, 24);
  ctx.lineTo(11.5, 40);
  ctx.moveTo(17, 24);
  ctx.lineTo(17, 40);
  ctx.moveTo(47, 24);
  ctx.lineTo(47, 40);
  ctx.moveTo(52.5, 24);
  ctx.lineTo(52.5, 40);
  ctx.moveTo(6, 32);
  ctx.lineTo(58, 32);
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // Central octagonal spacecraft bus with forward directional antenna
  ctx.beginPath();
  ctx.moveTo(32, 13);
  ctx.lineTo(32, 21);
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 3.5;
  ctx.stroke();
  ctx.strokeStyle = '#FAE8FF';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(26, 21);
  ctx.lineTo(38, 21);
  ctx.lineTo(40, 27);
  ctx.lineTo(40, 37);
  ctx.lineTo(38, 43);
  ctx.lineTo(26, 43);
  ctx.lineTo(24, 37);
  ctx.lineTo(24, 27);
  ctx.closePath();
  fillAndHalo(ctx, color, 3, '#FAE8FF');

  // Nadir sensor core
  ctx.beginPath();
  ctx.arc(32, 32, 3.6, 0, Math.PI * 2);
  ctx.fillStyle = '#FDF4FF';
  ctx.fill();
}

function drawBalloon(ctx: CanvasRenderingContext2D, color: string): void {
  // Suspension shroud lines to radiosonde package
  ctx.beginPath();
  ctx.moveTo(22, 30);
  ctx.lineTo(32, 46);
  ctx.lineTo(42, 30);
  ctx.moveTo(32, 34);
  ctx.lineTo(32, 46);
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 2.8;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(209, 250, 229, 0.85)';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // Sonde payload diamond
  ctx.beginPath();
  ctx.moveTo(32, 45);
  ctx.lineTo(36.5, 50.5);
  ctx.lineTo(32, 56);
  ctx.lineTo(27.5, 50.5);
  ctx.closePath();
  fillAndHalo(ctx, '#ECFDF5', 2.6, color);

  // Spherical stratospheric balloon envelope
  ctx.beginPath();
  ctx.arc(32, 22, 13.5, 0, Math.PI * 2);
  fillAndHalo(ctx, color, 3.4, '#D1FAE5');

  // Meridian shine arc
  ctx.beginPath();
  ctx.arc(28.5, 18.5, 7, Math.PI * 1.05, Math.PI * 1.65);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawDrone(ctx: CanvasRenderingContext2D, color: string, breach: boolean): void {
  if (breach) {
    // Warning diamond halo around breaching UAS
    ctx.beginPath();
    ctx.moveTo(32, 4);
    ctx.lineTo(60, 32);
    ctx.lineTo(32, 60);
    ctx.lineTo(4, 32);
    ctx.closePath();
    ctx.fillStyle = 'rgba(251, 113, 133, 0.16)';
    ctx.fill();
    ctx.strokeStyle = HALO_COLOR;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.9;
    ctx.stroke();
  }

  // Diagonal X arms
  ctx.beginPath();
  ctx.moveTo(17, 17);
  ctx.lineTo(47, 47);
  ctx.moveTo(47, 17);
  ctx.lineTo(17, 47);
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.6;
  ctx.stroke();

  // Four quadrotor rings
  const rotors: Array<[number, number]> = [
    [16.5, 16.5],
    [47.5, 16.5],
    [16.5, 47.5],
    [47.5, 47.5],
  ];
  for (const [rx, ry] of rotors) {
    ctx.beginPath();
    ctx.arc(rx, ry, 7.2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(6, 9, 15, 0.65)';
    ctx.fill();
    ctx.strokeStyle = HALO_COLOR;
    ctx.lineWidth = 3.2;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }

  // Forward-pointing fuselage chevron (North = headingDeg)
  ctx.beginPath();
  ctx.moveTo(32, 18);
  ctx.lineTo(38, 30);
  ctx.lineTo(35.5, 41);
  ctx.lineTo(28.5, 41);
  ctx.lineTo(26, 30);
  ctx.closePath();
  fillAndHalo(ctx, color, 2.8, '#F8FAFC');
}

function drawOperator(ctx: CanvasRenderingContext2D, color: string): void {
  // Ground control station antenna arcs
  ctx.beginPath();
  ctx.arc(32, 22, 9, Math.PI * 1.15, Math.PI * 1.85);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(32, 22, 14, Math.PI * 1.2, Math.PI * 1.8);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Antenna mast
  ctx.beginPath();
  ctx.moveTo(32, 22);
  ctx.lineTo(32, 34);
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 3.5;
  ctx.stroke();
  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth = 1.8;
  ctx.stroke();

  // Transceiver base box
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(21, 34, 22, 16, 4);
  } else {
    ctx.rect(21, 34, 22, 16);
  }
  fillAndHalo(ctx, color, 3, '#E2E8F0');

  ctx.beginPath();
  ctx.arc(32, 42, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = '#0F172A';
  ctx.fill();
}

function drawObserver(ctx: CanvasRenderingContext2D, color: string): void {
  // Outer halo ring
  ctx.beginPath();
  ctx.arc(32, 32, 20, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(56, 189, 248, 0.14)';
  ctx.fill();
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Precision crosshair ticks
  ctx.beginPath();
  ctx.moveTo(32, 6);
  ctx.lineTo(32, 18);
  ctx.moveTo(32, 46);
  ctx.lineTo(32, 58);
  ctx.moveTo(6, 32);
  ctx.lineTo(18, 32);
  ctx.moveTo(46, 32);
  ctx.lineTo(58, 32);
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 3.8;
  ctx.stroke();
  ctx.strokeStyle = '#E0F2FE';
  ctx.lineWidth = 1.8;
  ctx.stroke();

  // Inner radar dot
  ctx.beginPath();
  ctx.arc(32, 32, 5.5, 0, Math.PI * 2);
  fillAndHalo(ctx, color, 2.5, '#F8FAFC');
}

function drawReticle(ctx: CanvasRenderingContext2D, color: string): void {
  const b = 10;
  const len = 14;
  ctx.beginPath();
  // Top-left
  ctx.moveTo(b, b + len);
  ctx.lineTo(b, b);
  ctx.lineTo(b + len, b);
  // Top-right
  ctx.moveTo(64 - b - len, b);
  ctx.lineTo(64 - b, b);
  ctx.lineTo(64 - b, b + len);
  // Bottom-right
  ctx.moveTo(64 - b, 64 - b - len);
  ctx.lineTo(64 - b, 64 - b);
  ctx.lineTo(64 - b - len, 64 - b);
  // Bottom-left
  ctx.moveTo(b + len, 64 - b);
  ctx.lineTo(b, 64 - b);
  ctx.lineTo(b, 64 - b - len);
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 4.2;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.stroke();
}

export function registerTacticalSprites(map: maplibregl.Map): void {
  registerCanvasSprite(map, 'sprite-jet-civil', (ctx) => drawJetCivil(ctx, '#22D3EE'));
  registerCanvasSprite(map, 'sprite-heavy-civil', (ctx) => drawHeavyCivil(ctx, '#22D3EE'));
  registerCanvasSprite(map, 'sprite-prop-civil', (ctx) => drawPropCivil(ctx, '#38BDF8'));
  registerCanvasSprite(map, 'sprite-heli-civil', (ctx) => drawHelicopter(ctx, '#22D3EE', false));
  registerCanvasSprite(map, 'sprite-fast-military', (ctx) => drawFastMilitary(ctx, '#F59E0B'));
  registerCanvasSprite(map, 'sprite-heli-military', (ctx) => drawHelicopter(ctx, '#F59E0B', true));
  registerCanvasSprite(map, 'sprite-emergency', (ctx) => drawEmergency(ctx, '#EF4444'));
  registerCanvasSprite(map, 'sprite-satellite', (ctx) => drawSatellite(ctx, '#E879F9'));
  registerCanvasSprite(map, 'sprite-satellite-eclipsed', (ctx) => drawSatellite(ctx, '#7E22CE'));
  registerCanvasSprite(map, 'sprite-balloon', (ctx) => drawBalloon(ctx, '#34D399'));
  registerCanvasSprite(map, 'sprite-drone', (ctx) => drawDrone(ctx, '#A3E635', false));
  registerCanvasSprite(map, 'sprite-drone-breach', (ctx) => drawDrone(ctx, '#FB7185', true));
  registerCanvasSprite(map, 'sprite-operator', (ctx) => drawOperator(ctx, '#94A3B8'));
  registerCanvasSprite(map, 'sprite-observer', (ctx) => drawObserver(ctx, '#38BDF8'));
  registerCanvasSprite(map, 'sprite-reticle', (ctx) => drawReticle(ctx, '#22D3EE'));
}

export function resolveSpriteForEntity(entity: SkyEntity): TacticalSpriteId {
  switch (entity.category) {
    case 'flight':
    case 'military': {
      const isEmergencySquawk =
        entity.squawk === '7700' || entity.squawk === '7600' || entity.squawk === '7500';
      if (entity.emergencyFlag || isEmergencySquawk) {
        return 'sprite-emergency';
      }
      if (entity.isMilitary || entity.category === 'military') {
        return entity.airframeClass === 'heli' ? 'sprite-heli-military' : 'sprite-fast-military';
      }
      switch (entity.airframeClass) {
        case 'heavy':
          return 'sprite-heavy-civil';
        case 'prop':
          return 'sprite-prop-civil';
        case 'heli':
          return 'sprite-heli-civil';
        case 'fast-mil':
        case 'jet':
        default:
          return 'sprite-jet-civil';
      }
    }
    case 'satellite':
      return entity.sunlit ? 'sprite-satellite' : 'sprite-satellite-eclipsed';
    case 'balloon':
      return 'sprite-balloon';
    case 'drone':
      return entity.ceilingBreach || entity.tfrBreach || Boolean(entity.emergencyFlag)
        ? 'sprite-drone-breach'
        : 'sprite-drone';
  }
}
