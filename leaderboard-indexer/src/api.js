import { createServer } from 'node:http';
import { json, roundKey } from './domain.js';

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const hex = (value, bytes) => {
  if (!new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value ?? '')) throw new HttpError(400, `Expected ${bytes}-byte hex value`);
  return value.toLowerCase();
};
const uint = value => {
  if (!/^(0|[1-9][0-9]*)$/.test(value ?? '') || value.length > 78 || BigInt(value) >= 2n ** 256n) throw new HttpError(400, 'Expected unsigned decimal integer');
  return value;
};
const pageNumber = (value, fallback, min, max) => {
  if (value === null) return fallback;
  uint(value);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new HttpError(400, 'Invalid pagination');
  return number;
};
const summary = ({ rankings, ...round }) => round;
const walletMatches = (row, wallet) => !wallet || [row.payer, row.player, row.recipient].includes(wallet);

export function createApi(indexer, { corsOrigin = '*' } = {}) {
  return createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET, OPTIONS'); throw new HttpError(405, 'Method not allowed'); }
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const q = url.searchParams;
      const status = indexer.status();
      const snapshot = { indexedBlock: status.indexedBlock, indexedBlockHash: status.indexedBlockHash };
      if (q.has('atBlockHash') && q.get('atBlockHash') !== snapshot.indexedBlockHash) throw new HttpError(409, 'Indexed snapshot changed; restart pagination');
      const view = indexer.store.view;
      const list = items => {
        const limit = pageNumber(q.get('limit'), 50, 1, 200);
        const offset = pageNumber(q.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
        return { items: items.slice(offset, offset + limit), total: items.length, limit, offset,
          nextOffset: offset + limit < items.length ? offset + limit : null, ...snapshot };
      };
      const filters = () => ({
        chartHash: q.has('chartHash') ? hex(q.get('chartHash'), 32) : null,
        dayId: q.has('dayId') ? uint(q.get('dayId')) : null,
        wallet: q.has('wallet') ? hex(q.get('wallet'), 20) : null,
      });
      const filterRows = rows => {
        const f = filters();
        return rows.filter(row => (!f.chartHash || row.chartHash === f.chartHash) &&
          (f.dayId === null || row.dayId === f.dayId) && walletMatches(row, f.wallet));
      };
      let data;
      if (parts.length === 1 && parts[0] === 'status') data = status;
      else if (parts.length === 1 && parts[0] === 'charts') data = list([...view.charts.values()].sort((a, b) => a.chartHash.localeCompare(b.chartHash)));
      else if (parts[0] === 'charts' && parts.length >= 2) {
        const chartHash = hex(parts[1], 32);
        if (parts.length === 2) {
          const chart = view.charts.get(chartHash);
          if (!chart) throw new HttpError(404, 'Chart not found');
          data = { ...chart, ...snapshot };
        } else if (parts.length === 3 && parts[2] === 'rounds') data = list([...view.rounds.values()]
          .filter(r => r.chartHash === chartHash).sort((a, b) => BigInt(a.dayId) === BigInt(b.dayId) ? 0 : BigInt(a.dayId) > BigInt(b.dayId) ? -1 : 1).map(summary));
        else if ((parts.length === 4 || parts.length === 5) && parts[2] === 'days') {
          const round = view.rounds.get(roundKey(chartHash, uint(parts[3])));
          if (!round) throw new HttpError(404, 'Round not found');
          if (parts.length === 4) data = { ...summary(round), ...snapshot };
          else if (parts[4] === 'rankings') data = list(round.rankings);
        }
      } else if (parts.length === 1 && parts[0] === 'attempts') data = list(filterRows([...view.attempts.values()]));
      else if (parts.length === 1 && parts[0] === 'settlements') data = list(filterRows(view.settlements));
      else if (parts.length === 3 && parts[0] === 'wallets') {
        const wallet = hex(parts[1], 20);
        if (parts[2] === 'attempts') data = list(filterRows([...view.attempts.values()].filter(row => walletMatches(row, wallet))));
        else if (parts[2] === 'history') data = list(filterRows(view.history.filter(row => walletMatches(row, wallet))));
        else if (parts[2] === 'bests') data = list(filterRows([...view.rounds.values()].flatMap(round => round.rankings
          .filter(row => row.player === wallet).map(row => ({ chartHash: round.chartHash, dayId: round.dayId, ...row })))));
      }
      if (data === undefined) throw new HttpError(404, 'Route not found');
      res.writeHead(200); res.end(json(data));
    } catch (error) {
      res.writeHead(error.status ?? 500);
      res.end(json({ error: error.status ? error.message : 'Internal server error' }));
    }
  });
}
