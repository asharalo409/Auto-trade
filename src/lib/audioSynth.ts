// Refined Web Audio API synthesizer with lowpass master chain and musical harmonic voicings

class TerminalAudioSynth {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private enabled = false;
  private lastHoverAt = 0;

  setEnabled(value: boolean) {
    this.enabled = value;
  }

  isEnabled() {
    return this.enabled;
  }

  private getAudioGraph(): { ctx: AudioContext; destination: AudioNode } | null {
    if (!this.enabled || typeof window === 'undefined') return null;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;

    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioCtx) return null;
      const ctx = new AudioCtx();
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 3400;
      filter.Q.value = 0.7;

      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.knee.value = 18;
      compressor.ratio.value = 4;

      const master = ctx.createGain();
      master.gain.value = 0.85;

      filter.connect(compressor);
      compressor.connect(master);
      master.connect(ctx.destination);

      this.ctx = ctx;
      this.filter = filter;
      this.masterGain = master;
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return {
      ctx: this.ctx,
      destination: this.filter ?? this.masterGain ?? this.ctx.destination,
    };
  }

  private chimeNote(
    freqStart: number,
    freqEnd: number,
    durationSec: number,
    type: OscillatorType,
    gainPeak: number,
    delaySec = 0,
    attackSec = 0.006
  ) {
    const graph = this.getAudioGraph();
    if (!graph) return;
    const { ctx, destination } = graph;

    const now = ctx.currentTime + delaySec;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, now);
    if (freqEnd !== freqStart) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(45, freqEnd), now + durationSec);
    }

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(gainPeak, now + attackSec);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

    osc.connect(gain);
    gain.connect(destination);

    osc.start(now);
    osc.stop(now + durationSec + 0.015);
  }

  playHover() {
    const now = performance.now();
    if (now - this.lastHoverAt < 75) return;
    this.lastHoverAt = now;
    // Ultra-subtle crystalline air ping
    this.chimeNote(1318.5, 1480, 0.036, 'sine', 0.011, 0, 0.004);
  }

  playClick() {
    // Crisp glassy tap with gentle warm sub-pop
    this.chimeNote(784, 523.25, 0.042, 'sine', 0.032, 0, 0.003);
    this.chimeNote(1568, 1046.5, 0.028, 'sine', 0.014, 0, 0.002);
  }

  playTabSwitch() {
    // Smooth pentatonic crystalline bloom (G5 -> D6)
    this.chimeNote(783.99, 783.99, 0.065, 'sine', 0.024, 0, 0.005);
    this.chimeNote(1174.66, 1174.66, 0.095, 'sine', 0.022, 0.035, 0.006);
  }

  playToggle(on: boolean) {
    if (on) {
      // Uplifting C-major glassy chime (C5 -> E5 -> G5)
      this.chimeNote(523.25, 523.25, 0.08, 'sine', 0.03, 0, 0.005);
      this.chimeNote(659.25, 659.25, 0.09, 'sine', 0.028, 0.04, 0.005);
      this.chimeNote(783.99, 783.99, 0.13, 'sine', 0.032, 0.08, 0.006);
    } else {
      // Soft descending fifth (G4 -> D4)
      this.chimeNote(392.0, 392.0, 0.08, 'sine', 0.028, 0, 0.005);
      this.chimeNote(293.66, 293.66, 0.11, 'sine', 0.024, 0.045, 0.006);
    }
  }

  playPowerState(engage: boolean) {
    if (engage) {
      // Cinematic neural core warm chord swell (A3 - E4 - A4 - C#5)
      this.chimeNote(220.0, 220.0, 0.24, 'sine', 0.038, 0, 0.02);
      this.chimeNote(329.63, 329.63, 0.24, 'sine', 0.03, 0.04, 0.02);
      this.chimeNote(440.0, 440.0, 0.26, 'sine', 0.028, 0.08, 0.015);
      this.chimeNote(554.37, 554.37, 0.3, 'sine', 0.026, 0.12, 0.015);
    } else {
      // Gentle power-down harmonic sweep (E4 -> A3)
      this.chimeNote(329.63, 220.0, 0.2, 'sine', 0.032, 0, 0.01);
      this.chimeNote(220.0, 146.83, 0.22, 'sine', 0.024, 0.07, 0.015);
    }
  }

  playTradeChime(isProfit: boolean) {
    if (isProfit) {
      // Sparkling major-9th win chime (C5 - E5 - G5 - D6)
      this.chimeNote(523.25, 523.25, 0.12, 'sine', 0.03, 0, 0.005);
      this.chimeNote(659.25, 659.25, 0.14, 'sine', 0.028, 0.045, 0.005);
      this.chimeNote(783.99, 783.99, 0.16, 'sine', 0.028, 0.09, 0.005);
      this.chimeNote(1174.66, 1174.66, 0.24, 'sine', 0.026, 0.135, 0.006);
    } else {
      // Gentle muted double bell for hold/warning (F4 -> C4)
      this.chimeNote(349.23, 349.23, 0.11, 'sine', 0.026, 0, 0.006);
      this.chimeNote(261.63, 261.63, 0.16, 'sine', 0.022, 0.06, 0.008);
    }
  }
}

export const audioSynth = new TerminalAudioSynth();
