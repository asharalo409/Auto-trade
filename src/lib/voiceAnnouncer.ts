// Built-in browser sound effects (Web Audio API oscillators) and English voice
// announcements (window.speechSynthesis). Nothing here needs an API key, a network
// request or an audio file: every sound is synthesized and every word is spoken by
// the browser's own speech engine.

const STORAGE_VOICE_KEY = 'aegis_voice_enabled_v1';

const TICK_COOLDOWN_MS = 900;

function readStoredVoice(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = window.localStorage.getItem(STORAGE_VOICE_KEY);
    // Default ON: the announcer stays silent until the first user gesture unlocks
    // audio anyway, so an opt-in default would only add a click.
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

function persistVoice(value: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_VOICE_KEY, value ? 'true' : 'false');
  } catch {
    // ignore storage errors
  }
}

/** "10,000 dollars", "1 dollar and 49 cents", "minus 3 dollars and 20 cents" */
export function moneyWords(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  const negative = safe < 0;
  const totalCents = Math.round(Math.abs(safe) * 100);
  const dollars = Math.floor(totalCents / 100);
  const cents = totalCents % 100;
  const parts = [
    `${dollars.toLocaleString('en-US')} ${dollars === 1 ? 'dollar' : 'dollars'}`,
  ];
  if (cents > 0) parts.push(`${cents} ${cents === 1 ? 'cent' : 'cents'}`);
  return `${negative ? 'minus ' : ''}${parts.join(' and ')}`;
}

const COIN_NAMES: Record<string, string> = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
  BNB: 'BNB',
  XRP: 'XRP',
  ADA: 'Cardano',
  DOGE: 'Dogecoin',
  AVAX: 'Avalanche',
  LINK: 'Chainlink',
  DOT: 'Polkadot',
  MATIC: 'Polygon',
  LTC: 'Litecoin',
  TRX: 'TRON',
  TON: 'Toncoin',
  SUI: 'Sui',
  NEAR: 'NEAR',
  ARB: 'Arbitrum',
  OP: 'Optimism',
  ATOM: 'Cosmos',
  FIL: 'Filecoin',
  PEPE: 'Pepe',
  SHIB: 'Shiba Inu',
};

/** "SOLUSDT" -> "Solana", unknown symbols fall back to the bare asset ticker. */
export function coinName(pair: string): string {
  const base = String(pair || '')
    .toUpperCase()
    .replace(/(USDT|USDC|BUSD|FDUSD|USD)$/, '');
  return COIN_NAMES[base] ?? (base || 'this asset');
}

export function balanceSentence(mode: 'LIVE' | 'DEMO', amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  const cents = Math.round(Math.abs(safe) * 100) % 100;
  if (mode === 'LIVE') {
    return `Live spot balance is ${moneyWords(safe)}${cents > 0 ? ' USDT' : ''}.`;
  }
  return `Virtual demo balance is ${moneyWords(safe)}.`;
}

export function buySentence(pair: string, entryPrice: number, amountUsdt: number): string {
  return `Buy order executed on ${coinName(pair)} at ${moneyWords(
    entryPrice
  )}, size ${Math.round(amountUsdt).toLocaleString('en-US')} USDT.`;
}

export function sellSentence(
  pair: string,
  pnl: number,
  newBalance: number
): string {
  const coin = coinName(pair);
  const safePnl = Number.isFinite(pnl) ? pnl : 0;
  if (Math.abs(safePnl) < 0.005) return `Sell order closed on ${coin} at breakeven.`;
  if (safePnl > 0) {
    return `Sell order closed on ${coin} with a profit of ${moneyWords(
      safePnl
    )}. New balance is ${moneyWords(newBalance)}.`;
  }
  return `Sell order closed on ${coin} with a loss of ${moneyWords(
    Math.abs(safePnl)
  )}. New balance is ${moneyWords(newBalance)}.`;
}

export function catchUpSentence(
  tradeCount: number,
  netPnl: number,
  balance: number
): string {
  const count = Math.max(1, Math.round(tradeCount));
  const net = Number.isFinite(netPnl) ? netPnl : 0;
  return `Welcome back. ${count} trade${
    count === 1 ? '' : 's'
  } executed while you were away. ${net < 0 ? 'Net loss' : 'Net profit'} is ${moneyWords(
    Math.abs(net)
  )}. Current balance is ${moneyWords(balance)}.`;
}

class VoiceAnnouncer {
  private enabled = readStoredVoice();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private lastTickAt = 0;
  private queue: string[] = [];
  private speaking = false;
  private speechPrimed = false;
  private cachedVoice: SpeechSynthesisVoice | null = null;
  private unlockInstalled = false;

  isEnabled() {
    return this.enabled;
  }

  setEnabled(value: boolean) {
    this.enabled = value;
    persistVoice(value);
    if (!value) {
      this.queue = [];
      this.cancelSpeech();
    } else {
      this.unlock();
    }
  }

  /** Resume the AudioContext and prime speechSynthesis inside a user gesture. */
  unlock() {
    this.ensureGraph();
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    if (this.speechPrimed) return;
    this.speechPrimed = true;
    try {
      // Android Chrome only enables utterances after one has been queued from a
      // gesture; a silent, zero-length utterance is the cheapest way to do that.
      const primer = new SpeechSynthesisUtterance(' ');
      primer.volume = 0;
      window.speechSynthesis.speak(primer);
    } catch {
      // ignore unsupported primitives
    }
  }

  /** First click/touch/keypress anywhere unlocks audio for the rest of the page. */
  installUnlockHandlers() {
    if (this.unlockInstalled || typeof window === 'undefined') return;
    this.unlockInstalled = true;
    const handler = () => {
      this.unlock();
    };
    window.addEventListener('pointerdown', handler);
    window.addEventListener('touchstart', handler, { passive: true });
    window.addEventListener('keydown', handler);
  }

  private ensureGraph(): { ctx: AudioContext; destination: AudioNode } | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      const ctx = new AudioCtx();
      const master = ctx.createGain();
      master.gain.value = 0.7;
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
    }
    return { ctx: this.ctx, destination: this.master ?? this.ctx.destination };
  }

  private tone(
    freqStart: number,
    freqEnd: number,
    durationSec: number,
    gainPeak: number,
    type: OscillatorType = 'sine',
    delaySec = 0
  ) {
    const graph = this.ensureGraph();
    if (!graph) return;
    const { ctx, destination } = graph;
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
    gain.connect(destination);
    osc.start(now);
    osc.stop(now + durationSec + 0.02);
  }

  /** Soft ascending harmonic blip for a green candle tick. */
  candleUp() {
    if (!this.enabled || !this.tickAllowed()) return;
    this.tone(880, 1100, 0.06, 0.04, 'sine');
    this.tone(1760, 2200, 0.045, 0.012, 'sine');
  }

  /** Soft descending blip for a red candle tick. */
  candleDown() {
    if (!this.enabled || !this.tickAllowed()) return;
    this.tone(520, 390, 0.06, 0.04, 'sine');
    this.tone(260, 195, 0.05, 0.012, 'sine');
  }

  private tickAllowed(): boolean {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastTickAt < TICK_COOLDOWN_MS) return false;
    this.lastTickAt = now;
    return true;
  }

  /** Crisp two-tone confirmation chime played right before a BUY/SELL announcement. */
  tradeChime() {
    if (!this.enabled) return;
    this.tone(659.25, 659.25, 0.09, 0.05, 'triangle');
    this.tone(987.77, 987.77, 0.13, 0.045, 'sine', 0.07);
  }

  successChime() {
    if (!this.enabled) return;
    this.tone(523.25, 523.25, 0.1, 0.045, 'sine', 0);
    this.tone(659.25, 659.25, 0.11, 0.042, 'sine', 0.075);
    this.tone(783.99, 783.99, 0.13, 0.04, 'sine', 0.15);
    this.tone(1046.5, 1046.5, 0.2, 0.035, 'sine', 0.225);
  }

  lossTone() {
    if (!this.enabled) return;
    this.tone(349.23, 349.23, 0.13, 0.04, 'sine', 0);
    this.tone(233.08, 233.08, 0.22, 0.035, 'sine', 0.1);
  }

  private pickVoice(): SpeechSynthesisVoice | null {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
    if (this.cachedVoice) return this.cachedVoice;
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return null;
    const preferredNames = [
      'Google US English',
      'Microsoft Aria',
      'Microsoft Jenny',
      'Microsoft Guy',
      'Samantha',
      'Alex',
    ];
    let picked = voices.find((v) =>
      preferredNames.some((name) => v.name.toLowerCase().includes(name.toLowerCase()))
    );
    if (!picked) picked = voices.find((v) => v.lang?.replace('_', '-') === 'en-US');
    if (!picked) picked = voices.find((v) => v.lang?.toLowerCase().startsWith('en'));
    if (picked) this.cachedVoice = picked;
    return picked ?? null;
  }

  private drainQueue() {
    if (this.speaking) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const text = this.queue.shift();
    if (!text) return;

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 1.03;
    utterance.pitch = 1;
    utterance.volume = 1;
    const voice = this.pickVoice();
    if (voice) utterance.voice = voice;

    this.speaking = true;
    const finish = () => {
      this.speaking = false;
      window.setTimeout(() => this.drainQueue(), 80);
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      finish();
    }
  }

  /** Queue a clean English announcement; stale announcements are never overlapped. */
  speak(text: string) {
    if (!this.enabled) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    this.unlock();
    if (this.queue.length >= 3) this.queue.shift();
    this.queue.push(clean);
    this.drainQueue();
  }

  cancelSpeech() {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
    this.speaking = false;
  }

  /** Test button: unlocks audio, plays the confirmation chime and speaks a sample. */
  test() {
    if (!this.enabled) this.setEnabled(true);
    this.unlock();
    this.tradeChime();
    this.speak('Voice announcer ready. Live market sounds and trade announcements are enabled.');
  }
}

export const voiceAnnouncer = new VoiceAnnouncer();
