import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Check, Copy, Pause, Play, Search, Terminal } from 'lucide-react';
import { LogEntry, LogLevel } from '../../types/trading';
import { SkeletonBlock } from '../ui/MotionPrimitives';
import { TerminalPanel } from '../ui/TerminalPanel';

interface LiveEngineFeedProps {
  t: Record<string, string>;
  logs: LogEntry[];
  loading: boolean;
}

const LEVELS: ('ALL' | LogLevel)[] = ['ALL', 'INFO', 'TRADE', 'WARNING', 'ERROR'];

const TypewriterLine: React.FC<{ text: string; animate: boolean }> = ({
  text,
  animate,
}) => {
  const reducedMotion = useReducedMotion();
  const [shown, setShown] = useState(animate && !reducedMotion ? 0 : text.length);

  useEffect(() => {
    if (!animate || reducedMotion) {
      setShown(text.length);
      return;
    }
    setShown(0);
    let idx = 0;
    const step = Math.max(1, Math.ceil(text.length / 26));
    const timer = window.setInterval(() => {
      idx += step;
      if (idx >= text.length) {
        setShown(text.length);
        window.clearInterval(timer);
      } else {
        setShown(idx);
      }
    }, 18);
    return () => window.clearInterval(timer);
  }, [text, animate, reducedMotion]);

  return <span>{text.slice(0, shown)}</span>;
};

export const LiveEngineFeed: React.FC<LiveEngineFeedProps> = ({ t, logs, loading }) => {
  const reducedMotion = useReducedMotion();
  const [levelFilter, setLevelFilter] = useState<'ALL' | LogLevel>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [copiedIpKey, setCopiedIpKey] = useState<string | null>(null);
  const scrollBoxRef = useRef<HTMLDivElement>(null);

  const handleCopyIp = async (logId: string, ip: string) => {
    try {
      await navigator.clipboard.writeText(ip);
      setCopiedIpKey(logId);
      window.setTimeout(() => {
        setCopiedIpKey((prev) => (prev === logId ? null : prev));
      }, 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  const filteredLogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return logs.filter((log) => {
      if (levelFilter !== 'ALL' && log.level !== levelFilter) return false;
      if (!q) return true;
      return (
        log.message.toLowerCase().includes(q) ||
        (log.pair ?? '').toLowerCase().includes(q) ||
        log.level.toLowerCase().includes(q)
      );
    });
  }, [logs, levelFilter, searchQuery]);

  useEffect(() => {
    if (autoScroll && scrollBoxRef.current) {
      scrollBoxRef.current.scrollTop = scrollBoxRef.current.scrollHeight;
    }
  }, [filteredLogs.length, autoScroll]);

  const getLevelColor = (lvl: LogLevel) => {
    switch (lvl) {
      case 'TRADE':
        return 'text-emerald-400';
      case 'WARNING':
        return 'text-amber-300';
      case 'ERROR':
        return 'text-rose-400';
      default:
        return 'text-cyan-300';
    }
  };

  if (loading) {
    return <SkeletonBlock className="h-[460px]" />;
  }

  return (
    <TerminalPanel
      accent="cyan"
      title={t.liveFeedTitle}
      subtitle={t.liveFeedSub}
      rightSlot={
        <button
          type="button"
          onClick={() => setAutoScroll((v) => !v)}
          className={`flex min-h-[36px] items-center gap-1.5 rounded-lg border px-3 py-1.5 font-mono-tech text-[11px] transition-colors ${
            autoScroll
              ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
              : 'border-slate-700 bg-slate-900 text-slate-400'
          }`}
        >
          {autoScroll ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
          {autoScroll ? t.autoScrollOn : t.autoScrollOff}
        </button>
      }
    >
      <div className="mb-3 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-800 bg-[#05060a] p-1">
          {LEVELS.map((lvl) => (
            <button
              key={lvl}
              type="button"
              onClick={() => setLevelFilter(lvl)}
              className={`min-h-[34px] rounded px-2.5 py-1 font-mono-tech text-[11px] font-semibold transition-colors ${
                levelFilter === lvl
                  ? 'bg-cyan-500/20 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {lvl === 'ALL' ? t.allLevels : lvl}
            </button>
          ))}
        </div>

        <div className="relative flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t.searchLogsPlaceholder}
            className="min-h-[38px] w-full rounded-lg border border-slate-800 bg-[#05060a] pr-3 pl-8 font-mono-tech text-xs text-slate-200 placeholder-slate-500 focus:border-cyan-400 focus:outline-none"
          />
        </div>
      </div>

      <div
        ref={scrollBoxRef}
        className="h-[420px] overflow-y-auto rounded-xl border border-slate-800/90 bg-[#040509] p-3.5 font-mono-tech text-xs leading-relaxed sm:h-[480px]"
      >
        {filteredLogs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
            <Terminal className="h-6 w-6 text-slate-600" />
            <span>{t.emptyFeed}</span>
          </div>
        ) : (
          <div className="space-y-1.5">
            {filteredLogs.map((log, idx) => {
              const isNewest = idx === filteredLogs.length - 1;
              const timeStr = new Date(log.created_at).toLocaleTimeString([], {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              });
              const ipMatch = log.message.match(/\[SERVER PUBLIC IP\]\s*(\d{1,3}(?:\.\d{1,3}){3})/);
              const matchedIp = ipMatch ? ipMatch[1] : null;
              const isIpCopied = copiedIpKey === log.id;
              return (
                <motion.div
                  key={log.id}
                  initial={reducedMotion ? false : { opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.2 }}
                  className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 rounded px-1.5 py-1 hover:bg-slate-900/50"
                >
                  <span className="text-slate-500 shrink-0">{timeStr}</span>
                  <span className={`shrink-0 font-bold ${getLevelColor(log.level)}`}>
                    [{log.level}]
                  </span>
                  {log.pair && (
                    <span className="shrink-0 font-semibold text-slate-200">
                      {log.pair}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 text-slate-300 break-words">
                    <TypewriterLine text={log.message} animate={isNewest} />
                  </span>
                  {matchedIp && (
                    <button
                      type="button"
                      onClick={() => handleCopyIp(log.id, matchedIp)}
                      className={`inline-flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 font-mono-tech text-[10px] transition-colors ${
                        isIpCopied
                          ? 'border-emerald-500/60 bg-emerald-500/20 text-emerald-300'
                          : 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20'
                      }`}
                    >
                      {isIpCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      {isIpCopied ? 'Copied' : `Copy ${matchedIp}`}
                    </button>
                  )}
                </motion.div>
              );
            })}
            <div className="flex items-center gap-2 pt-2 text-cyan-400">
              <span>aegis@engine:~$</span>
              <span
                className={`inline-block h-3.5 w-2 bg-cyan-400 ${
                  reducedMotion ? '' : 'animate-pulse'
                }`}
              />
            </div>
          </div>
        )}
      </div>
    </TerminalPanel>
  );
};
