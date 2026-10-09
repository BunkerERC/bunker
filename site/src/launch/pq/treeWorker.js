// Builds a slice of the 1,024 XMSS leaves off the main thread. Leaves are public; master stays in this tab.
import { leafRange } from './xmss.js';

self.onmessage = e => {
  const { master, seed, from, to } = e.data;
  let done = 0;
  const leaves = leafRange(master, seed, from, to, () => {
    done++;
    if (done % 8 === 0) self.postMessage({ type: 'progress', done });
  });
  self.postMessage({ type: 'done', from, leaves }, leaves.map(l => l.buffer));
};
