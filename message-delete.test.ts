import {expect, test} from "bun:test";
import {decorate} from "./thread";
import type {ImsgMessage} from "./collector";
import {deletionTarget, deleteMessage} from './message-delete';

const message: ImsgMessage = {
  id: "9223372036854775807", guid: "11111111-2222-4333-8444-555555555555",
  chat: "chat123456789", handle: "+15551234567", name: "Example Person",
  ts: "2026-09-13 12:00:00", service: "iMessage", from_me: false, text: "Synthetic message",
};

test("bubble actions preserve the exact message and original chat identity", () => {
  const bubble = decorate([message], "2026-09-13")[0] as any;
  expect(bubble.messageId).toBe(message.id);
  expect(bubble.messageGuid).toBe(message.guid);
  expect(bubble.messageChat).toBe(message.chat);
});

const request={id:'1',guid:'11111111-2222-4333-8444-555555555555',chat:'chat12345',confirmed:true};
test('deletion requires confirmation and exact bounded identity before spawning',()=>{
  let calls=0;
  const runner=((..._:any[])=>{calls++;return {};}) as any;
  for (const delta of [{confirmed:false},{id:1},{id:'9223372036854775808'},{chat:'x\n'},{guid:'bad'}])
    expect(()=>deleteMessage({...request,...delta},runner)).toThrow();
  expect(calls).toBe(0);
  expect(deletionTarget(request)).toEqual({id:request.id,guid:request.guid,chat:request.chat});
});
test('deletion sends only confirmed identity on stdin and verifies every returned field',()=>{
  const response={ok:true,deleted:true,...request};
  const runner=((path:any,args:any,options:any)=>{
    expect(path.endsWith('/bin/imsg-delete')).toBe(true);expect(args).toEqual([]);
    expect(JSON.parse(options.input)).toEqual(request);
    expect(options.timeout).toBe(90000);expect(options.maxBuffer).toBe(8192);
    return {status:0,stdout:JSON.stringify(response)};
  }) as any;
  expect(deleteMessage({...request,text:'Do not transport this body'},runner)).toEqual({ok:true});
  for(const change of [{id:'2'},{guid:'22222222-2222-4333-8444-555555555555'},{chat:'other'},{deleted:false}])
    expect(deleteMessage(request,(()=>({status:0,stdout:JSON.stringify({...response,...change})})) as any).uncertain).toBe(true);
});
test('failed or lost deletion responses are never reported as success',()=>{
  for(const result of [{status:1,stdout:''},{status:0,stdout:'{}'},{error:new Error('timeout')},
    {status:1,stdout:JSON.stringify({ok:false,code:'unverified'})}])
    expect(deleteMessage(request,(()=>result) as any).uncertain).toBe(true);
  expect(deleteMessage(request,(()=>({status:1,stdout:JSON.stringify({ok:false,code:'permission'})})) as any))
    .toMatchObject({ok:false,uncertain:false});
});

test("missing or imprecise identities cannot become deletion targets", () => {
  for (const id of [undefined, 0, -1, Number.MAX_SAFE_INTEGER + 1, "1;delete", "0"]) {
    const bubble = decorate([{...message, id}], "2026-09-13")[0] as any;
    expect(bubble.messageId).toBe("");
  }
  const bubble = decorate([{...message, guid: undefined}], "2026-09-13")[0] as any;
  expect(bubble.messageGuid).toBe("");
});
