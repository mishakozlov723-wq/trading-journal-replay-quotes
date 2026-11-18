// Daily quote updates from the OANDA v20 REST API (practice account token).
//
// The published Dukascopy archive is never rewritten: archived candles in the
// overlap window are returned unchanged, and only completed OANDA candles that
// are newer than the last archived candle are appended. Every run verifies that
// OANDA still agrees with the archive (coverage, price level, candle direction)
// and that OANDA H1 agrees with OANDA M5 before anything can be published.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTRUMENTS, validateBar } from './tools/data.mjs';
import { updateQuotes } from './tools/update.mjs';

export const PRACTICE_HOST = 'https://api-fxpractice.oanda.com';
export const SOURCE_LABEL = 'Dukascopy BID archive + OANDA BID daily updates';
export const OANDA_INSTRUMENTS = {
  XAUUSD: 'XAU_USD', EURUSD: 'EUR_USD', GBPUSD: 'GBP_USD', GER40: 'DE30_EUR',
  USDJPY: 'USD_JPY', XAGUSD: 'XAG_USD', USDCAD: 'USD_CAD', NZDUSD: 'NZD_USD', USDCHF: 'USD_CHF',
};
// OANDA trades GER40 (DE30_EUR) with a shorter evening/night session than
// Dukascopy. Archived hours OANDA does not trade are not counted as missing.
export const SHORTER_SESSION = new Set(['GER40']);
export const LIMITS = { coverage: 0.97, medianRelative: 0.002, maxRelative: 0.02, sameDirection: 0.8, hourMismatch: 0.02 };
// Seeding a new instrument: no gap longer than this (weekends, Christmas, New Year),
// and every calendar year must be reasonably complete.
export const SEED_LIMITS = { maxGapHours: 100, minH1PerYear: 5000, minM5PerYear: 60000, minM3PerYear: 100000 };
const TIMEFRAMES = { h1: ['H1', 3600000], m5: ['M5', 300000], m1: ['M1', 60000] };
const CHUNK = 4000; // candles per request; OANDA allows at most 5000
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const iso = t => new Date(t).toISOString();
const median = values => { const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

async function request(url, token, fetchImpl, wait) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: 'Bearer ' + token, 'Accept-Datetime-Format': 'RFC3339' },
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) { lastError = error; }
    if (response) {
      if (response.status === 401 || response.status === 403)
        throw new Error('OANDA rejected the token (HTTP ' + response.status + '); check the OANDA_API_TOKEN secret');
      if (response.ok) return response.json();
      const text = await response.text().catch(() => '');
      lastError = new Error('OANDA HTTP ' + response.status + ' ' + text.slice(0, 200));
      if (response.status < 500 && response.status !== 429) throw lastError;
    }
    if (attempt < 4) await wait(2000 * 2 ** attempt);
  }
  throw new Error('OANDA request failed after 5 attempts: ' + lastError?.message);
}

// Completed BID candles in [from, to), sorted, without duplicates.
export async function fetchCandles({ instrument, timeframe, from, to, token, fetchImpl = fetch, wait = pause, host = PRACTICE_HOST, concurrency = 4 }) {
  const [granularity, ms] = TIMEFRAMES[timeframe];
  const rows = new Map(), starts = [];
  for (let start = from; start < to; start += CHUNK * ms) starts.push(start);
  let next = 0;
  const worker = async () => { while (next < starts.length) await chunk(starts[next++]); };
  async function chunk(start) {
    const end = Math.min(start + CHUNK * ms, to);
    const url = new URL('/v3/instruments/' + instrument + '/candles', host);
    url.search = new URLSearchParams({ granularity, price: 'B', from: iso(start), to: iso(end) }).toString();
    const body = await request(url, token, fetchImpl, wait);
    if (body?.instrument !== instrument || body?.granularity !== granularity || !Array.isArray(body?.candles))
      throw new Error('Unexpected OANDA response for ' + instrument + ' ' + granularity);
    for (const candle of body.candles) {
      if (candle.complete !== true) continue;
      const timestamp = Date.parse(candle.time);
      const bid = candle.bid || {};
      const bar = { timestamp, open: Number(bid.o), high: Number(bid.h), low: Number(bid.l), close: Number(bid.c), volume: candle.volume };
      if (!Number.isFinite(timestamp)) throw new Error('Invalid OANDA candle time ' + candle.time);
      if (timestamp < start || timestamp + ms > end) continue;
      rows.set(timestamp, bar);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, starts.length) }, worker));
  return [...rows.values()].sort((a, b) => a.timestamp - b.timestamp);
}

// Build exact three-minute candles from verified OANDA M1 candles. The first
// minute supplies the open, the last supplies the close; high/low span all
// minutes in the bucket. Empty market gaps are naturally omitted.
export function aggregateMinutes(rows, intervalMs = 180000) {
  if (!Array.isArray(rows)) throw new Error('Minute rows must be an array');
  const groups = new Map();
  for (const row of rows) {
    const timestamp = Math.floor(row.timestamp / intervalMs) * intervalMs;
    const g = groups.get(timestamp);
    if (g) { g.high = Math.max(g.high, row.high); g.low = Math.min(g.low, row.low); g.close = row.close; g.volume = (g.volume || 0) + (row.volume || 0); }
    else groups.set(timestamp, { timestamp, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume || 0 });
  }
  return [...groups.values()].sort((a, b) => a.timestamp - b.timestamp);
}

// OANDA H1 must be the aggregation of OANDA M5 (same hours, same high/low).
export function verifyHours(hours, minutes, scale, label = '') {
  const derived = new Map();
  for (const bar of minutes) {
    const t = Math.floor(bar.timestamp / 3600000) * 3600000;
    const g = derived.get(t);
    if (g) { g.high = Math.max(g.high, bar.high); g.low = Math.min(g.low, bar.low); }
    else derived.set(t, { high: bar.high, low: bar.low });
  }
  const all = new Set([...derived.keys(), ...hours.map(b => b.timestamp)]);
  let mismatched = 0;
  const examples = [];
  const native = new Map(hours.map(b => [b.timestamp, b]));
  for (const t of all) {
    const h = native.get(t), g = derived.get(t);
    // A missing hour is not a price discrepancy. Publishing later candles
    // would make this gap permanent because daily updates only append.
    if (!h || !g) throw new Error(label + ': OANDA H1/M5 missing ' + (!h ? 'H1' : 'M5') + ' hour at ' + iso(t));
    const ok = Math.round(h.high * scale) === Math.round(g.high * scale) && Math.round(h.low * scale) === Math.round(g.low * scale);
    if (!ok) { mismatched++; if (examples.length < 3) examples.push(iso(t)); }
  }
  if (!all.size) throw new Error(label + ': OANDA returned no candles');
  if (mismatched / all.size > LIMITS.hourMismatch)
    throw new Error(label + ': OANDA H1/M5 disagree in ' + mismatched + ' of ' + all.size + ' hours, e.g. ' + examples.join(', '));
  return { hours: all.size, hourMismatch: mismatched };
}

// Statistical agreement between OANDA and the archive over the overlap window.
// Prices of two providers are never identical, so we check the shape: the
// candles are present, on the same price level and move in the same direction.
export function checkOverlap(existing, incoming, { asset, from, to, label = asset }) {
  const overlap = existing.filter(b => b.timestamp >= from && b.timestamp < to);
  const byTime = new Map(incoming.map(b => [b.timestamp, b]));
  const tradedHours = new Set(incoming.filter(b => b.timestamp >= from && b.timestamp < to).map(b => new Date(b.timestamp).getUTCHours()));
  const relevant = SHORTER_SESSION.has(asset) ? overlap.filter(b => tradedHours.has(new Date(b.timestamp).getUTCHours())) : overlap;
  if (relevant.length < 20) throw new Error(label + ': not enough archived candles to verify OANDA (' + relevant.length + ')');
  const common = relevant.filter(b => byTime.has(b.timestamp));
  const coverage = common.length / relevant.length;
  if (!common.length) throw new Error(label + ': OANDA candles do not overlap the archive');
  const relative = common.map(b => Math.abs(b.close - byTime.get(b.timestamp).close) / b.close);
  let same = 0, directed = 0;
  for (const b of common) {
    const o = byTime.get(b.timestamp), a = Math.sign(b.close - b.open), c = Math.sign(o.close - o.open);
    if (a && c) { directed++; if (a === c) same++; }
  }
  const stats = {
    archived: overlap.length, compared: relevant.length, common: common.length,
    coverage: +coverage.toFixed(4), medianRelative: +median(relative).toFixed(6), maxRelative: +Math.max(...relative).toFixed(6),
    sameDirection: directed ? +(same / directed).toFixed(4) : 1,
  };
  const problems = [];
  if (stats.coverage < LIMITS.coverage) problems.push('coverage ' + stats.coverage);
  if (stats.medianRelative > LIMITS.medianRelative) problems.push('median price difference ' + stats.medianRelative);
  if (stats.maxRelative > LIMITS.maxRelative) problems.push('max price difference ' + stats.maxRelative);
  if (stats.sameDirection < LIMITS.sameDirection) problems.push('same direction ' + stats.sameDirection);
  if (problems.length) throw new Error(label + ': OANDA does not match the archive (' + problems.join(', ') + ')');
  return stats;
}

export function oandaHistory({ token, fetchImpl = fetch, wait = pause, host = PRACTICE_HOST, log = console.log, report = {} }) {
  const cache = new Map();
  const candles = (instrument, timeframe, from, to) => {
    const key = [instrument, timeframe, from, to].join(' ');
    if (!cache.has(key)) cache.set(key, fetchCandles({ instrument, timeframe, from, to, token, fetchImpl, wait, host }));
    return cache.get(key);
  };
  return async ({ asset, timeframe, existing, from, to }) => {
    const instrument = OANDA_INSTRUMENTS[asset], { scale } = INSTRUMENTS[asset];
    if (!instrument) throw new Error('No OANDA instrument for ' + asset);
    const label = asset + ' ' + timeframe;
    let incoming, hours = {};
    if (timeframe === 'm3') {
      const m1 = await candles(instrument, 'm1', from, to);
      for (const bar of m1) {
        try { validateBar(bar, scale, 60); }
        catch (error) { throw new Error(label + ': invalid OANDA M1 candle at ' + iso(bar.timestamp) + ': ' + error.message); }
      }
      incoming = aggregateMinutes(m1);
    } else {
      const h1 = await candles(instrument, 'h1', from, to), m5 = await candles(instrument, 'm5', from, to);
      for (const [rows, interval] of [[h1, 3600], [m5, 300]]) for (const bar of rows) {
        try { validateBar(bar, scale, interval); }
        catch (error) { throw new Error(label + ': invalid OANDA candle at ' + iso(bar.timestamp) + ': ' + error.message); }
      }
      hours = verifyHours(h1, m5, scale, asset);
      incoming = timeframe === 'h1' ? h1 : m5;
    }
    if (!existing.length) {
      if (!incoming.length) throw new Error(label + ': provider returned no candles for initial M3 archive');
      const stats = { seeded: true, newBars: incoming.length, lastNewUTC: iso(incoming.at(-1).timestamp) };
      report[label] = { ...stats, ...hours };
      log(label, JSON.stringify(report[label]));
      return incoming;
    }
    const stats = checkOverlap(existing, incoming, { asset, from, to, label });
    const last = existing.at(-1).timestamp;
    const fresh = incoming.filter(b => b.timestamp > last);
    report[label] = { ...stats, ...hours, newBars: fresh.length, lastArchivedUTC: iso(last), lastNewUTC: fresh.length ? iso(fresh.at(-1).timestamp) : null };
    log(label, JSON.stringify(report[label]));
    // Archived candles stay byte-for-byte; OANDA only extends the series.
    return [...existing.filter(b => b.timestamp >= from && b.timestamp < to), ...fresh];
  };
}

// Plausibility of a freshly seeded series (no archive to compare with).
export function checkSeed(rows, interval, label, limits = SEED_LIMITS) {
  if (!rows.length) throw new Error(label + ': OANDA returned no candles');
  let maxGap = 0, at = rows[0].timestamp;
  const perYear = {};
  for (let i = 0; i < rows.length; i++) {
    const y = new Date(rows[i].timestamp).getUTCFullYear();
    perYear[y] = (perYear[y] || 0) + 1;
    if (i && rows[i].timestamp - rows[i - 1].timestamp > maxGap) { maxGap = rows[i].timestamp - rows[i - 1].timestamp; at = rows[i - 1].timestamp; }
  }
  const maxGapHours = +(maxGap / 3600000).toFixed(1);
  if (maxGapHours > limits.maxGapHours) throw new Error(label + ': gap of ' + maxGapHours + ' hours after ' + iso(at));
  const minimum = interval === 3600 ? limits.minH1PerYear : interval === 300 ? limits.minM5PerYear : limits.minM3PerYear;
  const firstYear = new Date(rows[0].timestamp).getUTCFullYear(), lastYear = new Date(rows.at(-1).timestamp).getUTCFullYear();
  for (const [year, n] of Object.entries(perYear)) {
    // The first and the current year are partial.
    if (+year !== firstYear && +year !== lastYear && n < minimum) throw new Error(label + ': only ' + n + ' candles in ' + year);
  }
  return { bars: rows.length, firstUTC: iso(rows[0].timestamp), lastUTC: iso(rows.at(-1).timestamp), maxGapHours };
}

// Full history for an instrument that is not published yet.
export function oandaSeed({ token, fetchImpl = fetch, wait = pause, host = PRACTICE_HOST, log = console.log, report = {} }) {
  const cache = new Map();
  const candles = (instrument, timeframe, from, to) => {
    const key = [instrument, timeframe, from, to].join(' ');
    if (!cache.has(key)) cache.set(key, fetchCandles({ instrument, timeframe, from, to, token, fetchImpl, wait, host }));
    return cache.get(key);
  };
  const ranges = {};
  return async ({ asset, timeframe, from, to }) => {
    const instrument = OANDA_INSTRUMENTS[asset], { scale } = INSTRUMENTS[asset];
    if (!instrument) throw new Error('No OANDA instrument for ' + asset);
    (ranges[asset] ||= {})[timeframe] = from;
    const label = asset + ' ' + timeframe + ' seed', interval = timeframe === 'h1' ? 3600 : timeframe === 'm5' ? 300 : 180;
    const sourceTimeframe = timeframe === 'm3' ? 'm1' : timeframe;
    const sourceRows = await candles(instrument, sourceTimeframe, from, to);
    for (const bar of sourceRows) {
      try { validateBar(bar, scale, timeframe === 'm3' ? 60 : interval); }
      catch (error) { throw new Error(label + ': invalid OANDA candle at ' + iso(bar.timestamp) + ': ' + error.message); }
    }
    const rows = timeframe === 'm3' ? aggregateMinutes(sourceRows) : sourceRows;
    const stats = checkSeed(rows, interval, label);
    // H1 and M5 must describe the same market where both exist.
    const m5From = timeframe === 'm5' ? from : ranges[asset].m5;
    let hours = {};
    if (m5From != null) {
      const h1 = await candles(instrument, 'h1', ranges[asset].h1 ?? from, to), m5 = await candles(instrument, 'm5', m5From, to);
      hours = verifyHours(h1.filter(b => b.timestamp >= m5From), m5, scale, asset);
    }
    report[label] = { seeded: true, ...stats, ...hours, newBars: rows.length, lastNewUTC: stats.lastUTC };
    log(label, JSON.stringify(report[label]));
    return rows;
  };
}

function summaryTable(report, dryRun, changed) {
  const rows = Object.entries(report).map(([k, v]) => v.seeded
    ? `|${k}|new: ${v.firstUTC.slice(0, 10)} → ${v.lastUTC.slice(0, 10)}|max gap ${v.maxGapHours} h|—|${v.hourMismatch ?? '—'}|${v.newBars}|${v.lastNewUTC}|`
    : `|${k}|${(v.coverage * 100).toFixed(1)}%|${(v.medianRelative * 100).toFixed(3)}%|${(v.sameDirection * 100).toFixed(1)}%|${v.hourMismatch}|${v.newBars}|${v.lastNewUTC ?? '—'}|`);
  return '# OANDA quote update' + (dryRun ? ' (dry run, no publication)' : '') + '\n\n' +
    '|Series|Archive coverage|Median price diff|Same direction|H1/M5 mismatched hours|New bars|Last new UTC|\n|---|---:|---:|---:|---:|---:|---|\n' +
    rows.join('\n') + '\n\nChanged: ' + changed + '\n';
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const token = (process.env.OANDA_API_TOKEN || '').trim();
  if (!token) throw new Error('OANDA_API_TOKEN secret is missing or empty');
  if (!/^[0-9a-f]{32}-[0-9a-f]{32}$/.test(token)) throw new Error('OANDA_API_TOKEN does not look like an OANDA personal access token');
  const report = {};
  const out = dryRun ? path.resolve('oanda-check/replay-data') : undefined;
  const result = await updateQuotes({
    sourceURL: process.env.REPLAY_SOURCE_URL, out, sourceLabel: SOURCE_LABEL, cacheDir: process.env.QUOTES_CACHE_DIR || undefined,
    history: oandaHistory({ token, report, host: process.env.OANDA_HOST || PRACTICE_HOST }),
    seed: oandaSeed({ token, report, host: process.env.OANDA_HOST || PRACTICE_HOST }),
    supportsM3: true,
  });
  await fs.mkdir('oanda-check', { recursive: true });
  await fs.writeFile('oanda-check/report.json', JSON.stringify({ dryRun, changed: result.changed, limits: LIMITS, series: report }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summaryTable(report, dryRun, result.changed));
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, 'changed=' + (!dryRun && result.changed) + '\n');
  console.log(dryRun ? 'Dry run complete; nothing published. Would change:' : 'Verified OANDA update; changed:', result.changed);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('Update stopped. Existing published data remains unchanged:', error.message); process.exitCode = 1; });
}
