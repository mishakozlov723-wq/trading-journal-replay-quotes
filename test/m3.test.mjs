import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateMinutes } from '../oanda-fetch.mjs';

test('aggregates three one-minute candles into an exact M3 OHLC bar', () => {
  const rows = aggregateMinutes([
    { timestamp: 0, open: 10, high: 12, low: 9, close: 11, volume: 1 },
    { timestamp: 60_000, open: 11, high: 13, low: 10, close: 12, volume: 2 },
    { timestamp: 120_000, open: 12, high: 14, low: 11, close: 13, volume: 3 },
  ]);
  assert.deepEqual(rows, [{ timestamp: 0, open: 10, high: 14, low: 9, close: 13, volume: 6 }]);
});

test('keeps market gaps out and starts the next aligned M3 bucket', () => {
  const rows = aggregateMinutes([
    { timestamp: 0, open: 10, high: 10, low: 10, close: 10, volume: 1 },
    { timestamp: 240_000, open: 20, high: 22, low: 19, close: 21, volume: 1 },
  ]);
  assert.deepEqual(rows.map(row => row.timestamp), [0, 180_000]);
  assert.equal(rows[1].open, 20);
});
