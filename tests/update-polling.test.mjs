import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createUpdatePolling} from '../src/utils/updatePolling.ts';
test('fake time: idle slows, active accelerates, requests serialize, teardown stops',async()=>{
 let calls=0,active=false,fn,delay,cleared=false;
 const stop=createUpdatePolling(async()=>{calls++;},()=>active,{set(f,d){fn=f;delay=d;return 1;},clear(){cleared=true;}});
 await Promise.resolve();assert.equal(calls,1);assert.equal(delay,15000);
 active=true;fn();await Promise.resolve();assert.equal(calls,2);assert.equal(delay,1000);
 stop();assert.equal(cleared,true);
});
test('explicit activity wakes idle poll without overlapping an in-flight observation',async()=>{
 let resolve,calls=0,fn,delay;const pending=new Promise(r=>resolve=r);
 const stop=createUpdatePolling(async()=>{calls++;await pending;},()=>true,{set(f,d){fn=f;delay=d;},clear(){}});
 stop.wake();stop.wake();assert.equal(calls,1);resolve();await Promise.resolve();await Promise.resolve();
 assert.equal(delay,0);fn();await Promise.resolve();assert.equal(calls,2);stop();
});
