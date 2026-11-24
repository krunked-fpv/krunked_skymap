import type maplibregl from 'maplibre-gl';
import type { SkyEntity } from '../../types/sky-contracts';

export type TacticalSpriteId =
  | 'sprite-jet-civil'
  | 'sprite-heavy-civil'
  | 'sprite-prop-civil'
  | 'sprite-heli-civil'
  | 'sprite-fast-military'
  | 'sprite-heavy-military'
  | 'sprite-heli-military'
  | 'sprite-emergency'
  | 'sprite-satellite'
  | 'sprite-satellite-eclipsed'
  | 'sprite-balloon'
  | 'sprite-balloon-windborne'
  | 'sprite-drone'
  | 'sprite-drone-hale'
  | 'sprite-drone-breach'
  | 'sprite-operator'
  | 'sprite-observer'
  | 'sprite-reticle';

const SPRITE_SIZE = 96;
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
  map.addImage(id, imgData, { pixelRatio: 3 });
}

function fillAndHalo(
  ctx: CanvasRenderingContext2D,
  fill: string,
  haloWidth = 4.8,
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
    ctx.lineWidth = 1.35;
    ctx.stroke();
  }
  ctx.restore();
}

function drawJetCivil(ctx: CanvasRenderingContext2D, color: string): void {
  // Sleek twin-engine commercial jet facing North (-Y), centered at (48, 48)
  ctx.beginPath();
  ctx.moveTo(48, 10.5);
  ctx.lineTo(52.8, 24);
  ctx.lineTo(53.1, 36);
  ctx.lineTo(84, 54.75);
  ctx.lineTo(84, 60.75);
  ctx.lineTo(53.1, 51.75);
  ctx.lineTo(51.9, 71.25);
  ctx.lineTo(65.25, 80.25);
  ctx.lineTo(65.25, 84.75);
  ctx.lineTo(49.8, 80.25);
  ctx.lineTo(48, 85.5);
  ctx.lineTo(46.2, 80.25);
  ctx.lineTo(30.75, 84.75);
  ctx.lineTo(30.75, 80.25);
  ctx.lineTo(44.1, 71.25);
  ctx.lineTo(42.9, 51.75);
  ctx.lineTo(12, 60.75);
  ctx.lineTo(12, 54.75);
  ctx.lineTo(42.9, 36);
  ctx.lineTo(43.2, 24);
  ctx.closePath();
  fillAndHalo(ctx, color, 5.1, 'rgba(248, 250, 252, 0.45)');

  // Crisp centerline highlight
  ctx.beginPath();
  ctx.moveTo(48, 16.5);
  ctx.lineTo(48, 72);
  ctx.strokeStyle = 'rgba(248, 250, 252, 0.55)';
  ctx.lineWidth = 1.8;
  ctx.stroke();
}

function drawHeavyCivil(ctx: CanvasRenderingContext2D, color: string): void {
  // Widebody four-engine airliner facing North (-Y), centered at (48, 48)
  ctx.beginPath();
  ctx.moveTo(48, 7.5);
  ctx.lineTo(54, 21);
  ctx.lineTo(54.3, 33);
  ctx.lineTo(87, 52.5);
  ctx.lineTo(87, 59.25);
  ctx.lineTo(54.3, 50.25);
  ctx.lineTo(53.1, 71.25);
  ctx.lineTo(68.25, 81);
  ctx.lineTo(68.25, 86.25);
  ctx.lineTo(50.25, 81);
  ctx.lineTo(48, 88.5);
  ctx.lineTo(45.75, 81);
  ctx.lineTo(27.75, 86.25);
  ctx.lineTo(27.75, 81);
  ctx.lineTo(42.9, 71.25);
  ctx.lineTo(41.7, 50.25);
  ctx.lineTo(9, 59.25);
  ctx.lineTo(9, 52.5);
  ctx.lineTo(41.7, 33);
  ctx.lineTo(42, 21);
  ctx.closePath();
  fillAndHalo(ctx, color, 5.4, 'rgba(248, 250, 252, 0.55)');

  // Four wing-mounted nacelles
  const nacelles: Array<[number, number]> = [
    [30, 44.25],
    [20.25, 50.25],
    [66, 44.25],
    [75.75, 50.25],
  ];
  for (const [nx, ny] of nacelles) {
    ctx.beginPath();
    ctx.moveTo(nx, ny - 6);
    ctx.lineTo(nx, ny + 3.75);
    ctx.strokeStyle = '#F8FAFC';
    ctx.lineWidth = 3.6;
    ctx.stroke();
  }
}

function drawPropCivil(ctx: CanvasRenderingContext2D, color: string): void {
  // High-wing / straight-wing propeller aircraft facing North (-Y), centered at (48, 48)
  ctx.beginPath();
  ctx.moveTo(48, 16.5);
  ctx.lineTo(51.75, 28.5);
  ctx.lineTo(51.75, 37.5);
  ctx.lineTo(82.5, 40.5);
  ctx.lineTo(82.5, 48);
  ctx.lineTo(51.75, 48);
  ctx.lineTo(50.25, 72);
  ctx.lineTo(63, 78.75);
  ctx.lineTo(63, 83.25);
  ctx.lineTo(48, 80.25);
  ctx.lineTo(33, 83.25);
  ctx.lineTo(33, 78.75);
  ctx.lineTo(45.75, 72);
  ctx.lineTo(44.25, 48);
  ctx.lineTo(13.5, 48);
  ctx.lineTo(13.5, 40.5);
  ctx.lineTo(44.25, 37.5);
  ctx.lineTo(44.25, 28.5);
  ctx.closePath();
  fillAndHalo(ctx, color, 4.8, 'rgba(248, 250, 252, 0.45)');

  // Spinning nose prop bar
  ctx.beginPath();
  ctx.moveTo(35.25, 14.25);
  ctx.lineTo(60.75, 14.25);
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 5.25;
  ctx.stroke();
  ctx.strokeStyle = '#E0F2FE';
  ctx.lineWidth = 2.4;
  ctx.stroke();
}

function drawHelicopter(ctx: CanvasRenderingContext2D, color: string, military: boolean): void {
  // Rotor disc aura (centered geometrically around (48, 48) with tail stabilizer)
  ctx.beginPath();
  ctx.arc(48, 40.5, 31.5, 0, Math.PI * 2);
  ctx.strokeStyle = military ? 'rgba(245, 158, 11, 0.34)' : 'rgba(34, 211, 238, 0.32)';
  ctx.lineWidth = 2.1;
  ctx.stroke();

  // Fuselage + tailboom facing North (-Y)
  ctx.beginPath();
  ctx.moveTo(48, 19.5);
  ctx.quadraticCurveTo(57, 24, 56.25, 42);
  ctx.lineTo(51.3, 54);
  ctx.lineTo(50.4, 81);
  ctx.lineTo(58.5, 83.25);
  ctx.lineTo(58.5, 86.25);
  ctx.lineTo(45.75, 84.75);
  ctx.lineTo(45.75, 54);
  ctx.lineTo(39.75, 42);
  ctx.quadraticCurveTo(39, 24, 48, 19.5);
  ctx.closePath();
  fillAndHalo(ctx, color, 4.8, 'rgba(248, 250, 252, 0.4)');

  if (military) {
    // Stubby ordnance pylons
    ctx.beginPath();
    ctx.moveTo(31.5, 40.5);
    ctx.lineTo(64.5, 40.5);
    ctx.strokeStyle = color;
    ctx.lineWidth = 5.1;
    ctx.stroke();
  }

  // Crisp X-blade main rotor
  ctx.beginPath();
  ctx.moveTo(22.5, 15);
  ctx.lineTo(73.5, 66);
  ctx.moveTo(73.5, 15);
  ctx.lineTo(22.5, 66);
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 6.3;
  ctx.stroke();
  ctx.strokeStyle = '#F8FAFC';
  ctx.lineWidth = 2.85;
  ctx.stroke();

  // Rotor hub
  ctx.beginPath();
  ctx.arc(48, 40.5, 4.8, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#F8FAFC';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawFastMilitary(ctx: CanvasRenderingContext2D, color: string): void {
  // Delta-wing supersonic fighter facing North (-Y), centered at (48, 48)
  ctx.beginPath();
  ctx.moveTo(48, 9);
  ctx.lineTo(53.25, 27);
  ctx.lineTo(56.25, 36);
  ctx.lineTo(84, 63);
  ctx.lineTo(81, 69);
  ctx.lineTo(56.25, 63.75);
  ctx.lineTo(58.5, 78);
  ctx.lineTo(65.25, 84.75);
  ctx.lineTo(52.5, 82.5);
  ctx.lineTo(48, 76.5);
  ctx.lineTo(43.5, 82.5);
  ctx.lineTo(30.75, 84.75);
  ctx.lineTo(37.5, 78);
  ctx.lineTo(39.75, 63.75);
  ctx.lineTo(15, 69);
  ctx.lineTo(12, 63);
  ctx.lineTo(39.75, 36);
  ctx.lineTo(42.75, 27);
  ctx.closePath();
  fillAndHalo(ctx, color, 5.1, 'rgba(254, 243, 199, 0.7)');

  // Canopy glass highlight
  ctx.beginPath();
  ctx.ellipse(48, 27, 3.15, 7.8, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#FEF3C7';
  ctx.fill();
}

function drawHeavyMilitary(ctx: CanvasRenderingContext2D, color: string): void {
  // 4-engine heavy strategic tanker / airlifter facing North (-Y), centered at (48, 48)
  ctx.beginPath();
  ctx.moveTo(48, 8);
  ctx.lineTo(54.5, 21.5);
  ctx.lineTo(55, 32);
  ctx.lineTo(88, 52);
  ctx.lineTo(88, 59.5);
  ctx.lineTo(55, 51);
  ctx.lineTo(53, 73);
  ctx.lineTo(70, 81);
  ctx.lineTo(70, 86.5);
  ctx.lineTo(50.5, 81.5);
  ctx.lineTo(48, 88.5);
  ctx.lineTo(45.5, 81.5);
  ctx.lineTo(26, 86.5);
  ctx.lineTo(26, 81);
  ctx.lineTo(43, 73);
  ctx.lineTo(41, 51);
  ctx.lineTo(8, 59.5);
  ctx.lineTo(8, 52);
  ctx.lineTo(41, 32);
  ctx.lineTo(41.5, 21.5);
  ctx.closePath();
  fillAndHalo(ctx, color, 5.4, 'rgba(254, 243, 199, 0.72)');

  // Four wing-mounted strategic engine pods with dark halo separation
  const nacelles: Array<[number, number]> = [
    [30, 42.5],
    [19.5, 48.5],
    [66, 42.5],
    [76.5, 48.5],
  ];
  for (const [nx, ny] of nacelles) {
    ctx.beginPath();
    ctx.moveTo(nx, ny - 6.5);
    ctx.lineTo(nx, ny + 4);
    ctx.strokeStyle = HALO_COLOR;
    ctx.lineWidth = 5.4;
    ctx.stroke();
    ctx.strokeStyle = '#FEF3C7';
    ctx.lineWidth = 2.8;
    ctx.stroke();
  }

  // Flight-deck glass & fuselage tactical spine
  ctx.beginPath();
  ctx.ellipse(48, 19.5, 3.8, 3.2, 0, Math.PI, Math.PI * 2);
  ctx.strokeStyle = '#FEF3C7';
  ctx.lineWidth = 2.2;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(48, 25);
  ctx.lineTo(48, 73);
  ctx.strokeStyle = 'rgba(254, 243, 199, 0.6)';
  ctx.lineWidth = 1.6;
  ctx.stroke();
}

function drawEmergency(ctx: CanvasRenderingContext2D, color: string): void {
  // Alert outer octagon beacon centered at (48, 48)
  ctx.beginPath();
  const r = 39;
  for (let i = 0; i < 8; i++) {
    const a = ((i * 45 + 22.5) * Math.PI) / 180;
    const x = 48 + Math.cos(a) * r;
    const y = 48 + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(239, 68, 68, 0.16)';
  ctx.fill();
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.stroke();

  // Inner sharp aircraft pointing North (-Y), centered at (48, 48)
  ctx.beginPath();
  ctx.moveTo(48, 18);
  ctx.lineTo(52.5, 33);
  ctx.lineTo(75, 51);
  ctx.lineTo(75, 57);
  ctx.lineTo(52.5, 49.5);
  ctx.lineTo(51.75, 66);
  ctx.lineTo(61.5, 73.5);
  ctx.lineTo(61.5, 78);
  ctx.lineTo(48, 74.25);
  ctx.lineTo(34.5, 78);
  ctx.lineTo(34.5, 73.5);
  ctx.lineTo(44.25, 66);
  ctx.lineTo(43.5, 49.5);
  ctx.lineTo(21, 57);
  ctx.lineTo(21, 51);
  ctx.lineTo(43.5, 33);
  ctx.closePath();
  fillAndHalo(ctx, color, 4.2, '#FEE2E2');
}

function drawSatellite(ctx: CanvasRenderingContext2D, color: string): void {
  // Solar array wings (left & right) centered at (48, 48)
  ctx.beginPath();
  ctx.rect(9, 36, 25.5, 24);
  ctx.rect(61.5, 36, 25.5, 24);
  fillAndHalo(ctx, color, 4.5, 'rgba(250, 232, 255, 0.75)');

  // Solar panel cell lines
  ctx.beginPath();
  ctx.moveTo(17.25, 36);
  ctx.lineTo(17.25, 60);
  ctx.moveTo(25.5, 36);
  ctx.lineTo(25.5, 60);
  ctx.moveTo(70.5, 36);
  ctx.lineTo(70.5, 60);
  ctx.moveTo(78.75, 36);
  ctx.lineTo(78.75, 60);
  ctx.moveTo(9, 48);
  ctx.lineTo(87, 48);
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 2.1;
  ctx.stroke();

  // Forward directional antenna pointing strictly North (-Y)
  ctx.beginPath();
  ctx.moveTo(48, 19.5);
  ctx.lineTo(48, 31.5);
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 5.25;
  ctx.stroke();
  ctx.strokeStyle = '#FAE8FF';
  ctx.lineWidth = 2.4;
  ctx.stroke();

  // Central octagonal spacecraft bus centered at (48, 48)
  ctx.beginPath();
  ctx.moveTo(39, 31.5);
  ctx.lineTo(57, 31.5);
  ctx.lineTo(60, 40.5);
  ctx.lineTo(60, 55.5);
  ctx.lineTo(57, 64.5);
  ctx.lineTo(39, 64.5);
  ctx.lineTo(36, 55.5);
  ctx.lineTo(36, 40.5);
  ctx.closePath();
  fillAndHalo(ctx, color, 4.5, '#FAE8FF');

  // Nadir sensor core
  ctx.beginPath();
  ctx.arc(48, 48, 5.4, 0, Math.PI * 2);
  ctx.fillStyle = '#FDF4FF';
  ctx.fill();
}

function drawBalloon(ctx: CanvasRenderingContext2D, color: string): void {
  // Suspension shroud lines to radiosonde package
  ctx.beginPath();
  ctx.moveTo(33, 45);
  ctx.lineTo(48, 69);
  ctx.lineTo(63, 45);
  ctx.moveTo(48, 51);
  ctx.lineTo(48, 69);
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 4.2;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(209, 250, 229, 0.85)';
  ctx.lineWidth = 1.8;
  ctx.stroke();

  // Sonde payload diamond
  ctx.beginPath();
  ctx.moveTo(48, 67.5);
  ctx.lineTo(54.75, 75.75);
  ctx.lineTo(48, 84);
  ctx.lineTo(41.25, 75.75);
  ctx.closePath();
  fillAndHalo(ctx, '#ECFDF5', 3.9, color);

  // Spherical stratospheric balloon envelope
  ctx.beginPath();
  ctx.arc(48, 33, 20.25, 0, Math.PI * 2);
  fillAndHalo(ctx, color, 5.1, '#D1FAE5');

  // Meridian shine arc
  ctx.beginPath();
  ctx.arc(42.75, 27.75, 10.5, Math.PI * 1.05, Math.PI * 1.65);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
  ctx.lineWidth = 3;
  ctx.stroke();
}

function drawBalloonWindBorne(ctx: CanvasRenderingContext2D, color: string): void {
  // Crisp tether line from tear-drop envelope neck to smart gondola
  ctx.beginPath();
  ctx.moveTo(48, 59.5);
  ctx.lineTo(48, 71.5);
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 4.6;
  ctx.stroke();
  ctx.strokeStyle = '#A7F3D0';
  ctx.lineWidth = 1.9;
  ctx.stroke();

  // Compact instrumented WindBorne gondola package
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(40.5, 71, 15, 11.5, 3);
  } else {
    ctx.rect(40.5, 71, 15, 11.5);
  }
  fillAndHalo(ctx, '#064E3B', 4.2, '#A7F3D0');

  ctx.beginPath();
  ctx.arc(48, 76.75, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = '#34D399';
  ctx.fill();

  // Tear-drop stratospheric sounding envelope
  ctx.beginPath();
  ctx.moveTo(48, 10.5);
  ctx.bezierCurveTo(63.5, 10.5, 69, 25, 66.5, 36.5);
  ctx.bezierCurveTo(64, 48, 53.5, 55, 48, 60.5);
  ctx.bezierCurveTo(42.5, 55, 32, 48, 29.5, 36.5);
  ctx.bezierCurveTo(27, 25, 32.5, 10.5, 48, 10.5);
  ctx.closePath();
  fillAndHalo(ctx, color, 5.1, '#A7F3D0');

  // Subtle central gore seam
  ctx.beginPath();
  ctx.moveTo(48, 12);
  ctx.quadraticCurveTo(51.5, 35, 48, 58.5);
  ctx.strokeStyle = 'rgba(167, 243, 208, 0.45)';
  ctx.lineWidth = 1.35;
  ctx.stroke();

  // Specular highlight along upper-left envelope crown
  ctx.beginPath();
  ctx.moveTo(39.5, 17.5);
  ctx.quadraticCurveTo(34, 25, 36, 36.5);
  ctx.strokeStyle = '#A7F3D0';
  ctx.lineWidth = 3;
  ctx.stroke();
}

function drawDroneHale(ctx: CanvasRenderingContext2D, color: string): void {
  // Sleek swept-wing & V-tail HALE fixed-wing UAV facing North (-Y), centered at (48, 48)
  ctx.beginPath();
  ctx.moveTo(48, 10);
  ctx.quadraticCurveTo(54.5, 15, 53.2, 27);
  ctx.lineTo(52.2, 39.5);
  ctx.lineTo(89, 49.5);
  ctx.lineTo(89, 54);
  ctx.lineTo(52, 47.5);
  ctx.lineTo(51, 69);
  ctx.lineTo(64.5, 79.5);
  ctx.lineTo(64.5, 84);
  ctx.lineTo(50, 76.5);
  ctx.lineTo(48, 82);
  ctx.lineTo(46, 76.5);
  ctx.lineTo(31.5, 84);
  ctx.lineTo(31.5, 79.5);
  ctx.lineTo(45, 69);
  ctx.lineTo(44, 47.5);
  ctx.lineTo(7, 54);
  ctx.lineTo(7, 49.5);
  ctx.lineTo(43.8, 39.5);
  ctx.lineTo(42.8, 27);
  ctx.quadraticCurveTo(41.5, 15, 48, 10);
  ctx.closePath();
  fillAndHalo(ctx, color, 5.1, '#ECFCCB');

  // Forward SATCOM radome highlight & dorsal spine
  ctx.beginPath();
  ctx.ellipse(48, 21, 3.1, 6.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#ECFCCB';
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(48, 29);
  ctx.lineTo(48, 72);
  ctx.strokeStyle = 'rgba(236, 252, 203, 0.72)';
  ctx.lineWidth = 1.6;
  ctx.stroke();
}

function drawDrone(ctx: CanvasRenderingContext2D, color: string, breach: boolean): void {
  if (breach) {
    // Warning diamond halo around breaching UAS centered at (48, 48)
    ctx.beginPath();
    ctx.moveTo(48, 6);
    ctx.lineTo(90, 48);
    ctx.lineTo(48, 90);
    ctx.lineTo(6, 48);
    ctx.closePath();
    ctx.fillStyle = 'rgba(251, 113, 133, 0.16)';
    ctx.fill();
    ctx.strokeStyle = HALO_COLOR;
    ctx.lineWidth = 5.25;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.85;
    ctx.stroke();
  }

  // Diagonal X arms centered at (48, 48)
  ctx.beginPath();
  ctx.moveTo(25.5, 25.5);
  ctx.lineTo(70.5, 70.5);
  ctx.moveTo(70.5, 25.5);
  ctx.lineTo(25.5, 70.5);
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 7.5;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3.9;
  ctx.stroke();

  // Four quadrotor rings
  const rotors: Array<[number, number]> = [
    [24.75, 24.75],
    [71.25, 24.75],
    [24.75, 71.25],
    [71.25, 71.25],
  ];
  for (const [rx, ry] of rotors) {
    ctx.beginPath();
    ctx.arc(rx, ry, 10.8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(6, 9, 15, 0.65)';
    ctx.fill();
    ctx.strokeStyle = HALO_COLOR;
    ctx.lineWidth = 4.8;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.7;
    ctx.stroke();
  }

  // Forward-pointing fuselage chevron (North = headingDeg)
  ctx.beginPath();
  ctx.moveTo(48, 27);
  ctx.lineTo(57, 45);
  ctx.lineTo(53.25, 61.5);
  ctx.lineTo(42.75, 61.5);
  ctx.lineTo(39, 45);
  ctx.closePath();
  fillAndHalo(ctx, color, 4.2, '#F8FAFC');
}

function drawOperator(ctx: CanvasRenderingContext2D, color: string): void {
  // Ground control station antenna arcs
  ctx.beginPath();
  ctx.arc(48, 33, 13.5, Math.PI * 1.15, Math.PI * 1.85);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.7;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(48, 33, 21, Math.PI * 1.2, Math.PI * 1.8);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
  ctx.lineWidth = 2.25;
  ctx.stroke();

  // Antenna mast
  ctx.beginPath();
  ctx.moveTo(48, 33);
  ctx.lineTo(48, 51);
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 5.25;
  ctx.stroke();
  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth = 2.7;
  ctx.stroke();

  // Transceiver base box
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(31.5, 51, 33, 24, 6);
  } else {
    ctx.rect(31.5, 51, 33, 24);
  }
  fillAndHalo(ctx, color, 4.5, '#E2E8F0');

  ctx.beginPath();
  ctx.arc(48, 63, 3.75, 0, Math.PI * 2);
  ctx.fillStyle = '#0F172A';
  ctx.fill();
}

function drawObserver(ctx: CanvasRenderingContext2D, color: string): void {
  // Outer halo ring centered at (48, 48)
  ctx.beginPath();
  ctx.arc(48, 48, 30, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(56, 189, 248, 0.14)';
  ctx.fill();
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.stroke();

  // Precision crosshair ticks
  ctx.beginPath();
  ctx.moveTo(48, 9);
  ctx.lineTo(48, 27);
  ctx.moveTo(48, 69);
  ctx.lineTo(48, 87);
  ctx.moveTo(9, 48);
  ctx.lineTo(27, 48);
  ctx.moveTo(69, 48);
  ctx.lineTo(87, 48);
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 5.7;
  ctx.stroke();
  ctx.strokeStyle = '#E0F2FE';
  ctx.lineWidth = 2.7;
  ctx.stroke();

  // Inner radar dot
  ctx.beginPath();
  ctx.arc(48, 48, 8.25, 0, Math.PI * 2);
  fillAndHalo(ctx, color, 3.75, '#F8FAFC');
}

function drawReticle(ctx: CanvasRenderingContext2D, color: string): void {
  const b = 15;
  const len = 21;
  ctx.beginPath();
  // Top-left
  ctx.moveTo(b, b + len);
  ctx.lineTo(b, b);
  ctx.lineTo(b + len, b);
  // Top-right
  ctx.moveTo(SPRITE_SIZE - b - len, b);
  ctx.lineTo(SPRITE_SIZE - b, b);
  ctx.lineTo(SPRITE_SIZE - b, b + len);
  // Bottom-right
  ctx.moveTo(SPRITE_SIZE - b, SPRITE_SIZE - b - len);
  ctx.lineTo(SPRITE_SIZE - b, SPRITE_SIZE - b);
  ctx.lineTo(SPRITE_SIZE - b - len, SPRITE_SIZE - b);
  // Bottom-left
  ctx.moveTo(b + len, SPRITE_SIZE - b);
  ctx.lineTo(b, SPRITE_SIZE - b);
  ctx.lineTo(b, SPRITE_SIZE - b - len);
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = 6.3;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3.3;
  ctx.stroke();
}

export function registerTacticalSprites(map: maplibregl.Map): void {
  registerCanvasSprite(map, 'sprite-jet-civil', (ctx) => drawJetCivil(ctx, '#22D3EE'));
  registerCanvasSprite(map, 'sprite-heavy-civil', (ctx) => drawHeavyCivil(ctx, '#22D3EE'));
  registerCanvasSprite(map, 'sprite-prop-civil', (ctx) => drawPropCivil(ctx, '#38BDF8'));
  registerCanvasSprite(map, 'sprite-heli-civil', (ctx) => drawHelicopter(ctx, '#22D3EE', false));
  registerCanvasSprite(map, 'sprite-fast-military', (ctx) => drawFastMilitary(ctx, '#F59E0B'));
  registerCanvasSprite(map, 'sprite-heavy-military', (ctx) => drawHeavyMilitary(ctx, '#F59E0B'));
  registerCanvasSprite(map, 'sprite-heli-military', (ctx) => drawHelicopter(ctx, '#F59E0B', true));
  registerCanvasSprite(map, 'sprite-emergency', (ctx) => drawEmergency(ctx, '#EF4444'));
  registerCanvasSprite(map, 'sprite-satellite', (ctx) => drawSatellite(ctx, '#E879F9'));
  registerCanvasSprite(map, 'sprite-satellite-eclipsed', (ctx) => drawSatellite(ctx, '#7E22CE'));
  registerCanvasSprite(map, 'sprite-balloon', (ctx) => drawBalloon(ctx, '#34D399'));
  registerCanvasSprite(map, 'sprite-balloon-windborne', (ctx) =>
    drawBalloonWindBorne(ctx, '#34D399')
  );
  registerCanvasSprite(map, 'sprite-drone', (ctx) => drawDrone(ctx, '#A3E635', false));
  registerCanvasSprite(map, 'sprite-drone-hale', (ctx) => drawDroneHale(ctx, '#A3E635'));
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
        if (entity.airframeClass === 'heli') return 'sprite-heli-military';
        if (entity.airframeClass === 'heavy') return 'sprite-heavy-military';
        return 'sprite-fast-military';
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
      return entity.subSource === 'windborne' ? 'sprite-balloon-windborne' : 'sprite-balloon';
    case 'drone':
      if (entity.ceilingBreach || entity.tfrBreach || Boolean(entity.emergencyFlag)) {
        return 'sprite-drone-breach';
      }
      return entity.subSource === 'adsb-uas' || entity.uaType === 'fixed-wing'
        ? 'sprite-drone-hale'
        : 'sprite-drone';
  }
}
