import { fetchCandles, aggregateMinutes, OANDA_INSTRUMENTS } from './oanda-fetch.mjs';
import { DAY, validateBar, INSTRUMENTS } from './tools/data.mjs';

const START = Date.UTC(2020, 0, 1), scale = INSTRUMENTS.GER40.scale;
const keys = ['open', 'high', 'low', 'close'];
// Keep the normal five-day guard. A longer Christmas closure is allowed
// only across weekends and Dec 24–26, and still requires exact native H1
// agreement below (a missing M1 trading hour must never be accepted).
export function allowedGap(previous, next) {
  if (next <= previous) return false;
  if (next - previous <= 5*DAY) return true;
  if (next - previous > 7*DAY) return false;
  let christmas = false;
  for (let t = Math.floor(previous / DAY)*DAY + DAY; t < Math.floor(next / DAY)*DAY; t += DAY) {
    const d = new Date(t), holiday = d.getUTCMonth() === 11 && d.getUTCDate() >= 24 && d.getUTCDate() <= 26;
    christmas ||= holiday;
    if (!holiday && d.getUTCDay() !== 0 && d.getUTCDay() !== 6) return false;
  }
  return christmas;
}
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
      if (b.timestamp < from || b.timestamp >= end || !allowedGap(previous,b.timestamp)) throw Error('GER40 gap or wrong range from '+new Date(previous).toISOString()+' to '+new Date(b.timestamp).toISOString());
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
