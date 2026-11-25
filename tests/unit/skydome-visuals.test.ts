import { describe, expect, it } from 'vitest';
import polarDomeSourceRaw from '../../src/components/skydome/PolarSkyDome.tsx?raw';
import { projectToSkyDome } from '../../src/math/geodesy';
import {
  SKY_DOME_VAULT_STOPS,
  computeSkyDomeApertureMetrics,
  drawMoonMarker,
  getMoonVisualMetrics,
  solveDomeLabelLayout,
  type DomeLabelCandidate,
} from '../../src/components/skydome/PolarSkyDome';

interface NodeFsSubset {
  readFileSync(path: URL, encoding: 'utf8'): string;
}

async function loadNodeFs(): Promise<NodeFsSubset> {
  const mod = 'node:fs';
  return (await import(/* @vite-ignore */ mod)) as NodeFsSubset;
}

interface RecordedCanvasCall {
  op: string;
  args: unknown[];
}

function createRecordingCanvasContext(): {
  ctx: CanvasRenderingContext2D;
  calls: RecordedCanvasCall[];
  fills: string[];
  texts: Array<{ text: string; x: number; y: number }>;
  ellipses: Array<{
    rx: number;
    ry: number;
    startAngle: number;
    endAngle: number;
    anticlockwise?: boolean;
  }>;
} {
  const calls: RecordedCanvasCall[] = [];
  const fills: string[] = [];
  const texts: Array<{ text: string; x: number; y: number }> = [];
  const ellipses: Array<{
    rx: number;
    ry: number;
    startAngle: number;
    endAngle: number;
    anticlockwise?: boolean;
  }> = [];

  const rec = (op: string, ...args: unknown[]) => {
    calls.push({ op, args });
  };

  const mock = {
    globalAlpha: 1,
    fillStyle: '' as string | CanvasGradient,
    strokeStyle: '' as string | CanvasGradient,
    lineWidth: 1,
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    save: () => rec('save'),
    restore: () => rec('restore'),
    translate: (x: number, y: number) => rec('translate', x, y),
    beginPath: () => rec('beginPath'),
    closePath: () => rec('closePath'),
    moveTo: (x: number, y: number) => rec('moveTo', x, y),
    lineTo: (x: number, y: number) => rec('lineTo', x, y),
    arc: (
      x: number,
      y: number,
      radius: number,
      startAngle: number,
      endAngle: number,
      anticlockwise?: boolean
    ) => rec('arc', x, y, radius, startAngle, endAngle, anticlockwise),
    ellipse: (
      x: number,
      y: number,
      rx: number,
      ry: number,
      rotation: number,
      startAngle: number,
      endAngle: number,
      anticlockwise?: boolean
    ) => {
      rec('ellipse', x, y, rx, ry, rotation, startAngle, endAngle, anticlockwise);
      ellipses.push({ rx, ry, startAngle, endAngle, anticlockwise });
    },
    clip: () => rec('clip'),
    fill: () => {
      rec('fill');
      if (typeof mock.fillStyle === 'string') {
        fills.push(mock.fillStyle);
      }
    },
    stroke: () => rec('stroke'),
    fillText: (text: string, x: number, y: number) => {
      rec('fillText', text, x, y);
      texts.push({ text, x, y });
    },
    createRadialGradient: (
      x0: number,
      y0: number,
      r0: number,
      x1: number,
      y1: number,
      r1: number
    ) => {
      const stops: Array<{ offset: number; color: string }> = [];
      rec('createRadialGradient', x0, y0, r0, x1, y1, r1);
      return {
        addColorStop: (offset: number, color: string) => {
          stops.push({ offset, color });
        },
        stops,
      };
    },
  };

  return {
    ctx: mock as unknown as CanvasRenderingContext2D,
    calls,
    fills,
    texts,
    ellipses,
  };
}

describe('PolarSkyDome vault contrast & lunar marker visuals', () => {
  it('defines deep obsidian-cobalt vault stops that contrast boldly against the 0.30 pane backdrop', () => {
    const PANE_BACKDROP_ALPHA = 0.3;
    expect(SKY_DOME_VAULT_STOPS.length).toBeGreaterThanOrEqual(4);
    expect(SKY_DOME_VAULT_STOPS[0].offset).toBe(0);
    expect(SKY_DOME_VAULT_STOPS[SKY_DOME_VAULT_STOPS.length - 1].offset).toBe(1);

    // Center stays deep smoked-glass (~0.78) and thickens toward horizon rim (~0.90-0.95)
    expect(SKY_DOME_VAULT_STOPS[0].alpha).toBeGreaterThanOrEqual(0.75);
    expect(SKY_DOME_VAULT_STOPS[0].alpha).toBeLessThanOrEqual(0.84);
    const rimAlpha = SKY_DOME_VAULT_STOPS[SKY_DOME_VAULT_STOPS.length - 1].alpha;
    expect(rimAlpha).toBeGreaterThanOrEqual(0.9);
    expect(rimAlpha).toBeLessThan(1);

    for (let i = 0; i < SKY_DOME_VAULT_STOPS.length; i += 1) {
      const stop = SKY_DOME_VAULT_STOPS[i];
      // Every stop must be much less translucent than the 0.30 outer pane while preserving subtle glass feel
      expect(stop.alpha - PANE_BACKDROP_ALPHA).toBeGreaterThanOrEqual(0.45);
      expect(stop.alpha).toBeLessThan(1);

      const rgbaMatch = stop.color.match(
        /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\s*\)$/
      );
      expect(rgbaMatch, `Invalid rgba stop: ${stop.color}`).not.toBeNull();
      expect(Number(rgbaMatch![4])).toBeCloseTo(stop.alpha, 3);

      if (i > 0) {
        expect(stop.offset).toBeGreaterThan(SKY_DOME_VAULT_STOPS[i - 1].offset);
        expect(stop.alpha).toBeGreaterThanOrEqual(SKY_DOME_VAULT_STOPS[i - 1].alpha);
      }
    }
  });

  it('scales Moon disc, glow, and label metrics proportionally across full/split dome vs PIP', () => {
    const fullDome = getMoonVisualMetrics(320, false, 0.85, 1);
    const splitDome = getMoonVisualMetrics(230, false, 0.85, 1);
    const desktopPip = getMoonVisualMetrics(115, true, 0.85, 1);
    const mobilePip = getMoonVisualMetrics(60, true, 0.85, 1);

    // Noticeably larger than legacy 13px glyph (~9px rendered) in split & full dome
    expect(fullDome.diameterPx).toBeGreaterThanOrEqual(20);
    expect(fullDome.diameterPx).toBeLessThanOrEqual(24);
    expect(splitDome.diameterPx).toBeGreaterThanOrEqual(19);
    expect(splitDome.diameterPx).toBeLessThanOrEqual(24);

    // PIP moon is smaller than full dome yet crisp and legible, with label suppressed
    expect(desktopPip.diameterPx).toBeGreaterThanOrEqual(13.5);
    expect(desktopPip.diameterPx).toBeLessThan(fullDome.diameterPx);
    expect(mobilePip.diameterPx).toBeGreaterThanOrEqual(13.5);
    expect(desktopPip.showLabel).toBe(false);
    expect(mobilePip.showLabel).toBe(false);

    // Full/split dome shows crisp MOON label clearly spaced below the disc rim
    expect(fullDome.showLabel).toBe(true);
    expect(splitDome.showLabel).toBe(true);
    expect(fullDome.labelFontPx).toBeGreaterThanOrEqual(8);
    expect(fullDome.labelOffsetY - fullDome.discRadius).toBeGreaterThanOrEqual(7);

    // Illumination intensifies silvery aura, rim brightness, and overall alpha monotonically
    const newMoon = getMoonVisualMetrics(260, false, 0, 1);
    const quarterMoon = getMoonVisualMetrics(260, false, 0.5, 1);
    const fullMoon = getMoonVisualMetrics(260, false, 1, 1);
    expect(newMoon.glowRadius).toBeLessThan(quarterMoon.glowRadius);
    expect(quarterMoon.glowRadius).toBeLessThan(fullMoon.glowRadius);
    expect(newMoon.glowPeakAlpha).toBeLessThan(quarterMoon.glowPeakAlpha);
    expect(quarterMoon.glowPeakAlpha).toBeLessThan(fullMoon.glowPeakAlpha);
    expect(newMoon.rimAlpha).toBeLessThan(fullMoon.rimAlpha);
    expect(newMoon.markerAlpha).toBeGreaterThanOrEqual(0.7);
    expect(fullMoon.markerAlpha).toBeCloseTo(1, 5);

    // Defensive clamping on non-finite / out-of-range inputs
    const bad = getMoonVisualMetrics(Number.NaN, false, Number.NaN, -5);
    expect(Number.isFinite(bad.discRadius)).toBe(true);
    expect(bad.discRadius).toBeGreaterThan(0);
    expect(Number.isFinite(bad.glowRadius)).toBe(true);
    expect(bad.markerAlpha).toBeGreaterThan(0);
    expect(bad.markerAlpha).toBeLessThanOrEqual(1);
  });

  it('renders phase-accurate shaded Moon canvas geometry with balanced save/restore across phases', () => {
    const phases: Array<{
      name: string;
      illum: number;
      phase: number;
      pip: boolean;
      expectEllipse: boolean;
      expectAnticlockwise?: boolean;
    }> = [
      { name: 'new moon', illum: 0, phase: 0, pip: false, expectEllipse: false },
      {
        name: 'waxing crescent',
        illum: 0.2,
        phase: 0.14,
        pip: false,
        expectEllipse: true,
        expectAnticlockwise: true,
      },
      { name: 'first quarter', illum: 0.5, phase: 0.25, pip: false, expectEllipse: false },
      {
        name: 'waxing gibbous',
        illum: 0.8,
        phase: 0.36,
        pip: false,
        expectEllipse: true,
        expectAnticlockwise: false,
      },
      { name: 'full moon', illum: 1, phase: 0.5, pip: false, expectEllipse: false },
      {
        name: 'waning gibbous',
        illum: 0.78,
        phase: 0.65,
        pip: false,
        expectEllipse: true,
        expectAnticlockwise: false,
      },
      {
        name: 'waning crescent',
        illum: 0.18,
        phase: 0.86,
        pip: false,
        expectEllipse: true,
        expectAnticlockwise: true,
      },
      {
        name: 'PIP waxing gibbous',
        illum: 0.75,
        phase: 0.35,
        pip: true,
        expectEllipse: true,
        expectAnticlockwise: false,
      },
    ];

    for (const tc of phases) {
      const rec = createRecordingCanvasContext();
      drawMoonMarker(rec.ctx, 180, 140, tc.pip ? 110 : 260, tc.illum, tc.phase, 1, tc.pip);

      const saves = rec.calls.filter((c) => c.op === 'save').length;
      const restores = rec.calls.filter((c) => c.op === 'restore').length;
      expect(saves, `${tc.name}: balanced save/restore`).toBe(restores);
      expect(saves, `${tc.name}: uses save/restore`).toBeGreaterThanOrEqual(1);

      // Every phase draws outer glow gradient and crisp limb stroke
      const gradCalls = rec.calls.filter((c) => c.op === 'createRadialGradient').length;
      expect(gradCalls, `${tc.name}: glow gradient`).toBeGreaterThanOrEqual(tc.illum > 0.02 ? 2 : 1);
      expect(rec.calls.filter((c) => c.op === 'stroke').length, `${tc.name}: rim stroke`).toBe(1);

      if (tc.expectEllipse) {
        expect(rec.ellipses.length, `${tc.name}: terminator ellipse`).toBe(1);
        expect(rec.ellipses[0].rx, `${tc.name}: positive rx`).toBeGreaterThan(0);
        expect(rec.ellipses[0].ry, `${tc.name}: positive ry`).toBeGreaterThan(0);
        expect(rec.ellipses[0].anticlockwise, `${tc.name}: terminator curvature`).toBe(
          tc.expectAnticlockwise
        );
      } else {
        expect(rec.ellipses.length, `${tc.name}: no degenerate ellipse`).toBe(0);
      }

      if (tc.pip) {
        expect(rec.texts.length, `${tc.name}: hides MOON label in PIP`).toBe(0);
      } else {
        expect(rec.texts.length, `${tc.name}: renders MOON label`).toBe(1);
        expect(rec.texts[0].text).toBe('MOON');
        expect(rec.texts[0].x).toBe(0);
        expect(rec.texts[0].y).toBeGreaterThan(16);
      }
    }
  });
});

describe('PolarSkyDome safe-zone aperture geometry & HUD non-overlap invariants', () => {
  it('keeps vault bezel, lubber tick, and N/E/S/W compass badges strictly clear of top pills, bezel controls, legend, and ControlDock across mobile split viewports (390x844, 375x667, 360x740)', () => {
    const mobileViewports = [
      { name: '390x844 mobile split', vw: 390, vh: 844, minExpectedRadius: 90 },
      { name: '375x667 compact mobile split', vw: 375, vh: 667, minExpectedRadius: 45 },
      { name: '360x740 narrow mobile split', vw: 360, vh: 740, minExpectedRadius: 64 },
    ];

    for (const vp of mobileViewports) {
      // Mobile TopTelemetryBar is ~83px; .skymap-stage occupies remaining height, .stage-dome-pane is bottom 54%
      const stageH = vp.vh - 83;
      const paneH = Math.round(stageH * 0.54);
      const topHeaderBottomPx = 26; // 6px top + ~20px compact header/readout pill
      const controlDockTopPx = paneH - 96; // 8px bottom + 88px mobile .dock-pill
      const bezelControlsTopPx = paneH - (104 + 27); // bottom: 104px + 27px single-row bezel bar

      // Test both unmeasured stage fallbacks and live measured DOM HUD rects
      for (const measured of [false, true]) {
        const ap = computeSkyDomeApertureMetrics({
          width: vp.vw,
          height: paneH,
          mode: 'split',
          viewportWidth: vp.vw,
          hasStageDock: true,
          measuredTopHudBottomPx: measured ? topHeaderBottomPx : null,
          measuredBottomHudTopPx: measured
            ? Math.min(controlDockTopPx, bezelControlsTopPx)
            : null,
        });

        const tag = `${vp.name} (measured=${measured})`;
        expect(ap.isMobile, tag).toBe(true);
        expect(ap.isPip, tag).toBe(false);
        expect(ap.badgeRadius, tag).toBe(8);
        expect(ap.exteriorClearancePx, tag).toBeGreaterThanOrEqual(24);
        expect(ap.cy, tag).toBeCloseTo(ap.topInset + ap.availHeight / 2, 6);
        expect(ap.cx, tag).toBeCloseTo(ap.leftInset + ap.availWidth / 2, 6);
        expect(ap.outerRadius, tag).toBeGreaterThanOrEqual(vp.minExpectedRadius);

        // Outermost exterior pixel: cardinal compass badge stroke (`R + 8 + 2 * badgeRadius + 0.6`)
        const exteriorReach = ap.outerRadius + 8 + 2 * ap.badgeRadius + 0.6;
        const lubberTopY = ap.cy - ap.outerRadius - 6.4;
        const northBadgeTopY = ap.cy - exteriorReach;
        const southBadgeBottomY = ap.cy + exteriorReach;
        const westBadgeLeftX = ap.cx - exteriorReach;
        const eastBadgeRightX = ap.cx + exteriorReach;

        expect(lubberTopY, `${tag}: lubber clears top header`).toBeGreaterThan(topHeaderBottomPx);
        expect(northBadgeTopY, `${tag}: N badge clears top header & AZ/EL/RNG`).toBeGreaterThan(
          topHeaderBottomPx
        );
        expect(
          southBadgeBottomY,
          `${tag}: S badge clears .skydome-bezel-controls & .skydome-legend`
        ).toBeLessThan(bezelControlsTopPx);
        expect(southBadgeBottomY, `${tag}: S badge clears .control-dock-wrap`).toBeLessThan(
          controlDockTopPx
        );
        expect(westBadgeLeftX, `${tag}: W badge inside pane`).toBeGreaterThanOrEqual(ap.leftInset);
        expect(eastBadgeRightX, `${tag}: E badge inside pane`).toBeLessThanOrEqual(
          vp.vw - ap.rightInset
        );
      }

      // Also verify dynamic lift when degraded-feed `.dock-retry-banner` expands ControlDock upward
      const retryDockTopPx = paneH - 138;
      const liftedBezelTopPx = paneH - (144 + 27);
      const apDegraded = computeSkyDomeApertureMetrics({
        width: vp.vw,
        height: paneH,
        mode: 'split',
        viewportWidth: vp.vw,
        hasStageDock: true,
        measuredTopHudBottomPx: topHeaderBottomPx,
        measuredBottomHudTopPx: Math.min(retryDockTopPx, liftedBezelTopPx),
      });
      const degradedReach = apDegraded.outerRadius + 8 + 2 * apDegraded.badgeRadius + 0.6;
      expect(apDegraded.cy - degradedReach).toBeGreaterThan(topHeaderBottomPx);
      expect(apDegraded.cy + degradedReach).toBeLessThan(liftedBezelTopPx);
    }
  });

  it('computes conflict-free safe-zone geometry across mobile dome, desktop split, desktop dome, and PIP modes', () => {
    // 1. Mobile full-stage DOME mode (390x844 -> 390x761 stage)
    const mobileDome = computeSkyDomeApertureMetrics({
      width: 390,
      height: 761,
      mode: 'dome',
      viewportWidth: 390,
      hasStageDock: true,
    });
    expect(mobileDome.isMobile).toBe(true);
    expect(mobileDome.outerRadius).toBeGreaterThanOrEqual(155);
    const mobileDomeReach = mobileDome.outerRadius + 8 + 2 * mobileDome.badgeRadius + 0.6;
    expect(mobileDome.cy - mobileDomeReach).toBeGreaterThan(26);
    expect(mobileDome.cy + mobileDomeReach).toBeLessThan(761 - 131);
    expect(mobileDome.cx - mobileDomeReach).toBeGreaterThanOrEqual(6);
    expect(mobileDome.cx + mobileDomeReach).toBeLessThanOrEqual(390 - 6);

    // 2. Desktop SPLIT mode (1280x800 -> right 42% = 538x756) & short desktop split (538x600)
    for (const h of [756, 600]) {
      const desktopSplit = computeSkyDomeApertureMetrics({
        width: 538,
        height: h,
        mode: 'split',
        viewportWidth: 1280,
        hasStageDock: true,
      });
      expect(desktopSplit.isMobile).toBe(false);
      expect(desktopSplit.badgeRadius).toBe(9);
      expect(desktopSplit.exteriorClearancePx).toBeGreaterThanOrEqual(30);
      const reach = desktopSplit.outerRadius + 8 + 2 * desktopSplit.badgeRadius + 0.6;
      // Clears 2-line desktop header (~52px) and 2-row narrow-split bezel controls (~136px from bottom)
      expect(desktopSplit.cy - reach).toBeGreaterThan(52);
      expect(desktopSplit.cy + reach).toBeLessThan(h - 136);
      expect(desktopSplit.cx - reach).toBeGreaterThanOrEqual(8);
      expect(desktopSplit.cx + reach).toBeLessThanOrEqual(538 - 8);
    }

    // 3. Desktop DOME mode (1280x756)
    const desktopDome = computeSkyDomeApertureMetrics({
      width: 1280,
      height: 756,
      mode: 'dome',
      viewportWidth: 1280,
      hasStageDock: true,
    });
    const desktopDomeReach = desktopDome.outerRadius + 8 + 2 * desktopDome.badgeRadius + 0.6;
    expect(desktopDome.outerRadius).toBeGreaterThanOrEqual(240);
    expect(desktopDome.cy - desktopDomeReach).toBeGreaterThan(52);
    expect(desktopDome.cy + desktopDomeReach).toBeLessThan(756 - 98);

    // 4. Desktop PIP (320x280 canvas stage below 40px PIP header) & Mobile PIP (208x168)
    for (const [pw, ph, minR] of [
      [320, 280, 110],
      [208, 168, 56],
    ] as const) {
      const pip = computeSkyDomeApertureMetrics({
        width: pw,
        height: ph,
        mode: 'pip',
        viewportWidth: pw === 320 ? 1280 : 390,
      });
      expect(pip.isPip).toBe(true);
      expect(pip.topInset).toBe(0);
      expect(pip.bottomInset).toBe(0);
      expect(pip.cx).toBe(pw / 2);
      expect(pip.cy).toBe(ph / 2);
      expect(pip.outerRadius).toBeGreaterThanOrEqual(minR);
      const pipReach = pip.outerRadius + 8 + 2 * pip.badgeRadius + 0.6;
      expect(pip.cy - pipReach).toBeGreaterThan(0);
      expect(pip.cy + pipReach).toBeLessThan(ph);
      expect(pip.cx - pipReach).toBeGreaterThan(0);
      expect(pip.cx + pipReach).toBeLessThan(pw);
    }

    // 5. Defensive handling of degenerate / NaN inputs
    const empty = computeSkyDomeApertureMetrics({
      width: Number.NaN,
      height: -20,
      mode: 'split',
      viewportWidth: Number.NaN,
    });
    expect(empty.outerRadius).toBe(0);
    expect(Number.isFinite(empty.cx)).toBe(true);
    expect(Number.isFinite(empty.cy)).toBe(true);
  });

  it('enforces HUD safe bounds (topInset / bottomInset) and circular aperture (radius - 8) in solveDomeLabelLayout, including rim mustShow targets', () => {
    const scenarios = [
      { name: '390x844 mobile split', width: 390, height: 411, vw: 390, mode: 'split' as const },
      { name: '375x667 compact mobile split', width: 375, height: 315, vw: 375, mode: 'split' as const },
      { name: '360x740 narrow mobile split', width: 360, height: 355, vw: 360, mode: 'split' as const },
      { name: '390x844 mobile dome', width: 390, height: 761, vw: 390, mode: 'dome' as const },
      { name: '1280x800 desktop split', width: 538, height: 756, vw: 1280, mode: 'split' as const },
    ];

    for (const sc of scenarios) {
      const ap = computeSkyDomeApertureMetrics({
        width: sc.width,
        height: sc.height,
        mode: sc.mode,
        viewportWidth: sc.vw,
        hasStageDock: true,
      });

      const candidates: DomeLabelCandidate[] = [];

      // Place a selected target right on the North 0° horizon rim (closest to top header)
      const northRim = projectToSkyDome(0, 0.5, ap.cx, ap.cy, ap.outerRadius, 'hemisphere');
      candidates.push({
        id: 'selected-north-rim',
        x: northRim.x,
        y: northRim.y,
        w: 118,
        h: 14,
        elDeg: 0.5,
        slantRangeKm: 180,
        isSelected: true,
        isHovered: false,
        isEmergency: false,
        isBreach: false,
        text: 'RCH101 · 32,000 ft · 1°',
        color: '#F59E0B',
      });

      // Place a hovered target right on the South 180° horizon rim (closest to bezel controls & ControlDock)
      const southRim = projectToSkyDome(180, 0.5, ap.cx, ap.cy, ap.outerRadius, 'hemisphere');
      candidates.push({
        id: 'hovered-south-rim',
        x: southRim.x,
        y: southRim.y,
        w: 112,
        h: 14,
        elDeg: 0.5,
        slantRangeKm: 175,
        isSelected: false,
        isHovered: true,
        isEmergency: false,
        isBreach: false,
        text: 'ISS · 420 km · 1°',
        color: '#C084FC',
      });

      // Add 24 passive airborne/orbital targets distributed around all azimuths and elevations
      for (let i = 0; i < 24; i += 1) {
        const az = (i * 37) % 360;
        const el = 9 + ((i * 11) % 75);
        const pt = projectToSkyDome(az, el, ap.cx, ap.cy, ap.outerRadius, 'hemisphere');
        candidates.push({
          id: `passive-${i}`,
          x: pt.x,
          y: pt.y,
          w: sc.width <= 375 ? 58 : 76,
          h: 14,
          elDeg: el,
          slantRangeKm: 15 + i * 4,
          isSelected: false,
          isHovered: false,
          isEmergency: i === 0,
          isBreach: false,
          text: `DAL${100 + i}`,
          color: '#22D3EE',
        });
      }

      const res = solveDomeLabelLayout({
        candidates,
        width: ap.width,
        height: ap.height,
        cx: ap.cx,
        cy: ap.cy,
        radius: ap.outerRadius,
        topInset: ap.topInset,
        bottomInset: ap.bottomInset,
        leftInset: ap.leftInset,
        rightInset: ap.rightInset,
        mode: sc.mode,
        zoomMode: 'hemisphere',
        labelsEnabled: true,
      });

      const placed = res.labels.slice(0, res.count);
      expect(placed.length, `${sc.name}: places labels`).toBeGreaterThanOrEqual(2);
      expect(
        placed.some((p) => p.id === 'selected-north-rim'),
        `${sc.name}: retains mustShow north-rim target`
      ).toBe(true);
      expect(
        placed.some((p) => p.id === 'hovered-south-rim'),
        `${sc.name}: retains mustShow south-rim target`
      ).toBe(true);

      const limSq = (ap.outerRadius - 8) * (ap.outerRadius - 8) + 1e-6;
      const minX = Math.max(8, ap.leftInset);
      const maxX = ap.width - Math.max(8, ap.rightInset);
      const minY = Math.max(8, ap.topInset);
      const maxY = ap.height - Math.max(8, ap.bottomInset);

      for (let i = 0; i < placed.length; i += 1) {
        const lb = placed[i];
        expect(lb.x, `${sc.name} ${lb.id} left`).toBeGreaterThanOrEqual(minX);
        expect(lb.x + lb.w, `${sc.name} ${lb.id} right`).toBeLessThanOrEqual(maxX);
        expect(lb.y, `${sc.name} ${lb.id} clears top HUD`).toBeGreaterThanOrEqual(minY);
        expect(lb.y + lb.h, `${sc.name} ${lb.id} clears bottom HUD & dock`).toBeLessThanOrEqual(
          maxY
        );

        // Every corner of the label pill must sit strictly inside `outerRadius - 8`
        const corners: Array<[number, number]> = [
          [lb.x, lb.y],
          [lb.x + lb.w, lb.y],
          [lb.x, lb.y + lb.h],
          [lb.x + lb.w, lb.y + lb.h],
        ];
        for (const [cxPt, cyPt] of corners) {
          const d2 = (cxPt - ap.cx) * (cxPt - ap.cx) + (cyPt - ap.cy) * (cyPt - ap.cy);
          expect(d2, `${sc.name} ${lb.id} inside circular aperture`).toBeLessThanOrEqual(limSq);
        }
      }

      // Passive labels never overlap one another
      const passivePlaced = placed.filter((p) => !p.mustShow);
      for (let i = 0; i < passivePlaced.length; i += 1) {
        for (let j = i + 1; j < passivePlaced.length; j += 1) {
          const a = passivePlaced[i];
          const b = passivePlaced[j];
          const overlaps =
            a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
          expect(overlaps, `${sc.name} passive overlap ${a.id}/${b.id}`).toBe(false);
        }
      }
    }
  });

  it('aligns mobile split CSS height with MapLibre bottom-right control offset and keeps mobile bezel strip single-row', async () => {
    const fs = await loadNodeFs();
    const cockpitCssRaw = fs.readFileSync(
      new URL('../../src/styles/cockpit.css', import.meta.url),
      'utf8'
    );
    const mobileBlock = cockpitCssRaw.slice(cockpitCssRaw.indexOf('@media (max-width: 767px)'));
    const domeHeightMatch = mobileBlock.match(
      /\.skymap-stage\[data-layout='split'\]\s*\.stage-dome-pane[\s\S]*?height:\s*(\d+)%/
    );
    expect(domeHeightMatch).not.toBeNull();
    const pct = Number(domeHeightMatch![1]);
    expect(pct).toBeGreaterThanOrEqual(50);
    expect(pct).toBeLessThanOrEqual(56);

    // MapLibre bottom-right control offset matches exact mobile split dome height percentage
    expect(mobileBlock).toContain(`bottom: calc(${pct}% + 8px)`);

    // Mobile TopTelemetryBar Row 1 prevents left/right zone collision even with PWA install banner
    expect(mobileBlock).toMatch(/\.topbar-zone--left\s*\{[\s\S]*?overflow:\s*hidden/);
    expect(mobileBlock).toMatch(/\.topbar-crest\s*\{[\s\S]*?display:\s*none/);

    // Mobile bezel controls strip is strictly single-row (flex-wrap: nowrap) and separated from .skydome-legend
    expect(mobileBlock).toMatch(/\.skydome-bezel-controls[\s\S]*?flex-wrap:\s*nowrap/);
    expect(mobileBlock).toMatch(/\.skydome-readout[\s\S]*?max-width:\s*calc\(100%\s*-\s*124px\)/);
    expect(polarDomeSourceRaw).toContain('skydome-corner-title');
    expect(polarDomeSourceRaw).toContain('skydome-readout');
    expect(polarDomeSourceRaw).toContain('computeSkyDomeApertureMetrics');
  });
});
