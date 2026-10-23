const assert=require('node:assert/strict'),http=require('http'),fs=require('fs');
const {chromium}=require('playwright-core');const {Runner,replayStep,config,sleep}=require('../src/engine');const {RepeatClicks}=require('../src/repeat-clicks');const {crop,locateClick}=require('../src/vision');
async function until(fn){for(let i=0;i<300;i++){if(await fn())return;await sleep(100);}throw Error('repeat timeout');}
(async()=>{
 let requests=0;const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');const seat=url.pathname==='/runner'?(requests++%2?450:350):Number(url.searchParams.get('x')||80);res.setHeader('Content-Type','text/html');res.end('<style>body{margin:0}canvas{display:block}#badge{position:absolute;top:340px;width:100px;height:30px;background:linear-gradient(45deg,#183acd,#fc9320)}</style><canvas id="game" width="600" height="320"></canvas><div id="badge"></div><script>window.hits=0;window.downs=0;const c=document.querySelector("canvas"),ctx=c.getContext("2d");let bx='+seat+';window.paint=(x,active=false)=>{bx=x;ctx.fillStyle="#192b3c";ctx.fillRect(0,0,600,320);for(let y=0;y<48;y++)for(let i=0;i<48;i++){ctx.fillStyle=active?"#ff2233":"rgb("+((i*17+y*31)%256)+","+((i*7+y*11)%256)+",120)";ctx.fillRect(x+i,120+y,1,1);}};paint(bx);c.onpointerdown=e=>{downs++;if(e.offsetX>=bx&&e.offsetX<bx+48&&e.offsetY>=120&&e.offsetY<168){hits++;paint(bx,true)}};</script>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;let browser,run,repeats;
 try{
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:640,height:400}});await page.goto(base);const shot=await page.screenshot();const visual={image:crop(shot,{x:80,y:120,width:48,height:48}).buffer.toString('base64'),offset:{x:20,y:20}};
  const step={type:'canvas',page:0,frame:[],selector:'#game',button:'left',delay:300,points:[{x:100/600,y:140/320,t:0},{x:100/600,y:140/320,t:35}],visual};
  await page.evaluate(()=>paint(350));repeats=new RepeatClicks();const logs=[];const log=(m,l)=>logs.push({m,l});let screenshots=0;const capture=page.screenshot.bind(page);page.screenshot=async(...args)=>{screenshots++;return capture(...args)};
  for(let i=0;i<9;i++){
   await replayStep(page,step,undefined,log,repeats);
   if(i===0)await assert.rejects(locateClick(await capture(),visual,{x:100,y:140},{x:0,y:0,width:600,height:320}),{code:'VISUAL_NOT_FOUND'});
  }
  assert.equal(await page.evaluate(()=>hits),9);assert.equal(await page.evaluate(()=>downs),9);assert.equal(screenshots,1);assert.equal(logs.filter(x=>x.m.includes('复用本段已确认坐标')).length,8);assert.equal(logs.filter(x=>x.l==='warn').length,0);
  // A different location must discard the established anchor.
  await replayStep(page,{...step,points:[{x:200/600,y:140/320,t:0},{x:200/600,y:140/320,t:30}]},undefined,log,repeats);assert.equal(screenshots,2);assert.equal(repeats.last,null);
  await page.evaluate(()=>paint(350));await replayStep(page,step,undefined,log,repeats);assert.ok(repeats.last);
  // A long gap must not reuse an old seat.
  repeats.last.at-=6000;await replayStep(page,step,undefined,log,repeats);assert.equal(repeats.last,null);
  await page.evaluate(()=>paint(350));await replayStep(page,step,undefined,log,repeats);assert.ok(repeats.last);
  // Replacing a canvas at the same rectangle invalidates its element identity.
  await page.locator('canvas').evaluate(c=>c.replaceWith(c.cloneNode()));await replayStep(page,step,undefined,log,repeats);assert.equal(repeats.last,null);
  await replayStep(page,{type:'goto',url:base},undefined,log,repeats);assert.equal(repeats.last,null);
  const trusted={page:0,rect:{x:0,y:340,width:100,height:30},image:crop(shot,{x:0,y:340,width:100,height:30}).buffer.toString('base64')};
  const flow={id:'repeat-test',viewport:{width:640,height:400},steps:[{type:'goto',page:0,url:base+'/runner'},...Array.from({length:9},()=>structuredClone(step))],trusted};
  run=new Runner(flow,config({count:2,actionInterval:20,grace:0,interval:1,retries:0}),null);const runLogs=[];run.on('log',(l,m)=>runLogs.push({l,m}));run.start();
  await until(()=>run.states.length===2&&run.states.every(s=>s.status==='正常运行'));
  for(const b of run.browsers)assert.equal(await b.contexts()[0].pages()[0].evaluate(()=>hits),9);
  assert.equal(runLogs.filter(x=>x.m.includes('复用本段已确认坐标')).length,16);assert.ok(!runLogs.some(x=>x.l==='warn'));await run.stop();
  fs.writeFileSync('test-results/repeat-report.txt','PASS: nine distinct down/up clicks; first unique relocation retained despite post-click appearance change; eight reuse decisions and one screenshot; different position, expired anchor, canvas replacement and navigation invalidation; two isolated Runner instances with different seats each receive nine successful clicks.\n');console.log('PASS repeated clicks and two-instance Runner');
 }finally{await repeats?.clear();await run?.stop();await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
