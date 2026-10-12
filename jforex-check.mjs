import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTRUMENTS, DAY, readBars, validateBar, sha256 } from './tools/data.mjs';

export function parseCandles(text, scale, interval) {
  const lines=text.trim().split(/\r?\n/);
  if(lines.shift()!=='timestamp,open,high,low,close,volume') throw new Error('Invalid CSV header');
  let previous=-Infinity;
  return lines.map(line=>{
    const fields=line.split(',');
    if(fields.length!==6 || fields.some(s=>s.trim()==='')) throw new Error('Invalid CSV row');
    const values=fields.map(Number);
    if(values.some(v=>!Number.isFinite(v))) throw new Error('Non-finite candle');
    const [timestamp,open,high,low,close,volume]=values;
    const bar={timestamp,open,high,low,close,volume};
    validateBar(bar,scale,interval);
    if(timestamp<=previous || volume<=0) throw new Error('Unsorted/empty candle');
    previous=timestamp;
    return bar;
  });
}

export function compareCandles(existing, incoming, from, to, scale) {
  if(!incoming.length || incoming.some(b=>b.timestamp<from || b.timestamp>=to)) throw new Error('Empty/out-of-range history');
  const index=new Map(incoming.map(b=>[b.timestamp,b]));
  const overlap=existing.filter(b=>b.timestamp>=from && b.timestamp<to);
  if(!overlap.length) throw new Error('No archived overlap');
  let missing=0,different=0;
  const examples=[];
  for(const old of overlap) {
    const row=index.get(old.timestamp);
    if(!row) { missing++; continue; }
    const fields=['open','high','low','close'].filter(k=>Math.round(old[k]*scale)!==Math.round(row[k]*scale));
    if(fields.length) {
      different++;
      if(examples.length<3) examples.push({utc:new Date(old.timestamp).toISOString(),fields,archive:old,jforex:row});
    }
  }
  const last=existing.at(-1).timestamp;
  return {overlap:overlap.length,missing,different,newCandles:incoming.filter(b=>b.timestamp>last).length,lastUTC:new Date(incoming.at(-1).timestamp).toISOString(),examples};
}

async function remote(name) {
  const r=await fetch(new URL(name,'https://retocker-replay-quotes.web.app/replay-data/'),{cache:'no-store',signal:AbortSignal.timeout(60000)});
  if(!r.ok) throw new Error('Published archive HTTP '+r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function main() {
  const out=path.resolve('jforex-check');
  await fs.mkdir(out,{recursive:true});
  if(process.argv.includes('--prepare')) {
    const bytes=await remote('meta.json');
    const meta=JSON.parse(bytes);
    const last=Math.min(...Object.keys(INSTRUMENTS).map(a=>meta.instruments[a].h1.last));
    const from=Math.floor(last*1000/DAY)*DAY-7*DAY;
    const to=Math.floor(Date.now()/DAY)*DAY;
    if(!Number.isFinite(from) || to<=from || to-from>45*DAY) throw new Error('Invalid/stale snapshot range');
    await fs.writeFile(path.join(out,'meta.json'),bytes);
    await fs.writeFile(path.join(out,'range.json'),JSON.stringify({from,to}));
    const dates='from='+new Date(from).toISOString().slice(0,10)+'\nto='+new Date(to).toISOString().slice(0,10)+'\n';
    if(process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT,dates);
    console.log(dates);
    return;
  }
  const meta=JSON.parse(await fs.readFile(path.join(out,'meta.json'),'utf8'));
  const {from,to}=JSON.parse(await fs.readFile(path.join(out,'range.json'),'utf8'));
  const results={};
  for(const [asset,cfg] of Object.entries(INSTRUMENTS)) for(const [tf,interval] of [['h1',3600],['m5',300]]) {
    const files=tf==='h1'?[asset.toLowerCase()+'_h1.bin']:meta.instruments[asset].m5Years.filter(y=>y>=new Date(from).getUTCFullYear()).map(y=>asset.toLowerCase()+'_m5_'+y+'.bin');
    const existing=[];
    for(const file of files) {
      const bytes=await remote(file);
      if(!meta.files?.[file]?.sha256 || sha256(bytes)!==meta.files[file].sha256) throw new Error('Snapshot changed or checksum missing: '+file);
      for(const bar of readBars(bytes,cfg.scale,interval)) existing.push(bar);
    }
    const rows=parseCandles(await fs.readFile(path.join(out,asset+'_'+tf+'.csv'),'utf8'),cfg.scale,interval);
    const result=compareCandles(existing,rows,from,to,cfg.scale);
    results[asset+' '+tf]=result;
    console.log(asset,tf,JSON.stringify(result));
  }
  await fs.writeFile(path.join(out,'comparison.json'),JSON.stringify(results,null,2));
  if(process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
    '# JForex read-only comparison\n\n|Series|Overlap|Missing|Changed OHLC|New bars|Last UTC|\n|---|---:|---:|---:|---:|---|\n'+Object.entries(results).map(([k,v])=>`|${k}|${v.overlap}|${v.missing}|${v.different}|${v.newCandles}|${v.lastUTC}|`).join('\n')+'\n\nNo publication performed.\n');
  if(!process.argv.includes('--report-only') && Object.values(results).some(v=>v.missing || v.different || !v.newCandles)) throw new Error('Compatibility/freshness check failed; inspect comparison before changing the production updater');
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(e=>{console.error(e.message);process.exitCode=1;});
