const assert=require('node:assert/strict'),http=require('http'),fs=require('fs');
const {chromium}=require('playwright-core');
const {SubflowSession,SubflowScheduler}=require('../src/subflows');
const {Runner,config,sleep}=require('../src/engine');
const {crop}=require('../src/vision');
const html=`<html><body><div id="ready" style="width:120px;height:60px;background:#27a488">READY</div><input id="value"><button id="add" onclick="window.count=(window.count||0)+1">Add</button><button id="popup" onclick="window.open('/popup')">Popup</button></body></html>`;
async function until(fn,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(50);}throw Error('Timed out');}
async function fixture(){
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+server.address().port;
  const b=await chromium.launch({channel:'chrome',headless:true});let trusted;
  try{const p=await b.newPage({viewport:{width:1280,height:720}});await p.goto(url);const result=crop(await p.screenshot(),{x:8,y:8,width:120,height:60});trusted={rect:result.rect,image:result.buffer.toString('base64'),page:0};}finally{await b.close();}
  const flow={version:1,id:'11111111-1111-4111-8111-111111111111',name:'子流程验收',viewport:{width:1280,height:720},config:config({grace:0,interval:1,actionInterval:20,retries:1,checkpointTimeout:5000,stepTimeout:5000}),steps:[{type:'goto',url,page:0}],trusted};
  return {flow,close:()=>new Promise(r=>server.close(r))};
}
async function main(){
 const site=await fixture();let session,run;
 try{
  session=new SubflowSession(site.flow);await session.start();assert.equal(session.phase,'condition');assert.equal(session.recorder.flow.steps.length,0);
  const browser=session.recorder.browser,p=session.recorder.pages.get(0);
  await p.locator('#value').fill('not-recorded');await sleep(200);assert.equal(session.recorder.flow.steps.length,0);
  await assert.rejects(()=>session.setTrigger({type:'cron',expression:'invalid'}));
  await session.setTrigger({type:'cron',expression:'* * * * *'});await session.finish();assert.throws(()=>session.save('empty'),/至少/);
  await session.recorder.resumeCapture();session.setPhase('recording');
  await p.locator('#value').fill('private-value');await p.locator('#add').click();await session.finish();session.save('定时填写');
  assert.ok(session.flow.subflows[0].steps.some(s=>s.type==='fill'&&s.value==='private-value'));
  const saved=structuredClone(session.flow.subflows[0]),context=session.recorder.context,pageBase=session.pageBase;
  await p.evaluate(()=>{window.keepScreen='preserved';sessionStorage.setItem('keep','yes');});
  await p.locator('#value').fill('manual-before-next');
  await session.next();assert.equal(session.recorder.browser,browser);assert.equal(session.recorder.context,context);
  assert.equal(session.recorder.pages.get(0),p);assert.equal(p.isClosed(),false);assert.equal(session.pageBase,pageBase);
  assert.equal(await p.locator('#value').inputValue(),'manual-before-next');assert.equal(await p.evaluate(()=>window.keepScreen),'preserved');
  assert.equal(await p.evaluate(()=>sessionStorage.getItem('keep')),'yes');assert.equal(session.trigger,null);
  await p.goto(site.flow.steps[0].url+'?manual=1');await p.locator('#value').fill('manual-after-next');
  await sleep(200);assert.equal(session.recorder.flow.steps.length,0);assert.deepEqual(session.flow.subflows[0],saved);
  await session.recorder.snapshot();await session.setTrigger({type:'image',rect:site.flow.trusted.rect});
  await session.recorder.pages.get(0).locator('#add').click();await session.finish();session.save('截图点击');assert.equal(session.flow.subflows[1].steps.length,1);assert.equal(session.flow.subflows[1].steps[0].type,'click');
  await session.next();await session.setTrigger({type:'cron',expression:'* * * * *'});
  const root=session.recorder.pages.get(0),popupPromise=root.waitForEvent('popup');await root.locator('#popup').click();const popup=await popupPromise;await popup.waitForLoadState();await popup.locator('#add').click();
  await session.finish();session.save('弹出页动作');
  await session.next();assert.equal(popup.isClosed(),false);
  await session.setTrigger({type:'cron',expression:'* * * * *'});
  const nextPopupPromise=root.waitForEvent('popup');await root.locator('#popup').click();const nextPopup=await nextPopupPromise;
  await nextPopup.waitForLoadState();await nextPopup.goto(site.flow.steps[0].url+'/popup-again');await nextPopup.locator('#add').click();await session.finish();session.save('再次弹出页动作');
  assert.equal(session.flow.subflows[3].steps.at(-1).page,session.pageBase);
  const flow=structuredClone(session.flow);assert.equal(flow.subflows.length,4);await session.stop();
  run=new Runner(flow,config({...flow.config,count:2,interval:15}));const logs=[];run.on('log',(l,m)=>logs.push(m));run.start();
  await until(()=>logs.filter(x=>x.includes('子流程完成：截图点击')).length>=2);
  await until(()=>logs.filter(x=>x.includes('子流程完成：截图点击')).length>=6,5000);
  assert.equal(logs.filter(x=>x.includes('可信图像匹配')).length,2,'fast subflow polling must not increase inspection frequency');
  assert.equal(logs.filter(x=>x.includes('触发子流程：定时填写')).length,2);
  assert.equal(logs.filter(x=>x.includes('子流程完成：弹出页动作')).length,2);
  assert.equal(logs.filter(x=>x.includes('子流程完成：再次弹出页动作')).length,2);
  assert.ok(!logs.join('\n').includes('private-value'));
  for(const b of run.browsers)assert.equal(await b.contexts()[0].pages()[0].locator('#value').inputValue(),'private-value');
  await run.stop();
  // Inspections still recur on their own deadline while image subflows keep running.
  run=new Runner({...flow,subflows:[flow.subflows[1]]},config({...flow.config,interval:1}));
  const inspections=[],completed=[];run.on('log',(l,m)=>{
    if(m.includes('可信图像匹配'))inspections.push(performance.now());
    if(m.includes('子流程完成：截图点击'))completed.push(performance.now());
  });run.start();
  await until(()=>inspections.length>=3);
  assert.ok(inspections.slice(1).every((t,i)=>t-inspections[i]>=990));
  assert.ok(completed.length>inspections.length);
  assert.ok(completed.slice(1).every((t,i)=>t-completed[i]>=190),'polls rest for 200ms after completion');
  const stopping=performance.now();await run.stop();assert.ok(performance.now()-stopping<3000);
  const seconds=structuredClone(site.flow);seconds.subflows=[{id:'seconds',name:'秒级点击',trigger:{type:'cron',expression:'* * * * * *'},steps:[{type:'click',selector:'#add',page:0}]}];
  run=new Runner(seconds,config({...seconds.config,count:2,interval:15}));
  const secondRuns=new Map();run.on('log',(l,m)=>{if(m.includes('子流程完成：秒级点击'))secondRuns.set(m,(secondRuns.get(m)||0)+1);});
  run.start();await until(()=>secondRuns.size===2&&[...secondRuns.values()].every(n=>n>=3),12000);
  await run.stop();
  const broken=structuredClone(site.flow);broken.subflows=[{id:'retry',name:'失败定时动作',trigger:{type:'cron',expression:'* * * * *'},steps:[{type:'click',selector:'#missing'}]}];
  run=new Runner(broken,broken.config);const failed=[];run.on('log',(l,m)=>failed.push(m));await run.start();
  assert.equal(failed.filter(m=>m.includes('触发子流程：失败定时动作')).length,2,failed.join('\n'));assert.equal(run.states[0].status,'需要人工处理');
  // Retry exhaustion and cancellation never enable recording.
  const bad=structuredClone(site.flow);bad.steps.push({type:'click',selector:'#missing',page:0});
  session=new SubflowSession(bad);let attempts=0;session.on('log',(l,m)=>{if(m.includes('正在恢复主流程'))attempts++;});
  await assert.rejects(()=>session.start(),/上限/);assert.equal(attempts,2);assert.notEqual(session.phase,'recording');await session.stop();
  session=new SubflowSession(bad);const pending=assert.rejects(session.start());await until(()=>!!session.recorder?.context);await session.stop();await pending;
  // Closing Chrome ends the session.
  session=new SubflowSession(site.flow);await session.start();await session.recorder.browser.close();await until(()=>session.phase==='closed');
  fs.writeFileSync('test-results/subflows-e2e-report.txt','PASS: restore and suppression; required trigger/action; named save; same Chrome/context/page retained; manual navigation and input excluded; saved draft unchanged; image and cron; two isolated instances; independent 200ms polling with 15s inspections; inspection cadence; no busy polling; minute deduplication; retry exhaustion; stop; browser close; redacted logs.\n');
  console.log('PASS subflows e2e');
 }finally{await run?.stop();await session?.stop();await site.close();}
}
module.exports={fixture,until};if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
