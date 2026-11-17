import React, { useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import { InfoTip } from '../ui/InfoTip';
import { TerminalPanel } from '../ui/TerminalPanel';

interface MarketSentimentWidgetProps {
  t: Record<string, string>;
}

interface SentimentData {
  value: number;
  classification: string;
  yesterday: number;
  isLiveApi: boolean;
}

function getSentimentMeta(val: number, t: Record<string, string>) {
  if (val <= 24) return { label: t.sentimentExtremeFear, color: '#f43f5e' };
  if (val <= 45) return { label: t.sentimentFear, color: '#fb923c' };
  if (val <= 55) return { label: t.sentimentNeutral, color: '#facc15' };
  if (val <= 75) return { label: t.sentimentGreed, color: '#4ade80' };
  return { label: t.sentimentExtremeGreed, color: '#10b981' };
}

export const MarketSentimentWidget: React.FC<MarketSentimentWidgetProps> = ({ t }) => {
  const [sentiment, setSentiment] = useState<SentimentData>({
    value: 64,
    classification: 'Greed',
    yesterday: 61,
    isLiveApi: false,
  });

  useEffect(() => {
    let active = true;
    const fetchFng = async () => {
      try {
        const res = await fetch('https://api.alternative.me/fng/?limit=2');
        if (!res.ok) return;
        const json = (await res.json()) as {
          data?: { value: string; value_classification: string }[];
        };
        if (!active || !json.data || json.data.length === 0) return;
        const current = Number(json.data[0].value);
        const prev = Number(json.data[1]?.value ?? current);
        if (!Number.isFinite(current)) return;
        setSentiment({
          value: current,
          classification: json.data[0].value_classification,
          yesterday: Number.isFinite(prev) ? prev : current,
          isLiveApi: true,
        });
      } catch {
        // Silent fallback when offline or blocked
      }
    };

    fetchFng();
    const id = window.setInterval(fetchFng, 120_000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, []);

  const clamped = Math.max(0, Math.min(100, sentiment.value));
  const meta = getSentimentMeta(clamped, t);
  const diff = clamped - sentiment.yesterday;

  // Semi-circular Gauge Geometry (180 degrees)
  const cx = 110;
  const cy = 96;
  const r = 74;
  const startAngle = Math.PI;
  const needleAngle = startAngle - (clamped / 100) * Math.PI;
  const nx = cx + (r - 12) * Math.cos(needleAngle);
  const ny = cy - (r - 12) * Math.sin(needleAngle);

  const arcPath = (fromPct: number, toPct: number) => {
    const a1 = Math.PI - (fromPct / 100) * Math.PI;
    const a2 = Math.PI - (toPct / 100) * Math.PI;
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy - r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2);
    const y2 = cy - r * Math.sin(a2);
    return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  };

  return (
    <TerminalPanel
      accent="amber"
      title={t.marketSentimentTitle}
      subtitle={sentiment.isLiveApi ? t.sentimentLiveSource : t.sentimentCachedSource}
      rightSlot={
        <div className="flex items-center gap-2">
          <InfoTip text={t.helpSentiment} label={t.marketSentimentTitle} />
          <Gauge className="h-4 w-4 text-amber-300" />
        </div>
      }
      delay={0.18}
    >
      <div className="flex flex-col items-center justify-between gap-2 sm:flex-row">
        {/* SVG Semi-Circular Fear & Greed Gauge */}
        <div className="relative flex w-full max-w-[230px] flex-col items-center">
          <svg viewBox="0 0 220 118" className="w-full overflow-visible">
            {/* Background Zone Segments */}
            <path d={arcPath(0, 24)} fill="none" stroke="#f43f5e" strokeWidth="12" strokeLinecap="round" opacity="0.28" />
            <path d={arcPath(26, 45)} fill="none" stroke="#fb923c" strokeWidth="12" opacity="0.28" />
            <path d={arcPath(47, 55)} fill="none" stroke="#facc15" strokeWidth="12" opacity="0.28" />
            <path d={arcPath(57, 75)} fill="none" stroke="#4ade80" strokeWidth="12" opacity="0.28" />
            <path d={arcPath(77, 100)} fill="none" stroke="#10b981" strokeWidth="12" strokeLinecap="round" opacity="0.28" />

            {/* Active Gauge Sweep */}
            <path
              d={arcPath(0, clamped)}
              fill="none"
              stroke={meta.color}
              strokeWidth="12"
              strokeLinecap="round"
            />

            {/* Gauge Needle */}
            <line
              x1={cx}
              y1={cy}
              x2={nx}
              y2={ny}
              stroke="#f8fafc"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
            <circle cx={cx} cy={cy} r="5" fill={meta.color} stroke="#05060a" strokeWidth="2" />

            {/* Center Score */}
            <text
              x={cx}
              y={cy - 18}
              textAnchor="middle"
              fill={meta.color}
              fontSize="26"
              fontWeight="700"
              fontFamily="JetBrains Mono"
            >
              {clamped}
            </text>
            <text
              x={18}
              y={112}
              fill="#64748b"
              fontSize="9"
              fontFamily="JetBrains Mono"
            >
              0 FEAR
            </text>
            <text
              x={160}
              y={112}
              fill="#64748b"
              fontSize="9"
              fontFamily="JetBrains Mono"
            >
              100 GREED
            </text>
          </svg>
        </div>

        {/* Metrics & Interpretation */}
        <div className="w-full flex-1 space-y-2 rounded-xl border border-slate-800/80 bg-[#05070d] p-3 font-mono-tech text-xs">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-slate-400 uppercase">{t.sentimentStatusLabel}</span>
            <span className="font-bold uppercase" style={{ color: meta.color }}>
              {meta.label}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-slate-400 uppercase">{t.sentimentYesterday}</span>
            <span className="text-slate-200">
              {sentiment.yesterday}{' '}
              <span className={diff >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                ({diff >= 0 ? '+' : ''}
                {diff})
              </span>
            </span>
          </div>
          <p className="border-t border-slate-800/70 pt-1.5 text-[10px] leading-relaxed text-slate-400">
            {clamped < 40 ? t.sentimentTipFear : clamped > 65 ? t.sentimentTipGreed : t.sentimentTipNeutral}
          </p>
        </div>
      </div>
    </TerminalPanel>
  );
};
