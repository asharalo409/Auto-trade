// Futuristic Web Audio API oscillator synthesizer for subtle UI telemetry feedback

class TerminalAudioSynth {
  private ctx: AudioContext | null = null;
  private enabled = false;
  private lastHoverAt = 0;

  setEnabled(value: boolean) {
    this.enabled = value;
  }

  isEnabled() {
    return this.enabled;
  }

  private getContext(): AudioContext | null {
    if (!this.enabled || typeof window === 'undefined') return null;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;

    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private tone(
    freqStart: number,
    freqEnd: number,
    durationSec: number,
    type: OscillatorType,
    gainPeak: number,
    delaySec = 0
  ) {
    const ctx = this.getContext();
    if (!ctx) return;

    const now = ctx.currentTime + delaySec;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, now);
    if (freqEnd !== freqStart) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), now + durationSec);
    }

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(gainPeak, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + durationSec + 0.01);
  }

  playHover() {
    const now = performance.now();
    if (now - this.lastHoverAt < 65) return;
    this.lastHoverAt = now;
    this.tone(1180, 1420, 0.032, 'sine', 0.018);
  }

  playClick() {
    this.tone(680, 420, 0.048, 'triangle', 0.045);
  }

  playTabSwitch() {
    this.tone(520, 880, 0.055, 'sine', 0.038);
  }

  playToggle(on: boolean) {
    if (on) {
      this.tone(440, 660, 0.06, 'sine', 0.045, 0);
      this.tone(660, 990, 0.08, 'sine', 0.045, 0.05);
    } else {
      this.tone(640, 390, 0.08, 'triangle', 0.045, 0);
    }
  }

  playPowerState(engage: boolean) {
    if (engage) {
      this.tone(240, 520, 0.14, 'triangle', 0.06, 0);
      this.tone(520, 1040, 0.16, 'sine', 0.055, 0.11);
    } else {
      this.tone(540, 180, 0.18, 'triangle', 0.055, 0);
    }
  }

  playTradeChime(isProfit: boolean) {
    if (isProfit) {
      this.tone(587.33, 587.33, 0.08, 'sine', 0.04, 0);
      this.tone(880, 880, 0.14, 'sine', 0.045, 0.07);
    } else {
      this.tone(330, 260, 0.12, 'triangle', 0.04, 0);
    }
  }
}

export const audioSynth = new TerminalAudioSynth();
