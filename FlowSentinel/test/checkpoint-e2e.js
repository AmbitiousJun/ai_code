const assert=require('node:assert/strict'),http=require('http'),fs=require('fs'),path=require('path');
const {Recorder,Runner,config,sleep}=require('../src/engine');
async function until(fn,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(fn())return;await sleep(50);}throw new Error('Timed out');}
(async()=>{
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><style>body{margin:30px;background:#fff}#ready{width:180px;height:60px;background:linear-gradient(45deg,#168555 25%,#224977 25%,#224977 50%,#168555 50%,#168555 75%,#224977 75%);display:none}canvas{border:1px solid #000;display:block;margin-top:20px}</style><button id="begin">Begin</button><div id="ready"></div><canvas id="canvas" width="300" height="140"></canvas><input id="final"><script>const ctx=document.querySelector('canvas').getContext('2d');for(let y=0;y<140;y++)for(let x=0;x<300;x++){ctx.fillStyle='rgb('+((x*13+y*7)%255)+','+((y*19)%255)+',80)';ctx.fillRect(x,y,1,1);}window.stage=0;window.bad=0;const ready=document.querySelector('#ready');document.querySelector('#begin').onclick=()=>setTimeout(()=>{window.stage=1;ready.style.display='block'},1200);document.querySelector('canvas').onclick=()=>{if(window.stage!==1){window.bad++;return;}window.stage=2;ready.style.background='linear-gradient(45deg,#8b39b8 25%,#eabe20 25%,#eabe20 50%,#8b39b8 50%,#8b39b8 75%,#eabe20 75%)';ready.style.display='none';setTimeout(()=>{window.stage=3;ready.style.display='block'},900)};</script>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const flow={id:'checkpoint-test',name:'Checkpoints',viewport:{width:1280,height:720},steps:[]};let rec,run;
 try{
  rec=new Recorder(flow);await rec.start();const p=rec.page;
  await p.goto('http://127.0.0.1:'+server.address().port);await p.locator('#begin').click();await p.locator('#ready').waitFor();
  await rec.snapshot();const rect=await p.locator('#ready').boundingBox();const first=rec.setCheckpoint(rect,{timeout:5000,threshold:0.9});
  const boundary=flow.steps.indexOf(first);assert.equal(boundary,flow.steps.length-1);
  const count=flow.steps.length;await p.locator('#final').fill('not-recorded-during-capture');await sleep(100);assert.equal(flow.steps.length,count);await p.locator('#final').fill('');await rec.resumeCapture();
  const box=await p.locator('canvas').boundingBox();await p.mouse.click(box.x+80,box.y+60);await p.locator('#ready').waitFor();await rec.snapshot();rec.setCheckpoint(await p.locator('#ready').boundingBox(),{timeout:5000,threshold:0.9});await rec.resumeCapture();
  await p.locator('#final').fill('after-both-checkpoints');await rec.snapshot();rec.setTrusted(await p.locator('#ready').boundingBox());await rec.resumeCapture();await rec.stop();
  assert.equal(flow.steps.filter(s=>s.type==='checkpoint').length,2);
  flow.steps.forEach(s=>s.delay=60000);
  const started=Date.now();run=new Runner(flow,config({count:1,ignoreRecordedDelays:true,actionInterval:0,interval:1,grace:0,retries:0}),path.resolve('test-results/checkpoint-evidence'));
  const logs=[];run.on('log',(l,m)=>logs.push(m));run.start();await until(()=>run.states[0]?.status==='正常运行');assert.ok(Date.now()-started<15000);
  const actual=[...run.browsers][0].contexts()[0].pages()[0];assert.equal(await actual.evaluate(()=>window.bad),0);assert.equal(await actual.locator('#final').inputValue(),'after-both-checkpoints');assert.equal(logs.filter(x=>x.includes('已通过，继续执行')).length,2);await run.stop();
  const timeoutFlow=structuredClone(flow);timeoutFlow.steps[0].url+='?timeout';const check=timeoutFlow.steps.find(s=>s.type==='checkpoint');check.timeout=1000;check.trusted=flow.trusted;
  run=new Runner(timeoutFlow,config({actionInterval:0,ignoreRecordedDelays:true,retries:0,grace:0}),path.resolve('test-results/checkpoint-timeout'));const timeoutLogs=[];run.on('log',(l,m)=>timeoutLogs.push(m));await run.start();assert.equal(run.states[0].status,'需要人工处理');assert.ok(timeoutLogs.some(x=>x.includes('检查点等待超时')));const checkIndex=timeoutFlow.steps.findIndex(s=>s.type==='checkpoint');assert.ok(!timeoutLogs.some(x=>x.startsWith('实例 1 · #'+(checkIndex+2)+' ')));
  run=new Runner(timeoutFlow,config({actionInterval:0,ignoreRecordedDelays:true,retries:0}),path.resolve('test-results/checkpoint-stop'));run.flow.steps.find(s=>s.type==='checkpoint').timeout=60000;run.start();await until(()=>run.states[0]?.status.startsWith('等待检查点'));const t=Date.now();await run.stop();assert.ok(Date.now()-t<3000);
  fs.writeFileSync('test-results/checkpoint-report.txt','PASS: two screenshot checkpoints recorded in order; capture pauses events; headless replay waits for asynchronous UI states; 60-second recorded idle is ignored; checkpoint timeout blocks next step with evidence; stop interrupts checkpoint wait.\n');console.log('Checkpoint E2E PASS');
 }finally{await run?.stop();await rec?.stop();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
