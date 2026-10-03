import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTRUMENTS, DAY, readBars, writeBars, mergeBars, summary, sha256, expectedFiles } from './data.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  fetchImpl = fetch, rates, wait = pause, log = console.log, bootstrap = false,
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
  const buffers = new Map(), rowsByFile = new Map();
  // Restore the published snapshot rather than stale files from a Git checkout.
  // All download/validation work finishes before touching the output directory.
  for (const file of files) {
    const buffer = source ? await getRemote(file.name) : await fs.readFile(path.join(out, file.name));
    if (meta.files?.[file.name]?.sha256 && sha256(buffer) !== meta.files[file.name].sha256) {
      throw new Error('Snapshot changed during download; retry the run');
    }
    const rows = readBars(buffer, INSTRUMENTS[file.asset].scale, file.interval);
    if (file.year && rows.some(row => new Date(row.timestamp).getUTCFullYear() !== file.year)) {
      throw new Error('Candle is in the wrong yearly file');
    }
    buffers.set(file.name, buffer); rowsByFile.set(file.name, rows);
  }
  for (const [asset, cfg] of Object.entries(INSTRUMENTS)) {
    const h1 = rowsByFile.get(asset.toLowerCase() + '_h1.bin');
    if (JSON.stringify(summary(h1)) !== JSON.stringify(meta.instruments[asset].h1)) {
      throw new Error('H1 metadata disagrees with candles for ' + asset);
    }
    const m5 = files.filter(file => file.asset === asset && file.year);
    if (m5.reduce((n, file) => n + rowsByFile.get(file.name).length, 0) !== meta.instruments[asset].m5Count) {
      throw new Error('M5 metadata disagrees with candles for ' + asset);
    }
  }
  if (!bootstrap && !rates) ({ getHistoricalRates: rates } = await import('dukascopy-node'));
  let changed = false;
  if (!bootstrap) {
  for (const [asset, cfg] of Object.entries(INSTRUMENTS)) {
    const prefix = asset.toLowerCase();
    const m5Files = files.filter(file => file.asset === asset && file.year);
    for (const [timeframe, interval, existing] of [
      ['h1', 3600, rowsByFile.get(prefix + '_h1.bin')],
      ['m5', 300, m5Files.flatMap(file => rowsByFile.get(file.name))],
    ]) {
      const from = Math.floor((existing.at(-1).timestamp - 7 * DAY) / DAY) * DAY;
      const downloaded = [];
      // Daily chunks keep recovery after a long pause bounded and retryable.
      for (let day = from; day < cutoff; day += DAY) {
        const chunk = await retry(() => rates({
          instrument: cfg.instrument, dates: { from: new Date(day), to: new Date(Math.min(day + DAY, cutoff)) },
          timeframe, format: 'json', priceType: 'bid', useCache: false,
        }), asset + ' ' + timeframe + ' ' + new Date(day).toISOString().slice(0, 10), wait);
        if (!Array.isArray(chunk)) throw new Error('Invalid provider response');
        downloaded.push(...chunk.filter(row => row.timestamp >= day && row.timestamp < Math.min(day + DAY, cutoff)));
      }
      let merged;
      try { merged = mergeBars(existing, downloaded, { scale: cfg.scale, interval, from, to: cutoff }); }
      catch (error) { throw new Error(asset + ' ' + timeframe + ': ' + error.message, { cause: error }); }
      const partitions = new Map();
      for (const row of merged) {
        const name = timeframe === 'h1' ? prefix + '_h1.bin' : prefix + '_m5_' + new Date(row.timestamp).getUTCFullYear() + '.bin';
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
    meta.instruments[asset] = {
      ...meta.instruments[asset], h1: summary(rowsByFile.get(prefix + '_h1.bin')),
      m5Years: years, m5First: rowsByFile.get(prefix + '_m5_' + years[0] + '.bin')[0].timestamp / 1000,
      m5Count: years.reduce((n, year) => n + rowsByFile.get(prefix + '_m5_' + year + '.bin').length, 0),
    };
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
  meta.source = 'Dukascopy BID';
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
