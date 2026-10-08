import { useCallback, useEffect, useState } from 'react';
import { Docs } from './components/Docs';
import { Home } from './components/Home';
import { Move } from './components/Move';
import { Ticker } from './components/Ticker';
import { VaultPanel } from './vault/VaultPanel';
import { CHAIN_BY_ID } from './chains';
import { DRAKE_TWEET, X_HANDLE, X_URL } from './config';
import { short } from './lib/format';
import { useWallet } from './wallet';

type Page = 'home' | 'move' | 'vault' | 'docs';
type Section = 'scan' | 'board' | 'coin' | null;
const NAV: { href: string; label: string; page: Page; section?: Section }[] = [
  { href: '#scan', label: 'Scan', page: 'home', section: 'scan' },
  { href: '#board', label: 'Board', page: 'home', section: 'board' },
  { href: '#move', label: 'Move', page: 'move' },
  { href: '#vault', label: 'Vault', page: 'vault' },
  { href: '#coin', label: '$BUNKER', page: 'home', section: 'coin' },
  { href: '#docs', label: 'Docs', page: 'docs' },
];

interface Route {
  page: Page;
  section: Section;
  addrs: string[];
}
function readHash(): Route {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const a = new URLSearchParams(query).get('a');
  const addrs = a ? a.split(',').map(s => s.trim()).filter(Boolean) : [];
  if (path === 'move' || path === 'vault' || path === 'docs') return { page: path, section: null, addrs: [] };
  const section = path === 'board' || path === 'coin' || path === 'scan' ? path : null;
  return { page: 'home', section, addrs };
}

export default function App() {
  const [route, setRoute] = useState(readHash);
  useEffect(() => {
    const on = () => setRoute(readHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  // in-page sections: scroll after the page has rendered
  useEffect(() => {
    if (route.page !== 'home' || !route.section || route.section === 'scan') {
      if (route.page !== 'home') window.scrollTo({ top: 0 });
      return;
    }
    requestAnimationFrame(() => document.getElementById(route.section!)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, [route.page, route.section]);

  const scan = useCallback((l: string[]) => {
    const h = `#scan?a=${l.join(',')}`;
    if (location.hash !== h) history.pushState(null, '', h);
    setRoute({ page: 'home', section: 'scan', addrs: l });
  }, []);

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <Ticker />
      <Header route={route} />
      <main className="wrap" id="main">
        {route.page === 'home' && <Home list={route.addrs} onScan={scan} />}
        {route.page === 'move' && <Move />}
        {route.page === 'docs' && <Docs />}
        {route.page === 'vault' && (
          <section className="sec" id="vault">
            <div className="sec-head">
              <h1 className="display sec-h">Vault</h1>
              <p className="sec-p">Park funds where only a hash-based signature can move them.</p>
            </div>
            <VaultPanel />
          </section>
        )}
      </main>
      <Footer />
    </>
  );
}

function Header({ route }: { route: Route }) {
  const w = useWallet();
  const chain = w.chainId ? CHAIN_BY_ID.get(w.chainId) : undefined;
  const active = (n: (typeof NAV)[number]) =>
    n.page === route.page && (n.page !== 'home' || n.section === (route.section ?? 'scan'));
  return (
    <header className="top">
      <div className="top-in">
        <a className="mark" href="#scan" aria-label="BUNKER home">BUNKER</a>
        <nav className="tabs" aria-label="Sections">
          {NAV.map(n => (
            <a key={n.href} href={n.href} className={`tab${active(n) ? ' on' : ''}`} aria-current={active(n) ? 'page' : undefined}>
              {n.label}
            </a>
          ))}
        </nav>
        <span className="grow" />
        <a className="x-link" href={X_URL} target="_blank" rel="noreferrer">{X_HANDLE}</a>
        {w.address ? (
          <div className="acct">
            {chain && <img src={chain.logo} alt={chain.name} width={14} height={14} />}
            <span className="mono">{short(w.address)}</span>
            <button className="btn sm ghost" onClick={w.disconnect}>disconnect</button>
          </div>
        ) : (
          <button className="btn sm" onClick={() => w.connect()} disabled={w.connecting}>
            {w.connecting ? 'connecting…' : 'Connect wallet'}
          </button>
        )}
      </div>
      {w.error && !w.address && <div className="top-err err">{w.error}</div>}
    </header>
  );
}

function Footer() {
  return (
    <footer className="foot">
      <div className="wrap foot-in">
        <span className="mark sm">BUNKER</span>
        <span className="dim">
          Not financial advice. Open tools with no custody: every move is signed in your own wallet or browser. The
          vault contract has not had an external audit.
        </span>
        <span className="grow" />
        <a className="dim2" href={X_URL} target="_blank" rel="noreferrer">{X_HANDLE} on X ↗</a>
        <a className="dim2" href={DRAKE_TWEET} target="_blank" rel="noreferrer">the bunker mode post ↗</a>
      </div>
    </footer>
  );
}
