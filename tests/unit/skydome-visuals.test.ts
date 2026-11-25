import { describe, expect, it } from 'vitest';
import {
  SKY_DOME_VAULT_STOPS,
  drawMoonMarker,
  getMoonVisualMetrics,
} from '../../src/components/skydome/PolarSkyDome';

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
