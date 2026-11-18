import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTRUMENTS, M5_FROM, M3_FROM, DAY, readBars, writeBars, mergeBars, summary, sha256, expectedFiles, missingInstruments, validateBar } from './data.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function hourlyFromMinutes(minutes, scale) {
  const hours = new Map();
  let previous = -Infinity;
  for (const row of minutes) {
    validateBar(row, scale, 60);
    if (row.timestamp <= previous) throw new Error('Unsorted/duplicate minute candles');
    previous = row.timestamp;
    const timestamp = Math.floor(row.timestamp / 3600000) * 3600000;
    const hour = hours.get(timestamp);
    if (!hour) hours.set(timestamp, { timestamp, open: row.open, high: row.high, low: row.low, close: row.close });
    else { hour.high = Math.max(hour.high, row.high); hour.low = Math.min(hour.low, row.low); hour.close = row.close; }
  }
  return [...hours.values()];
}

const sameRange = (a, b, scale) => ['high', 'low']
  .every(key => Math.round(a[key] * scale) === Math.round(b[key] * scale));

async function retry(fn, label, wait = pause) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await fn(); }
    catch (error) {
      if (attempt === 3) throw new Error(label + ': ' + error.message, { cause: error });
      await wait(1000 * 2 ** attempt);
    }
  }
}

export async function updateQuotes({
  sourceURL, out = path.join(root, 'public/replay-data'), now = new Date(),
  fetchImpl = fetch, rates, history, seed, wait = pause, log = console.log, bootstrap = false,
  sourceLabel = 'Dukascopy BID', cacheDir, supportsM3 = false, backfillM3 = false,
} = {}) {
  const source = sourceURL ? new URL(sourceURL) : null;
  if (source && (source.protocol !== 'https:' || !source.hostname.endsWith('.web.app') || source.search || source.hash)) {
    throw new Error('Source must be an HTTPS Firebase Hosting URL');
  }
  if (source && !source.pathname.endsWith('/')) throw new Error('Source URL must end with /');
  // Download only completed UTC days. NY trading days are already closed by the scheduled run.
  const cutoff = Math.floor(now.getTime() / DAY) * DAY;
  if (!Number.isFinite(cutoff)) throw new Error('Invalid update time');
  const runVersion = Date.now().toString();
  const getRemote = async filename => {
    const url = new URL(filename, source); url.searchParams.set('v', runVersion);
    return retry(async () => {
      const response = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + filename);
      return Buffer.from(await response.arrayBuffer());
    }, 'Download ' + filename, wait);
  };
  const metaBuffer = source ? await getRemote('meta.json') : await fs.readFile(path.join(out, 'meta.json'));
  const meta = JSON.parse(metaBuffer.toString('utf8'));
  const files = expectedFiles(meta);
  const missing = missingInstruments(meta);
  const published = Object.entries(INSTRUMENTS).filter(([asset]) => !missing.includes(asset));
  const buffers = new Map(), rowsByFile = new Map();
  // Restore the published snapshot rather than stale files from a Git checkout.
  // All download/validation work finishes before touching the output directory.
  // Files whose checksum matches the published meta are reused from the local
  // cache (GitHub Actions cache) instead of being downloaded from Hosting again.
  const fromCache = async name => {
    const expected = meta.files?.[name]?.sha256;
    if (!cacheDir || !expected) return null;
    try { const buffer = await fs.readFile(path.join(cacheDir, name)); return sha256(buffer) === expected ? buffer : null; }
    catch { return null; }
  };
  const toCache = async (name, buffer) => {
    if (!cacheDir) return;
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, name), buffer);
  };
  let reused = 0, downloadedFiles = 0;
  for (const file of files) {
    let buffer = source ? await fromCache(file.name) : null;
    if (buffer) reused++;
    else if (source) { buffer = await getRemote(file.name); downloadedFiles++; }
    else buffer = await fs.readFile(path.join(out, file.name));
    if (meta.files?.[file.name]?.sha256 && sha256(buffer) !== meta.files[file.name].sha256) {
      throw new Error('Snapshot changed during download; retry the run');
    }
    const rows = readBars(buffer, INSTRUMENTS[file.asset].scale, file.interval);
    if (file.year && rows.some(row => new Date(row.timestamp).getUTCFullYear() !== file.year)) {
      throw new Error('Candle is in the wrong yearly file');
    }
    buffers.set(file.name, buffer); rowsByFile.set(file.name, rows);
  }
  if (source) {
    log('Snapshot restored:', reused, 'files from cache,', downloadedFiles, 'downloaded');
    for (const [name, buffer] of buffers) await toCache(name, buffer);
  }
  for (const [asset] of published) {
    const h1 = rowsByFile.get(asset.toLowerCase() + '_h1.bin');
    if (JSON.stringify(summary(h1)) !== JSON.stringify(meta.instruments[asset].h1)) {
      throw new Error('H1 metadata disagrees with candles for ' + asset);
    }
    const m5 = files.filter(file => file.asset === asset && file.year && file.interval === 300);
    if (m5.reduce((n, file) => n + rowsByFile.get(file.name).length, 0) !== meta.instruments[asset].m5Count) {
      throw new Error('M5 metadata disagrees with candles for ' + asset);
    }
  }
  if (!bootstrap && !rates && !history) ({ getHistoricalRates: rates } = await import('dukascopy-node'));
  let changed = false;
  if (!bootstrap) {
  for (const [asset, cfg] of published) {
    const prefix = asset.toLowerCase();
    const hasM3 = supportsM3 && asset === 'GER40';
    const m5Files = files.filter(file => file.asset === asset && file.year && file.interval === 300);
    const m3Files = hasM3 ? files.filter(file => file.asset === asset && file.year && file.interval === 180) : [];
    for (const [timeframe, interval, existing] of [
      ['h1', 3600, rowsByFile.get(prefix + '_h1.bin')],
      ['m5', 300, m5Files.flatMap(file => rowsByFile.get(file.name))],
      ...(hasM3 ? [['m3', 180, m3Files.length ? m3Files.flatMap(file => rowsByFile.get(file.name)) : []]] : []),
    ]) {
      const from = existing.length && !(timeframe === 'm3' && backfillM3)
        ? Math.floor((existing.at(-1).timestamp - 7 * DAY) / DAY) * DAY
        : Date.parse(M3_FROM + 'T00:00:00Z');
      let downloaded = [];
      if (history) {
        downloaded = await history({ asset, timeframe, existing, from, to: cutoff });
      } else {
      if (timeframe === 'm3') throw new Error('M3 updates require the OANDA history provider');
      let nativeUnavailable = false;
      // H1 is supplied in monthly buckets: fetch each once, not once per day.
      // M5 is supplied in daily buckets. Explicit retries make non-200 responses
      // throw instead of dukascopy-node's default silent empty buffer.
      for (let day = from; day < cutoff;) {
        const date = new Date(day);
        const end = Math.min(timeframe === 'h1' ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) : day + DAY, cutoff);
        let chunk;
        try {
          chunk = await retry(() => rates({
            instrument: cfg.instrument, dates: { from: new Date(day), to: new Date(end) },
            timeframe, format: 'json', priceType: 'bid', useCache: false,
            batchSize: 1, retryCount: 1, pauseBetweenRetriesMs: 15000, failAfterRetryCount: true,
          }), asset + ' ' + timeframe + ' ' + date.toISOString().slice(0, 10), wait);
        } catch (error) {
          if (timeframe !== 'h1') throw error;
          nativeUnavailable = true;
          log(asset, 'Native H1 unavailable; checking same-provider M1 recovery:', error.message);
          chunk = [];
        }
        if (!Array.isArray(chunk)) throw new Error('Invalid provider response');
        downloaded.push(...chunk.filter(row => row.timestamp >= day && row.timestamp < end));
        day = end;
      }
      // The current-month H1 endpoint can omit days that are available in M1.
      // Recover from the same BID source only after verifying the minute-derived
      // high/low against every archived hour in the missing period and native
      // H1 in the preceding day. Open/close differ between provider resolutions,
      // so existing archived/native OHLC is always preserved in recovery.
      // Existing native/archive H1 always takes precedence over aggregation.
      // An inconsistent or empty recovery still aborts.
      if (timeframe === 'h1') {
        const native = new Map(downloaded.map(row => [row.timestamp, row]));
        const missing = existing.filter(row => row.timestamp >= from && row.timestamp < cutoff && !native.has(row.timestamp));
        if (missing.length || nativeUnavailable) {
          const recoveryFrom = Math.max(from, Math.floor((missing[0]?.timestamp ?? existing.at(-1).timestamp) / DAY) * DAY - DAY);
          const minutes = [];
          for (let day = recoveryFrom; day < cutoff; day += DAY) {
            const chunk = await retry(() => rates({
              instrument: cfg.instrument, dates: { from: new Date(day), to: new Date(Math.min(day + DAY, cutoff)) },
              timeframe: 'm1', format: 'json', priceType: 'bid', useCache: false, ignoreFlats: false,
              batchSize: 1, retryCount: 1, pauseBetweenRetriesMs: 15000, failAfterRetryCount: true,
            }), asset + ' M1 recovery ' + new Date(day).toISOString().slice(0, 10), wait);
            if (!Array.isArray(chunk)) throw new Error('Invalid minute recovery response');
            minutes.push(...chunk.filter(row => row.timestamp >= day && row.timestamp < Math.min(day + DAY, cutoff)));
          }
          const tradedHours = new Set(minutes.filter(row => row.volume === undefined || row.volume > 0)
            .map(row => Math.floor(row.timestamp / 3600000) * 3600000));
          const recovered = hourlyFromMinutes(minutes, cfg.scale).filter(row => tradedHours.has(row.timestamp));
          const byTime = new Map(recovered.map(row => [row.timestamp, row]));
          for (const row of missing) {
            if (!byTime.has(row.timestamp) || !sameRange(row, byTime.get(row.timestamp), cfg.scale)) {
              throw new Error(asset + ' H1 recovery does not match archived candle at ' + new Date(row.timestamp).toISOString());
            }
          }
          const nativeOverlap = downloaded.filter(row => row.timestamp >= recoveryFrom && byTime.has(row.timestamp));
          if (nativeOverlap.some(row => !sameRange(row, byTime.get(row.timestamp), cfg.scale))) {
            throw new Error(asset + ' H1 recovery does not match native hourly overlap');
          }
          const archived = new Map(existing.map(row => [row.timestamp, row]));
          downloaded.push(...recovered.filter(row => !native.has(row.timestamp)).map(row => archived.get(row.timestamp) || row));
          log(asset, 'H1 recovered from verified M1 candles:', missing.length, 'archived hours preserved;', recovered.length, 'hours checked');
        }
      }
      }
      let merged;
      try { merged = mergeBars(existing, downloaded, { scale: cfg.scale, interval, from, to: cutoff }); }
      catch (error) { throw new Error(asset + ' ' + timeframe + ': ' + error.message, { cause: error }); }
      const partitions = new Map();
      for (const row of merged) {
        const name = timeframe === 'h1' ? prefix + '_h1.bin' : prefix + '_' + timeframe + '_' + new Date(row.timestamp).getUTCFullYear() + '.bin';
        if (!partitions.has(name)) partitions.set(name, []);
        partitions.get(name).push(row);
      }
      for (const [filename, rows] of partitions) {
        const buffer = writeBars(rows, cfg.scale, interval, true);
        if (!buffers.get(filename)?.equals(buffer)) changed = true;
        buffers.set(filename, buffer); rowsByFile.set(filename, rows);
      }
      log(asset, timeframe, 'last bar:', new Date(merged.at(-1).timestamp).toISOString());
    }
    const years = [...rowsByFile.keys()].filter(name => name.startsWith(prefix + '_m5_'))
      .map(name => Number(name.match(/_(\d{4})\.bin$/)[1])).sort((a, b) => a - b);
    const m3Years = [...rowsByFile.keys()].filter(name => name.startsWith(prefix + '_m3_'))
      .map(name => Number(name.match(/_(\d{4})\.bin$/)[1])).sort((a, b) => a - b);
    meta.instruments[asset] = {
      ...meta.instruments[asset], tier: cfg.tier, h1: summary(rowsByFile.get(prefix + '_h1.bin')),
      m5Years: years, m5First: rowsByFile.get(prefix + '_m5_' + years[0] + '.bin')[0].timestamp / 1000,
      m5Count: years.reduce((n, year) => n + rowsByFile.get(prefix + '_m5_' + year + '.bin').length, 0),
      ...(hasM3 ? {
        m3Years,
        m3First: m3Years.length ? rowsByFile.get(prefix + '_m3_' + m3Years[0] + '.bin')[0].timestamp / 1000 : undefined,
        m3Count: m3Years.reduce((n, year) => n + rowsByFile.get(prefix + '_m3_' + year + '.bin').length, 0),
      } : {}),
    };
  }
  // New tier 2 instruments: download their full history once. Every candle is
  // validated strictly; nothing is published unless all instruments succeed.
  for (const asset of missing) {
    const cfg = INSTRUMENTS[asset], prefix = asset.toLowerCase();
    const hasM3 = supportsM3 && asset === 'GER40';
    if (!seed) { log(asset, 'not published yet; this source cannot seed history, skipped'); continue; }
    const fromOf = { h1: Date.parse(cfg.h1From + 'T00:00:00Z'), m5: Date.parse(M5_FROM + 'T00:00:00Z'), m3: Date.parse(M3_FROM + 'T00:00:00Z') };
    for (const [timeframe, interval] of [['h1', 3600], ['m5', 300], ...(hasM3 ? [['m3', 180]] : [])]) {
      const from = fromOf[timeframe];
      let rows;
      try { rows = mergeBars([], await seed({ asset, timeframe, from, to: cutoff }), { scale: cfg.scale, interval, from, to: cutoff }); }
      catch (error) { throw new Error(asset + ' ' + timeframe + ' seed: ' + error.message, { cause: error }); }
      if (!rows.length) throw new Error(asset + ' ' + timeframe + ' seed returned no candles');
      for (const row of rows) {
        const name = timeframe === 'h1' ? prefix + '_h1.bin' : prefix + '_' + timeframe + '_' + new Date(row.timestamp).getUTCFullYear() + '.bin';
        if (!rowsByFile.has(name)) rowsByFile.set(name, []);
        rowsByFile.get(name).push(row);
      }
    }
    const names = [...rowsByFile.keys()].filter(name => name.startsWith(prefix + '_'));
    for (const name of names) buffers.set(name, writeBars(rowsByFile.get(name), cfg.scale, name.endsWith('_h1.bin') ? 3600 : name.includes('_m3_') ? 180 : 300));
    const years = names.filter(name => name.startsWith(prefix + '_m5_'))
      .map(name => Number(name.match(/_(\d{4})\.bin$/)[1])).sort((a, b) => a - b);
    const m3Years = names.filter(name => name.startsWith(prefix + '_m3_'))
      .map(name => Number(name.match(/_(\d{4})\.bin$/)[1])).sort((a, b) => a - b);
    if (!years.length || !rowsByFile.has(prefix + '_h1.bin') || (hasM3 && !m3Years.length)) throw new Error(asset + ' seed is incomplete');
    meta.instruments[asset] = {
      scale: cfg.scale, dp: cfg.dp, tier: cfg.tier, h1: summary(rowsByFile.get(prefix + '_h1.bin')),
      m5Years: years, m5First: rowsByFile.get(prefix + '_m5_' + years[0] + '.bin')[0].timestamp / 1000,
      m5Count: years.reduce((n, year) => n + rowsByFile.get(prefix + '_m5_' + year + '.bin').length, 0),
      ...(hasM3 ? {
        m3Years,
        m3First: rowsByFile.get(prefix + '_m3_' + m3Years[0] + '.bin')[0].timestamp / 1000,
        m3Count: m3Years.reduce((n, year) => n + rowsByFile.get(prefix + '_m3_' + year + '.bin').length, 0),
      } : {}),
    };
    changed = true;
    log(asset, 'seeded:', meta.instruments[asset].h1.n, 'H1 and', meta.instruments[asset].m5Count, 'M5 candles');
  }
  }
  // Bootstrap copies validated history without claiming that fresh quotes were fetched.
  // Add checksums on the first run. No new bars/no corrections means no redeploy.
  if (!meta.files) changed = true;
  if (!changed && !bootstrap) { log('No new candles or corrections; publication skipped.'); return { changed: false, meta }; }
  if (!bootstrap) {
    meta.generated = now.toISOString();
    meta.checkedThroughUTC = new Date(cutoff - DAY).toISOString().slice(0, 10);
  }
  meta.source = sourceLabel;
  meta.files = Object.fromEntries([...buffers].map(([filename, buffer]) => [filename, {
    ...summary(rowsByFile.get(filename)), sha256: sha256(buffer), bytes: buffer.length,
  }]));
  const parent = path.dirname(out);
  await fs.mkdir(parent, { recursive: true });
  const stage = await fs.mkdtemp(path.join(parent, '.update-'));
  const backup = stage + '-old';
  let movedOld = false;
  try {
    for (const [filename, buffer] of buffers) await fs.writeFile(path.join(stage, filename), buffer);
    await fs.writeFile(path.join(stage, 'meta.json'), JSON.stringify(meta, null, 1) + '\n');
    try { await fs.rename(out, backup); movedOld = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await fs.rename(stage, out); }
    catch (error) { if (movedOld) await fs.rename(backup, out); throw error; }
    if (movedOld) await fs.rm(backup, { recursive: true, force: true });
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
  for (const [filename, buffer] of buffers) await toCache(filename, buffer);
  return { changed: true, meta };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await updateQuotes({ sourceURL: process.env.REPLAY_SOURCE_URL, bootstrap: process.argv.includes('--bootstrap') });
    if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, 'changed=' + result.changed + '\n');
  } catch (error) {
    console.error('Update stopped. Existing published data remains unchanged:', error.message);
    process.exitCode = 1;
  }
}

