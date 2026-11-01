import {Terminal} from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import '@fontsource/geist/400.css';
import '@fontsource/geist/500.css';
import '@fontsource/jetbrains-mono/400.css';
import './style.css';
import {Client} from './client';
import {choices} from './prompts';
import type {State,Space,Tab,TerminalInfo,Frame} from './types';
const root=document.querySelector<HTMLDivElement>('#app')!;
const client=new Client();
let state:State|undefined,space:Space|undefined,tab:Tab|undefined,active:TerminalInfo|undefined;
let emulator:Terminal|undefined,resize:ResizeObserver|undefined,decoder=new TextDecoder(),connected=false;
let currentText='',usedPrompt='',screenGeneration=0;
let appEpoch=0;
const folded=new Set<string>();
function element<K extends keyof HTMLElementTagNameMap>(tag:K,className='',text=''){const el=document.createElement(tag);el.className=className;el.textContent=text;return el;}
function button(label:string,action:()=>void,className=''){const el=element('button',className,label);el.type='button';el.onclick=action;return el;}
function notice(message:string){let el=document.querySelector<HTMLElement>('#notice');if(!el){el=element('div','notice');el.id='notice';el.role='status';root.append(el);}el.textContent=message;}
function disposeTerminal(){screenGeneration++;resize?.disconnect();emulator?.dispose();emulator=undefined;active=undefined;client.watch(null);}
function header(title:string,back=false){const head=element('header');if(back)head.append(button('‹',()=>{history.replaceState(null,'',location.pathname);home();},'icon back'));else head.append(element('span','brand-mark','H'));head.append(element('h1','',title));head.append(button('•••',settings,'icon'));return head;}
function pairing(message=''){
  appEpoch++;disposeTerminal();root.replaceChildren();root.append(header('Herdr'));
  const main=element('main','pairing');main.append(element('div','pair-symbol','H'),element('h2','','Your spaces, with you.'),element('p','muted','Enter the pairing code from your bridge to connect this phone.'));
  const form=element('form');const label=element('label','','Pairing code');const code=element('input');code.name='code';code.autocomplete='one-time-code';code.maxLength=8;code.pattern='[A-Za-z0-9]{8}';code.required=true;code.placeholder='XXXXXXXX';code.className='code';label.append(code);
  const deviceLabel=element('label','','Device name');const device=element('input');device.name='device';device.value='My phone';device.required=true;device.maxLength=64;device.autocomplete='off';deviceLabel.append(device);
  const submit=element('button','primary','Connect');submit.type='submit';const error=element('p','form-error',message);error.role='alert';form.append(label,deviceLabel,submit,error);
  form.onsubmit=async event=>{event.preventDefault();submit.disabled=true;error.textContent='';try{await client.pair(code.value,device.value);await start();}catch(e){error.textContent=(e as Error).message;submit.disabled=false;}};
  main.append(form);root.append(main);
}
function connectionText(){return connected?'Connected':'Reconnecting…';}
function home(){
  disposeTerminal();space=undefined;tab=undefined;root.replaceChildren(header('Herdr'));
  const main=element('main','spaces');const title=element('div','section-heading');title.append(element('h2','','Spaces'),button('+',()=>newSpace(),'icon'));main.append(title);
  if(!state){main.append(element('p','empty','Loading spaces…'));root.append(main);return;}
  for(const machine of state.machines){
    const group=element('section','machine');const heading=element('div','machine-heading');
    const fold=button('',()=>{folded.has(machine.id)?folded.delete(machine.id):folded.add(machine.id);home();},'machine-fold');fold.setAttribute('aria-expanded',String(!folded.has(machine.id)));fold.append(element('span','machine-icon',machine.id==='local'?'▱':'▤'),element('span','machine-name',machine.name));
    const dot=element('span',`dot ${machine.online?'online':''}`);dot.title=machine.online?'Online':'Offline';fold.append(dot,element('span','chevron',folded.has(machine.id)?'›':'⌄'));heading.append(fold,button('+',()=>newSpace(machine.id),'icon machine-add'));heading.lastElementChild!.setAttribute('aria-label',`New space on ${machine.name}`);(heading.lastElementChild as HTMLButtonElement).disabled=!machine.online;group.append(heading);
    if(!folded.has(machine.id))for(const item of state.spaces.filter(s=>s.machineId===machine.id)){
      const row=button('',()=>openSpace(item),'space-row');const tile=element('span','tile',Array.from(item.name)[0]?.toUpperCase()??'?');tile.style.background=/^#[\da-f]{6}$/i.test(item.color)?item.color:'#637184';
      const info=element('span','space-info');info.append(element('span','space-name',item.name));const detail=[item.repo,item.branch].filter(Boolean).join(' · ');if(detail)info.append(element('span','space-detail',detail));
      row.append(tile,info,element('span','row-chevron','›'));row.disabled=!machine.online;group.append(row);
    }
    main.append(group);
  }
  if(!state.spaces.length)main.append(element('p','empty','No spaces yet. Tap + to start one.'));
  root.append(main);const foot=element('footer','home-footer');foot.append(element('span',`dot ${connected?'online':''}`),element('span','',connectionText()));root.append(foot);
}
function openSpace(next:Space,desired?:string){space=next;tab=next.tabs.find(t=>t.terminals.some(x=>x.id===desired))??next.tabs[0];showTerminal(desired);}
function showTerminal(desired?:string){
  const savedSpace=space,savedTab=tab;disposeTerminal();space=savedSpace;tab=savedTab;
  if(!space)return home();
  root.replaceChildren(header(space.name,true));const tabs=element('nav','tabs');tabs.setAttribute('aria-label','Tabs');
  for(const item of space.tabs){const b=button(item.name,()=>{tab=item;showTerminal();},`tab ${item.id===tab?.id?'selected':''}`);b.setAttribute('aria-current',String(item.id===tab?.id));tabs.append(b);}root.append(tabs);
  const terminals=tab?.terminals??[];active=terminals.find(t=>t.id===desired)??terminals[0];
  if(terminals.length>1){const panes=element('nav','panes');panes.setAttribute('aria-label','Terminals');for(const terminal of terminals)panes.append(button(terminal.title,()=>showTerminal(terminal.id),terminal.id===active?.id?'selected':''));root.append(panes);}
  if(!active){root.append(element('p','empty','This tab has no running terminal.'));return;}
  history.replaceState(null,'',`#terminal=${encodeURIComponent(active.id)}`);
  const info=element('div','terminal-info');info.id='terminal-info';root.append(info);updateTerminalInfo();
  const viewport=element('main','terminal-viewport');viewport.setAttribute('aria-label','Terminal screen');const canvas=element('div','terminal-canvas');viewport.append(canvas);root.append(viewport);
  const approvals=element('div','approvals');approvals.id='approvals';root.append(approvals);
  const dock=element('div','input-dock');const keys=element('div','keybar');
  for(const [label,key] of [['⇧ Tab','shift+tab'],['Esc','esc'],['↑','up'],['↓','down'],['Enter','enter'],['^C','ctrl+c']]){const b=button(label,()=>send('keys',[key]));b.setAttribute('aria-label',key);b.onpointerdown=e=>e.preventDefault();keys.append(b);}
  const input=element('textarea','terminal-input');input.rows=1;input.setAttribute('aria-label','Type to terminal');input.placeholder='Type to terminal…';input.autocapitalize='off';input.autocomplete='off';input.spellcheck=false;
  input.addEventListener('input',e=>{if((e as InputEvent).isComposing)return;if(input.value){send('input',input.value);input.value='';}else if((e as InputEvent).inputType==='deleteContentBackward')send('keys',['backspace']);});
  input.addEventListener('compositionend',()=>{if(input.value){send('input',input.value);input.value='';}});
  input.onkeydown=e=>{const key=({Enter:'enter',Backspace:'backspace',ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right',Escape:'esc',Tab:e.shiftKey?'shift+tab':'tab'} as Record<string,string>)[e.key];if(key&&!e.isComposing){e.preventDefault();send('keys',[key]);}};
  dock.append(keys,input);root.append(dock);
  emulator=new Terminal({cols:active.cols,rows:active.rows,fontFamily:'JetBrains Mono',fontSize:14,lineHeight:1.15,scrollback:0,disableStdin:true,theme:{background:'#101114',foreground:'#d8d8df',cursor:'#d8d8df'},allowProposedApi:false});emulator.open(canvas);
  viewport.onclick=()=>input.focus();resize=new ResizeObserver(()=>scaleTerminal());resize.observe(viewport);scaleTerminal();
  currentText='';usedPrompt='';decoder=new TextDecoder();const id=active.id,generation=screenGeneration;
  client.watch(id);client.screen(id).then(screen=>{if(active?.id!==id||generation!==screenGeneration)return;active=screen.terminal;paint(screen.text,screen.terminal.cols,screen.terminal.rows);}).catch(e=>notice((e as Error).message));
}
function updateTerminalInfo(){const info=document.querySelector('#terminal-info');if(info&&active)info.textContent=`${active.title} · ${active.cols} × ${active.rows} · ${connected?active.status:'reconnecting'}`;}
function scaleTerminal(){const canvas=document.querySelector<HTMLElement>('.terminal-canvas'),viewport=document.querySelector<HTMLElement>('.terminal-viewport');if(!canvas||!viewport||!emulator)return;const natural=emulator.element?.querySelector<HTMLElement>('.xterm-screen')?.offsetWidth??0;if(natural){const scale=Math.min(1,(viewport.clientWidth-24)/natural);canvas.style.transform=`scale(${scale})`;canvas.style.width=`${natural}px`;canvas.style.height=`${(emulator.element?.offsetHeight??0)}px`;viewport.style.setProperty('--terminal-height',`${(emulator.element?.offsetHeight??0)*scale}px`);}}
function dimensions(cols:number,rows:number){if(!emulator||!active)return;if(!Number.isInteger(cols)||!Number.isInteger(rows)||cols<1||rows<1||cols>1000||rows>500)return;active.cols=cols;active.rows=rows;if(emulator.cols!==cols||emulator.rows!==rows)emulator.resize(cols,rows);updateTerminalInfo();}
function paint(text:string,cols:number,rows:number){dimensions(cols,rows);if(!emulator)return;currentText=text;emulator.reset();emulator.write(text.replace(/\r?\n/g,'\r\n'),()=>scaleTerminal());renderChoices();}
function renderChoices(){const area=document.querySelector('#approvals');if(!area)return;area.replaceChildren();if(!active||currentText===usedPrompt)return;for(const choice of choices(currentText,active.status)){const id=active.id,prompt=currentText;area.append(button(choice.label,()=>{if(active?.id!==id||currentText!==prompt)return;usedPrompt=prompt;area.replaceChildren();send('keys',choice.keys);},'approval'));}}
function send(kind:'input'|'keys',value:string|string[]){if(!active||!connected){notice('Connection unavailable. Input was not sent.');return;}const id=active.id;usedPrompt=currentText;renderChoices();client.input(id,kind,value).catch(e=>notice(`${(e as Error).message} Input was not replayed; check the terminal before continuing.`));}
function frame(message:Frame){
  if(message.type==='state'){state=message.state;const requested=new URLSearchParams(location.hash.slice(1)).get('terminal');if(space){const updated=state.spaces.find(s=>s.id===space!.id);if(!updated)return home();space=updated;tab=updated.tabs.find(t=>t.id===tab?.id);const terminal=tab?.terminals.find(t=>t.id===active?.id);if(!terminal)return showTerminal();active=terminal;updateTerminalInfo();renderChoices();}else if(requested){const found=state.spaces.find(s=>s.tabs.some(t=>t.terminals.some(x=>x.id===requested)));if(found)openSpace(found,requested);else home();}else home();}
  if(message.type==='connection'){connected=message.connected;updateTerminalInfo();if(!space)home();}
  if(message.type==='screen'&&message.terminalId===active?.id){screenGeneration++;paint(message.text,message.cols,message.rows);}
  if(message.type==='output'&&message.terminalId===active?.id&&emulator){screenGeneration++;dimensions(message.cols,message.rows);if(message.reset){emulator.reset();decoder=new TextDecoder();}try{const bytes=Uint8Array.from(atob(message.data),c=>c.charCodeAt(0));emulator.write(decoder.decode(bytes,{stream:true}),()=>{currentText=Array.from({length:emulator!.rows},(_,i)=>emulator!.buffer.active.getLine(i)?.translateToString(true)??'').join('\n');scaleTerminal();renderChoices();});}catch{notice('Unable to display terminal output. Reopen this tab.');}}
  if(message.type==='error')notice(message.message);
}
function modal(title:string){const dialog=element('dialog');const head=element('div','dialog-heading');head.append(element('h2','',title),button('×',()=>dialog.close(),'icon'));dialog.append(head);dialog.addEventListener('close',()=>dialog.remove());root.append(dialog);dialog.showModal();return dialog;}
function newSpace(machineId=state?.machines.find(m=>m.online)?.id??'local'){
  if(!state)return;const dialog=modal('New space');const form=element('form');
  const machine=element('select');machine.setAttribute('aria-label','Machine');for(const m of state.machines){const option=element('option','',m.name);option.value=m.id;option.disabled=!m.online;option.selected=m.id===machineId;machine.append(option);}
  const name=element('input');name.placeholder='Space name';name.setAttribute('aria-label','Space name');name.required=true;name.maxLength=100;
  const cwd=element('input');cwd.placeholder='Working directory';cwd.setAttribute('aria-label','Working directory');cwd.required=true;cwd.autocapitalize='off';cwd.spellcheck=false;
  const program=element('select');program.setAttribute('aria-label','Program');for(const p of state.programs){const option=element('option','',p.name);option.value=p.id;program.append(option);}
  const submit=element('button','primary','Create space');submit.type='submit';submit.disabled=!state.programs.length;const error=element('p','form-error');error.role='alert';form.append(machine,name,cwd,program,submit,error);dialog.append(form);
  form.onsubmit=async e=>{e.preventDefault();submit.disabled=true;try{const result=await client.request<{spaceId:string;terminalId:string}>('/spaces',{machineId:machine.value,name:name.value,cwd:cwd.value,programId:program.value});dialog.close();state=await client.state();const found=state.spaces.find(s=>s.id===result.spaceId);if(found)openSpace(found,result.terminalId);else home();}catch(e){error.textContent=(e as Error).message;submit.disabled=false;}};
}
function settings(){const dialog=modal('Device');dialog.append(button('Enable notifications',async()=>{try{if(!('serviceWorker' in navigator)||!('PushManager' in window))throw new Error('Add Herdr to your Home Screen to enable notifications.');const permission=await Notification.requestPermission();if(permission!=='granted')throw new Error('Notifications are not enabled.');const registration=await navigator.serviceWorker.ready;const {publicKey}=await client.request<{publicKey:string}>('/push/key');const raw=atob(publicKey.replace(/-/g,'+').replace(/_/g,'/'));const key=Uint8Array.from(raw,c=>c.charCodeAt(0));const subscription=await registration.pushManager.getSubscription()??await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});await client.request('/push/subscription',subscription.toJSON());notice('Notifications enabled.');dialog.close();}catch(e){notice((e as Error).message);}},'settings-action'));
  dialog.append(button('Disconnect this phone',async()=>{try{await client.request('/device',undefined,'DELETE');client.forget();dialog.close();pairing();}catch(e){notice((e as Error).message);}},'settings-action'));}
async function start(){const epoch=++appEpoch;home();try{const snapshot=await client.state();if(epoch!==appEpoch)return;state=snapshot;client.onFrame=frame;client.onConnection=value=>{connected=value;if(!space)home();else updateTerminalInfo();};client.connect();frame({type:'state',state});}catch(e){if(epoch!==appEpoch)return;if(client.token){home();notice((e as Error).message);const retry=button('Retry connection',()=>void start(),'retry');root.append(retry);}}}
client.onUnauthorized=()=>{client.forget();state=undefined;pairing('Pair this phone to continue.');};
window.addEventListener('hashchange',()=>{if(state)frame({type:'state',state});});
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
if(client.token)void start();else pairing();
