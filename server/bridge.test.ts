import { test, expect } from 'bun:test';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, hash } from './security';
import { frame, Frames, Core } from './core';
import { start, inputKeys } from './index';
import { Snapshot } from './state';
const temp = () => mkdtemp(join(tmpdir(), 'phone-test-'));
test('framed decoder handles every split, coalesced frames and bounded length', () => {
 const a = frame(0,0,Buffer.from('{"id":1}')), b=frame(7,0,Buffer.from('next'));
 for(let i=0;i<a.length;i++) { const f=new Frames(); expect(f.feed(a.subarray(0,i))).toHaveLength(0); expect(f.feed(Buffer.concat([a.subarray(i),b])).map(v=>v.body.toString())).toEqual(['{"id":1}','next']); }
 const bad=Buffer.alloc(9);bad.writeUInt32LE(9000000,5);expect(()=>new Frames().feed(bad)).toThrow();
});
test('pair codes expire, burn after five failures, are single use and consumed concurrently', async () => {
 const dir=await temp(); let now=1000; const s=new Store(dir,()=>now);
 try {
  const code=await s.pairing(); const result=await Promise.allSettled([s.exchange(code,'Phone'),new Store(dir,()=>now).exchange(code,'Other')]);
  expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const ok:any=result.find(r=>r.status==='fulfilled'); const token=ok.value.token;
  expect(await s.auth(token)).toMatchObject({label:ok.value.device.label});
  expect(await readFile(join(dir,'state.json'),'utf8')).not.toContain(token);
  expect((await stat(join(dir,'state.json'))).mode & 0o777).toBe(0o600);
  await s.revoke(ok.value.device.id);await expect(s.auth(token)).rejects.toThrow();
  const expire=await s.pairing(); now+=600001;await expect(s.exchange(expire,'Phone')).rejects.toThrow();
  const burn=await s.pairing(); for(let i=0;i<5;i++) await expect(s.exchange('AAAAAAAA','Phone')).rejects.toThrow();
  await expect(s.exchange(burn,'Phone')).rejects.toThrow();
  const replace=await s.pairing(); await s.pairing(); await expect(s.exchange(replace,'Phone')).rejects.toThrow();
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('corruption fails closed, duplicate labels require explicit id, throttle persists',async()=>{
 const dir=await temp();const s=new Store(dir);
 try{
  for(let n=0;n<2;n++) await s.exchange(await s.pairing(),'Same');
  await expect(s.revoke('Same')).rejects.toThrow();expect(await s.list()).toHaveLength(2);
  for(let n=0;n<20;n++)try{await s.exchange('BAD','Phone');}catch{}
  await expect(s.exchange(await s.pairing(),'Phone')).rejects.toMatchObject({status:429});
  await writeFile(join(dir,'state.json'),'{}');await expect(s.list()).rejects.toMatchObject({status:503});
 }finally{await rm(dir,{recursive:true,force:true});}
});
class Mock {
 calls:any[]=[];
 async call(method:string,p:any={}) {this.calls.push({method,p});
  if(method==='hello')return {generation:1};
  if(method==='machine.list')return {machines:[{name:'remote',state:'connected'},{name:'scratch',temporary:true,state:'connected'}]};
  if(method==='terminal.list')return {terminals:[{address:'remote/t1',state:'live',cols:80,rows:24,labels:{},status:{state:'blocked'}}]};
  if(method==='doc.get')return {value:{spaces:[{id:'s1',name:'Work',folder:'/work',tabs:[{id:'tab',name:'Tab',root:{children:[{content:{terminal:'t1'}}]}}]}]}};
  if(method==='terminal.get')return {address:p.terminal,state:'live',cols:80,rows:24};
  if(method==='terminal.read')return {text:'screen',complete:true};
  if(method==='terminal.keys'){await Bun.sleep(15);return {turn:1};}
 }
}
test('normalization preserves qualified ids and cached offline spaces',async()=>{
 const c=new Mock(); const s=new Snapshot(c);let snap=await s.get();
 expect(snap.machines.map((m:any)=>m.id)).toEqual(['local','remote']);
 expect(snap.spaces[1].tabs[0].terminals[0].id).toBe('remote/t1');
 c.call=async(m,p)=>m==='machine.list'?{machines:[{name:'remote',state:'unreachable'}]}:Mock.prototype.call.call(c,m,p);
 snap=await s.get(true);expect(snap.spaces[1].name).toBe('Work');expect(snap.machines[1].online).toBe(false);
});
test('HTTP rejects absent/revoked tokens, wrong origins and URL credentials; input ack order and history zero',async()=>{
 const dir=await temp(), store=new Store(dir),core=new Mock(); const paired=await store.exchange(await store.pairing(),'Phone');
 const app=start({port:0,origin:'http://localhost',store,core}); const base=`http://127.0.0.1:${app.server.port}`;
 const headers={Authorization:`Bearer ${paired.token}`,'Content-Type':'application/json'};
 try{
  expect((await fetch(base+'/api/state')).status).toBe(401);
  expect((await fetch(base+'/api/state',{headers})).status).toBe(200);
  expect((await fetch(base+'/api/state',{headers:{...headers,Origin:'https://wrong.invalid'}})).status).toBe(401);
  expect((await fetch(base+'/api/state?token='+paired.token,{headers})).status).toBe(400);
  const screen=await fetch(base+'/api/terminals/remote%2Ft1/screen',{headers});expect(screen.status).toBe(200);expect(core.calls.find(c=>c.method==='terminal.read').p).toEqual({terminal:'remote/t1',lines:0});
  await Promise.all(['A','B'].map(text=>fetch(base+'/api/terminals/remote%2Ft1/input',{method:'POST',headers,body:JSON.stringify({text})})));
  expect(core.calls.filter(c=>c.method==='terminal.keys').map(c=>c.p.keys)).toEqual([['A'],['B']]);
  expect((await fetch(base+'/api/device',{method:'DELETE',headers})).status).toBe(204);
  expect((await fetch(base+'/api/state',{headers})).status).toBe(401);
 }finally{app.stop();await rm(dir,{recursive:true,force:true});}
});
test('input preserves printable Unicode, translates known controls and rejects unknown controls',()=>{
 expect(inputKeys('a🙂\r\n\t\x03')).toEqual(['a','🙂','enter','tab','ctrl+c']);expect(()=>inputKeys('\x01')).toThrow();expect(()=>inputKeys('x'.repeat(4097))).toThrow();
});
test('health honestly reports disconnected core',async()=>{
 const app=start({port:0,origin:'http://localhost',core:{call:async()=>{throw Error('secret process detail')}}});
 try{const r=await fetch(`http://127.0.0.1:${app.server.port}/api/health`);expect(r.status).toBe(503);expect(await r.json()).toEqual({ok:false,version:'1',core:'disconnected'});}finally{app.stop();}
});
