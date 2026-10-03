import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { INSTRUMENTS, writeBars, readBars, sha256, summary, mergeBars } from '../tools/data.mjs';
import { updateQuotes } from '../tools/update.mjs';

const stamp = value => Date.parse(value + 'Z');
const candle = timestamp => ({ timestamp, open: 1, high: 1.2, low: 0.8, close: 1.1 });
const oldH1 = candle(stamp('2013-12-31T23:00:00'));
const oldM5 = candle(stamp('2013-12-31T23:55:00'));

async function seed(t, { checksums = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tj-replay-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const out = path.join(root, 'replay-data'); await fs.mkdir(out);
  const meta = { generated: '2014-01-01T06:00:00.000Z', instruments: {} }, buffers = new Map();
  for (const [asset, cfg] of Object.entries(INSTRUMENTS)) {
    const prefix = asset.toLowerCase();
    const h1 = writeBars([oldH1], cfg.scale, 3600), m5 = writeBars([oldM5], cfg.scale, 300);
    buffers.set(prefix + '_h1.bin', h1); buffers.set(prefix + '_m5_2013.bin', m5);
    meta.instruments[asset] = { scale: cfg.scale, dp: cfg.dp, h1: summary([oldH1]), m5Years: [2013], m5First: oldM5.timestamp / 1000, m5Count: 1 };
  }
  if (checksums) meta.files = Object.fromEntries([...buffers].map(([name, buf]) => [name, {
    ...summary([name.includes('_h1') ? oldH1 : oldM5]), sha256: sha256(buf), bytes: buf.length,
  }]));
  buffers.set('meta.json', Buffer.from(JSON.stringify(meta)));
  for (const [name, buffer] of buffers) await fs.writeFile(path.join(out, name), buffer);
  return { root, out, buffers, meta };
}

function provider({ append = true, incomplete = false, failAsset } = {}) {
  return async ({ instrument, timeframe, dates }) => {
    if (instrument === failAsset) throw new Error('Provider unavailable');
    const rows = [timeframe === 'h1' ? oldH1 : oldM5];
    if (append) rows.push(candle(stamp('2014-01-01T00:00:00')));
    const result = rows.filter(row => row.timestamp >= +dates.from && row.timestamp < +dates.to);
    return incomplete ? result.filter(row => row.timestamp !== oldH1.timestamp && row.timestamp !== oldM5.timestamp) : result;
  };
}
const common = { now: new Date('2014-01-02T06:23:00Z'), wait: async () => {}, log: () => {} };

test('binary round trip, bad lengths, scales, sorting and OHLC are rejected', () => {
  const buffer = writeBars([oldH1], 1000, 3600);
  assert.deepEqual(readBars(buffer, 1000, 3600), [oldH1]);
  assert.throws(() => readBars(buffer.subarray(0, buffer.length - 1), 1000, 3600));
  assert.throws(() => readBars(buffer, 100000, 3600));
  assert.throws(() => writeBars([oldH1, oldH1], 1000, 3600));
  assert.throws(() => writeBars([{ ...oldH1, close: 3 }], 1000, 3600));
});

test('a correction replaces the existing timestamp without duplicating candles', () => {
  const corrected = { ...oldH1, high: 1.3 };
  const rows = mergeBars([oldH1], [corrected], { scale: 1000, interval: 3600, from: oldH1.timestamp, to: oldH1.timestamp + 3600000 });
  assert.deepEqual(rows, [corrected]);
});

test('legacy two-tick inconsistencies are preserved; new invalid provider rows are rejected', () => {
  const legacy = { ...oldH1, open: 1.202 };
  const original = writeBars([legacy], 1000, 3600, true);
  const restored = readBars(original, 1000, 3600);
  assert.deepEqual(writeBars(restored, 1000, 3600, true), original);
  assert.throws(() => mergeBars([], [legacy], { scale: 1000, interval: 3600, from: oldH1.timestamp, to: oldH1.timestamp + 3600000 }), /Invalid candle OHLC/);
});

test('new year creates M5 files, extends H1, preserves old files and writes checksums', async t => {
  const { out, buffers } = await seed(t);
  const result = await updateQuotes({ ...common, out, rates: provider() });
  assert.equal(result.changed, true);
  for (const [asset, cfg] of Object.entries(INSTRUMENTS)) {
    const prefix = asset.toLowerCase();
    assert.deepEqual(result.meta.instruments[asset].m5Years, [2013, 2014]);
    assert.equal(result.meta.instruments[asset].h1.n, 2);
    assert.equal(result.meta.instruments[asset].m5Count, 2);
    assert.deepEqual(await fs.readFile(path.join(out, prefix + '_m5_2013.bin')), buffers.get(prefix + '_m5_2013.bin'));
    const next = await fs.readFile(path.join(out, prefix + '_m5_2014.bin'));
    assert.equal(readBars(next, cfg.scale, 300).length, 1);
    assert.equal(result.meta.files[prefix + '_m5_2014.bin'].sha256, sha256(next));
  }
});

test('failure of a later instrument leaves every local file byte-for-byte unchanged', async t => {
  const { out, buffers } = await seed(t);
  await assert.rejects(updateQuotes({ ...common, out, rates: provider({ failAsset: 'gbpusd' }) }), /Provider unavailable/);
  for (const [name, buffer] of buffers) assert.deepEqual(await fs.readFile(path.join(out, name)), buffer);
});

test('empty/partial overlap fails rather than replacing established history', async t => {
  const { out, buffers } = await seed(t);
  await assert.rejects(updateQuotes({ ...common, out, rates: provider({ incomplete: true }) }), /incomplete overlap/);
  assert.deepEqual(await fs.readFile(path.join(out, 'meta.json')), buffers.get('meta.json'));
});

test('weekend/no new candles skips publication and preserves generated timestamp', async t => {
  const { out, buffers } = await seed(t, { checksums: true });
  const result = await updateQuotes({ ...common, out, rates: provider({ append: false }) });
  assert.equal(result.changed, false);
  for (const [name, buffer] of buffers) assert.deepEqual(await fs.readFile(path.join(out, name)), buffer);
});

test('unclosed UTC day is excluded even if the provider returns extra candles', async t => {
  const { out } = await seed(t);
  const base = provider();
  const result = await updateQuotes({ ...common, out, rates: async options => [...await base(options), candle(stamp('2014-01-02T00:00:00'))] });
  assert.equal(result.meta.instruments.XAUUSD.h1.last, stamp('2014-01-01T00:00:00') / 1000);
});

test('restore uses the published source, not an outdated Git checkout', async t => {
  const { root, buffers } = await seed(t, { checksums: true });
  const out = path.join(root, 'fresh-output');
  const fetchImpl = async url => {
    assert.equal(url.hostname, 'quotes-example.web.app');
    assert.ok(url.searchParams.get('v'));
    const buffer = buffers.get(path.posix.basename(url.pathname));
    return { ok: !!buffer, status: buffer ? 200 : 404, arrayBuffer: async () => buffer };
  };
  const result = await updateQuotes({ ...common, out, sourceURL: 'https://quotes-example.web.app/replay-data/', fetchImpl, rates: provider() });
  assert.equal(result.changed, true);
  assert.ok(await fs.stat(path.join(out, 'meta.json')));
});

test('a changed remote snapshot is rejected before publication', async t => {
  const { root, buffers } = await seed(t, { checksums: true });
  const out = path.join(root, 'fresh-output');
  const fetchImpl = async url => {
    const name = path.posix.basename(url.pathname), buffer = Buffer.from(buffers.get(name));
    if (name === 'xauusd_h1.bin') buffer[20] ^= 1;
    return { ok: true, arrayBuffer: async () => buffer };
  };
  await assert.rejects(updateQuotes({ ...common, out, sourceURL: 'https://quotes-example.web.app/replay-data/', fetchImpl, rates: provider() }), /Snapshot changed/);
  await assert.rejects(fs.stat(out), { code: 'ENOENT' });
});

test('bootstrap preserves archive bytes and generation date without calling provider', async t => {
  const { out, buffers, meta } = await seed(t);
  const result = await updateQuotes({ ...common, out, bootstrap: true,
    rates: () => { throw new Error('Bootstrap must not fetch new candles'); } });
  assert.equal(result.changed, true);
  assert.equal(result.meta.generated, meta.generated);
  assert.equal(result.meta.checkedThroughUTC, undefined);
  for (const [name, buffer] of buffers) {
    if (name !== 'meta.json') assert.deepEqual(await fs.readFile(path.join(out, name)), buffer);
  }
  assert.equal(Object.keys(result.meta.files).length, 8);
});
