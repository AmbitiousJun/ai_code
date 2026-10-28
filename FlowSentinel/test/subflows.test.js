const test=require('node:test'),assert=require('node:assert/strict');
const {parseCron,cronMatches}=require('../src/cron');
const {validateFlow}=require('../src/flow-schema');
const transfer=require('../src/flow-transfer');
const base=()=>({version:1,name:'main',viewport:{width:1280,height:720},config:{},steps:[],subflows:[{id:'sub',name:'child',trigger:{type:'cron',expression:'*/5 * * * *'},steps:[{type:'click',selector:'#go'}]}]});
test('cron ranges, lists, steps, weekday Sunday aliases and DOM/DOW OR',()=>{
  assert.ok(cronMatches('*/5 9-17 * * 1-5',new Date(2026,9,26,9,15)));
  assert.ok(!cronMatches('*/5 9-17 * * 1-5',new Date(2026,9,26,9,16)));
  assert.ok(cronMatches('0 9 1 * 1',new Date(2026,9,26,9,0)));
  assert.ok(cronMatches('0 9 * * 7',new Date(2026,9,25,9,0)));
  assert.ok(cronMatches('0,30 * * * *',new Date(2026,9,26,9,30)));
  for(const s of ['','* * * *','60 * * * *','*/0 * * * *','0 24 * * *','1-0 * * * *','0 0 * 13 *','@daily','0 0 * * MON'])assert.throws(()=>parseCron(s));
});
test('subflows survive exchange and require 1.3.0; reject invalid nested data',()=>{
  const f=base();validateFlow(f);const text=transfer.encode(f,'1.3.0');
  assert.deepEqual(transfer.decode(text,'1.3.0'),f);assert.throws(()=>transfer.decode(text,'1.2.9'),/1.3.0/);
  for(const mutate of [f=>f.subflows[0].steps=[],f=>f.subflows[0].trigger={},f=>f.subflows[0].trigger.expression='broken',f=>f.subflows[0].subflows=[],f=>f.subflows.push(f.subflows[0]),f=>f.subflows[0].steps=[{type:'fill',selector:'#a',value:1}]]){const f=base();mutate(f);assert.throws(()=>validateFlow(f));}
  const old=base();delete old.subflows;assert.doesNotThrow(()=>transfer.decode(transfer.encode(old,'1.3.0'),'1.2.9'));
});

test('second cron matching and legacy minute slots',()=>{
  const {cronSlot}=require('../src/cron');
  const d=new Date(2026,9,26,9,15,20);
  assert.ok(cronMatches('*/10 * * * * *',d));
  assert.ok(!cronMatches('*/10 * * * * *',new Date(+d+1000)));
  assert.ok(cronMatches('20 15 9 * * 1',d));
  assert.ok(cronMatches('*/5 * * * *',new Date(+d+1000)));
  assert.equal(cronSlot('* * * * *',d),cronSlot('* * * * *',new Date(+d+1000)));
  assert.notEqual(cronSlot('* * * * * *',d),cronSlot('* * * * * *',new Date(+d+1000)));
  assert.equal(cronSlot('* * * * * *',d),cronSlot('* * * * * *',new Date(+d+999)));
  for(const value of ['60 * * * * *','*/0 * * * * *','0 0 24 * * *','0 0 0 * * 8','* * * * * * *'])assert.throws(()=>parseCron(value));
  const f=base();f.subflows[0].trigger.expression='*/10 * * * * *';
  validateFlow(f);const encoded=transfer.encode(f,'1.3.2');
  assert.equal(JSON.parse(encoded).minImporterVersion,'1.3.2');
  assert.throws(()=>transfer.decode(encoded,'1.3.1'),/1.3.2/);
  assert.deepEqual(transfer.decode(encoded,'1.3.2'),f);
});
test('scheduler deduplicates seconds and retries failures across recovery',async()=>{
  const {SubflowScheduler}=require('../src/subflows');
  const {config}=require('../src/engine');
  const RealDate=Date;let time=+new RealDate(2026,9,26,9,15,20),clicks=0,fail=false;
  global.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[time]));}static now(){return time;}};
  const page={setDefaultTimeout:()=>{},setDefaultNavigationTimeout:()=>{},mainFrame:()=>page,isClosed:()=>false,context:()=>null,locator:()=>({click:async()=>{if(fail)throw Error('failure');clicks++;}})};
  const sub={id:'s',name:'seconds',trigger:{type:'cron',expression:'* * * * * *'},steps:[{type:'click',selector:'#go'}]};
  const scheduler=new SubflowScheduler([sub]),pages=new Map([[0,page]]),cfg=config({actionInterval:0});
  const tick=()=>scheduler.tick(pages,cfg,new AbortController().signal,()=>{});
  try{
    await tick();await tick();assert.equal(clicks,1);
    time+=1000;await tick();assert.equal(clicks,2);
    time+=5000;await tick();assert.equal(clicks,3);
    time+=1000;fail=true;await assert.rejects(tick,/failure/);
    fail=false;await tick();await tick();assert.equal(clicks,4);
  }finally{global.Date=RealDate;}
});

test('continued drafts normalize new popup pages without changing recorded data',()=>{
  const {SubflowSession}=require('../src/subflows');
  const session=new SubflowSession(base());session.phase='review';session.pageBase=1;session.recordingPageStart=3;
  session.trigger={type:'cron',expression:'* * * * *'};
  session.recorder={flow:{steps:[{type:'click',selector:'#old',page:2}]}};
  assert.throws(()=>session.save('old popup'),/主流程标签页/);
  session.recorder.flow.steps=[{type:'click',selector:'#open',page:0},{type:'goto',url:'https://example.com',page:3},{type:'click',selector:'#go',page:3}];
  const before=structuredClone(session.recorder.flow.steps),sub=session.save('new popup');
  assert.deepEqual(sub.steps.map(s=>s.page),[0,1,1]);assert.deepEqual(session.recorder.flow.steps,before);
});

test('subflow checkpoints declare unlimited-wait importer semantics',()=>{
 const f=base();f.subflows[0].steps.unshift({type:'checkpoint',timeout:1000,threshold:.9,trusted:{rect:{x:0,y:0,width:12,height:12},image:'legacy',page:0}});
 validateFlow(f);const text=transfer.encode(f,'1.4.9');assert.equal(JSON.parse(text).minImporterVersion,'1.4.9');assert.throws(()=>transfer.decode(text,'1.4.7'),/1.4.9/);assert.deepEqual(transfer.decode(text,'1.4.9'),f);
});
