import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAudioDraftOwner} from '../src/utils/audioDraftOwner.ts';
test('recording lease transfers to draft across recorder unmount; upload failure retains, success releases',async()=>{
 let locked=0; const acquire=async()=>{locked++;let done=false;return async()=>{if(!done){done=true;locked--;}}};
 const owner=createAudioDraftOwner(acquire), file={name:'recorded'};
 const lease=await acquire(); await owner.retain('record',file,lease);
 assert.equal(locked,1); // recorder has transferred lease; its unmount has nothing to release
 await assert.rejects(owner.upload(file,async()=>{throw Error('upload');})); assert.equal(locked,1);
 await owner.upload(file,async()=>{}); assert.equal(locked,0);
 await owner.retain('record',file,await acquire()); await owner.retain('record',null); assert.equal(locked,0);
 await owner.retain('file',{name:'import'}); assert.equal(locked,1); await owner.dispose(); assert.equal(locked,0);
 await owner.retain('record',file,await acquire()); assert.equal(locked,0);
});
test('upload completion cannot release a replacement or another retained input',async()=>{
 let locked=0; const acquire=async()=>{locked++;return async()=>{locked--;}};const owner=createAudioDraftOwner(acquire);
 const first={}, second={};await owner.retain('record',first);await owner.retain('file',second);
 await owner.upload(first,async()=>{});assert.equal(locked,1);await owner.dispose();assert.equal(locked,0);
});
