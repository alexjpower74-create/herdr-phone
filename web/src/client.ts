import type { Frame, State, TerminalInfo } from './types';
const TOKEN_KEY='herdr-phone.device';
export class ApiError extends Error { constructor(public status:number,message:string){super(message);} }
export class Client {
  token=localStorage.getItem(TOKEN_KEY)??'';
  private queues=new Map<string,Promise<unknown>>();
  private epochs=new Map<string,number>();
  private socket?:WebSocket;
  private reconnect?:ReturnType<typeof setTimeout>;
  private stopped=false;
  private attempt=0;
  private watched:string|null=null;
  onFrame:(frame:Frame)=>void=()=>{};
  onConnection:(connected:boolean)=>void=()=>{};
  onUnauthorized:()=>void=()=>{};
  async request<T>(path:string,body?:unknown,method=body===undefined?'GET':'POST'):Promise<T>{
    const response=await fetch(`/api${path}`,{method,cache:'no-store',headers:{...(this.token?{Authorization:`Bearer ${this.token}`} : {}),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    if(!response.ok){const data=await response.json().catch(()=>null);if(response.status===401&&path!=='/pair')this.onUnauthorized();throw new ApiError(response.status,data?.error?.message??'The bridge could not complete this request.');}
    return response.status===204?undefined as T:response.json();
  }
  async pair(code:string,label:string){const data=await this.request<{token:string}>('/pair',{code:code.trim().toUpperCase(),label:label.trim()});this.token=data.token;localStorage.setItem(TOKEN_KEY,this.token);}
  state(){return this.request<State>('/state');}
  screen(id:string){return this.request<{terminal:TerminalInfo;text:string;complete:true}>(`/terminals/${encodeURIComponent(id)}/screen`);}
  input(id:string,kind:'input'|'keys',value:string|string[]){
    const epoch=this.epochs.get(id)??0;
    const next=(this.queues.get(id)??Promise.resolve()).catch(()=>{}).then(()=>{
      if(epoch!==(this.epochs.get(id)??0))throw new Error('Pending input was cancelled. Check the terminal before typing again.');
      return this.request(`/terminals/${encodeURIComponent(id)}/${kind}`,kind==='keys'?{keys:value}:{text:value});
    }).catch(error=>{this.epochs.set(id,(this.epochs.get(id)??0)+1);throw error;});
    this.queues.set(id,next);return next;
  }
  watch(id:string|null){this.watched=id;this.sendWatch();}
  private sendWatch(){if(this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify(this.watched?{type:'watch',terminalId:this.watched}:{type:'unwatch'}));}
  connect(){
    this.stopped=false;
    if(this.socket&&(this.socket.readyState===WebSocket.OPEN||this.socket.readyState===WebSocket.CONNECTING))return;
    const url=new URL('/api/ws',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
    const socket=new WebSocket(url,['herdr-phone.v1',`auth.${this.token}`]);this.socket=socket;
    socket.onopen=()=>{this.attempt=0;this.onConnection(true);this.sendWatch();};
    socket.onmessage=event=>{try{if(typeof event.data!=='string'||event.data.length>4*1024*1024)return;this.onFrame(JSON.parse(event.data));}catch{this.onConnection(false);}};
    socket.onclose=event=>{if(this.socket!==socket)return;this.onConnection(false);if(event.code===4001){this.onUnauthorized();return;}if(!this.stopped)this.reconnect=setTimeout(()=>this.connect(),Math.min(15000,500*2**this.attempt++));};
    socket.onerror=()=>socket.close();
  }
  disconnect(){this.stopped=true;clearTimeout(this.reconnect);this.socket?.close();this.socket=undefined;this.watch(null);for(const id of this.queues.keys())this.epochs.set(id,(this.epochs.get(id)??0)+1);}
  forget(){this.disconnect();this.token='';localStorage.removeItem(TOKEN_KEY);}
}
