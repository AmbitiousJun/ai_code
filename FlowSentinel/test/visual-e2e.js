const assert=require('node:assert/strict');
const http=require('http');
const {chromium}=require('playwright-core');
const {Recorder,replayStep,sleep}=require('../src/engine');
const fs=require('fs');
const html=`<style>body{margin:13px}canvas{border:2px solid black;width:600px;height:300px}</style><canvas id="game" width="1200" height="600"></canvas><script>
const c=document.querySelector('canvas'),ctx=c.getContext('2d');let bx=80,by=80;window.hits=0;
window.draw=(x,y,duplicate=false)=>{bx=x;by=y;ctx.fillStyle='#16304d';ctx.fillRect(0,0,1200,600);const tile=(x,y)=>{for(let j=0;j<64;j++)for(let i=0;i<64;i++){let n=i+64*j+1;n=Math.imul(n^(n>>>16),0x45d9f3b);n=Math.imul(n^(n>>>16),0x45d9f3b);n^=n>>>16;ctx.fillStyle='rgb('+(n&255)+','+((n>>>8)&255)+',120)';ctx.fillRect((x+i)*2,(y+j)*2,2,2);}};tile(x,y);if(duplicate)tile(450,180);};draw(80,80);
c.onpointerdown=e=>{window.clicks=(window.clicks||0)+1;const r=c.getBoundingClientRect(),x=e.clientX-r.left-2,y=e.clientY-r.top-2;window.lastPoint={x,y};if(x>=bx&&x<bx+64&&y>=by&&y<by+64){hits++;ctx.clearRect(0,0,1200,600);}};
</script>`;
const webgl=`<canvas id="game" width="600" height="300"></canvas><script>
const c=document.querySelector('canvas'),gl=c.getContext('webgl');window.hits=0;let bx=80;
window.shift=()=>bx=350;c.onpointerdown=()=>hits++;
function render(){gl.disable(gl.SCISSOR_TEST);gl.clearColor(.05,.1,.2,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.enable(gl.SCISSOR_TEST);for(let y=0;y<8;y++)for(let x=0;x<8;x++){gl.scissor(bx+x*8,156+y*8,8,8);gl.clearColor(((x*73+y*37)%255)/255,((x*31+y*97)%255)/255,(x+y)%2,1);gl.clear(gl.COLOR_BUFFER_BIT);}requestAnimationFrame(render);}requestAnimationFrame(render);
</script>`;
(async()=>{
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(req.url==='/webgl'?webgl:req.url==='/frame'?html:'<iframe id="frame" style="width:680px;height:400px;margin:20px" src="http://localhost:'+server.address().port+'/frame"></iframe>');});
  await new Promise(r=>server.listen(0,r));let rec,browser;
  try{
    const flow={id:'visual',name:'位移点击验收',viewport:{width:1000,height:700},steps:[]};rec=new Recorder(flow);await rec.start();
    await rec.page.goto('http://127.0.0.1:'+server.address().port);const el=rec.page.frameLocator('#frame').locator('#game');await el.hover();await rec.page.screenshot();const box=await el.boundingBox();
    await rec.page.mouse.click(box.x+2+105,box.y+2+111);await sleep(250);await rec.stop();
    const step=flow.steps.find(s=>s.type==='canvas');assert.ok(step?.visual,'pre-click template recorded: '+JSON.stringify(flow.steps));assert.equal(step.frame.length,1);
    fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/visual-flow.json',JSON.stringify(flow));
    browser=await chromium.launch({channel:'chrome',headless:true});
    const messages=[];
    await Promise.all([[80,80],[350,170]].map(async([x,y])=>{
      const context=await browser.newContext({viewport:flow.viewport,deviceScaleFactor:1});const page=await context.newPage();await page.goto(flow.steps.find(s=>s.type==='goto').url);
      const frame=await (await page.locator('#frame').elementHandle()).contentFrame();await frame.waitForSelector('#game');await frame.evaluate(([x,y])=>draw(x,y),[x,y]);
      await replayStep(page,step,undefined,m=>messages.push(m));assert.equal(await frame.evaluate(()=>hits),1);
      await frame.evaluate(()=>draw(200,100,true));
      await replayStep(page,step);assert.deepEqual(await frame.evaluate(()=>lastPoint),{x:step.points[0].x*604-2,y:step.points[0].y*304-2});
      await frame.evaluate(()=>ctx.clearRect(0,0,1200,600));
      await replayStep(page,step);assert.deepEqual(await frame.evaluate(()=>lastPoint),{x:step.points[0].x*604-2,y:step.points[0].y*304-2});
      await replayStep(page,{...step,visual:null});
      await replayStep(page,{...step,visual:{...step.visual,image:'invalid PNG'}});
      const screenshot=page.screenshot;page.screenshot=async()=>{throw new Error('simulated capture failure')};
      try{await assert.rejects(replayStep(page,step),/simulated capture failure/);}finally{page.screenshot=screenshot;}
      const controller=new AbortController();controller.abort();await assert.rejects(replayStep(page,step,controller.signal),/STOPPED/);
      assert.equal(await frame.evaluate(()=>clicks),5,'fallback clicks execute, capture errors and cancellation do not');
      await context.close();
    }));
    assert.ok(messages.some(m=>m.startsWith('点击图像原位置校验通过')));assert.ok(messages.some(m=>m.startsWith('点击图像已重新定位')));
    const glFlow={id:'webgl',viewport:flow.viewport,steps:[]};rec=new Recorder(glFlow);await rec.start();await rec.page.goto('http://127.0.0.1:'+server.address().port+'/webgl');
    await rec.page.mouse.move(118,118);await sleep(160);await rec.page.mouse.click(118,118);await sleep(200);await rec.stop();
    const glStep=glFlow.steps.find(s=>s.type==='canvas');assert.ok(glStep?.visual,'WebGL default drawing-buffer capture: '+JSON.stringify(glStep));
    const glPage=await browser.newPage({viewport:flow.viewport});await glPage.goto(glFlow.steps.find(s=>s.type==='goto').url);await glPage.evaluate(()=>shift());await sleep(100);
    await replayStep(glPage,glStep,undefined,m=>assert.ok(m.startsWith('点击图像已重新定位')));assert.equal(await glPage.evaluate(()=>hits),1);
    fs.writeFileSync('test-results/visual-report.txt','PASS: pre-click capture before target disappears; scaled canvas; cross-origin iframe; concurrent isolated contexts with different seats; original and relocated clicks; ambiguous/missing/invalid templates click original coordinates; cancellation does not click.\n');
    fs.appendFileSync('test-results/visual-report.txt','PASS: WebGL default drawing buffer, animation-frame capture and relocated replay.\n');
    console.log('PASS visual replay, capture, iframe, scaling, concurrency, WebGL and visual fallback');
  }finally{await rec?.stop();await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
