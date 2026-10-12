import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCandles,compareCandles } from '../jforex-check.mjs';
import { preserveOverlap,completeHours,verifyTimeframes } from '../jforex-update.mjs';
import { combineExports } from '../jforex-fetch.mjs';
const head='timestamp,open,high,low,close,volume\n';
const line='3600000,1.1,1.2,1,1.15,2';
test('SDK retries fill missing chunks, deduplicate and reject conflicting prices',()=>{
  const [a]=parseCandles(head+line,100000,3600);
  const b={...a,timestamp:7200000};
  assert.deepEqual(combineExports([b],[a,b],100000),[a,b]);
  assert.deepEqual(combineExports([a],[],100000),[a]);
  assert.throws(()=>combineExports([a],[{...a,close:1.16}],100000),/disagree/);
});
test('JForex CSV rejects malformed, duplicated and off-grid candles',()=>{
  assert.equal(parseCandles(head+line,100000,3600).length,1);
  for(const body of [line+'\n'+line,'3600001,1.1,1.2,1,1.15,2','3600000,1.1,1.2,1,NaN,2','3600000,,1.2,1,1.15,2'])
    assert.throws(()=>parseCandles(head+body,100000,3600));
});

test('SDK migration preserves archive OHLC and refuses missing/unrelated prices',()=>{
  const old=parseCandles(head+line,100000,3600);
  const cfg={from:3600000,to:10800000,scale:100000,timeframe:'h1'};
  const revised={...old[0],open:1.11};
  const next={...old[0],timestamp:7200000};
  assert.deepEqual(preserveOverlap(old,[revised,next],cfg),[...old,next]);
  assert.throws(()=>preserveOverlap(old,[next],cfg),/omitted/);
  assert.throws(()=>preserveOverlap(old,[{...revised,high:1.3},next],cfg),/mismatch/);
  assert.throws(()=>preserveOverlap(old,[revised,revised],cfg),/Duplicate/);
});

test('Only a final daily M5 extension with matching open is accepted and preserved',()=>{
  const old={timestamp:86400000-300000,open:1.1,high:1.2,low:1,close:1.15};
  const cfg={from:3600000,to:86400000,scale:100000,timeframe:'m5'};
  assert.deepEqual(preserveOverlap([old],[{...old,high:1.21,close:1.2}],cfg),[old]);
  assert.throws(()=>preserveOverlap([old],[{...old,open:1.12}],cfg),/mismatch/);
  assert.throws(()=>preserveOverlap([old],[{...old,high:1.19}],cfg),/mismatch/);
  assert.throws(()=>preserveOverlap([{...old,timestamp:3600000}],[{...old,timestamp:3600000,close:1.12}],cfg),/mismatch/);
});

test('Missing native hours are recovered only after cross-resolution verification',()=>{
  const a={timestamp:3600000,open:1.1,high:1.2,low:1,close:1.15};
  const b={...a,timestamp:7200000};
  const c={...b,timestamp:7500000,high:1.3,close:1.25};
  const full=completeHours([a],[a,b,c],100000);
  assert.equal(full.length,2);assert.equal(full[1].high,1.3);assert.equal(full[1].close,1.25);
  verifyTimeframes(full,[a,b,c],100000);
  assert.throws(()=>completeHours([{...a,high:1.21}],[a,b],100000),/disagree/);
  assert.throws(()=>verifyTimeframes([a],[a,b],100000),/coverage/);
});
test('JForex comparison exposes missing and changed overlap separately from fresh bars',()=>{
  const old=parseCandles(head+line,100000,3600);
  const next={...old[0],timestamp:7200000};
  const ok=compareCandles(old,[...old,next],0,10800000,100000);
  assert.equal(ok.newCandles,1);assert.equal(ok.different,0);assert.equal(ok.missing,0);
  assert.equal(compareCandles(old,[{...old[0],close:1.16},next],0,10800000,100000).different,1);
  assert.equal(compareCandles(old,[next],0,10800000,100000).missing,1);
  assert.throws(()=>compareCandles(old,[],0,10800000,100000));
});
