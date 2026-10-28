const assert=require('node:assert/strict'),http=require('http'),fs=require('fs');
const {PNG}=require('pngjs');
const {chromium}=require('playwright-core');
const {Recorder,replayStep,config,sleep}=require('../src/engine');
const {executeSteps,SubflowScheduler}=require('../src/subflows');
const tile=new PNG({width:32,height:32});
for(let i=0;i<1024;i++){let n=i+1;n=Math.imul(n^(n>>>16),0x45d9f3b);n=Math.imul(n^(n>>>16),0x45d9f3b);n^=n>>>16;tile.data.set([n&255,(n>>>8)&255,120,255],i*4);}
const image=PNG.sync.write(tile).toString('base64');
(async()=>{
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');const port=server.address().port;
 res.end(req.url==='/inner'?`<style>body{margin:0}img{position:absolute;left:60px;top:60px;width:32px;height:32px}</style><img id="target" src="data:image/png;base64,${image}"><input id="after" style="position:absolute;top:280px"><script>window.hits=0;document.addEventListener('click',e=>{hits++;window.lastPoint={x:e.clientX,y:e.clientY}});window.move=(mode)=>{document.querySelector('#copy')?.remove();target.style.left=mode==='original'?'60px':'300px';target.style.display=mode==='missing'?'none':'block';if(mode==='duplicate'){const c=target.cloneNode();c.id='copy';c.style.left='170px';document.body.append(c);}}</script>`:req.url==='/outer'?`<iframe id="inner" style="margin:13px;border:3px solid black;width:500px;height:330px" src="http://127.0.0.1:${port}/inner"></iframe>`:`<iframe id="outer" style="margin:17px;border:4px solid black;width:580px;height:400px" src="http://localhost:${port}/outer"></iframe>`);});
 await new Promise(r=>server.listen(0,r));let rec,browser;
 try{
 const flow={viewport:{width:900,height:650},steps:[]};rec=new Recorder(flow);await rec.start();await rec.page.goto('http://127.0.0.1:'+server.address().port);
 const target=rec.page.frameLocator('#outer').frameLocator('#inner').locator('#target');await target.waitFor();await rec.page.screenshot();await sleep(250);await target.click({position:{x:16,y:16}});await sleep(200);await rec.stop();
 const step=flow.steps.find(s=>s.type==='click');assert.equal(step.frame.length,2);assert.equal(step.visual.width,12);assert.equal(step.visual.height,12);assert.ok(step.clickPoint);assert.ok(!step.visualError);
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:flow.viewport});await page.goto(flow.steps.find(s=>s.type==='goto').url);
 const frame=page.frames().find(f=>f.url().endsWith('/inner'));await frame.locator('#target').waitFor();const pages=new Map([[0,page]]),cfg=config({actionInterval:0});
 await replayStep(page,step);assert.equal(await frame.evaluate(()=>hits),1);
 await frame.evaluate(()=>move('moved'));
 const base={kind:'base',steps:[step],config:{actionInterval:0}};
 await executeSteps({steps:[step],baseFlow:base},pages,cfg);assert.equal(await frame.evaluate(()=>hits),2);
 const sub={id:'strict',name:'strict',trigger:{type:'cron',expression:'* * * * * *'},steps:[step,{type:'fill',frame:step.frame,selector:'#after',value:'passed'}]};
 await new SubflowScheduler([sub]).tick(pages,cfg,undefined,()=>{});assert.equal(await frame.evaluate(()=>hits),3);assert.equal(await frame.locator('#after').inputValue(),'passed');
 await frame.locator('#after').fill('');
 for(const mode of ['duplicate','missing']){
 await frame.evaluate(m=>move(m),mode);
 const before=await frame.evaluate(()=>hits);
 await executeSteps({steps:sub.steps,baseFlow:base},pages,cfg);
 await new SubflowScheduler([sub]).tick(pages,cfg,undefined,()=>{});
 assert.equal(await frame.evaluate(()=>hits),before+2);assert.deepEqual(await frame.evaluate(()=>lastPoint),step.clickPoint);assert.equal(await frame.locator('#after').inputValue(),'passed');
 }
 await replayStep(page,{...step,visual:undefined});
 await assert.rejects(replayStep(page,{...step,clickPoint:undefined}),{code:'VISUAL_INVALID'});
 fs.writeFileSync('test-results/strict-clicks-report.txt','PASS: nested cross-origin iframe records 12x12 pre-click marker; original and moved DOM clicks; embedded base and subflow scheduler share visual fallback; missing/duplicate/legacy markers click original coordinates and subsequent steps continue; absent coordinates fail.\n');
 console.log('PASS fallback iframe, base and subflow clicks');
 }finally{await rec?.stop();await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
