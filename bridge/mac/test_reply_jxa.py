#!/usr/bin/env python3
"""Execute shipped JXA guards in Node with a synthetic accessibility tree."""
import json
import subprocess
import unittest
from pathlib import Path
from test_reply import tool

class GuardTests(unittest.TestCase):
    def test_recipient_sheet_and_reply_subtree_are_rechecked_before_return(self):
        script = tool.JXA[:tool.JXA.index('function run(')]
        harness = r"""
let scenario="", filled=false, pressed=0;
const ObjC={import(){}}, REACTED_SOURCE="^$";
const field={value(v){if(arguments.length){filled=true; this.text=v;}return this.text||"";},
 attributes:{byName:n=>({value:()=>n==="AXIdentifier"?"messageBodyField":"Reply"})}};
Object.defineProperty(field,"value",{get:()=>()=>field.text||"",set:v=>{filled=true;field.text=v;}});
const transcript={description:()=>"Reply transcript",path:"window.reply"};
const target={description:()=>"Me, target, 09:15",path:"window.reply.message"};
const win={sheets:{get length(){return scenario==="sheet"?1:0}},
 name:()=>scenario==="recipient"&&filled?"Other":"Synthetic",
 entireContents:()=>[transcript,target]};
const proc={windows:[win],frontmost:()=>true,attributes:{byName:()=>({value:()=>field})}};
const se={processes:{byName:()=>proc},keyCode:()=>{pressed++;field.text="";}};
const Application=()=>se, Automation={getDisplayString:e=>e.path};
function delay(){}
"""
        checks = r"""
for (scenario of ["valid","sheet","recipient","outside"]) {
 filled=false; pressed=0; field.text="";target.path=scenario==="outside"?"window.main.message":"window.reply.message";
 const r=send({polls:1,body:"synthetic reply",chatNames:["Synthetic"],text:"target",hhmm:"09:15"});
 if(pressed !== (scenario==="valid"?1:0)) throw Error(scenario+" pressed "+pressed);
}
console.log("ok");
"""
        # proc and se come from Application in the shipping script.
        harness = harness.replace('const proc=', 'const fakeProc=').replace('const se=', 'const fakeSe=').replace('()=>proc}', '()=>fakeProc}').replace('()=>se, Automation','()=>fakeSe, Automation')
        result = subprocess.run(["node", "-e", harness + script + checks], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

if __name__ == "__main__":
    unittest.main()
