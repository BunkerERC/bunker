import { useEffect, useState } from 'react';
import { formatGwei } from 'viem';
import { client } from '../chains';
import { TOKEN_ADDRESS } from '../config';
import { usePrices } from '../prices';

const usd = (v?: number) =>
  v ? '$' + v.toLocaleString('en-US', { maximumFractionDigits: v < 1000 ? 2 : 0, minimumFractionDigits: v < 1000 ? 2 : 0 }) : '—';

/** Thin live strip: prices from Chainlink, block + base fee from Ethereum, refreshed every block while visible. */
export function Ticker() {
  const prices = usePrices();
  const [blk, setBlk] = useState<{ n: bigint; base: bigint } | null>(null);
  useEffect(() => {
    let dead = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const b = await client(1).getBlock();
        if (!dead) setBlk({ n: b.number, base: b.baseFeePerGas ?? 0n });
      } catch {
        /* keep the last value */
      }
    };
    tick();
    const t = setInterval(tick, 12_000);
    return () => { dead = true; clearInterval(t); };
  }, []);
  const gwei = blk ? Number(formatGwei(blk.base)) : undefined;
  return (
    <div className="ticker" role="status" aria-label="Live market data">
      <div className="ticker-in">
        <span><b>ETH</b> {usd(prices.eth)}</span>
        <span className="t-btc"><b>BTC</b> {usd(prices.btc)}</span>
        <span><b>gas</b> {gwei === undefined ? '—' : `${gwei < 1 ? gwei.toFixed(2) : gwei.toFixed(1)} gwei`}</span>
        <span className="t-block"><b>block</b> {blk ? `#${blk.n.toLocaleString()}` : '—'}</span>
        <span className="grow" />
        <span className="t-coin">
          <b>$BUNKER</b> {TOKEN_ADDRESS ? <a href="#coin">live on Ethereum</a> : <a href="#coin">launching</a>}
        </span>
      </div>
    </div>
  );
}
