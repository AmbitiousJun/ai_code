const assert=require('node:assert/strict'),http=require('http'),fs=require('fs');
const {Runner,sleep}=require('../src/engine');
const {PNG}=require('pngjs');
async function until(fn,timeout=25000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await sleep(50);}throw new Error('Timed out');}
(async()=>{
  let hits=0,run;
  const server=http.createServer((req,res)=>{
    if(req.url==='/asset.js'){
      hits++;res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'public, max-age=3600'});
      res.end('window.assetReady=true;');return;
    }
    res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
    res.end('<!doctype html><body style="margin:0;background:#fff"><script src="/asset.js"></script><button onclick="window.open(\'/popup\')">popup</button></body>');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+server.address().port;
  const png=new PNG({width:20,height:20});png.data.fill(255);
  const flow={viewport:{width:400,height:300},steps:[{type:'goto',url,page:0}],trusted:{page:0,rect:{x:100,y:100,width:20,height:20},image:PNG.sync.write(png).toString('base64')}};
  try{
    run=new Runner(flow,{count:2,interval:1,failures:1,retries:8,grace:0,actionInterval:0});
    const logs=[];run.on('log',(l,m)=>logs.push(m));run.start();
    await until(()=>run.states.length===2&&run.states.every(s=>s.status==='正常运行'));
    assert.equal(hits,2,'independent instances fetch their own cache');
    const [browser,other]=[...run.browsers],context=browser.contexts()[0],page=context.pages()[0];
    const listenerCount=context.listenerCount('page');
    await page.evaluate(()=>{localStorage.setItem('retained','yes');document.cookie='retained=yes';});
    assert.equal(await other.contexts()[0].pages()[0].evaluate(()=>localStorage.getItem('retained')),null);
    await page.locator('button').click();await until(()=>context.pages().length===2);
    const oldPages=context.pages();
    await page.evaluate(()=>document.body.style.background='#000');
    await until(()=>oldPages.every(p=>p.isClosed()));
    await until(()=>run.states.every(s=>s.status==='正常运行')&&context.pages().length===1);
    assert.ok(run.browsers.has(browser));assert.equal(browser.contexts()[0],context);
    assert.equal(hits,2,'recovery reuses cached asset without a server request');
    assert.equal(context.listenerCount('page'),listenerCount);
    assert.equal(await context.pages()[0].evaluate(()=>localStorage.getItem('retained')),'yes');
    assert.match(await context.pages()[0].evaluate(()=>document.cookie),/retained=yes/);
    // A closed target page also recovers within the same context.
    await context.pages()[0].close();
    await until(()=>context.pages().length===1&&run.states.every(s=>s.status==='正常运行'));
    assert.equal(hits,2);assert.equal(context.listenerCount('page'),listenerCount);
    // Losing the context requires a fresh browser, while the other instance survives.
    await context.close();
    await until(()=>!run.browsers.has(browser)&&run.browsers.size===2&&run.states.every(s=>s.status==='正常运行'));
    assert.equal(hits,3);assert.ok(run.browsers.has(other));
    const replacement=[...run.browsers].find(b=>b!==other);await replacement.close();
    await until(()=>!run.browsers.has(replacement)&&run.browsers.size===2&&run.states.every(s=>s.status==='正常运行'));
    assert.equal(hits,4);
    // Stop during recovery backoff closes the retained browser immediately.
    const last=[...run.browsers].find(b=>b!==other),lastPage=last.contexts()[0].pages()[0];
    await lastPage.evaluate(()=>document.body.style.background='#000');
    await until(()=>run.states.some(s=>s.status==='准备恢复'));
    const at=Date.now();await run.stop();assert.ok(Date.now()-at<5000);assert.equal(run.browsers.size,0);
    assert.ok(run.states.every(s=>s.status==='已停止'));
    // Exhausting retries still releases retained browser resources.
    const failing=structuredClone(flow);failing.trusted.image=PNG.sync.write(new PNG({width:20,height:20})).toString('base64');
    run=new Runner(failing,{interval:1,failures:1,retries:1,grace:0,actionInterval:0});await run.start();
    assert.equal(run.states[0].status,'需要人工处理');assert.equal(run.browsers.size,0);
    fs.mkdirSync('test-results',{recursive:true});
    fs.writeFileSync('test-results/cache-report.txt','PASS: real Chrome HTTP cache reuse across page recovery; popup cleanup; cookie/localStorage retention and instance isolation; page listener count stable; closed page recovery; context/browser loss fallback; stop during backoff; retry exhaustion cleanup.\n');
    console.log('Cache recovery E2E PASS');
  }finally{await run?.stop();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
