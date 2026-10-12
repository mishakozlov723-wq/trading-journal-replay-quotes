import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { INSTRUMENTS, writeBars, readBars, sha256, summary } from '../tools/data.mjs';
import { updateQuotes } from '../tools/update.mjs';
import { fetchCandles, verifyHours, checkOverlap, checkSeed, oandaHistory, oandaSeed, OANDA_INSTRUMENTS, SOURCE_LABEL } from '../oanda-fetch.mjs';

const H = 3600000, M = 300000, DAY = 86400000;
const start = Date.parse('2014-01-06T00:00:00Z'); // Monday
const BASE = { XAUUSD: 1250, EURUSD: 1.36, GBPUSD: 1.64, GER40: 9400, USDJPY: 104.5, XAGUSD: 19.9, USDCAD: 1.06, NZDUSD: 0.82, USDCHF: 0.89 };
const ASSET_BY_INSTRUMENT = Object.fromEntries(Object.entries(OANDA_INSTRUMENTS).map(([a, i]) => [i, a]));

// Deterministic M5 candles on the price grid; H1 is their exact aggregation.
function m5Bar(asset, t, offsetTicks = 0) {
  const { scale } = INSTRUMENTS[asset];
  const p = x => Math.round(BASE[asset] * (1 + 0.002 * Math.sin(x / 7e6)) * scale) + offsetTicks;
  const o = p(t), c = p(t + M), h = Math.max(o, c) + 3, l = Math.min(o, c) - 3;
  return { timestamp: t, open: o / scale, high: h / scale, low: l / scale, close: c / scale };
}
function series(asset, from, to, { offsetTicks = 0, skipHour = () => false } = {}) {
  const m5 = [];
  for (let t = from; t < to; t += M) if (!skipHour(new Date(t).getUTCHours())) m5.push(m5Bar(asset, t, offsetTicks));
  const hours = new Map();
  for (const b of m5) {
    const t = Math.floor(b.timestamp / H) * H, g = hours.get(t);
    if (!g) hours.set(t, { ...b, timestamp: t });
    else { g.high = Math.max(g.high, b.high); g.low = Math.min(g.low, b.low); g.close = b.close; }
  }
  return { h1: [...hours.values()], m5 };
}

function oandaFetch({ offsetTicks = 1, status, calls = [], gerNight = true } = {}) {
  return async url => {
    calls.push(url);
    if (status) return { ok: false, status, text: async () => 'error', json: async () => ({}) };
    const instrument = url.pathname.split('/')[3], granularity = url.searchParams.get('granularity');
    const asset = ASSET_BY_INSTRUMENT[instrument];
    const from = Date.parse(url.searchParams.get('from')), to = Date.parse(url.searchParams.get('to'));
    const skipHour = asset === 'GER40' && gerNight ? h => h >= 20 : () => false;
    const s = series(asset, from - from % H, to, { offsetTicks, skipHour });
    const rows = (granularity === 'H1' ? s.h1 : s.m5).filter(b => b.timestamp >= from && b.timestamp < to);
    const candles = rows.map(b => ({ complete: true, volume: 5, time: new Date(b.timestamp).toISOString().replace('.000Z', '.000000000Z'),
      bid: { o: String(b.open), h: String(b.high), l: String(b.low), c: String(b.close) } }));
    candles.push({ complete: false, volume: 1, time: new Date(to).toISOString(), bid: candles.at(-1)?.bid });
    return { ok: true, status: 200, json: async () => ({ instrument, granularity, candles }) };
  };
}

async function seed(t, days = 2, only = () => true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tj-oanda-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const out = path.join(root, 'replay-data'); await fs.mkdir(out);
  const meta = { generated: '2014-01-08T06:00:00.000Z', source: 'Dukascopy BID', instruments: {}, files: {} }, buffers = new Map();
  for (const [asset, cfg] of Object.entries(INSTRUMENTS).filter(([a, c]) => only(a, c))) {
    const prefix = asset.toLowerCase(), s = series(asset, start, start + days * DAY);
    for (const [name, rows, interval] of [[prefix + '_h1.bin', s.h1, 3600], [prefix + '_m5_2014.bin', s.m5, 300]]) {
      const buffer = writeBars(rows, cfg.scale, interval);
      buffers.set(name, buffer);
      meta.files[name] = { ...summary(rows), sha256: sha256(buffer), bytes: buffer.length };
    }
    meta.instruments[asset] = { scale: cfg.scale, dp: cfg.dp, h1: summary(s.h1), m5Years: [2014], m5First: s.m5[0].timestamp / 1000, m5Count: s.m5.length };
  }
  buffers.set('meta.json', Buffer.from(JSON.stringify(meta)));
  for (const [name, buffer] of buffers) await fs.writeFile(path.join(out, name), buffer);
  return { out, buffers };
}
const common = { now: new Date(start + 3 * DAY + 6 * H), wait: async () => {}, log: () => {} };
const token = 'a'.repeat(32) + '-' + 'b'.repeat(32);

test('fetchCandles splits long ranges, drops incomplete/out-of-range candles and parses BID prices', async () => {
  const calls = [];
  const rows = await fetchCandles({ instrument: 'EUR_USD', timeframe: 'm5', from: start, to: start + 20 * DAY, token, fetchImpl: oandaFetch({ calls }), wait: async () => {} });
  assert.equal(calls.length, 2);
  assert.equal(rows.length, 20 * 288);
  assert.equal(rows.at(-1).timestamp, start + 20 * DAY - M);
  assert.ok(rows.every((b, i) => !i || b.timestamp > rows[i - 1].timestamp));
  assert.equal(calls[0].searchParams.get('price'), 'B');
});

test('token errors fail fast, server errors are retried, wrong responses are rejected', async () => {
  const calls = [];
  await assert.rejects(fetchCandles({ instrument: 'EUR_USD', timeframe: 'h1', from: start, to: start + DAY, token, fetchImpl: oandaFetch({ status: 401, calls }), wait: async () => {} }), /rejected the token/);
  assert.equal(calls.length, 1);
  let n = 0; const good = oandaFetch();
  const flaky = async url => (++n < 3 ? { ok: false, status: 503, text: async () => 'busy' } : good(url));
  assert.equal((await fetchCandles({ instrument: 'EUR_USD', timeframe: 'h1', from: start, to: start + DAY, token, fetchImpl: flaky, wait: async () => {} })).length, 24);
  const wrong = async url => ({ ok: true, status: 200, json: async () => ({ instrument: 'GBP_USD', granularity: 'H1', candles: [] }) });
  await assert.rejects(fetchCandles({ instrument: 'EUR_USD', timeframe: 'h1', from: start, to: start + DAY, token, fetchImpl: wrong, wait: async () => {} }), /Unexpected OANDA response/);
  await assert.rejects(fetchCandles({ instrument: 'EUR_USD', timeframe: 'h1', from: start, to: start + DAY, token, fetchImpl: oandaFetch({ status: 400 }), wait: async () => {} }), /HTTP 400/);
});

test('H1 must agree with M5 aggregation', () => {
  const s = series('EURUSD', start, start + DAY);
  assert.deepEqual(verifyHours(s.h1, s.m5, 100000), { hours: 24, hourMismatch: 0 });
  const broken = s.h1.map(b => ({ ...b, high: b.high + 0.001 }));
  assert.throws(() => verifyHours(broken, s.m5, 100000), /H1\/M5 disagree/);
});

test('a missing new hour in either timeframe aborts even below the price mismatch tolerance', async t => {
  for (const granularity of ['H1', 'M5']) {
    const { out, buffers } = await seed(t);
    const good = oandaFetch();
    const missingHour = start + 2 * DAY + 5 * H;
    const partial = async url => {
      const response = await good(url);
      const body = await response.json();
      if (body.instrument === 'EUR_USD' && body.granularity === granularity) {
        body.candles = body.candles.filter(c => {
          const time = Date.parse(c.time);
          return time < missingHour || time >= missingHour + H;
        });
      }
      return { ...response, json: async () => body };
    };
    await assert.rejects(updateQuotes({ ...common, out,
      history: oandaHistory({ token, fetchImpl: partial, wait: async () => {}, log: () => {} }),
    }), /H1\/M5.*missing/);
    for (const [name, buffer] of buffers) assert.deepEqual(await fs.readFile(path.join(out, name)), buffer);
  }
});

test('overlap check accepts a similar feed and rejects wrong level, gaps and opposite candles', () => {
  const range = { from: start, to: start + DAY };
  const archive = series('EURUSD', start, start + DAY).m5;
  const similar = series('EURUSD', start, start + DAY, { offsetTicks: 2 }).m5;
  assert.equal(checkOverlap(archive, similar, { asset: 'EURUSD', ...range }).coverage, 1);
  assert.throws(() => checkOverlap(archive, similar.map(b => ({ ...b, open: b.open * 1.01, high: b.high * 1.01, low: b.low * 1.01, close: b.close * 1.01 })), { asset: 'EURUSD', ...range }), /median price difference/);
  assert.throws(() => checkOverlap(archive, similar.filter((_, i) => i % 10), { asset: 'EURUSD', ...range }), /coverage/);
  assert.throws(() => checkOverlap(archive, similar.map(b => ({ ...b, open: b.close, close: b.open })), { asset: 'EURUSD', ...range }), /same direction/);
  const night = h => h >= 20;
  const ger = series('GER40', start, start + DAY, { skipHour: night }).m5;
  assert.equal(checkOverlap(series('GER40', start, start + DAY).m5, ger, { asset: 'GER40', ...range }).coverage, 1);
  assert.throws(() => checkOverlap(archive, series('EURUSD', start, start + DAY, { skipHour: night }).m5, { asset: 'EURUSD', ...range }), /coverage/);
});

test('OANDA update appends only new completed candles and never rewrites the archive', async t => {
  const { out, buffers } = await seed(t);
  const fetchImpl = oandaFetch({ offsetTicks: 1 });
  const result = await updateQuotes({ ...common, out, sourceLabel: SOURCE_LABEL, history: oandaHistory({ token, fetchImpl, wait: async () => {}, log: () => {} }) });
  assert.equal(result.changed, true);
  assert.equal(result.meta.source, SOURCE_LABEL);
  assert.equal(result.meta.checkedThroughUTC, '2014-01-08');
  for (const [asset, cfg] of Object.entries(INSTRUMENTS)) {
    const prefix = asset.toLowerCase();
    for (const [name, interval, perDay] of [[prefix + '_h1.bin', 3600, 24], [prefix + '_m5_2014.bin', 300, 288]]) {
      const before = readBars(buffers.get(name), cfg.scale, interval), after = readBars(await fs.readFile(path.join(out, name)), cfg.scale, interval);
      assert.deepEqual(after.slice(0, before.length), before, name + ' archived candles changed');
      const night = asset === 'GER40' ? 4 : 0;
      assert.equal(after.length - before.length, perDay - night * perDay / 24, name + ' new candles');
      assert.ok(after.at(-1).timestamp < start + 3 * DAY);
    }
  }
  const again = await updateQuotes({ ...common, out, sourceLabel: SOURCE_LABEL, history: oandaHistory({ token, fetchImpl, wait: async () => {}, log: () => {} }) });
  assert.equal(again.changed, false);
});

test('a rejected token or mismatching feed leaves every file byte-for-byte unchanged', async t => {
  const { out, buffers } = await seed(t);
  await assert.rejects(updateQuotes({ ...common, out, history: oandaHistory({ token, fetchImpl: oandaFetch({ status: 401 }), wait: async () => {}, log: () => {} }) }), /rejected the token/);
  await assert.rejects(updateQuotes({ ...common, out, history: oandaHistory({ token, fetchImpl: oandaFetch({ offsetTicks: 500000 }), wait: async () => {}, log: () => {} }) }), /does not match the archive/);
  for (const [name, buffer] of buffers) assert.deepEqual(await fs.readFile(path.join(out, name)), buffer);
});
test('missing tier 2 instruments are seeded with full history; tier 1 archive is untouched', async t => {
  const { out, buffers } = await seed(t, 2, (a, c) => c.tier === 1);
  const fetchImpl = oandaFetch({ offsetTicks: 1 }), quiet = { token, fetchImpl, wait: async () => {}, log: () => {} };
  const report = {};
  const result = await updateQuotes({ ...common, out, sourceLabel: SOURCE_LABEL, history: oandaHistory(quiet), seed: oandaSeed({ ...quiet, report }) });
  assert.equal(result.changed, true);
  for (const [asset, cfg] of Object.entries(INSTRUMENTS)) {
    const m = result.meta.instruments[asset], prefix = asset.toLowerCase();
    assert.equal(m.tier, cfg.tier); assert.equal(m.scale, cfg.scale);
    if (cfg.tier === 1) {
      const before = readBars(buffers.get(prefix + '_h1.bin'), cfg.scale, 3600), after = readBars(await fs.readFile(path.join(out, prefix + '_h1.bin')), cfg.scale, 3600);
      assert.deepEqual(after.slice(0, before.length), before);
      continue;
    }
    assert.equal(m.dp, cfg.dp);
    assert.deepEqual(m.m5Years, [2013, 2014]);
    assert.equal(m.h1.first * 1000, Date.parse(cfg.h1From + 'T00:00:00Z'));
    assert.equal(m.m5First * 1000, Date.parse('2013-01-01T00:00:00Z'));
    assert.ok(m.h1.last * 1000 < start + 3 * DAY);
    const h1 = readBars(await fs.readFile(path.join(out, prefix + '_h1.bin')), cfg.scale, 3600);
    assert.equal(h1.length, m.h1.n);
    assert.equal(result.meta.files[prefix + '_m5_2013.bin'].n, 365 * 288);
    assert.equal(report[asset + ' m5 seed'].hourMismatch, 0);
  }
  // Next night the seeded instruments are ordinary published series.
  const again = await updateQuotes({ ...common, out, sourceLabel: SOURCE_LABEL, history: oandaHistory(quiet), seed: oandaSeed(quiet) });
  assert.equal(again.changed, false);
});

test('seed plausibility rejects long gaps and thin years', () => {
  const hours = (from, n) => Array.from({ length: n }, (_, i) => ({ timestamp: from + i * H }));
  const y = Date.parse('2010-01-01T00:00:00Z');
  assert.equal(checkSeed(hours(y, 3 * 8760), 3600, 'x').maxGapHours, 1);
  const gap = hours(y, 3 * 8760); gap.splice(4000, 120);
  assert.throws(() => checkSeed(gap, 3600, 'x'), /gap of 121 hours/);
  const thin = hours(y, 3 * 8760).filter((b, i) => i < 8760 || i >= 2 * 8760 || i % 3 === 0);
  assert.throws(() => checkSeed(thin, 3600, 'x', { maxGapHours: 100, minH1PerYear: 5000 }), /only \d+ candles in 2011/);
});

test('remote snapshot is reused from cache when checksums match; stale cache files are re-downloaded', async t => {
  const { out, buffers } = await seed(t);
  const cacheDir = out + '-cache'; t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const requested = [];
  const remote = async url => {
    const name = url.pathname.split('/').pop(); requested.push(name);
    const buffer = buffers.get(name); if (!buffer) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length) };
  };
  const quiet = { token, fetchImpl: oandaFetch({ offsetTicks: 1 }), wait: async () => {}, log: () => {} };
  const run = () => updateQuotes({ ...common, sourceURL: 'https://quotes-test.web.app/replay-data/', fetchImpl: remote, out: out + '-new', cacheDir, history: oandaHistory(quiet) });
  t.after(() => fs.rm(out + '-new', { recursive: true, force: true }));
  await run();
  assert.ok(requested.length > 2);
  // Simulate the deploy: Hosting now serves what the first run produced.
  for (const name of await fs.readdir(out + '-new')) buffers.set(name, await fs.readFile(path.join(out + '-new', name)));
  requested.length = 0;
  await fs.writeFile(path.join(cacheDir, 'eurusd_h1.bin'), Buffer.from('stale'));
  await fs.rm(path.join(cacheDir, 'gbpusd_h1.bin'));
  await run();
  // Only meta.json and the two damaged files are fetched again.
  assert.deepEqual(requested.sort(), ['eurusd_h1.bin', 'gbpusd_h1.bin', 'meta.json']);
});
