import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTRUMENTS, expectedFiles, readBars, summary } from './data.mjs';

const out = fileURLToPath(new URL('../public/replay-data/', import.meta.url));
const meta = JSON.parse(await fs.readFile(path.join(out, 'meta.json'), 'utf8'));
const counts = {}, dates = {};
for (const file of expectedFiles(meta)) {
  const rows = readBars(await fs.readFile(path.join(out, file.name)), INSTRUMENTS[file.asset].scale, file.interval);
  if (file.year) {
    counts[file.asset] = (counts[file.asset] || 0) + rows.length;
    if (rows.some(row => new Date(row.timestamp).getUTCFullYear() !== file.year)) throw new Error('Wrong year in ' + file.name);
    dates[file.asset] = rows.at(-1).timestamp;
  } else if (JSON.stringify(summary(rows)) !== JSON.stringify(meta.instruments[file.asset].h1)) {
    throw new Error('Wrong H1 summary for ' + file.asset);
  }
}
for (const asset of Object.keys(INSTRUMENTS)) {
  if (counts[asset] !== meta.instruments[asset].m5Count) throw new Error('Wrong M5 count for ' + asset);
  console.log(asset, 'validated:', counts[asset], 'M5 candles; last', new Date(dates[asset]).toISOString());
}
