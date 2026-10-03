// Read-only provider probe; does not change any published/local quote files.
import { getHistoricalRates } from 'dukascopy-node';
import { INSTRUMENTS, validateBar } from './data.mjs';

for (const [asset, cfg] of Object.entries(INSTRUMENTS)) {
  const rows = await getHistoricalRates({
    instrument: cfg.instrument, dates: { from: new Date('2024-10-01T00:00:00Z'), to: new Date('2024-10-02T00:00:00Z') },
    timeframe: 'h1', format: 'json', priceType: 'bid', useCache: false,
  });
  if (!rows.length) throw new Error('No sample bars returned for ' + asset);
  rows.forEach(row => validateBar(row, cfg.scale, 3600));
  console.log(asset, rows.length, 'sample H1 bars;', new Date(rows.at(-1).timestamp).toISOString());
}
