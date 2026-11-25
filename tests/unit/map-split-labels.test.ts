import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlightEntity, LayoutMode, SkyEntity } from '../../src/types/sky-contracts';

interface MockMapPadding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface MockMapInstance {
  handlers: Map<string, Set<(...args: unknown[]) => void>>;
  layerHandlers: Map<string, Map<string, Set<(...args: unknown[]) => void>>>;
  sources: Map<string, { data: unknown; setData: (d: unknown) => void }>;
  layers: Map<string, Record<string, unknown>>;
  images: Set<string>;
  padding: MockMapPadding;
  setPaddingCalls: MockMapPadding[];
  easeToCalls: Array<Record<string, unknown>>;
  jumpToCalls: Array<Record<string, unknown>>;
  flyToCalls: Array<Record<string, unknown>>;
  center: { lng: number; lat: number };
  zoom: number;
  projectFn: (lngLat: [number, number]) => { x: number; y: number };
  canvas: HTMLCanvasElement;
  emit: (event: string, payload?: unknown) => void;
  emitLayer: (event: string, layerId: string, payload?: unknown) => void;
}

const createdMaps: MockMapInstance[] = [];

vi.mock('maplibre-gl', () => {
  class FakeScaleControl {
    setUnit = vi.fn();
  }
  class FakeNavigationControl {}
  class FakeMap {
    handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    layerHandlers = new Map<string, Map<string, Set<(...args: unknown[]) => void>>>();
    sources = new Map<string, { data: unknown; setData: (d: unknown) => void }>();
    layers = new Map<string, Record<string, unknown>>();
    images = new Set<string>();
    padding: MockMapPadding = { top: 0, bottom: 0, left: 0, right: 0 };
    setPaddingCalls: MockMapPadding[] = [];
    easeToCalls: Array<Record<string, unknown>> = [];
    jumpToCalls: Array<Record<string, unknown>> = [];
    flyToCalls: Array<Record<string, unknown>> = [];
    center = { lng: -77.0402, lat: 38.8512 };
    zoom = 9.5;
    projectFn = ([lng, lat]: [number, number]) => ({ x: lng, y: lat });
    canvas: HTMLCanvasElement;

    constructor(opts: { center?: [number, number]; zoom?: number; container: HTMLElement }) {
      if (opts.center) {
        this.center = { lng: opts.center[0], lat: opts.center[1] };
      }
      if (typeof opts.zoom === 'number') {
        this.zoom = opts.zoom;
      }
      this.canvas = opts.container.ownerDocument.createElement('canvas');
      opts.container.appendChild(this.canvas);
      createdMaps.push(this as unknown as MockMapInstance);
    }

    addControl = vi.fn();
    resize = vi.fn(() => {
      this.emit('resize');
    });
    remove = vi.fn();
    getCanvas() {
      return this.canvas;
    }
    getZoom() {
      return this.zoom;
    }
    getCenter() {
      return this.center;
    }
    getPadding() {
      return { ...this.padding };
    }
    setPadding(pad: MockMapPadding) {
      this.padding = { ...pad };
      this.setPaddingCalls.push({ ...pad });
      return this;
    }
    easeTo(opts: Record<string, unknown>) {
      if (opts.padding && typeof opts.padding === 'object') {
        this.padding = { ...(opts.padding as MockMapPadding) };
      }
      if (Array.isArray(opts.center) && opts.center.length === 2) {
        this.center = { lng: Number(opts.center[0]), lat: Number(opts.center[1]) };
      }
      this.easeToCalls.push(opts);
      return this;
    }
    jumpTo(opts: Record<string, unknown>) {
      if (opts.padding && typeof opts.padding === 'object') {
        this.padding = { ...(opts.padding as MockMapPadding) };
      }
      if (Array.isArray(opts.center) && opts.center.length === 2) {
        this.center = { lng: Number(opts.center[0]), lat: Number(opts.center[1]) };
      }
      if (typeof opts.zoom === 'number') {
        this.zoom = opts.zoom;
      }
      this.jumpToCalls.push(opts);
      return this;
    }
    flyTo(opts: Record<string, unknown>) {
      if (opts.padding && typeof opts.padding === 'object') {
        this.padding = { ...(opts.padding as MockMapPadding) };
      }
      if (Array.isArray(opts.center) && opts.center.length === 2) {
        this.center = { lng: Number(opts.center[0]), lat: Number(opts.center[1]) };
      }
      if (typeof opts.zoom === 'number') {
        this.zoom = opts.zoom;
      }
      this.flyToCalls.push(opts);
      return this;
    }
    project(lngLat: [number, number]) {
      return this.projectFn(lngLat);
    }
    hasImage(id: string) {
      return this.images.has(id);
    }
    addImage(id: string) {
      this.images.add(id);
    }
    removeImage(id: string) {
      this.images.delete(id);
    }
    addSource(id: string, spec: { data?: unknown }) {
      const entry = {
        data: spec.data,
        setData: (next: unknown) => {
          entry.data = next;
        },
      };
      this.sources.set(id, entry);
    }
    getSource(id: string) {
      return this.sources.get(id);
    }
    addLayer(spec: { id: string }) {
      this.layers.set(spec.id, { ...spec });
    }
    getLayer(id: string) {
      return this.layers.get(id);
    }
    setLayoutProperty = vi.fn();

    on(
      event: string,
      layerOrCb: string | ((...args: unknown[]) => void),
      maybeCb?: (...args: unknown[]) => void
    ) {
      if (typeof layerOrCb === 'string' && typeof maybeCb === 'function') {
        let byLayer = this.layerHandlers.get(event);
        if (!byLayer) {
          byLayer = new Map();
          this.layerHandlers.set(event, byLayer);
        }
        let set = byLayer.get(layerOrCb);
        if (!set) {
          set = new Set();
          byLayer.set(layerOrCb, set);
        }
        set.add(maybeCb);
        return this;
      }
      if (typeof layerOrCb === 'function') {
        let set = this.handlers.get(event);
        if (!set) {
          set = new Set();
          this.handlers.set(event, set);
        }
        set.add(layerOrCb);
      }
      return this;
    }

    off(
      event: string,
      layerOrCb: string | ((...args: unknown[]) => void),
      maybeCb?: (...args: unknown[]) => void
    ) {
      if (typeof layerOrCb === 'string' && typeof maybeCb === 'function') {
        this.layerHandlers.get(event)?.get(layerOrCb)?.delete(maybeCb);
        return this;
      }
      if (typeof layerOrCb === 'function') {
        this.handlers.get(event)?.delete(layerOrCb);
      }
      return this;
    }

    emit(event: string, payload?: unknown) {
      const set = this.handlers.get(event);
      if (!set) return;
      for (const cb of set) {
        cb(payload);
      }
    }

    emitLayer(event: string, layerId: string, payload?: unknown) {
      const set = this.layerHandlers.get(event)?.get(layerId);
      if (!set) return;
      for (const cb of set) {
        cb(payload);
      }
    }
  }

  return {
    default: {
      Map: FakeMap,
      ScaleControl: FakeScaleControl,
      NavigationControl: FakeNavigationControl,
    },
    Map: FakeMap,
    ScaleControl: FakeScaleControl,
    NavigationControl: FakeNavigationControl,
  };
});

import {
  MAP_OUTER_EDGE_MARGIN_PX,
  MAP_SPLIT_SEAM_MARGIN_PX,
  MAP_SPRITE_EXCLUSION_RADIUS_PX,
  MAP_SPRITE_SEAM_CLEARANCE_PX,
  TacticalMap,
  clampMapTooltipPosition,
  computeExposedMapViewport,
  computeLayoutCameraPadding,
  isMapLabelAnchorEligible,
  isPointInExposedMapViewport,
  solveMapLabelBox,
  type LabelBox,
  type ViewportRectLike,
} from '../../src/components/map/TacticalMap';
import { liveKinematicsRegistry, useSkyStore } from '../../src/store/useSkyStore';

function makeRect(left: number, top: number, width: number, height: number): ViewportRectLike {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}

function makeTestFlight(
  id: string,
  callsign: string,
  screenX: number,
  screenY: number,
  overrides: Partial<FlightEntity> = {}
): FlightEntity {
  // Store screenX in lon and screenY in lat for deterministic mock map.project([lon, lat]) -> {x, y}
  return {
    id,
    category: 'flight',
    callsign,
    subtitle: 'B738 · N12345',
    country: 'United States',
    lat: screenY,
    lon: screenX,
    altM: 10_668,
    altBaroM: 10_668,
    speedMs: 230,
    headingDeg: 90,
    headingValid: true,
    vertRateMs: 0,
    timestampMs: Date.now(),
    topocentric: {
      azimuthDeg: 45,
      elevationDeg: 32,
      slantRangeKm: 18,
      groundDistKm: 14,
      belowHorizon: false,
    },
    trail: [],
    icaoHex: id.replace(/[^a-f0-9]/gi, '').padEnd(6, '0').slice(0, 6),
    registration: 'N12345',
    aircraftType: 'B738',
    airframeClass: 'jet',
    onGround: false,
    isMilitary: false,
    squawk: '1200',
    ...overrides,
  };
}

interface RecordedLabelCanvas {
  ctx: CanvasRenderingContext2D;
  clips: Array<{ x: number; y: number; w: number; h: number }>;
  pills: Array<{ x: number; y: number; w: number; h: number }>;
  texts: Array<{ text: string; x: number; y: number }>;
  saveCount: number;
  restoreCount: number;
  resetRecording: () => void;
}

function createRecordingLabelContext(): RecordedLabelCanvas {
  const clips: Array<{ x: number; y: number; w: number; h: number }> = [];
  const pills: Array<{ x: number; y: number; w: number; h: number }> = [];
  const texts: Array<{ text: string; x: number; y: number }> = [];
  let lastRect: { x: number; y: number; w: number; h: number } | null = null;
  let saveCount = 0;
  let restoreCount = 0;

  const makeGradient = () => ({ addColorStop: () => {} });

  const mock = {
    globalAlpha: 1,
    fillStyle: '' as string | CanvasGradient,
    strokeStyle: '' as string | CanvasGradient,
    lineWidth: 1,
    lineJoin: 'round' as CanvasLineJoin,
    lineCap: 'round' as CanvasLineCap,
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'middle' as CanvasTextBaseline,
    save: () => {
      saveCount += 1;
    },
    restore: () => {
      restoreCount += 1;
    },
    setTransform: () => {},
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    setLineDash: () => {},
    clearRect: () => {},
    fillRect: () => {},
    strokeRect: () => {},
    beginPath: () => {
      lastRect = null;
    },
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    arcTo: () => {},
    ellipse: () => {},
    quadraticCurveTo: () => {},
    bezierCurveTo: () => {},
    createLinearGradient: makeGradient,
    createRadialGradient: makeGradient,
    rect: (x: number, y: number, w: number, h: number) => {
      lastRect = { x, y, w, h };
    },
    roundRect: (x: number, y: number, w: number, h: number) => {
      pills.push({ x, y, w, h });
    },
    clip: () => {
      if (lastRect) {
        clips.push({ ...lastRect });
      }
    },
    fill: () => {},
    stroke: () => {},
    fillText: (text: string, x: number, y: number) => {
      texts.push({ text, x, y });
    },
    measureText: (text: string) => ({ width: text.length * 5.8 }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
  };

  return {
    ctx: mock as unknown as CanvasRenderingContext2D,
    clips,
    pills,
    texts,
    get saveCount() {
      return saveCount;
    },
    get restoreCount() {
      return restoreCount;
    },
    resetRecording: () => {
      clips.length = 0;
      pills.length = 0;
      texts.length = 0;
      saveCount = 0;
      restoreCount = 0;
    },
  };
}

describe('TacticalMap split camera padding & exposed viewport geometry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('computes exact fallback camera padding and exposed viewports across map, dome, mobile split (390x844, 375x667), and desktop split', () => {
    expect(computeLayoutCameraPadding('map', 390, 844)).toEqual({
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
    });
    expect(computeLayoutCameraPadding('dome', 390, 844)).toEqual({
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
    });

    // Mobile 390x844 unmeasured fallback (48%)
    const pad390 = computeLayoutCameraPadding('split', 390, 844);
    expect(pad390).toEqual({ top: 0, bottom: 405, left: 0, right: 0 });
    const vp390 = computeExposedMapViewport('split', 390, 844);
    expect(vp390.width).toBe(390);
    expect(vp390.height).toBe(439);
    expect(vp390.seam).toBe('bottom');

    // Mobile 375x667 unmeasured fallback (48%)
    const pad375 = computeLayoutCameraPadding('split', 375, 667);
    expect(pad375).toEqual({ top: 0, bottom: 320, left: 0, right: 0 });
    const vp375 = computeExposedMapViewport('split', 375, 667);
    expect(vp375.width).toBe(375);
    expect(vp375.height).toBe(347);
    expect(vp375.seam).toBe('bottom');

    // Desktop 1280x800 & 1440x900 unmeasured fallback
    const vp1280 = computeExposedMapViewport('split', 1280, 800);
    expect(vp1280.padding).toEqual({ top: 0, bottom: 0, left: 0, right: 538 });
    expect(vp1280.width).toBe(742);
    expect(vp1280.height).toBe(800);
    expect(vp1280.seam).toBe('right');

    const vp1440 = computeExposedMapViewport('split', 1440, 900);
    expect(vp1440.padding).toEqual({ top: 0, bottom: 0, left: 0, right: 605 });
    expect(vp1440.width).toBe(835);
    expect(vp1440.height).toBe(900);
    expect(vp1440.seam).toBe('right');

    // Map vs Dome exposed viewports
    expect(computeExposedMapViewport('map', 390, 844)).toMatchObject({
      width: 390,
      height: 844,
      seam: 'none',
    });
    expect(computeExposedMapViewport('dome', 390, 844)).toMatchObject({
      width: 0,
      height: 0,
      seam: 'none',
    });
    expect(computeExposedMapViewport('split', 0, 0)).toMatchObject({
      width: 0,
      height: 0,
      seam: 'none',
    });
  });

  it('dynamically measures bottom-docked mobile and right-docked desktop [data-pane="dome"] rects across tuned CSS percentages (48%..54%)', () => {
    const mobileViewports = [
      { w: 390, h: 844, topbarH: 84 },
      { w: 375, h: 667, topbarH: 84 },
      { w: 360, h: 740, topbarH: 84 },
    ];
    const domeFractions = [0.48, 0.5, 0.52, 0.54];

    for (const { w, h, topbarH } of mobileViewports) {
      const stageH = h - topbarH;
      const mapRect = makeRect(0, topbarH, w, stageH);

      for (const frac of domeFractions) {
        const domeH = stageH * frac;
        const domeTop = topbarH + (stageH - domeH);
        const domeRect = makeRect(0, domeTop, w, domeH);

        const vp = computeExposedMapViewport('split', w, stageH, { mapRect, domeRect });
        expect(vp.seam).toBe('bottom');
        expect(vp.width).toBe(w);
        // Exposed height in map-local space must never cross domeRect.top even on subpixel fractions
        expect(topbarH + vp.height).toBeLessThanOrEqual(domeRect.top + 1e-6);
        expect(vp.padding.right).toBe(0);
        expect(vp.padding.bottom).toBeGreaterThanOrEqual(Math.floor(domeH));
      }
    }

    // Desktop right-docked custom width (e.g. 45% = 576px on 1280x756 stage)
    const desktopMapRect = makeRect(0, 44, 1280, 756);
    const desktopDomeRect = makeRect(1280 - 576, 44, 576, 756);
    const desktopVp = computeExposedMapViewport('split', 1280, 756, {
      mapRect: desktopMapRect,
      domeRect: desktopDomeRect,
    });
    expect(desktopVp.seam).toBe('right');
    expect(desktopVp.width).toBe(704);
    expect(desktopVp.height).toBe(756);
    expect(desktopVp.padding).toEqual({ top: 0, bottom: 0, left: 0, right: 576 });
  });

  it('ignores stale PIP (208x208 / 320x320) and full-bleed dome rects, and honors matchMedia(<=767px) when unmeasured', () => {
    // Switching from mobile map+PIP (208x208 top-right) to split before CSS updates
    const mapRect390 = makeRect(0, 84, 390, 760);
    const staleMobilePipRect = makeRect(172, 94, 208, 208);
    const vpFromPip = computeExposedMapViewport('split', 390, 760, {
      mapRect: mapRect390,
      domeRect: staleMobilePipRect,
    });
    expect(vpFromPip.seam).toBe('bottom');
    // Must NOT accept 208px PIP height as bottom padding; falls back to 48% of 760 = 365
    expect(vpFromPip.padding.bottom).toBe(Math.round(760 * 0.48));
    expect(vpFromPip.height).toBe(760 - Math.round(760 * 0.48));

    // Switching from full-bleed dome (100% height) to split before CSS updates
    const staleFullDome = makeRect(0, 84, 390, 760);
    const vpFromFullDome = computeExposedMapViewport('split', 390, 760, {
      mapRect: mapRect390,
      domeRect: staleFullDome,
    });
    expect(vpFromFullDome.padding.bottom).toBe(Math.round(760 * 0.48));

    // Unmeasured 0x0 container on cold boot uses window.matchMedia('(max-width: 767px)')
    vi.stubGlobal('window', {
      innerWidth: 390,
      innerHeight: 844,
      matchMedia: vi.fn((q: string) => ({
        matches: q.includes('767px'),
        media: q,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    const coldBootPad = computeLayoutCameraPadding('split', 0, 0);
    expect(coldBootPad.bottom).toBe(405);
    expect(coldBootPad.right).toBe(0);
  });
});

describe('Split-seam label candidate culling & >= 8px callsign pill safety margin', () => {
  it('culls anchors inside or within sprite-radius of the mobile bottom seam and keeps >= 8px safety margin for all pills', () => {
    for (const [w, h, domeFrac] of [
      [390, 760, 0.48],
      [390, 760, 0.52],
      [375, 583, 0.48],
      [375, 583, 0.54],
    ] as const) {
      const mapRect = makeRect(0, 84, w, h);
      const domeH = h * domeFrac;
      const domeRect = makeRect(0, 84 + (h - domeH), w, domeH);
      const vp = computeExposedMapViewport('split', w, h, { mapRect, domeRect });

      // Anchors inside dome or within MAP_SPRITE_SEAM_CLEARANCE_PX of seam are culled even for mustShow/isAlert
      for (const badY of [
        vp.height + 80,
        vp.height,
        vp.height - 1,
        vp.height - MAP_SPRITE_EXCLUSION_RADIUS_PX,
        vp.height - MAP_SPRITE_SEAM_CLEARANCE_PX + 0.5,
      ]) {
        expect(isMapLabelAnchorEligible(180, badY, vp.width, vp.height, vp.seam)).toBe(false);
        expect(
          solveMapLabelBox(180, badY, 96, 15, vp.width, vp.height, vp.seam, true, true, [], [])
        ).toBeNull();
      }

      // Eligible anchor right at exact clearance threshold above the mobile split seam
      const edgeY = vp.height - MAP_SPRITE_SEAM_CLEARANCE_PX;
      expect(isMapLabelAnchorEligible(180, edgeY, vp.width, vp.height, vp.seam)).toBe(true);

      const ownSprite: LabelBox = {
        x: 180 - MAP_SPRITE_EXCLUSION_RADIUS_PX,
        y: edgeY - MAP_SPRITE_EXCLUSION_RADIUS_PX,
        w: MAP_SPRITE_EXCLUSION_RADIUS_PX * 2,
        h: MAP_SPRITE_EXCLUSION_RADIUS_PX * 2,
      };

      const normalBox = solveMapLabelBox(
        180,
        edgeY,
        96,
        15,
        vp.width,
        vp.height,
        vp.seam,
        false,
        false,
        [ownSprite],
        []
      );
      expect(normalBox).not.toBeNull();
      expect(normalBox!.y + normalBox!.h).toBeLessThanOrEqual(vp.height - 8);
      expect(normalBox!.y + normalBox!.h).toBeLessThanOrEqual(
        vp.height - MAP_SPLIT_SEAM_MARGIN_PX
      );

      // Even when surrounded by blocker pills on all sides, mustShow and isAlert never violate >= 8px seam margin
      const blockers: LabelBox[] = [
        { x: 180 + 14, y: edgeY - 12, w: 100, h: 24 },
        { x: 180 - 114, y: edgeY - 12, w: 100, h: 24 },
        { x: 130, y: edgeY - 34, w: 100, h: 24 },
        { x: 130, y: edgeY + 10, w: 100, h: 24 },
      ];

      const mustShowBox = solveMapLabelBox(
        180,
        edgeY,
        96,
        15,
        vp.width,
        vp.height,
        vp.seam,
        true,
        false,
        [ownSprite],
        blockers
      );
      expect(mustShowBox).not.toBeNull();
      expect(mustShowBox!.x).toBeGreaterThanOrEqual(MAP_OUTER_EDGE_MARGIN_PX);
      expect(mustShowBox!.x + mustShowBox!.w).toBeLessThanOrEqual(
        vp.width - MAP_OUTER_EDGE_MARGIN_PX
      );
      expect(mustShowBox!.y).toBeGreaterThanOrEqual(MAP_OUTER_EDGE_MARGIN_PX);
      expect(mustShowBox!.y + mustShowBox!.h).toBeLessThanOrEqual(vp.height - 8);
      expect(mustShowBox!.y + mustShowBox!.h).toBeLessThanOrEqual(
        vp.height - MAP_SPLIT_SEAM_MARGIN_PX
      );

      // Near bottom-right corner of mobile exposed map
      const cornerMustShow = solveMapLabelBox(
        vp.width - 12,
        edgeY,
        104,
        15,
        vp.width,
        vp.height,
        vp.seam,
        true,
        true,
        [],
        blockers
      );
      expect(cornerMustShow).not.toBeNull();
      expect(cornerMustShow!.x + cornerMustShow!.w).toBeLessThanOrEqual(
        vp.width - MAP_OUTER_EDGE_MARGIN_PX
      );
      expect(cornerMustShow!.y + cornerMustShow!.h).toBeLessThanOrEqual(
        vp.height - MAP_SPLIT_SEAM_MARGIN_PX
      );
    }
  });

  it('culls anchors inside or within sprite-radius of the desktop right split seam and keeps >= 8px right margin', () => {
    const vp = computeExposedMapViewport('split', 1280, 800);
    expect(vp.seam).toBe('right');

    expect(
      isMapLabelAnchorEligible(vp.width - 8, 300, vp.width, vp.height, vp.seam)
    ).toBe(false);
    expect(
      solveMapLabelBox(vp.width - 8, 300, 96, 15, vp.width, vp.height, vp.seam, true, true, [], [])
    ).toBeNull();

    const edgeX = vp.width - MAP_SPRITE_SEAM_CLEARANCE_PX;
    const ownSprite: LabelBox = {
      x: edgeX - MAP_SPRITE_EXCLUSION_RADIUS_PX,
      y: 300 - MAP_SPRITE_EXCLUSION_RADIUS_PX,
      w: MAP_SPRITE_EXCLUSION_RADIUS_PX * 2,
      h: MAP_SPRITE_EXCLUSION_RADIUS_PX * 2,
    };

    const placed = solveMapLabelBox(
      edgeX,
      300,
      96,
      15,
      vp.width,
      vp.height,
      vp.seam,
      false,
      false,
      [ownSprite],
      []
    );
    expect(placed).not.toBeNull();
    expect(placed!.x + placed!.w).toBeLessThanOrEqual(vp.width - MAP_SPLIT_SEAM_MARGIN_PX);

    // Crowded mustShow right against the right split seam
    const crowdedMustShow = solveMapLabelBox(
      edgeX,
      300,
      96,
      15,
      vp.width,
      vp.height,
      vp.seam,
      true,
      false,
      [ownSprite],
      [
        { x: edgeX - 115, y: 290, w: 105, h: 22 },
        { x: edgeX - 55, y: 268, w: 105, h: 22 },
        { x: edgeX - 55, y: 312, w: 105, h: 22 },
      ]
    );
    expect(crowdedMustShow).not.toBeNull();
    expect(crowdedMustShow!.x + crowdedMustShow!.w).toBeLessThanOrEqual(vp.width - 8);
    expect(crowdedMustShow!.x + crowdedMustShow!.w).toBeLessThanOrEqual(
      vp.width - MAP_SPLIT_SEAM_MARGIN_PX
    );
  });
});

describe('Map hover/tap tooltip clamping & dome-region suppression on 390x844 and 375x667', () => {
  it('strictly clamps tooltips inside unobstructed mobile split viewports and suppresses hits inside .stage-dome-pane', () => {
    const scenarios = [
      { name: '390x844 full', w: 390, h: 844, domeFrac: 0.48 },
      { name: '390x760 stage 52% dome', w: 390, h: 760, domeFrac: 0.52 },
      { name: '375x667 full', w: 375, h: 667, domeFrac: 0.48 },
      { name: '375x583 stage 54% dome', w: 375, h: 583, domeFrac: 0.54 },
    ];

    for (const sc of scenarios) {
      const mapRect = makeRect(0, 84, sc.w, sc.h);
      const domeH = sc.h * sc.domeFrac;
      const domeTopLocal = sc.h - domeH;
      const domeRect = makeRect(0, 84 + domeTopLocal, sc.w, domeH);
      const vp = computeExposedMapViewport('split', sc.w, sc.h, { mapRect, domeRect });

      // Hits at or inside .stage-dome-pane are suppressed
      expect(isPointInExposedMapViewport(160, vp.height, vp.width, vp.height)).toBe(false);
      expect(
        clampMapTooltipPosition(160, vp.height, 'split', sc.w, sc.h, { mapRect, domeRect }).visible
      ).toBe(false);
      expect(
        clampMapTooltipPosition(160, vp.height + 90, 'split', sc.w, sc.h, { mapRect, domeRect })
          .visible
      ).toBe(false);

      // Sweep grid of unobstructed points across top, middle, and 1px above split seam
      for (const px of [2, 80, sc.w / 2, sc.w - 40, sc.w - 2]) {
        for (const py of [2, 60, vp.height / 2, vp.height - 30, vp.height - 1]) {
          const tip = clampMapTooltipPosition(px, py, 'split', sc.w, sc.h, {
            mapRect,
            domeRect,
          });
          expect(tip.visible, `${sc.name} (${px},${py}) visible`).toBe(true);
          expect(tip.left, `${sc.name} left >= 8`).toBeGreaterThanOrEqual(8);
          expect(
            tip.left + tip.width,
            `${sc.name} right <= exposedWidth - 8`
          ).toBeLessThanOrEqual(vp.width - 8);
          expect(tip.top, `${sc.name} top >= 8`).toBeGreaterThanOrEqual(8);
          expect(
            tip.top + tip.maxHeight,
            `${sc.name} bottom <= exposedHeight - 10`
          ).toBeLessThanOrEqual(vp.height - 10);
          // Also strictly above actual fractional domeTopLocal
          expect(tip.top + tip.maxHeight).toBeLessThanOrEqual(domeTopLocal - 9);
        }
      }

      // Dome layout always hides map tooltip
      expect(clampMapTooltipPosition(100, 100, 'dome', sc.w, sc.h).visible).toBe(false);
    }
  });
});

describe('TacticalMap component integration — canvas clip, dynamic dome ResizeObserver, breakpoint & hover suppression', () => {
  let savedWindow: unknown;
  let savedDocument: unknown;
  let savedResizeObserver: unknown;

  beforeEach(() => {
    createdMaps.length = 0;
    liveKinematicsRegistry.entities.clear();
    liveKinematicsRegistry.version = 1;
    savedWindow = (globalThis as Record<string, unknown>).window;
    savedDocument = (globalThis as Record<string, unknown>).document;
    savedResizeObserver = (globalThis as Record<string, unknown>).ResizeObserver;
  });

  afterEach(() => {
    liveKinematicsRegistry.entities.clear();
    vi.restoreAllMocks();
    if (savedWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = savedWindow;
    }
    if (savedDocument === undefined) {
      delete (globalThis as Record<string, unknown>).document;
    } else {
      (globalThis as Record<string, unknown>).document = savedDocument;
    }
    if (savedResizeObserver === undefined) {
      delete (globalThis as Record<string, unknown>).ResizeObserver;
    } else {
      (globalThis as Record<string, unknown>).ResizeObserver = savedResizeObserver;
    }
  });

  it('hard-clips labelCanvas, culls seam targets, syncs dome ResizeObserver + matchMedia + split rAF, and suppresses dome-region tooltips', async () => {
    const { JSDOM } = await import('jsdom');
    const React = await import('react');
    const { act } = React;
    const { createRoot } = await import('react-dom/client');

    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://krunked-fpv.github.io/krunked_skymap/#layout=split',
      pretendToBeVisual: true,
    });

    let viewportW = 390;
    let viewportH = 844;
    const topbarH = 84;
    let domeFraction = 0.52; // Simulates @skydome-ui tuned 52% mobile dome height!
    let stageLayoutAttr: LayoutMode = 'split';

    const mqlListeners = new Set<() => void>();
    const resizeObservers: Array<{
      cb: ResizeObserverCallback;
      targets: Set<Element>;
    }> = [];

    class FakeResizeObserver {
      targets = new Set<Element>();
      cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
        resizeObservers.push({ cb, targets: this.targets });
      }
      observe(el: Element) {
        this.targets.add(el);
      }
      unobserve(el: Element) {
        this.targets.delete(el);
      }
      disconnect() {
        this.targets.clear();
      }
    }

    Object.defineProperty(dom.window, 'innerWidth', {
      configurable: true,
      get: () => viewportW,
    });
    Object.defineProperty(dom.window, 'innerHeight', {
      configurable: true,
      get: () => viewportH,
    });
    Object.defineProperty(dom.window, 'devicePixelRatio', {
      configurable: true,
      value: 2,
    });

    (dom.window as unknown as Record<string, unknown>).WebGLRenderingContext = function WebGL() {};
    (dom.window as unknown as Record<string, unknown>).ResizeObserver = FakeResizeObserver;
    (dom.window as unknown as Record<string, unknown>).matchMedia = (query: string) => ({
      matches: query.includes('767px') ? viewportW <= 767 : false,
      media: query,
      addEventListener: (_ev: string, cb: () => void) => mqlListeners.add(cb),
      removeEventListener: (_ev: string, cb: () => void) => mqlListeners.delete(cb),
    });

    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as Record<string, unknown>).window = dom.window;
    (globalThis as Record<string, unknown>).document = dom.window.document;
    (globalThis as Record<string, unknown>).ResizeObserver = FakeResizeObserver;

    const recorder = createRecordingLabelContext();
    const spriteRecorder = createRecordingLabelContext();
    const origGetContext = dom.window.HTMLCanvasElement.prototype.getContext;
    dom.window.HTMLCanvasElement.prototype.getContext = function mockGetContext(
      this: HTMLCanvasElement,
      contextId: string
    ) {
      if (contextId === 'webgl2' || contextId === 'webgl' || contextId === 'experimental-webgl') {
        return {
          getExtension: () => ({ loseContext: () => {} }),
        } as unknown as RenderingContext;
      }
      if (contextId === '2d') {
        return (
          this.getAttribute('aria-hidden') === 'true' ? recorder.ctx : spriteRecorder.ctx
        ) as unknown as RenderingContext;
      }
      return origGetContext.call(this, contextId as never);
    } as typeof dom.window.HTMLCanvasElement.prototype.getContext;

    // Build realistic .skymap-stage with [data-pane="map"] and [data-pane="dome"]
    const rootHost = dom.window.document.getElementById('root')!;
    const stageEl = dom.window.document.createElement('main');
    stageEl.className = 'skymap-stage';
    stageEl.setAttribute('data-layout', stageLayoutAttr);
    const mapPaneEl = dom.window.document.createElement('section');
    mapPaneEl.setAttribute('data-pane', 'map');
    const domePaneEl = dom.window.document.createElement('section');
    domePaneEl.setAttribute('data-pane', 'dome');
    stageEl.appendChild(mapPaneEl);
    stageEl.appendChild(domePaneEl);
    rootHost.appendChild(stageEl);

    const getStageH = () => viewportH - topbarH;
    const getMapDomRect = (): DOMRect => {
      const stageH = getStageH();
      return {
        x: 0,
        y: topbarH,
        left: 0,
        top: topbarH,
        right: viewportW,
        bottom: viewportH,
        width: viewportW,
        height: stageH,
        toJSON: () => ({}),
      } as DOMRect;
    };

    const getDomeDomRect = (): DOMRect => {
      const stageH = getStageH();
      if (stageEl.getAttribute('data-layout') === 'map') {
        // 208x208 PIP rect in map mode
        return {
          x: viewportW - 218,
          y: topbarH + 10,
          left: viewportW - 218,
          top: topbarH + 10,
          right: viewportW - 10,
          bottom: topbarH + 218,
          width: 208,
          height: 208,
          toJSON: () => ({}),
        } as DOMRect;
      }
      if (viewportW <= 767) {
        const dH = stageH * domeFraction;
        const dTop = topbarH + (stageH - dH);
        return {
          x: 0,
          y: dTop,
          left: 0,
          top: dTop,
          right: viewportW,
          bottom: viewportH,
          width: viewportW,
          height: dH,
          toJSON: () => ({}),
        } as DOMRect;
      }
      const dW = Math.round(Math.min(680, Math.max(340, viewportW * 0.42)));
      return {
        x: viewportW - dW,
        y: topbarH,
        left: viewportW - dW,
        top: topbarH,
        right: viewportW,
        bottom: viewportH,
        width: dW,
        height: stageH,
        toJSON: () => ({}),
      } as DOMRect;
    };

    mapPaneEl.getBoundingClientRect = getMapDomRect;
    domePaneEl.getBoundingClientRect = getDomeDomRect;

    useSkyStore.setState({
      layout: 'split',
      mapLabelsEnabled: true,
      selectedId: 'flight:sel-seam',
      hoveredId: null,
      observer: {
        lat: 38.8512,
        lon: -77.0402,
        altM: 12,
        label: 'DC',
        source: 'url',
      },
      layers: {
        flight: true,
        military: true,
        satellite: true,
        balloon: true,
        drone: true,
      },
    });

    // Populate entities on 390x760 stage (52% dome -> exposedHeight = 364):
    // 1. Safe upper entity at y=140 -> MUST draw
    // 2. Eligible near-seam alert entity at y=348 (16px above 364) -> MUST draw with y+h <= 354
    // 3. Selected entity straddling seam at y=356 (8px above 364, within 14px sprite clearance) -> MUST CULL
    // 4. Entity inside dome region at y=510 -> MUST CULL
    const eSafe = makeTestFlight('flight:safe', 'DAL123', 120, 140);
    const eNearSeamAlert = makeTestFlight('flight:alert-near', 'SQK7700', 180, 348, {
      squawk: '7700',
      emergencyFlag: 'EMERGENCY',
    });
    const eStraddleSelected = makeTestFlight('flight:sel-seam', 'UAL999', 200, 356);
    const eInsideDome = makeTestFlight('flight:in-dome', 'AAL404', 160, 510);

    const entities: SkyEntity[] = [
      eSafe,
      eNearSeamAlert,
      eStraddleSelected,
      eInsideDome,
    ];
    for (const ent of entities) {
      liveKinematicsRegistry.entities.set(ent.id, ent);
    }
    liveKinematicsRegistry.version = 2;

    const root = createRoot(mapPaneEl);
    await act(async () => {
      root.render(React.createElement(TacticalMap));
    });

    // Patch inner TacticalMap container div rect and clientWidth/Height
    const innerMapDiv = mapPaneEl.querySelector('[aria-label="Tactical Airspace Map"]') as HTMLDivElement;
    expect(innerMapDiv).not.toBeNull();
    innerMapDiv.getBoundingClientRect = getMapDomRect;
    Object.defineProperty(innerMapDiv, 'clientWidth', {
      configurable: true,
      get: () => viewportW,
    });
    Object.defineProperty(innerMapDiv, 'clientHeight', {
      configurable: true,
      get: () => getStageH(),
    });

    expect(createdMaps.length).toBe(1);
    const mockMap = createdMaps[0];

    // Trigger ResizeObserver on container + MapLibre load
    recorder.resetRecording();
    await act(async () => {
      for (const ro of resizeObservers) {
        if (ro.targets.has(innerMapDiv)) {
          ro.cb(
            [
              {
                target: innerMapDiv,
                contentRect: getMapDomRect(),
              } as unknown as ResizeObserverEntry,
            ],
            ro as unknown as ResizeObserver
          );
        }
      }
      mockMap.emit('load');
    });

    // 1. Camera padding dynamically measured 52% of 760 = 395.2 -> 396 bottom padding (NOT hardcoded 48% = 365!)
    expect(mockMap.padding).toEqual({ top: 0, bottom: 396, left: 0, right: 0 });
    const expectedExposedH = 760 - 396; // 364

    // 2. Canvas hard-clip called with exact unobstructed viewport (0, 0, 390, 364) and balanced save/restore
    expect(recorder.clips.length).toBeGreaterThanOrEqual(1);
    expect(recorder.clips[recorder.clips.length - 1]).toEqual({
      x: 0,
      y: 0,
      w: 390,
      h: expectedExposedH,
    });
    expect(recorder.saveCount).toBe(recorder.restoreCount);

    // 3. Only DAL123 and SQK7700 drew; UAL999 (straddling seam) and AAL404 (inside dome) were culled!
    const drawnTextJoined = recorder.texts.map((t) => t.text).join(' ');
    expect(drawnTextJoined).toContain('DAL123');
    expect(drawnTextJoined).toContain('SQK7700');
    expect(drawnTextJoined).not.toContain('UAL999');
    expect(drawnTextJoined).not.toContain('AAL404');
    for (const pill of recorder.pills) {
      expect(pill.y + pill.h).toBeLessThanOrEqual(expectedExposedH - 10);
    }

    // 4. Hover hit inside unobstructed upper map (y = 348) renders clamped tooltip strictly above dome
    await act(async () => {
      mockMap.emitLayer('mousemove', 'entities-symbol', {
        point: { x: 180, y: 348 },
        features: [{ properties: { id: 'flight:alert-near' } }],
      });
    });
    const tipEl = mapPaneEl.querySelector('[data-testid="map-hover-tooltip"]') as HTMLDivElement | null;
    expect(tipEl).not.toBeNull();
    const tipTop = Number.parseFloat(tipEl!.style.top);
    const tipMaxH = Number.parseFloat(tipEl!.style.maxHeight);
    expect(tipTop).toBeGreaterThanOrEqual(8);
    expect(tipTop + tipMaxH).toBeLessThanOrEqual(expectedExposedH - 10);

    // 5. Hover hit inside .stage-dome-pane region (y = 420 >= 364) suppresses map tooltip and clears hoveredId
    await act(async () => {
      mockMap.emitLayer('mousemove', 'entities-symbol', {
        point: { x: 160, y: 420 },
        features: [{ properties: { id: 'flight:in-dome' } }],
      });
    });
    expect(mapPaneEl.querySelector('[data-testid="map-hover-tooltip"]')).toBeNull();
    expect(useSkyStore.getState().hoveredId).toBeNull();

    // 6. Simulate [data-pane="dome"] ResizeObserver firing when CSS changes dome height to 54% on 375x667!
    viewportW = 375;
    viewportH = 667;
    domeFraction = 0.54; // stageH = 583, domeH = 314.82 -> pad.bottom = 315, exposedH = 268
    recorder.resetRecording();
    await act(async () => {
      for (const listener of mqlListeners) {
        listener();
      }
      for (const ro of resizeObservers) {
        if (ro.targets.has(domePaneEl)) {
          ro.cb([], ro as unknown as ResizeObserver);
        }
      }
    });
    expect(mockMap.padding).toEqual({ top: 0, bottom: 315, left: 0, right: 0 });
    expect(recorder.clips[recorder.clips.length - 1]).toEqual({
      x: 0,
      y: 0,
      w: 375,
      h: 268,
    });

    // 7. Simulate crossing breakpoint to 1280x800 desktop split -> switches to right padding (538px)
    viewportW = 1280;
    viewportH = 800;
    recorder.resetRecording();
    await act(async () => {
      for (const listener of mqlListeners) {
        listener();
      }
    });
    expect(mockMap.padding).toEqual({ top: 0, bottom: 0, left: 0, right: 538 });
    expect(recorder.clips[recorder.clips.length - 1]).toEqual({
      x: 0,
      y: 0,
      w: 742,
      h: 716,
    });

    await act(async () => {
      root.unmount();
    });
    dom.window.close();
  });
});
