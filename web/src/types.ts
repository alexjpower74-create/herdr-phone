export type TerminalInfo = {id:string;title:string;state:'live'|'finished';status:'idle'|'working'|'done'|'blocked'|'error'|'unknown';cols:number;rows:number};
export type Tab = {id:string;name:string;terminals:TerminalInfo[]};
export type Space = {id:string;machineId:string;name:string;cwd:string;repo:string|null;branch:string|null;color:string;tabs:Tab[]};
export type State = {version:1;revision:number;machines:{id:string;name:string;online:boolean}[];spaces:Space[];programs:{id:string;name:string}[]};
export type Frame = {type:'state';state:State}|{type:'screen';terminalId:string;cols:number;rows:number;text:string}|{type:'output';terminalId:string;cols:number;rows:number;reset:boolean;data:string}|{type:'connection';connected:boolean}|{type:'error';code:string;message:string;terminalId?:string};
