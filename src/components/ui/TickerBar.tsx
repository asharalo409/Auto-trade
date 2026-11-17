import React from 'react';
import { BotStatus, PairMarketData } from '../../types/trading';

interface TickerBarProps {
  pairs: PairMarketData[];
  botStatus: BotStatus;
  mode: 'DEMO' | 'LIVE';
  position: 'top' | 'bottom';
  balance: number;
  openCount: number;
}

export const TickerBar: React.FC<TickerBarProps> = ({
  pairs,
  botStatus,
  mode,
  position,
  balance,
  openCount,
}) => {
  const items = pairs.map((p) => ({
    label: p.base,
    price:
      p.price > 10
        ? p.price.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })
        : p.price.toFixed(4),
    change: p.change24h,
  }));

  const statusText =
    position === 'top'
      ? `ENGINE:${botStatus} · WORKSPACE:${mode} · OPEN:${openCount} · EQUITY:$${balance.toLocaleString(
          'en-US',
          { minimumFractionDigits: 2 }
        )}`
      : `BINANCE SPOT STREAM · 10 PAIRS MONITORED · REALTIME TELEMETRY ACTIVE`;

  const renderStrip = (prefix: string) => (
    <div className="flex items-center gap-5 px-4 font-mono-tech text-[10px] tracking-wider whitespace-nowrap">
      <span className="text-cyan-400">{statusText}</span>
      <span className="text-slate-600">|</span>
      {items.map((item) => (
        <span key={`${prefix}-${item.label}`} className="flex items-center gap-1.5">
          <span className="font-semibold text-slate-300">{item.label}</span>
          <span className="text-slate-400">${item.price}</span>
          <span className={item.change >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
            {item.change >= 0 ? '+' : ''}
            {item.change.toFixed(2)}%
          </span>
        </span>
      ))}
    </div>
  );

  return (
    <div
      className={`w-full overflow-hidden border-slate-800/80 bg-[#040508]/95 py-1 select-none ${
        position === 'top' ? 'border-b' : 'border-t'
      }`}
    >
      <div className="animate-ticker">
        {renderStrip('a')}
        {renderStrip('b')}
      </div>
    </div>
  );
};
