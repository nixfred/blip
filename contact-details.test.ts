import {test,expect} from 'bun:test';
import {cardDetails} from './contact-details';
const token='sha256:'+'a'.repeat(64);
const request={handle:'+15551234567',token};
const base={ok:true,...request,name:'Example Person',sourceName:'iCloud',accountNumber:1,fields:[
  {key:'firstName',label:'',value:'Example'}, {key:'phone',label:'Mobile',value:'+15551234567'},
  {key:'address',label:'Home',value:'Street: 10 Example Lane; City: Sample City'},
  {key:'note',label:'',value:'A synthetic note with <b>plain text</b>'},
]};
function runner(body: unknown): any {return (_cmd:string,args:string[],options:any)=>{
  expect(args).toEqual(['--json','resolve']);
  expect(JSON.parse(options.input)).toEqual({operation:'details',...request});
  expect(options.maxBuffer).toBe(48*1024);
  return {status:0,stdout:JSON.stringify(body)};
};}
test('renders labeled contact fields from one exact card on bounded stdin',()=>{
  const view=cardDetails(request,runner(base));
  expect(view.source).toBe('iCloud · Account 1');
  expect(view.fields[1]).toEqual({label:'Phone · Mobile',value:'+15551234567'});
  expect(view.fields[3].value).toContain('<b>plain text</b>');
});
test('rejects mismatched cards and hostile detail shapes',()=>{
  for(const body of [null,{}, {...base,token:'sha256:'+'b'.repeat(64)}, {...base,handle:'+15551234568'},
    {...base,fields:Array(161).fill(base.fields[0])}, {...base,fields:[{key:'__proto__',label:'',value:'x'}]},
    {...base,fields:[{key:'note',label:'',value:'x'.repeat(4097)}]}, {...base,accountNumber:0}])
    expect(()=>cardDetails(request,runner(body))).toThrow();
  expect(()=>cardDetails({...request,token:'bad'},runner(base))).toThrow();
});
test('strips control and direction overrides and rejects oversized process output',()=>{
  expect(cardDetails(request,runner({...base,name:'Example\u202ePerson'})).name).toBe('Example Person');
  expect(()=>cardDetails(request,(()=>({status:0,stdout:' '.repeat(49153)})) as any)).toThrow('too large');
});
