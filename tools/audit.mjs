import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {INSTRUMENTS,expectedFiles,readBars,summary,sha256} from './data.mjs';

export async function audit(out) {
  const meta=JSON.parse(await fs.readFile(path.join(out,'meta.json'),'utf8'));
  const counts=new Map();
  for(const f of expectedFiles(meta)) {
    const bytes=await fs.readFile(path.join(out,f.name));
    if(meta.files?.[f.name]?.sha256!==sha256(bytes)) throw Error('Wrong checksum for '+f.name);
    const rows=readBars(bytes,INSTRUMENTS[f.asset].scale,f.interval);
    if(f.year){
      if(rows.some(row=>new Date(row.timestamp).getUTCFullYear()!==f.year)) throw Error('Wrong year in '+f.name);
      const key=f.asset+':'+f.interval;counts.set(key,(counts.get(key)||0)+rows.length);
    }else if(JSON.stringify(summary(rows))!==JSON.stringify(meta.instruments[f.asset].h1)) throw Error('Wrong H1 summary for '+f.asset);
  }
  for(const [asset,info] of Object.entries(meta.instruments)){
    if(counts.get(asset+':300')!==info.m5Count || (info.m3Years && counts.get(asset+':180')!==info.m3Count)) throw Error('Wrong candle count for '+asset);
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  await audit(process.argv[2]||fileURLToPath(new URL('../public/replay-data/',import.meta.url)));
  console.log('Verified archived candle counts and checksums on disk');
}
