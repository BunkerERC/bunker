// The launchpad pages, loaded on demand (the chart library and the coin board stay out of the main bundle).
import type { Hex } from 'viem';
import { MarketProvider } from './data';
import LaunchHome from './LaunchHome';
import LaunchForm from './LaunchForm';
import CoinPage from './CoinPage';
import Creator from './Creator';

export default function LaunchPages({ page, sub, ticker }: { page: 'launch' | 'coin'; sub?: string; ticker?: string }) {
  return (
    <MarketProvider>
      {page === 'coin' ? (
        <CoinPage key={sub} address={sub as Hex} />
      ) : sub === 'new' ? (
        <LaunchForm ticker={ticker} />
      ) : sub === 'keys' ? (
        <Creator />
      ) : (
        <LaunchHome />
      )}
    </MarketProvider>
  );
}
