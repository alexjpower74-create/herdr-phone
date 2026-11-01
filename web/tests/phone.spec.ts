import {test,expect,type Page,type WebSocketRoute} from '@playwright/test';
const fixture={version:1,revision:1,machines:[{id:'local',name:'This computer',online:true},{id:'remote',name:'remote',online:true}],spaces:[{id:'work',machineId:'local',name:'Workbench',cwd:'',repo:'sample',branch:'main',color:'#199f91',tabs:[{id:'one',name:'Build',terminals:[{id:'t1',title:'Build',state:'live',status:'blocked',cols:100,rows:30}]},{id:'two',name:'Check',terminals:[{id:'t2',title:'Check',state:'live',status:'working',cols:80,rows:24}]}]},{id:'remote/work',machineId:'remote',name:'Remote work',cwd:'',repo:null,branch:null,color:'#5685df',tabs:[{id:'remote/one',name:'Shell',terminals:[{id:'remote/t3',title:'Shell',state:'live',status:'idle',cols:120,rows:32}]}]}],programs:[{id:'shell',name:'Shell'}]};
const prompt='Allow this operation?\n› 1. Yes\n  2. No\nPress Enter to confirm';
type Call={path:string;body:any;auth:string|undefined};
async function setup(page:Page,paired=true){
 const calls:Call[]=[];const sockets:WebSocketRoute[]=[];
 await page.addInitScript(p=>{if(p)localStorage.setItem('herdr-phone.device','test-device-token');},paired);
 await page.routeWebSocket('**/api/ws',ws=>{sockets.push(ws);ws.onMessage(raw=>{const msg=JSON.parse(String(raw));if(msg.type==='watch')ws.send(JSON.stringify({type:'screen',terminalId:msg.terminalId,cols:100,rows:30,text:msg.terminalId==='t1'?prompt:'Ready for input'}));});ws.send(JSON.stringify({type:'state',state:fixture}));});
 await page.route('**/api/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;let body;try{body=request.postDataJSON();}catch{}calls.push({path,body,auth:request.headers()['authorization']});
  if(path==='/api/pair')return route.fulfill({status:201,json:{token:'test-device-token'}});
  if(path==='/api/state')return route.fulfill({json:fixture});
  if(path.endsWith('/screen')){const id=decodeURIComponent(path.split('/')[3]);const terminal=fixture.spaces.flatMap(s=>s.tabs.flatMap(t=>t.terminals)).find(t=>t.id===id);return route.fulfill({json:{terminal,text:id==='t1'?prompt:'Ready for input',complete:true}});}
  if(path==='/api/device')return route.fulfill({status:204});
  return route.fulfill({json:{ok:true}});
 });await page.goto('/');return {calls,sockets};
}
async function open(page:Page){await page.getByRole('button',{name:'W Workbench sample · main'}).tap();await expect(page.getByRole('button',{name:'Yes',exact:true})).toBeVisible();}
test('pairing, ordered groups, no overflow and usable hit targets',async({page})=>{
 const {calls}=await setup(page,false);await page.getByLabel('Pairing code').fill('ABCDEFGH');await page.getByRole('button',{name:'Connect',exact:true}).tap();
 await expect(page.getByRole('heading',{name:'Spaces'})).toBeVisible();await expect(page.getByText('This computer',{exact:true})).toBeVisible();await expect(page.getByText('remote',{exact:true})).toBeVisible();
 expect(calls.find(c=>c.path==='/api/pair')?.body).toEqual({code:'ABCDEFGH',label:'My phone'});expect(calls.find(c=>c.path==='/api/state')?.auth).toBe('Bearer test-device-token');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=390)).toBe(true);
 const row=page.getByRole('button',{name:'W Workbench sample · main'});expect(await row.evaluate(el=>{const r=el.getBoundingClientRect();return [r.height,...[4,r.height/2,r.height-4].map(y=>{const hit=document.elementFromPoint(r.x+r.width/2,r.y+y);return hit===el||el.contains(hit);})];})).toEqual([52,true,true,true]);
});
test('approval and slash menu controls send exact acknowledged keys',async({page})=>{
 const {calls}=await setup(page);await open(page);await page.getByRole('button',{name:'Yes',exact:true}).tap();
 await expect.poll(()=>calls.filter(c=>c.path.endsWith('/keys')).map(c=>c.body)).toContainEqual({keys:['1','enter']});await expect(page.getByRole('button',{name:'Yes',exact:true})).toHaveCount(0);
 await page.getByLabel('Type to terminal').fill('/model');await page.getByRole('button',{name:'enter',exact:true}).tap();await page.getByRole('button',{name:'down',exact:true}).tap();await page.getByRole('button',{name:'enter',exact:true}).tap();
 await expect.poll(()=>calls.filter(c=>c.path.endsWith('/input')||c.path.endsWith('/keys')).map(c=>c.body)).toEqual([{keys:['1','enter']},{text:'/model'},{keys:['enter']},{keys:['down']},{keys:['enter']}]);
 expect(calls.some(c=>c.path.includes('resize')||c.path.includes('attach'))).toBe(false);
});
test('remote terminal stays qualified and old-tab screens are ignored',async({page})=>{
 const {calls,sockets}=await setup(page);await page.getByRole('button',{name:'R Remote work'}).tap();await page.getByLabel('Type to terminal').fill('hello');await expect.poll(()=>calls.some(c=>c.path==='/api/terminals/remote%2Ft3/input')).toBe(true);
 sockets[0].send(JSON.stringify({type:'screen',terminalId:'t1',cols:50,rows:10,text:prompt}));await expect(page.getByRole('button',{name:'Yes',exact:true})).toHaveCount(0);expect(new URL(page.url()).hash).toBe('#terminal=remote%2Ft3');
});
test('pending input retains its terminal and failures cancel queued input',async({page})=>{
 const {calls}=await setup(page);let release!:()=>void;const blocked=new Promise<void>(r=>release=r);let received=false;
 await page.route('**/api/terminals/t1/input',async route=>{calls.push({path:'/api/terminals/t1/input',body:route.request().postDataJSON(),auth:undefined});received=true;await blocked;await route.fulfill({status:503,json:{error:{message:'Disconnected'}}});});
 await open(page);await page.getByLabel('Type to terminal').fill('first');await expect.poll(()=>received).toBe(true);await page.getByRole('button',{name:'enter',exact:true}).tap();await page.getByRole('button',{name:'Check',exact:true}).tap();await page.getByLabel('Type to terminal').fill('second');
 release();await expect(page.getByRole('status')).toContainText('not replayed');await expect.poll(()=>calls.some(c=>c.path==='/api/terminals/t2/input'&&c.body.text==='second')).toBe(true);expect(calls.filter(c=>c.path==='/api/terminals/t1/keys')).toHaveLength(0);
});
test('stale historical approval text cannot create a button',async({page})=>{
 const {sockets}=await setup(page);await open(page);sockets[0].send(JSON.stringify({type:'screen',terminalId:'t1',cols:100,rows:30,text:prompt+'\nFinished.\n$ '}));await expect(page.getByRole('button',{name:'Yes',exact:true})).toHaveCount(0);
});
test('new space machine selector and device revocation',async({page})=>{
 await setup(page);await page.getByRole('button',{name:'New space on remote'}).tap();await expect(page.getByLabel('Machine',{exact:true})).toHaveValue('remote');await page.getByRole('button',{name:'×',exact:true}).tap();await page.getByRole('button',{name:'•••'}).tap();await page.getByRole('button',{name:'Disconnect this phone'}).tap();await expect(page.getByRole('heading',{name:'Your spaces, with you.'})).toBeVisible();expect(await page.evaluate(()=>localStorage.getItem('herdr-phone.device'))).toBeNull();
});
