const test=require('node:test'),assert=require('node:assert/strict');
const {validateFlow}=require('../src/flow-schema'),{encode,decode}=require('../src/flow-transfer'),{Recorder}=require('../src/engine');
const base=()=>({version:1,kind:'base',name:'基础',viewport:{width:1280,height:720},config:{},steps:[{type:'goto',url:'https://example.com'},{type:'fill',page:0,frame:[],selector:'#x',value:'original'}]});
test('base restrictions and snapshot prefix integrity',()=>{
 const b=base();validateFlow(b);for(const change of [{subflows:[{}]},{trusted:{}},{baseFlow:base()},{steps:[{type:'checkpoint'}]}])assert.throws(()=>validateFlow({...b,...change}));
 const full={...base(),kind:'full',baseFlow:b};validateFlow(full);const bad=structuredClone(full);bad.steps[1].value='changed';assert.throws(()=>validateFlow(bad));
 assert.throws(()=>encode(b,'1.4.0'));const text=encode(full,'1.4.0');assert.throws(()=>decode(text,'1.3.3'));assert.deepEqual(decode(text,'1.4.0'),full);
});
test('first manual fill never merges into immutable embedded prefix',()=>{
 const f=base(),r=new Recorder(f,{});r.recordingFloor=f.steps.length;r.append({...f.steps[1],value:'continued'});assert.equal(f.steps.length,3);assert.equal(f.steps[1].value,'original');r.append({...f.steps[2],value:'continued again'});assert.equal(f.steps.length,3);
});

test('base prefix overrides execution settings and inherits browser/inspection settings',async()=>{
 const {config,stepConfig}=require('../src/engine');
 const cfg=config({stepTimeout:5000,actionInterval:0,mute:false,retries:9});
 const b=base();b.config={stepTimeout:1000,actionInterval:0,threshold:.8,radius:4,maxStepDelay:3,checkpointTimeout:2000,ignoreRecordedDelays:false,mute:true,retries:1};
 const full={kind:'full',baseFlow:b,steps:[...b.steps,{type:'click',selector:'#next'}]};
 const effective=stepConfig(full,0,cfg);
 assert.equal(effective.stepTimeout,1000);assert.equal(effective.threshold,.8);assert.equal(effective.mute,false);assert.equal(effective.retries,9);
 assert.equal(stepConfig(full,2,cfg),cfg);
 const observed=[];let timeout;
 const page={isClosed:()=>false,url:()=> 'https://example.com',setDefaultTimeout:v=>timeout=v,setDefaultNavigationTimeout:()=>{},mainFrame:()=>page,locator:()=>({fill:async()=>observed.push(timeout),click:async()=>observed.push(timeout)})};
 await require('../src/subflows').executeSteps(full,new Map([[0,page]]),cfg,new AbortController().signal);
 assert.deepEqual(observed,[1000,5000]);assert.equal(timeout,5000);
});
