import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("./bridge/mac/imsg-reply", import.meta.url), "utf8");
const start = source.indexOf('JXA = r"""') + 10;
const script = source.slice(start, source.indexOf('\n"""', start)).replace("REACTED_SOURCE", '"^\\\\d+ reactions?$"');
function scene(options: {title?:string; draft?:string; label?:string; focus?:boolean; slow?:boolean} = {}) {
  let value=options.draft || "", returns=0, writes=0;
  const field:any={attributes:{byName:(name:string)=>({value:()=>name === "AXIdentifier" ? "messageBodyField" : name === "AXPlaceholderValue" ? "Reply" : null})}, value:()=>value};
  Object.defineProperty(field,"value",{get:()=>()=>value,set:(text:string)=>{writes++; value=text}});
  const transcript={description:()=>"Reply transcript", path:"window.group"};
  const bubble={description:()=>options.label || "You, hello, 14:05",path:"window.group.child"};
  const win={name:()=>options.title || "+15551234567",sheets:[],entireContents:()=>[transcript,bubble]};
  const proc={frontmost:()=>options.focus !== false,windows:[win],attributes:{byName:()=>({value:()=>field})}};
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
