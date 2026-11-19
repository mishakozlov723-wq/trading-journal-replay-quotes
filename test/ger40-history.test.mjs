import test from 'node:test';import assert from 'node:assert/strict';
import {buildGer40} from '../ger40-history.mjs';
const start=Date.UTC(2020,0,2,8), bar=(i,p)=>({timestamp:start+i*60000,open:p,high:p,low:p,close:p});
const minutes=[bar(0,10),bar(1,12),bar(5,11)],hour={...bar(0,10),high:12,close:11};
const archived=[{...bar(0,10),high:12,close:12},bar(3,11)];
const options={archived,to:Date.UTC(2020,0,3),load:async({timeframe})=>timeframe==='m1'?minutes:[hour],log:()=>{}};
test('same minute source for H1 and M5; existing M3 agrees across a 5-minute boundary',async()=>{const r=await buildGer40(options);assert.equal(r.h1[0].close,11);assert.deepEqual(r.m5.map(x=>x.close),[12,11]);});
test('reject mismatched M3, absent 2020 history and missing H1',async()=>{await assert.rejects(buildGer40({...options,archived:[bar(0,9)]}),/mismatch/);await assert.rejects(buildGer40({...options,load:async()=>[]}),/No GER40/);await assert.rejects(buildGer40({...options,load:async({timeframe})=>timeframe==='m1'?minutes:[]}),/count differs/);});
