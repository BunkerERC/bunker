// Same-origin door to the gasless relayer (launch/swap.mjs relayer). The relayer box only answers requests that
// carry the shared key, so its address stays out of the page and nobody can reach it around this function.
//   GET  /api/relay  -> what it charges right now
//   POST /api/relay  -> a signed bunker message to submit
// Env: RELAY_UPSTREAM (http://host:port), RELAY_SECRET.
export default async function handler(req, res) {
  const up = process.env.RELAY_UPSTREAM;
  res.setHeader('cache-control', 'no-store');
  if (!up) return res.status(503).json({ error: 'The relayer is not set up. Use a wallet to submit.' });
  const ip = String(req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  const headers = { 'x-relay-key': process.env.RELAY_SECRET ?? '', 'x-client-ip': ip };
  try {
    let r;
    if (req.method === 'GET') {
      r = await fetch(`${up}/info`, { headers, signal: AbortSignal.timeout(8000) });
    } else if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
      if (body.length > 65536) return res.status(413).json({ error: 'too large' });
      r = await fetch(`${up}/relay`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(25000) });
    } else {
      return res.status(405).json({ error: 'GET or POST' });
    }
    res.status(r.status).setHeader('content-type', 'application/json').send(await r.text());
  } catch {
    res.status(502).json({ error: 'The relayer did not answer. Use a wallet to submit, or try again.' });
  }
}
