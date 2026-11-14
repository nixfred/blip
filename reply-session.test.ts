import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as SendState from "./send-state";
const source=readFileSync(new URL("./BarWidget.qml",import.meta.url),"utf8");
function extract(name:string) {
  const at=source.indexOf("  function "+name+"("); const begin=source.indexOf("{",at); let depth=0;
  for(let i=begin;i<source.length;i++) {if(source[i]==="{")depth++; else if(source[i]==="}" && --depth===0)return source.slice(at,i+1);}
  throw Error(name);
}
test("bar-owned replies retain uncertain results and context after the view disappears",()=>{
  const later:Function[]=[], events:any[]=[], writes:string[]=[];
  const root:any={replyPending:[],replyQueue:[],replyJob:null,binDir:"/synthetic/bin",replyExited:(...args:any[])=>events.push(args)};
  const proc:any={running:false,lastErr:"",write:(text:string)=>writes.push(text)};
  const names=["queueReply","reconcileReplies","pumpReply","finishReply"];
  const api=new Function("root","replyProc","SourceId","SendState","Qt",names.map(extract).join("\n")+";return {"+names.join(",")+"};")(
    root,proc,{bridgeArgv:()=>["/synthetic/imsg-reply"]},SendState,{callLater:(fn:Function)=>later.push(fn)});
  Object.assign(root,api);
  const job={chat:"synthetic",text:"invented reply",localId:"1",stamp:"2026-11-10T00:00:00Z",reply:{guid:"GUID",text:"quoted target"}};
  root.queueReply(job,{...job,ts:job.stamp,replyText:job.reply.text});
  expect(proc.command).not.toContain(job.text); expect(writes).toEqual([job.text]);
  root.reconcileReplies("synthetic", []); expect(root.replyPending).toHaveLength(1);
  // No view owns these objects or receives the result.
  root.finishReply(76);
  expect(root.replyPending[0]).toMatchObject({failed:true,replyText:"quoted target",failureReason:"Check Messages before sending again"});
  expect(events[0][1]).toBe(76); expect(root.replyJob).toBe(null);
  root.reconcileReplies("synthetic",root.replyPending); expect(root.replyPending).toHaveLength(1);
  root.reconcileReplies("synthetic",[]); expect(root.replyPending).toEqual([]);
});

import { withPendingSends } from "./thread";
test("queued and running replies survive a thread refresh after the age limit", () => {
  const pending:any={chat:"synthetic",text:"queued words",ts:"2026-11-10T00:00:00Z",localId:"slow",inFlight:true};
  expect(withPendingSends([], [pending], "2026-11-10", undefined, Date.parse(pending.ts)+300000).pending).toEqual([pending]);
});

test("shipping reply completion hands words back only on proven refusals", () => {
  const view=readFileSync(new URL("./BlipView.qml",import.meta.url),"utf8");
  const start=view.indexOf("    function onReplyExited("), begin=view.indexOf("{",start);
  let end=begin, depth=0;
  for(;end<view.length;end++){if(view[end]==="{")depth++;else if(view[end]==="}" && --depth===0)break;}
  const handler=view.slice(start,end+1);
  for(const code of [-2,-1,0,1,2,9,15,64,65,69,70,75,76,77,78,127,137,255]) for(const draft of ["", "newer synthetic draft"]) for(const sameChat of [true,false]){
    const root:any={inThread:true,active:{chat:sameChat ? "synthetic" : "other"},requestThreadLoad(){}}, composeField={text:draft};
    const done=new Function("root","composeField","SendState",handler+";return onReplyExited;")(root,composeField,SendState);
    done({chat:"synthetic",text:"synthetic words",reply:{guid:"G"}},code,SendState.replyFailure(code,""));
    const restored = sameChat && draft === "" && [-2,1,64,65,75,77,78].includes(code);
    expect(composeField.text).toBe(restored ? "synthetic words" : draft);
    expect(root.replyTarget).toEqual(restored ? {guid:"G"} : undefined);
  }
});

test("shipping Process completion treats every crash status as uncertain", () => {
  const line = source.slice(source.indexOf("id: replyProc"));
  const handler = line.match(/onExited: function\(code, status\) \{([^}]+)\}/)![1];
  for (const status of [0,1]) for (const code of [0,1,64,65,75,77,78]) {
    let result = -99;
    new Function("root","SendState","code","status",handler)({finishReply:(n:number)=>result=n},SendState,code,status);
    expect(result).toBe(status === 0 ? code : 76);
    if (status !== 0) expect(SendState.replyCanRestore(result)).toBe(false);
  }
  expect(line).toContain("root.finishReply(SendState.REPLY_NOT_STARTED)");
  expect(SendState.replyCanRestore(SendState.REPLY_NOT_STARTED)).toBe(true);
  expect(SendState.replyCanRestore(70)).toBe(false);
});
