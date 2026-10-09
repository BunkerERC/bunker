import { useEffect, useRef } from 'react';
import { CandlestickSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { compact, tiny } from './format';

export interface Tick {
  ts: number;
  pre: number; // ETH per token before the trade
  post: number; // after
}

/** OHLC candles from the pool's own Swap events, starting at the launch price. */
export function candles(ticks: Tick[], start: { ts: number; price: number }, interval: number, scale: number) {
  const out: { time: UTCTimestamp; open: number; high: number; low: number; close: number }[] = [];
  let last = start.price;
  const push = (t: number, a: number, b: number) => {
    const bucket = Math.floor(t / interval) * interval;
    const cur = out[out.length - 1];
    if (cur && cur.time === bucket) {
      cur.high = Math.max(cur.high, a * scale, b * scale);
      cur.low = Math.min(cur.low, a * scale, b * scale);
      cur.close = b * scale;
    } else {
      const open = last * scale;
      out.push({ time: bucket as UTCTimestamp, open, high: Math.max(open, a * scale, b * scale), low: Math.min(open, a * scale, b * scale), close: b * scale });
    }
    last = b;
  };
  push(start.ts, start.price, start.price);
  for (const t of ticks) push(t.ts, t.pre, t.post);
  // carry the last price to now so the chart doesn't stop at the last trade
  const now = Math.floor(Date.now() / 1000);
  if (out.length && now - (out[out.length - 1].time as number) >= interval) push(now, last, last);
  return out;
}

export default function Chart({ data, money }: { data: ReturnType<typeof candles>; money: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: '#000000' }, textColor: '#737373', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: '#0e0e0e' }, horzLines: { color: '#0e0e0e' } },
      rightPriceScale: { borderColor: '#1a1a1a' },
      timeScale: { borderColor: '#1a1a1a', timeVisible: true, secondsVisible: false },
      crosshair: { horzLine: { color: '#333' }, vertLine: { color: '#333' } },
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: '#2ecf6e',
      downColor: '#ff5257',
      borderVisible: false,
      wickUpColor: '#2ecf6e',
      wickDownColor: '#ff5257',
      priceFormat: { type: 'custom', minMove: 1e-15, formatter: (p: number) => (money ? '$' : '') + (p >= 1 ? compact(p, 2) : tiny(p)) },
    });
    chart.current = c;
    series.current = s;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
    };
  }, [money]);

  useEffect(() => {
    if (!series.current) return;
    series.current.setData(data);
    // few candles: keep them candle-sized and pinned to the right instead of stretching across the whole chart
    const ts = chart.current?.timeScale();
    if (data.length > 60) ts?.fitContent();
    else {
      ts?.applyOptions({ barSpacing: 12, rightOffset: 4 });
      ts?.scrollToRealTime();
    }
  }, [data]);

  return <div ref={el} className="chart-box" />;
}
