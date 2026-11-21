import { useSkyStore } from '../store/useSkyStore';

type AudioCueKind = 'sweep' | 'lock' | 'zenith' | 'alert';

const COOLDOWN_MS: Record<AudioCueKind, number> = {
  sweep: 900,
  lock: 180,
  zenith: 6000,
  alert: 4500,
};

const MAX_CONCURRENT_VOICES = 8;

interface AudioWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

/**
 * Procedural zero-dependency WebAudio tactical cockpit synthesizer.
 * Muted by default (`audioEnabled` & `audioVolume` read from `useSkyStore`).
 * Strictly gesture-unlocked and cooldown-throttled so tones never clip or spam.
 */
export class TacticalAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private unlocked = false;
  private unlockPending = false;
  private activeVoices = 0;
  private storeUnsub: (() => void) | null = null;
  private lastPlayedAt: Record<AudioCueKind, number> = {
    sweep: -Infinity,
    lock: -Infinity,
    zenith: -Infinity,
    alert: -Infinity,
  };

  /**
   * Creates or resumes the WebAudio graph inside a user gesture.
   * Safe to call repeatedly and never throws or rejects on unsupported browsers.
   */
  public async unlock(): Promise<void> {
    const ctx = this.ensureContext();
    if (!ctx) return;

    this.unlocked = true;

    if (ctx.state === 'suspended') {
      this.unlockPending = true;
      try {
        await ctx.resume();
      } catch {
        // Ignore browser autoplay policy errors cleanly
      } finally {
        this.unlockPending = false;
      }
    } else {
      this.unlockPending = false;
    }

    this.syncMasterGain();
  }

  /**
   * Subtle radar phosphor sweep pulse (bandpass breath + clean descending sine ping).
   */
  public playSweepPulse(): void {
    const ctx = this.prepareCue('sweep');
    if (!ctx || !this.masterGain) return;

    const now = ctx.currentTime + 0.005;

    // Clean radar ping harmonic
    this.scheduleTone({
      ctx,
      type: 'sine',
      freqStart: 980,
      freqEnd: 620,
      startTime: now,
      attackSec: 0.006,
      durationSec: 0.18,
      peakGain: 0.15,
    });

    // Subtle filtered phosphor air burst
    this.scheduleFilteredNoise({
      ctx,
      startTime: now,
      durationSec: 0.06,
      filterFreq: 1900,
      q: 4.5,
      peakGain: 0.045,
    });
  }

  /**
   * Crisp avionics HUD lock-on double chirp (pure fifth interval).
   */
  public playTargetLock(): void {
    const ctx = this.prepareCue('lock');
    if (!ctx || !this.masterGain) return;

    const now = ctx.currentTime + 0.004;

    this.scheduleTone({
      ctx,
      type: 'triangle',
      freqStart: 1046.5,
      freqEnd: 1046.5,
      startTime: now,
      attackSec: 0.004,
      durationSec: 0.055,
      peakGain: 0.12,
      lowpassHz: 2800,
    });

    this.scheduleTone({
      ctx,
      type: 'sine',
      freqStart: 1567.98,
      freqEnd: 1567.98,
      startTime: now + 0.052,
      attackSec: 0.004,
      durationSec: 0.1,
      peakGain: 0.16,
    });
  }

  /**
   * Ethereal orbital zenith overpass harmonic triad chime.
   */
  public playZenithChime(): void {
    const ctx = this.prepareCue('zenith');
    if (!ctx || !this.masterGain) return;

    const now = ctx.currentTime + 0.008;
    const partials = [
      { freq: 587.33, offset: 0, gain: 0.09, dur: 0.72 },
      { freq: 880.0, offset: 0.055, gain: 0.08, dur: 0.78 },
      { freq: 1318.51, offset: 0.115, gain: 0.065, dur: 0.85 },
    ];

    for (const p of partials) {
      this.scheduleTone({
        ctx,
        type: 'sine',
        freqStart: p.freq,
        freqEnd: p.freq,
        startTime: now + p.offset,
        attackSec: 0.024,
        durationSec: p.dur,
        peakGain: p.gain,
        lowpassHz: 2600,
      });
    }
  }

  /**
   * Controlled dual-tone tactical cockpit caution alert (emergency squawk / airspace breach).
   */
  public playAlertTone(): void {
    const ctx = this.prepareCue('alert');
    if (!ctx || !this.masterGain) return;

    const now = ctx.currentTime + 0.006;

    // Pair 1
    this.scheduleTone({
      ctx,
      type: 'triangle',
      freqStart: 880,
      freqEnd: 880,
      startTime: now,
      attackSec: 0.008,
      durationSec: 0.095,
      peakGain: 0.15,
      lowpassHz: 1850,
    });
    this.scheduleTone({
      ctx,
      type: 'triangle',
      freqStart: 659.25,
      freqEnd: 659.25,
      startTime: now + 0.1,
      attackSec: 0.008,
      durationSec: 0.11,
      peakGain: 0.14,
      lowpassHz: 1850,
    });

    // Pair 2 subtle cadence repeat
    this.scheduleTone({
      ctx,
      type: 'triangle',
      freqStart: 880,
      freqEnd: 880,
      startTime: now + 0.25,
      attackSec: 0.008,
      durationSec: 0.095,
      peakGain: 0.13,
      lowpassHz: 1850,
    });
    this.scheduleTone({
      ctx,
      type: 'triangle',
      freqStart: 659.25,
      freqEnd: 659.25,
      startTime: now + 0.35,
      attackSec: 0.008,
      durationSec: 0.14,
      peakGain: 0.12,
      lowpassHz: 1850,
    });
  }

  /**
   * Tears down the WebAudio context and resets state.
   * Subsequent `unlock()` calls cleanly re-initialize a fresh graph.
   */
  public dispose(): void {
    if (this.storeUnsub) {
      this.storeUnsub();
      this.storeUnsub = null;
    }

    if (this.masterGain) {
      try {
        this.masterGain.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.masterGain = null;
    }

    if (this.compressor) {
      try {
        this.compressor.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.compressor = null;
    }

    if (this.ctx) {
      const closing = this.ctx;
      this.ctx = null;
      if (closing.state !== 'closed') {
        closing.close().catch(() => {});
      }
    }

    this.unlocked = false;
    this.unlockPending = false;
    this.activeVoices = 0;
    this.lastPlayedAt = {
      sweep: -Infinity,
      lock: -Infinity,
      zenith: -Infinity,
      alert: -Infinity,
    };
  }

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (this.ctx && this.ctx.state !== 'closed') return this.ctx;

    const audioWin = window as AudioWindow;
    const AudioCtx = window.AudioContext ?? audioWin.webkitAudioContext;
    if (!AudioCtx) return null;

    try {
      const ctx = new AudioCtx();
      const masterGain = ctx.createGain();
      const compressor = ctx.createDynamicsCompressor();

      compressor.threshold.setValueAtTime(-14, ctx.currentTime);
      compressor.knee.setValueAtTime(12, ctx.currentTime);
      compressor.ratio.setValueAtTime(6, ctx.currentTime);
      compressor.attack.setValueAtTime(0.003, ctx.currentTime);
      compressor.release.setValueAtTime(0.15, ctx.currentTime);

      masterGain.connect(compressor);
      compressor.connect(ctx.destination);

      this.ctx = ctx;
      this.masterGain = masterGain;
      this.compressor = compressor;
      this.syncMasterGain();
      if (!this.storeUnsub) {
        this.storeUnsub = useSkyStore.subscribe((state, prev) => {
          if (
            state.audioEnabled !== prev.audioEnabled ||
            state.audioVolume !== prev.audioVolume
          ) {
            this.syncMasterGain();
          }
        });
      }
      return ctx;
    } catch {
      this.ctx = null;
      this.masterGain = null;
      this.compressor = null;
      return null;
    }
  }

  private syncMasterGain(): void {
    if (!this.ctx || !this.masterGain) return;
    const { audioEnabled, audioVolume } = useSkyStore.getState();
    const clampedVol = Math.max(0, Math.min(1, audioVolume));
    const targetGain = audioEnabled ? clampedVol * 0.55 : 0;
    this.masterGain.gain.setTargetAtTime(targetGain, this.ctx.currentTime, 0.015);
  }

  private prepareCue(kind: AudioCueKind): AudioContext | null {
    const { audioEnabled, audioVolume } = useSkyStore.getState();
    if (!audioEnabled || audioVolume <= 0) return null;
    if (this.activeVoices >= MAX_CONCURRENT_VOICES) return null;

    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (nowMs - this.lastPlayedAt[kind] < COOLDOWN_MS[kind]) {
      return null;
    }

    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') {
      return null;
    }

    if (ctx.state === 'suspended' && !this.unlocked && !this.unlockPending) {
      return null;
    }

    if (ctx.state === 'suspended' && this.unlocked && !this.unlockPending) {
      this.unlockPending = true;
      ctx.resume()
        .catch(() => {})
        .finally(() => {
          this.unlockPending = false;
        });
    }

    this.lastPlayedAt[kind] = nowMs;
    this.syncMasterGain();
    return ctx;
  }

  private scheduleTone(opts: {
    ctx: AudioContext;
    type: OscillatorType;
    freqStart: number;
    freqEnd: number;
    startTime: number;
    attackSec: number;
    durationSec: number;
    peakGain: number;
    lowpassHz?: number;
  }): void {
    if (!this.masterGain || this.activeVoices >= MAX_CONCURRENT_VOICES) return;

    const { ctx, type, freqStart, freqEnd, startTime, attackSec, durationSec, peakGain, lowpassHz } =
      opts;

    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    let filter: BiquadFilterNode | null = null;

    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, startTime);
    if (freqEnd !== freqStart) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(20, freqEnd),
        startTime + Math.max(0.02, durationSec * 0.85)
      );
    }

    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.linearRampToValueAtTime(peakGain, startTime + attackSec);
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + durationSec);

    if (lowpassHz) {
      filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(lowpassHz, startTime);
      filter.Q.setValueAtTime(1.1, startTime);
      osc.connect(filter);
      filter.connect(env);
    } else {
      osc.connect(env);
    }

    env.connect(this.masterGain);

    this.activeVoices += 1;
    osc.onended = () => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
      try {
        osc.disconnect();
        filter?.disconnect();
        env.disconnect();
      } catch {
        // Ignore cleanup errors
      }
    };

    osc.start(startTime);
    osc.stop(startTime + durationSec + 0.02);
  }

  private scheduleFilteredNoise(opts: {
    ctx: AudioContext;
    startTime: number;
    durationSec: number;
    filterFreq: number;
    q: number;
    peakGain: number;
  }): void {
    if (!this.masterGain || this.activeVoices >= MAX_CONCURRENT_VOICES) return;

    const { ctx, startTime, durationSec, filterFreq, q, peakGain } = opts;
    const frameCount = Math.max(1, Math.floor(ctx.sampleRate * durationSec));
    const buffer = ctx.createBuffer(1, frameCount, ctx.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < frameCount; i += 1) {
      channel[i] = Math.random() * 2 - 1;
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(filterFreq, startTime);
    filter.Q.setValueAtTime(q, startTime);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.linearRampToValueAtTime(peakGain, startTime + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + durationSec);

    src.connect(filter);
    filter.connect(env);
    env.connect(this.masterGain);

    this.activeVoices += 1;
    src.onended = () => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
      try {
        src.disconnect();
        filter.disconnect();
        env.disconnect();
      } catch {
        // Ignore cleanup errors
      }
    };

    src.start(startTime);
    src.stop(startTime + durationSec + 0.01);
  }
}

export const tacticalAudio = new TacticalAudioEngine();
