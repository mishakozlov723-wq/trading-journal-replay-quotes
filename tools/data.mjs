import { createHash } from 'node:crypto';

// Tier 1: original Dukascopy archive, extended daily from OANDA.
// Tier 2: full history seeded once from OANDA (H1 from h1From, M5 from M5_FROM),
// then extended daily like tier 1. Tier 2 has no Dukascopy instrument.
export const INSTRUMENTS = {
  XAUUSD: { instrument: 'xauusd', scale: 1000, dp: 2, tier: 1 },
  EURUSD: { instrument: 'eurusd', scale: 100000, dp: 5, tier: 1 },
  GBPUSD: { instrument: 'gbpusd', scale: 100000, dp: 5, tier: 1 },
  GER40: { instrument: 'deuidxeur', scale: 1000, dp: 1, tier: 1 },
  USDJPY: { scale: 1000, dp: 3, tier: 2, h1From: '2005-01-01' },
  XAGUSD: { scale: 100000, dp: 3, tier: 2, h1From: '2006-03-01' },
  USDCAD: { scale: 100000, dp: 5, tier: 2, h1From: '2005-01-01' },
  NZDUSD: { scale: 100000, dp: 5, tier: 2, h1From: '2005-01-01' },
  USDCHF: { scale: 100000, dp: 5, tier: 2, h1From: '2005-01-01' },
};
export const M5_FROM = '2013-01-01';
// M3 is derived from verified OANDA M1 candles. Existing H1/M5 history stays
// unchanged; the first M3 backfill is limited to a recent window so the
// initial publication fits OANDA's request and workflow limits.
export const M3_FROM = '2025-01-01';
export const M3_LOOKBACK_DAYS = 90;
export const DAY = 86400000;

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function readBars(buffer, expectedScale, interval) {
  if (buffer.length < 16) throw new Error('Truncated candle file');
  const n = buffer.readInt32LE(0), scale = buffer.readInt32LE(4);
  if (n < 1 || scale !== expectedScale || buffer.length !== 16 + n * 20) {
    throw new Error('Invalid candle count, scale or length');
  }
  const rows = [];
  for (let i = 0; i < n; i++) {
    const row = {
      timestamp: buffer.readInt32LE(16 + i * 4) * 1000,
      open: buffer.readInt32LE(16 + (n + i) * 4) / scale,
      high: buffer.readInt32LE(16 + (2 * n + i) * 4) / scale,
      low: buffer.readInt32LE(16 + (3 * n + i) * 4) / scale,
      close: buffer.readInt32LE(16 + (4 * n + i) * 4) / scale,
    };
    validateBar(row, scale, interval, true);
    if (i && row.timestamp <= rows[i - 1].timestamp) throw new Error('Unsorted/duplicate candles');
    rows.push(row);
  }
  return rows;
}

export function validateBar(row, scale, interval, preserveLegacy = false) {
  const t = row.timestamp / 1000;
  if (!Number.isInteger(t) || t <= 0 || t > 2147483647 || t % interval !== 0) {
    throw new Error('Invalid candle timestamp');
  }
  for (const key of ['open', 'high', 'low', 'close']) {
    const value = row[key];
    if (!Number.isFinite(value) || value <= 0 || Math.round(value * scale) > 2147483647) {
      throw new Error('Invalid candle price');
    }
  }
  // Existing archive contains 1–2 tick OHLC inconsistencies in October 2024.
  // Preserve those exact historical values; new provider rows remain strict.
  const prices = Object.fromEntries(['open', 'high', 'low', 'close'].map(key => [key, Math.round(row[key] * scale)]));
  const allowance = preserveLegacy ? 2 : 0;
  if (Math.max(prices.low - prices.high, prices.low - prices.open, prices.open - prices.high,
      prices.low - prices.close, prices.close - prices.high) > allowance) throw new Error('Invalid candle OHLC');
}

export function writeBars(rows, scale, interval, preserveLegacy = false) {
  const buffer = Buffer.alloc(16 + rows.length * 20);
  buffer.writeInt32LE(rows.length, 0);
  buffer.writeInt32LE(scale, 4);
  rows.forEach((row, i) => {
    validateBar(row, scale, interval, preserveLegacy);
    if (i && row.timestamp <= rows[i - 1].timestamp) throw new Error('Unsorted/duplicate candles');
    buffer.writeInt32LE(row.timestamp / 1000, 16 + i * 4);
    ['open', 'high', 'low', 'close'].forEach((key, column) => {
      buffer.writeInt32LE(Math.round(row[key] * scale), 16 + ((column + 1) * rows.length + i) * 4);
    });
  });
  return buffer;
}

export function mergeBars(existing, downloaded, { scale, interval, from, to }) {
  if (!Array.isArray(downloaded)) throw new Error('Invalid provider response');
  const fresh = downloaded.filter(row => row.timestamp >= from && row.timestamp < to);
  fresh.forEach(row => validateBar(row, scale, interval));
  const byTime = new Map();
  for (const row of fresh) {
    if (byTime.has(row.timestamp)) throw new Error('Duplicate timestamps from provider');
    byTime.set(row.timestamp, row);
  }
  // An empty or partial provider response must not replace established history.
  // Including a week before the latest known bar gives every request an overlap.
  for (const row of existing) {
    if (row.timestamp >= from && row.timestamp < to && !byTime.has(row.timestamp)) {
      const missing = existing.filter(row => row.timestamp >= from && row.timestamp < to && !byTime.has(row.timestamp));
      throw new Error('Provider returned incomplete overlap; published history is preserved. Missing ' + missing.length +
        ' known bars; first ' + new Date(missing[0].timestamp).toISOString() + '; fresh rows ' + fresh.length);
    }
  }
  for (const row of existing) if (!byTime.has(row.timestamp)) byTime.set(row.timestamp, row);
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export function summary(rows) {
  return { n: rows.length, first: rows[0]?.timestamp / 1000, last: rows.at(-1)?.timestamp / 1000 };
}

// Tier 2 instruments that are not published yet and must be seeded.
export function missingInstruments(meta) {
  return Object.keys(INSTRUMENTS).filter(name => INSTRUMENTS[name].tier === 2 && !meta?.instruments?.[name]);
}

export function expectedFiles(meta) {
  const files = [], missing = new Set(missingInstruments(meta));
  for (const [name, cfg] of Object.entries(INSTRUMENTS)) {
    const instrument = meta?.instruments?.[name];
    if (missing.has(name)) continue;
    if (!instrument || instrument.scale !== cfg.scale || !Array.isArray(instrument.m5Years) ||
        !instrument.h1?.n || !instrument.m5Years.length) throw new Error('Invalid metadata for ' + name);
    if (instrument.m5Years.some((y, i, list) => !Number.isInteger(y) || y < 2013 || y > 2037 || (i && y <= list[i - 1]))) {
      throw new Error('Invalid M5 years');
    }
    files.push({ name: name.toLowerCase() + '_h1.bin', asset: name, interval: 3600 });
    for (const year of instrument.m5Years) {
      files.push({ name: name.toLowerCase() + '_m5_' + year + '.bin', asset: name, year, interval: 300 });
    }
    // M3 was added after the original archive. Keep it optional so an old
    // published snapshot can be upgraded atomically on its next run.
    if (Array.isArray(instrument.m3Years)) {
      if (!instrument.m3Years.length || instrument.m3Years.some((y, i, list) => !Number.isInteger(y) || y < 2013 || y > 2037 || (i && y <= list[i - 1]))) {
        throw new Error('Invalid M3 years');
      }
      for (const year of instrument.m3Years) {
        files.push({ name: name.toLowerCase() + '_m3_' + year + '.bin', asset: name, year, interval: 180 });
      }
    }
  }
  return files;
}
