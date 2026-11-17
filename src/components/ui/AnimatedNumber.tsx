import React, { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';

interface AnimatedNumberProps {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  showSign?: boolean;
  flashOnChange?: boolean;
  className?: string;
}

export const AnimatedNumber: React.FC<AnimatedNumberProps> = ({
  value,
  decimals = 2,
  prefix = '',
  suffix = '',
  showSign = false,
  flashOnChange = true,
  className = '',
}) => {
  const reducedMotion = useReducedMotion();
  const [displayValue, setDisplayValue] = useState<number>(value);
  const [flashDir, setFlashDir] = useState<'up' | 'down' | null>(null);
  const prevValueRef = useRef<number>(value);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const startVal = prevValueRef.current;
    const endVal = value;
    if (startVal === endVal) return;

    if (flashOnChange && !reducedMotion) {
      setFlashDir(endVal > startVal ? 'up' : 'down');
      const timer = window.setTimeout(() => setFlashDir(null), 650);

      const duration = 520;
      const startTime = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - startTime) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        setDisplayValue(startVal + (endVal - startVal) * eased);
        if (t < 1) {
          rafRef.current = requestAnimationFrame(step);
        } else {
          prevValueRef.current = endVal;
        }
      };
      rafRef.current = requestAnimationFrame(step);
      return () => {
        window.clearTimeout(timer);
        cancelAnimationFrame(rafRef.current);
      };
    }

    setDisplayValue(endVal);
    prevValueRef.current = endVal;
  }, [value, flashOnChange, reducedMotion]);

  const absFormatted = Math.abs(displayValue).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  const sign =
    displayValue < 0 ? '-' : showSign && displayValue > 0 ? '+' : '';

  const flashClass =
    flashDir === 'up'
      ? 'text-emerald-300 drop-shadow-[0_0_8px_rgba(16,185,129,0.85)]'
      : flashDir === 'down'
        ? 'text-rose-300 drop-shadow-[0_0_8px_rgba(244,63,94,0.85)]'
        : '';

  return (
    <span
      className={`font-mono-tech transition-colors duration-300 ${flashClass} ${className}`}
    >
      {sign}
      {prefix}
      {absFormatted}
      {suffix}
    </span>
  );
};
