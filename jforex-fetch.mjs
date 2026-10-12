import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { INSTRUMENTS } from './tools/data.mjs';
import { parseCandles } from './jforex-check.mjs';
import { updateFromJForex } from './jforex-update.mjs';

export function combineExports(previous,incoming,scale) {
  const rows=new Map(previous.map(b=>[b.timestamp,b]));
  for(const bar of incoming) {
    const old=rows.get(bar.timestamp);
    if(old && ['open','high','low','close'].some(k=>Math.round(old[k]*scale)!==Math.round(bar[k]*scale)))
      throw new Error('SDK attempts disagree at '+new Date(bar.timestamp).toISOString());
    rows.set(bar.timestamp,bar);
  }
  return [...rows.values()].sort((a,b)=>a.timestamp-b.timestamp);
}

async function readSDK(from,to,out) {
  await fs.mkdir(out,{recursive:true});
  return new Promise((resolve,reject)=>{
    const child=spawn('java',['-Djava.awt.headless=true','-Dlog4j.configuration=file:target/log4j.properties',
      '-cp',['target/classes','target/lib/*'].join(path.delimiter),'ReplayHistory',from,to,out],{stdio:'inherit'});
    const timeout=setTimeout(()=>child.kill('SIGKILL'),12*60000);
    child.once('error',error=>{clearTimeout(timeout);reject(error);});
    child.once('close',code=>{clearTimeout(timeout);resolve(code===0);});
  });
}

async function main() {
  const directory='jforex-check';
  const range=JSON.parse(await fs.readFile(path.join(directory,'range.json'),'utf8'));
  const from=new Date(range.from).toISOString().slice(0,10),to=new Date(range.to).toISOString().slice(0,10);
  await fs.mkdir('target',{recursive:true});
  await fs.writeFile('target/log4j.properties','log4j.rootLogger=OFF\n');
  const collected=new Map();
  for(let attempt=1;attempt<=3;attempt++) {
    console.log('SDK download and validation attempt',attempt,'of 3');
    const out=await fs.mkdtemp(path.join(directory,'attempt-'));
    if(await readSDK(from,to,out)) {
      // Combine only matching completed candles. Empty responses cannot erase
      // successful chunks; disagreements between attempts stop publication.
      for(const [asset,cfg] of Object.entries(INSTRUMENTS)) for(const [tf,interval] of [['h1',3600],['m5',300]]) {
        const name=asset+'_'+tf+'.csv';
        const rows=parseCandles(await fs.readFile(path.join(out,name),'utf8'),cfg.scale,interval);
        collected.set(name,combineExports(collected.get(name)||[],rows,cfg.scale));
      }
      for(const [name,rows] of collected) await fs.writeFile(path.join(directory,name),
        'timestamp,open,high,low,close,volume\n'+rows.map(b=>[b.timestamp,b.open,b.high,b.low,b.close,b.volume].join(',')).join('\n')+'\n');
      try {
        const result=await updateFromJForex({directory,sourceURL:process.env.REPLAY_SOURCE_URL});
        if(process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT,'changed='+result.changed+'\n');
        console.log('Complete snapshot verified; changed:',result.changed);
        return;
      } catch(error) { console.error('Incomplete/invalid snapshot; not published:',error.message); }
    }
    if(attempt<3) await new Promise(resolve=>setTimeout(resolve,10000));
  }
  throw new Error('No complete verified SDK snapshot after three attempts; published history unchanged');
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(e=>{console.error(e.message);process.exitCode=1;});
