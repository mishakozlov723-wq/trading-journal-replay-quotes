import { fetchCandles, aggregateMinutes, OANDA_INSTRUMENTS } from './oanda-fetch.mjs';
import { DAY, validateBar, INSTRUMENTS } from './tools/data.mjs';

const START = Date.UTC(2020, 0, 1), scale = INSTRUMENTS.GER40.scale;
const keys = ['open', 'high', 'low', 'close'];
function agree(expected, actual, label) {
  if (expected.length !== actual.length) throw Error(`${label}: candle count differs (${expected.length} vs ${actual.length})`);
  expected.forEach((b,i) => {
    const a = actual[i];
    if (a.timestamp !== b.timestamp || keys.some(k => Math.round(a[k]*scale) !== Math.round(b[k]*scale))) throw Error(`${label}: mismatch at ${new Date(b.timestamp).toISOString()}`);
  });
}
export async function buildGer40({to, archived, load = fetchCandles, token, log = console.log}) {
  if (!archived.length || archived[0].timestamp < START || archived.at(-1).timestamp >= to) throw Error('Missing or unexpected GER40 M3 range');
  const h1 = [], m5 = []; let cursor = 0, previous = START, checked = 0;
  for (let from = START; from < to;) {
    const date = new Date(from), end = Math.min(to, Date.UTC(date.getUTCFullYear(), date.getUTCMonth()+1,1));
    const get = timeframe => load({token,instrument:OANDA_INSTRUMENTS.GER40,timeframe,from,to:end});
    const minutes = await get('m1');
    // A new UTC month may contain only the New Year holiday / weekend so far.
    if (!minutes.length && (from === START || end-previous > 5*DAY)) throw Error(`No GER40 minutes for ${date.toISOString()}`);
    for (const b of minutes) {
      validateBar(b,scale,60);
      if (b.timestamp < from || b.timestamp >= end || b.timestamp - previous > 5*DAY) throw Error('GER40 gap or wrong range at '+new Date(b.timestamp).toISOString());
      previous = b.timestamp;
    }
    const hours = aggregateMinutes(minutes,3600000);
    agree(await get('h1'), hours, 'OANDA H1 vs minutes');
    const first = cursor;
    while (cursor < archived.length && archived[cursor].timestamp < end) cursor++;
    const overlap = aggregateMinutes(minutes).filter(b => b.timestamp >= archived[0].timestamp && b.timestamp <= archived.at(-1).timestamp);
    agree(archived.slice(first,cursor),overlap,'Published M3 vs OANDA M1');
    checked += overlap.length; h1.push(...hours); m5.push(...aggregateMinutes(minutes,300000)); from = end;
  }
  if (to-previous > 5*DAY || !checked || cursor !== archived.length) throw Error('GER40 history incomplete');
  log(`GER40 OANDA BID: ${h1.length} H1, ${m5.length} M5; ${checked} existing M3 verified; ${new Date(h1[0].timestamp).toISOString()} to ${new Date(previous).toISOString()}`);
  return {h1,m5};
}
