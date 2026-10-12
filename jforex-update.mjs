import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTRUMENTS, DAY } from './tools/data.mjs';
import { parseCandles } from './jforex-check.mjs';
import { updateQuotes } from './tools/update.mjs';

const equal = (a,b,keys,scale) => keys.every(k=>Math.round(a[k]*scale)===Math.round(b[k]*scale));

// The legacy endpoint occasionally supplied different H1 open/close values and
// an incomplete last M5 candle of a UTC day. Never rewrite those archived bars.
export function preserveOverlap(existing, incoming, { from, to, scale, timeframe }) {
  const selected=incoming.filter(b=>b.timestamp>=from && b.timestamp<to);
  const byTime=new Map(selected.map(b=>[b.timestamp,b]));
  if(byTime.size!==selected.length) throw new Error('Duplicate SDK candles');
  const overlap=existing.filter(b=>b.timestamp>=from && b.timestamp<to);
  if(!overlap.length) throw new Error('No archive overlap to verify');
  for(const old of overlap) {
    const row=byTime.get(old.timestamp);
    if(!row) throw new Error('SDK omitted archived candle at '+new Date(old.timestamp).toISOString());
    const exact=equal(old,row,['open','high','low','close'],scale);
    const hourly=timeframe==='h1' && equal(old,row,['high','low'],scale);
    const closing=timeframe==='m5' && old.timestamp%DAY===DAY-300000 && equal(old,row,['open'],scale)
      && Math.round(row.high*scale)>=Math.round(old.high*scale) && Math.round(row.low*scale)<=Math.round(old.low*scale);
    if(!exact && !hourly && !closing) throw new Error('SDK/archive price mismatch at '+new Date(old.timestamp).toISOString());
    byTime.set(old.timestamp,old);
  }
  // Do not backfill holes inside the established archive during migration.
  const last=existing.at(-1).timestamp;
  const archived=new Set(overlap.map(b=>b.timestamp));
  return [...byTime.values()].filter(b=>b.timestamp>last || archived.has(b.timestamp)).sort((a,b)=>a.timestamp-b.timestamp);
}

export function verifyTimeframes(hours, minutes, scale) {
  const groups=new Map();
  for(const bar of minutes) {
    const t=Math.floor(bar.timestamp/3600000)*3600000;
    const g=groups.get(t);
    if(g) { g.high=Math.max(g.high,bar.high);g.low=Math.min(g.low,bar.low); }
    else groups.set(t,{high:bar.high,low:bar.low});
  }
  if(groups.size!==hours.length) throw new Error('H1/M5 hour coverage differs');
  for(const bar of hours) {
    const g=groups.get(bar.timestamp);
    if(!g || !equal(bar,g,['high','low'],scale)) throw new Error('H1/M5 price range differs at '+new Date(bar.timestamp).toISOString());
  }
}

export function completeHours(hours, minutes, scale) {
  const derived=new Map();
  for(const row of minutes) {
    const timestamp=Math.floor(row.timestamp/3600000)*3600000;
    const hour=derived.get(timestamp);
    if(hour) { hour.high=Math.max(hour.high,row.high);hour.low=Math.min(hour.low,row.low);hour.close=row.close; }
    else derived.set(timestamp,{timestamp,open:row.open,high:row.high,low:row.low,close:row.close});
  }
  // Verify all available native hours before recovering omitted hours from M5.
  // Native OHLC takes priority; archive OHLC is preserved by preserveOverlap.
  for(const hour of hours) {
    if(!derived.has(hour.timestamp) || !equal(hour,derived.get(hour.timestamp),['high','low'],scale))
      throw new Error('Cannot recover H1: native/M5 ranges disagree');
    derived.set(hour.timestamp,hour);
  }
  return [...derived.values()].sort((a,b)=>a.timestamp-b.timestamp);
}

export async function updateFromJForex({ directory='jforex-check', ...options }={}) {
  const {from,to}=JSON.parse(await fs.readFile(path.join(directory,'range.json'),'utf8'));
  const now=options.now || new Date();
  if(!Number.isFinite(from) || !Number.isFinite(to) || from>=to || to!==Math.floor(now.getTime()/DAY)*DAY)
    throw new Error('Stale or invalid SDK export range');
  const series=new Map();
  for(const [asset,cfg] of Object.entries(INSTRUMENTS)) {
    for(const [tf,interval] of [['h1',3600],['m5',300]]) {
      const bars=parseCandles(await fs.readFile(path.join(directory,asset+'_'+tf+'.csv'),'utf8'),cfg.scale,interval);
      if(!bars.length || bars.some(b=>b.timestamp<from || b.timestamp>=to)) throw new Error('Empty/out-of-range SDK export');
      series.set(asset+' '+tf,bars);
    }
    const native=series.get(asset+' h1');
    let completed;
    try { completed=completeHours(native,series.get(asset+' m5'),cfg.scale); }
    catch(error) { throw new Error(asset+': '+error.message); }
    series.set(asset+' h1',completed);
    verifyTimeframes(completed,series.get(asset+' m5'),cfg.scale);
    (options.log || console.log)(asset,'H1 recovered from verified M5:',completed.length-native.length);
  }
  return updateQuotes({...options,now,history:async request=>{
    if(request.from<from || request.to!==to) throw new Error('SDK export does not cover the current snapshot');
    return preserveOverlap(request.existing,series.get(request.asset+' '+request.timeframe),{
      ...request,scale:INSTRUMENTS[request.asset].scale,
    });
  }});
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  updateFromJForex({sourceURL:process.env.REPLAY_SOURCE_URL}).then(async result=>{
    if(process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT,'changed='+result.changed+'\n');
  }).catch(error=>{console.error('No publication: '+error.message);process.exitCode=1;});
}
