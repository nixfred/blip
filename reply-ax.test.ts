import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("./bridge/mac/imsg-reply", import.meta.url), "utf8");
const start = source.indexOf('JXA = r"""') + 10;
const script = source.slice(start, source.indexOf('\n"""', start)).replace("REACTED_SOURCE", '"^\\\\d+ reactions?$"');
function scene(options: {title?:string; draft?:string; label?:string; focus?:boolean; slow?:boolean; afterFill?:string; noTranscript?:boolean} = {}) {
  let value=options.draft || "", returns=0, writes=0;
  const field:any={attributes:{byName:(name:string)=>({value:()=>name === "AXIdentifier" ? "messageBodyField" : name === "AXPlaceholderValue" ? "Reply" : null})}, value:()=>value};
  Object.defineProperty(field,"value",{get:()=>()=>value,set:(text:string)=>{writes++; value=text}});
  const transcript={description:()=>"Reply transcript", path:"window.group"};
  const bubble={description:()=>options.label || "You, hello, 14:05",path:"window.group.child"};
  const other:any={attributes:{byName:(name:string)=>({value:()=>name === "AXIdentifier" ? (options.afterFill === "id" ? "other" : "messageBodyField") : (options.afterFill === "placeholder" ? "iMessage" : "Reply")})}, value:()=>["id","placeholder"].includes(options.afterFill || "") ? value : options.afterFill === "value" ? "different words" : ""};
  const after = () => writes > 0;
  const win={name:()=>after() && options.afterFill === "recipient" ? "other" : options.title || "+15551234567",sheets:[],entireContents:()=>options.noTranscript ? [bubble] : after() && options.afterFill === "transcript" ? [transcript] : [transcript,bubble]};
  const proc={frontmost:()=>options.focus !== false && !(after() && options.afterFill === "front"),windows:[win],attributes:{byName:()=>({value:()=>after() && ["id","placeholder","empty","value"].includes(options.afterFill || "") ? other : field})}};
  const api=new Function("ObjC","Application","Automation","delay",script+'; return {send, viewNames};')(
    {import(){}},()=>({processes:{byName:()=>proc},keyCode:(code:number)=>{if(code === 36) { returns++; if (!options.slow) value=""; }}}),
    {getDisplayString:(el:any)=>el.path},()=>{});
  return {api, count:()=>returns, text:()=>value, writes:()=>writes};
}
const request={body:"synthetic reply",text:"hello",hhmm:"14:05",polls:1,chatNames:["+15551234567"]};
test("reply JXA refuses a draft, wrong recipient, wrong bubble or lost focus before filling",()=>{
  for (const option of [{draft:"existing draft"},{title:"other person"},{label:"You, other, 14:05"},{focus:false}]) {
    const s=scene(option); expect(s.api.send(request).ok).toBe(false); expect(s.count()).toBe(0); expect(s.writes()).toBe(0); expect(s.text()).toBe(option.draft || "");
  }
});
test("reply JXA slow clearing after Return is uncertain and preserves the result",()=>{
  const s=scene({slow:true}); expect(s.api.send(request).error).toBe("unconfirmed"); expect(s.count()).toBe(1);
});

test("reply refuses a wrong time and missing reply transcript before writing",()=>{
  for (const option of [{label:"You, hello, 14:06"},{noTranscript:true}]) {
    const s=scene(option);
    expect(s.api.send(request).ok).toBe(false);
    expect(s.writes()).toBe(0); expect(s.count()).toBe(0);
  }
});
test("every last-moment guard refuses before Return and clears only the filled field",()=>{
  for (const afterFill of ["recipient","transcript","front","id","placeholder","empty","value"]) {
    const s=scene({afterFill});
    expect(s.api.send(request).error).toBe("focus-moved");
    expect(s.count()).toBe(0); expect(s.text()).toBe("");
  }
});
test("verified field content sends once",()=>{
  const s=scene(); expect(s.api.send(request).ok).toBe(true); expect(s.count()).toBe(1);
});
