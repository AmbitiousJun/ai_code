const test=require('node:test'),assert=require('node:assert/strict');
const {encode,decode,importedFlow,nameError}=require('../src/flow-transfer');
const {validateFlow}=require('../src/flow-schema');
const flow={version:1,id:'old',name:'演示',viewport:{width:1280,height:720},config:{},steps:[{type:'goto',url:'https://example.com'},{type:'fill',selector:'#password',value:'secret'}],trusted:null,extra:{future:true}};
test('portable round trip preserves payload and replaces identity only on import',()=>{const result=validateFlow(decode(encode(flow,'1.2.7'),'1.2.7'));assert.deepEqual(result,flow);const copy=importedFlow(result,'新名字',[]);assert.notEqual(copy.id,flow.id);assert.deepEqual(copy.steps,flow.steps);assert.equal(copy.name,'新名字');assert.equal(flow.name,'演示');assert.deepEqual(copy.extra,flow.extra);});
test('compatibility uses protocol/minimum, not exporter version',()=>{const f=JSON.parse(encode(flow,'9.0.0'));assert.deepEqual(decode(JSON.stringify(f),'1.2.7'),flow);f.minImporterVersion='2.0.0';assert.throws(()=>decode(JSON.stringify(f),'1.2.7'),/最低导入版本.*2.0.0/);f.protocolVersion=2;assert.throws(()=>decode(JSON.stringify(f),'3.0.0'),/最低导入版本/);});
test('invalid files and payload are rejected',()=>{for(const text of ['no','null','{}'])assert.throws(()=>decode(text,'1.2.7'));assert.throws(()=>validateFlow({...flow,steps:[{type:'unknown'}]}));assert.throws(()=>validateFlow({...flow,version:2}));assert.throws(()=>validateFlow({...flow,steps:[{type:'checkpoint'}]}));});
test('duplicate and empty names blocked authoritatively',()=>{assert.ok(nameError('  DEMO ',['demo']));assert.ok(nameError('',['demo']));assert.throws(()=>importedFlow(flow,'演示',['演示']));assert.equal(nameError('新名字',['演示']),'');});

test('round trip retains checkpoint, visual, variables and per-instance settings',()=>{
 const {fieldId}=require('../src/variables');const fill={type:'fill',selector:'#name',page:0,frame:[],value:'original'};
 const image={rect:{x:0,y:0,width:12,height:12},image:'png-base64',page:0};
 const rich={...flow,config:{count:3,chromePath:'C:/Chrome/chrome.exe'},trusted:image,steps:[fill,{type:'checkpoint',trusted:image,timeout:60000,threshold:0.9},{type:'canvas',selector:'canvas',points:[{x:0.5,y:0.5,t:0}],visual:{image:'preview',offset:{x:24,y:24},width:48,height:48}}],variables:{[fieldId(fill)]:{mode:'template',template:'user_{{digits:6}}'}}};
 assert.deepEqual(validateFlow(decode(encode(rich,'1.4.7'),'1.4.7')),rich);
});


test('iframe fallback clicks require the current replay semantics',()=>{
 const strict={...flow,subflows:[{id:'s',name:'s',trigger:{type:'cron',expression:'* * * * *'},steps:[{type:'click',selector:'#button',frame:['iframe'],clickPoint:{x:20,y:20},visual:{image:'marker',offset:{x:6,y:6},width:12,height:12}}]}]};
 const text=encode(strict,'1.4.7');assert.equal(JSON.parse(text).minImporterVersion,'1.4.7');
 assert.throws(()=>decode(text,'1.4.6'),/最低导入版本/);assert.deepEqual(decode(text,'1.4.7'),strict);
});
