import test from 'node:test';
import assert from 'node:assert/strict';
import { packets, ResponseBuffer, Board, checkDescriptor } from '../src/lib/leaderboard/hid.ts';
const responses=(bytes,type=0x21,id=1)=>packets(type,id,bytes).map(b=>{b[3]=1;return b});
for(const n of [0,1,31,32,33,64,65,50000])test(`complete bounded trace transport: ${n} events`,()=>{
 const bytes=Uint8Array.from({length:n*14},(_,i)=>i%251), buffer=new ResponseBuffer(0x21,1);
 let actual;for(const b of responses(bytes))actual=buffer.accept(0,new DataView(b.buffer));
 assert.deepEqual(actual,bytes);
});
for(const [name,mutate] of [
 ['magic',b=>b[0]=0],['version',b=>b[1]=2],['type',b=>b[2]=1],['flags',b=>b[3]=5],
 ['transfer',b=>b[7]=2],['offset',b=>b[11]=1],['padding',b=>b[63]=1],['length',b=>new DataView(b.buffer).setUint32(12,700001)]
])test(`reject malformed ${name}`,()=>{const b=responses(new Uint8Array(1))[0];mutate(b);assert.throws(()=>new ResponseBuffer(0x21,1).accept(0,new DataView(b.buffer)));});
test('truncation is incomplete; duplicate fragments and report IDs rejected',()=>{
 const b=responses(new Uint8Array(100))[0],buffer=new ResponseBuffer(0x21,1);
 assert.equal(buffer.accept(0,new DataView(b.buffer)),undefined);
 assert.throws(()=>buffer.accept(0,new DataView(b.buffer)));
 assert.throws(()=>new ResponseBuffer(0x21,1).accept(1,new DataView(b.buffer)));
});
test('decode board error',()=>{const b=responses(Uint8Array.of(0,8,255,4))[0];b[3]=3;assert.throws(()=>new ResponseBuffer(0x21,1).accept(0,new DataView(b.buffer)),/NOT_READY.*255.*4/);});
const reports=[{reportId:0,items:[{reportSize:8,reportCount:64}]}];
class Device extends EventTarget { collections=[{usagePage:0xff60,usage:1,inputReports:reports,outputReports:reports}]; opened=true; async sendReport(id,p){this.last=p;} }
test('keyboard interface and wrong descriptors rejected',()=>{const d=new Device();checkDescriptor(d);d.collections.push({usagePage:1,usage:6});assert.throws(()=>checkDescriptor(d));});
test('disconnect makes command ambiguous and forbids blind retry',async()=>{
 const d=new Device(),hid=new EventTarget(),board=new Board(d,hid),request=board.request(0x11);
 const event=new Event('disconnect');event.device=d;hid.dispatchEvent(event);
 await assert.rejects(request,/disconnected/);await assert.rejects(board.request(0x11),/Reconnect/);
});
