// Built-in browser sound effects (Web Audio API oscillators) and voice
// announcements (window.speechSynthesis). Nothing here needs an API key, a network
// request or an audio file: every sound is synthesized and every word is spoken by
// the browser's own speech engine.
//
// Telegram's mobile WebView keeps AudioContext suspended and speechSynthesis muted
// until a *direct* user gesture happens. `unlock()` is therefore wired to the first
// touchstart/pointerdown/click/keydown on window: it resumes the context, plays a
// silent 1ms buffer (the cheapest "real" audio output Android accepts), warms up
// getVoices() and queues a silent utterance for iOS.

const STORAGE_VOICE_KEY = 'aegis_voice_enabled_v1';
const STORAGE_VOICE_LANG_KEY = 'aegis_voice_language_v1';

const TICK_COOLDOWN_MS = 900;

export type VoiceLanguage = 'en' | 'bn_en';

export function isVoiceLanguage(value: unknown): value is VoiceLanguage {
  return value === 'en' || value === 'bn_en';
}

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

function readStoredLanguage(): VoiceLanguage {
  if (typeof window === 'undefined') return 'en';
  try {
    const raw = window.localStorage.getItem(STORAGE_VOICE_LANG_KEY);
    return isVoiceLanguage(raw) ? raw : 'en';
  } catch {
    return 'en';
  }
}

function persistLanguage(value: VoiceLanguage) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_VOICE_LANG_KEY, value);
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

const BENGALI_TICKERS: Record<string, string> = {
  BTCUSDT: 'বিটকয়েন',
  ETHUSDT: 'ইথেরিয়াম',
  SOLUSDT: 'সোলানা',
  BNBUSDT: 'বিএনবি',
  XRPUSDT: 'এক্সআরপি',
  ADAUSDT: 'কার্ডানো',
  DOGEUSDT: 'ডোজকয়েন',
  AVAXUSDT: 'অ্যাভালাঞ্চ',
  LINKUSDT: 'চেইনলিংক',
  TRXUSDT: 'ট্রন',
};

function bengaliAsset(pair: string): string {
  const symbol = String(pair || '').toUpperCase();
  return BENGALI_TICKERS[symbol] ?? symbol.replace(/USDT$/, '');
}

/**
 * Short Bengali summary spoken before the English announcement when the operator
 * picks "Bengali + English Summary". It only needs to carry the headline, so a few
 * keyword rules are enough and no translation service is involved.
 */
export function bengaliSummary(text: string): string {
  const clean = String(text || '').trim();
  if (!clean) return '';
  const pairMatch = clean.match(/\b([A-Z]{2,10}USDT)\b/);
  const pair = pairMatch ? pairMatch[1] : '';
  const asset = pair ? bengaliAsset(pair) : '';
  const amountMatch = clean.match(/\$\s?-?([\d,]+(?:\.\d+)?)/);
  const amount = amountMatch ? amountMatch[1] : '';
  const lower = clean.toLowerCase();

  if (lower.includes('buy order executed') || lower.startsWith('quick buy')) {
    return asset
      ? `${asset} এ ক্রয় আদেশ সম্পন্ন হয়েছে।`
      : 'ক্রয় আদেশ সম্পন্ন হয়েছে।';
  }
  if (lower.includes('sell order closed') || lower.includes('quick sell')) {
    const profit = lower.includes('profit');
    const loss = lower.includes('loss');
    if (asset) {
      if (profit) return `${asset} বিক্রয় সম্পন্ন, লাভ হয়েছে।`;
      if (loss) return `${asset} বিক্রয় সম্পন্ন, ক্ষতি হয়েছে।`;
      return `${asset} বিক্রয় সম্পন্ন হয়েছে।`;
    }
    return 'বিক্রয় আদেশ সম্পন্ন হয়েছে।';
  }
  if (lower.includes('closed') && asset) {
    return `${asset} পজিশন বন্ধ হয়েছে।`;
  }
  if (lower.includes('balance')) {
    return amount
      ? `আপনার ব্যালেন্স ${amount} ডলার।`
      : 'আপনার ব্যালেন্স হালনাগাদ হয়েছে।';
  }
  if (lower.includes('trailing')) {
    return asset
      ? `${asset} ট্রেলিং স্টপ কার্যকর হয়েছে।`
      : 'ট্রেলিং স্টপ কার্যকর হয়েছে।';
  }
  return 'এজিস কোয়ান্ট টার্মিনাল থেকে নতুন ঘোষণা।';
}

type UtteranceJob = { text: string; lang: 'en-US' | 'bn-BD' };

class VoiceAnnouncer {
  private enabled = readStoredVoice();
  private language: VoiceLanguage = readStoredLanguage();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private lastTickAt = 0;
  private queue: UtteranceJob[] = [];
  private speaking = false;
  private speechPrimed = false;
  private cachedVoice: SpeechSynthesisVoice | null = null;
  private cachedBengaliVoice: SpeechSynthesisVoice | null = null;
  private unlockInstalled = false;
  private unlocked = false;
  private unlockListeners = new Set<(ready: boolean) => void>();

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

  getLanguage(): VoiceLanguage {
    return this.language;
  }

  setLanguage(language: VoiceLanguage) {
    if (this.language === language) return;
    this.language = language;
    persistLanguage(language);
  }

  /** True once a real user gesture has resumed the AudioContext / speech engine. */
  isAudioUnlocked() {
    return this.unlocked;
  }

  onAudioReady(listener: (ready: boolean) => void): () => void {
    this.unlockListeners.add(listener);
    listener(this.unlocked);
    return () => {
      this.unlockListeners.delete(listener);
    };
  }

  private markUnlocked() {
    if (this.unlocked) return;
    this.unlocked = true;
    this.unlockListeners.forEach((listener) => {
      try {
        listener(true);
      } catch {
        // a broken listener must never break audio
      }
    });
  }

  /** Resume the AudioContext and prime speechSynthesis inside a user gesture. */
  unlock() {
    const graph = this.ensureGraph();
    if (graph) {
      const { ctx } = graph;
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => {});
      }
      try {
        // A silent 1ms buffer is a real output request: Android WebView treats it
        // as proof of a user gesture and keeps the context running afterwards.
        const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        const source = ctx.createBufferSource();
        const silent = ctx.createGain();
        silent.gain.value = 0.0001;
        source.buffer = buffer;
        source.connect(silent);
        silent.connect(ctx.destination);
        source.start(ctx.currentTime);
      } catch {
        // ignore buffer failures
      }
      if (ctx.state === 'running') this.markUnlocked();
      else ctx.addEventListener('statechange', () => {
        if (ctx.state === 'running') this.markUnlocked();
      }, { once: true });
    }

    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    // Voice lists load asynchronously in Chrome/Android; asking here warms the
    // engine so the first announcement is not clipped or dropped.
    try {
      window.speechSynthesis.getVoices();
    } catch {
      // ignore
    }
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
    window.addEventListener('click', handler);
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
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
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

  private pickVoice(lang: 'en-US' | 'bn-BD'): SpeechSynthesisVoice | null {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
    const cached = lang === 'bn-BD' ? this.cachedBengaliVoice : this.cachedVoice;
    if (cached) return cached;
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return null;

    if (lang === 'bn-BD') {
      const picked =
        voices.find((v) => v.lang?.toLowerCase().startsWith('bn')) ??
        voices.find((v) => v.lang?.toLowerCase().startsWith('hi')) ??
        voices.find((v) => v.lang?.toLowerCase().startsWith('en-in')) ??
        null;
      if (picked) this.cachedBengaliVoice = picked;
      return picked;
    }

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
    const job = this.queue.shift();
    if (!job) return;

    const utterance = new SpeechSynthesisUtterance(job.text);
    utterance.lang = job.lang;
    utterance.rate = job.lang === 'bn-BD' ? 0.98 : 1.03;
    utterance.pitch = 1;
    utterance.volume = 1;
    const voice = this.pickVoice(job.lang);
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

  /** Queue a clean announcement; stale announcements are never overlapped. */
  speak(text: string) {
    if (!this.enabled) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    this.unlock();

    const jobs: UtteranceJob[] = [];
    if (this.language === 'bn_en') {
      const summary = bengaliSummary(clean);
      if (summary) jobs.push({ text: summary, lang: 'bn-BD' });
    }
    jobs.push({ text: clean, lang: 'en-US' });

    for (const job of jobs) {
      if (this.queue.length >= 4) this.queue.shift();
      this.queue.push(job);
    }
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

  /** Test button: cancels any stuck queue, unlocks audio and speaks a sample. */
  test() {
    if (!this.enabled) this.setEnabled(true);
    this.cancelSpeech();
    this.queue = [];
    this.unlock();
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      // Chrome can leave speechSynthesis in a paused state after a WebView
      // backgrounding; resume() is a no-op when it is already running.
      try {
        window.speechSynthesis.resume();
        window.speechSynthesis.getVoices();
      } catch {
        // ignore
      }
    }
    this.tradeChime();
    this.speak(
      'Voice announcer ready. Live market sounds and trade announcements are enabled.'
    );
  }
}

export const voiceAnnouncer = new VoiceAnnouncer();
