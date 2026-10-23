const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const {Recorder,Runner,config,sleep}=require('../src/engine');
const {fixture}=require('./fixture');
const {fieldId}=require('../src/variables');
async function until(fn,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await sleep(100);}throw new Error('Condition timed out');}
(async()=>{
  const site=await fixture();let rec,run;
  const report=[];const dir=path.resolve('test-results');fs.mkdirSync(dir,{recursive:true});
  try{
    const flow={id:'e2e',name:'Vue / iframe / Canvas',viewport:{width:1280,height:720},steps:[]};
    rec=new Recorder(flow);rec.on('log',(level,message)=>console.log('[record]',level,message));await rec.start();
    const p=rec.page;await p.goto(site.url);await p.locator('#user').fill('test-user');await p.locator('#pass').fill('test-secret');await p.locator('#mode').selectOption('b');await p.locator('#login').click();
    const outer=p.frameLocator('#outer');await outer.locator('#outerText').fill('cross-origin-value');
    const inner=outer.frameLocator('#inner');await inner.locator('#innerText').fill('nested-value');await inner.locator('#agree').check();
    const canvas=inner.locator('#pad');const box=await canvas.boundingBox();
    await p.mouse.move(box.x+20,box.y+20);await p.mouse.down();
    for(let i=1;i<=12;i++){await p.mouse.move(box.x+20+i*12,box.y+20+i*3);await sleep(20);}
    await p.mouse.up();await canvas.press('ArrowRight');await p.locator('#badge').waitFor();
    await sleep(300);const badge=await p.locator('#badge').boundingBox();const screenshot=await rec.snapshot();fs.writeFileSync(path.join(dir,'recorded-page.png'),screenshot);
    rec.setTrusted({x:badge.x,y:badge.y,width:badge.width,height:badge.height});await rec.stop();
    assert.ok(flow.steps.some(s=>s.type==='fill'&&s.secret));
    assert.ok(flow.steps.some(s=>s.frame?.length===2&&s.type==='canvas'&&s.points.length>=5));
    assert.ok(flow.steps.some(s=>s.frame?.length===1&&s.type==='fill'));
    report.push('PASS: real Chrome recording of Vue login, select, password, cross-origin input, nested iframe checkbox, Canvas drag and keyboard');
    const outerField=flow.steps.find(s=>s.type==='fill'&&s.selector==='#outerText');
    const innerField=flow.steps.find(s=>s.type==='fill'&&s.selector==='#innerText');
    flow.variables={[fieldId(outerField)]:{mode:'template',template:'acct_{{instance}}_{{digits:8}}@example.com'},[fieldId(innerField)]:{mode:'template',template:'{{int:100000:999999}}'}};
    fs.writeFileSync(path.join(dir,'recorded-flow.json'),JSON.stringify(flow));
    const cfg=config({count:2,interval:1,failures:2,retries:2,grace:0,maxStepDelay:100,stepTimeout:7000});
    run=new Runner(flow,cfg,path.join(dir,'evidence'));const images=[];const logs=[];run.on('log',(l,m,image)=>{if(image)images.push({m,image});logs.push(m);console.log('[run]',l,m);});run.start();
    await until(()=>run.states.length===2&&run.states.every(s=>s.status==='正常运行'));
    assert.ok(images.length>=2);assert.ok(images.every(x=>x.image.startsWith('data:image/png;base64,')&&x.m.includes('可信图像匹配')));
    const generated=[];
    for(const b of run.browsers){const p=b.contexts()[0].pages()[0];const value=await p.frameLocator('#outer').locator('#outerText').inputValue();generated.push(value);assert.match(value,/^acct_[12]_\d{8}@example\.com$/);assert.match(await p.frameLocator('#outer').frameLocator('#inner').locator('#innerText').inputValue(),/^\d{6}$/);assert.equal(await p.frameLocator('#outer').frameLocator('#inner').locator('#agree').isChecked(),true);assert.equal(await p.frameLocator('#outer').frameLocator('#inner').locator('#keyResult').textContent(),'ArrowRight');}
    assert.notEqual(generated[0],generated[1]);report.push('PASS: whole-field random integer and partial-field random digits with instance IDs in real cross-origin inputs');
    report.push('PASS: two isolated headless Chrome instances replay all values and nested Canvas/keyboard; both image checks healthy');
    const victim=[...run.browsers][0];await victim.contexts()[0].pages()[0].locator('#badge').evaluate(el=>el.remove());
    await until(()=>logs.some(x=>x.includes('第 1 次恢复')));
    await until(()=>run.states.every(s=>s.status==='正常运行'));
    assert.ok(fs.existsSync(path.join(dir,'evidence','instance-1-last-failure.png'))||fs.existsSync(path.join(dir,'evidence','instance-2-last-failure.png')));
    report.push('PASS: removing trusted image triggers consecutive-failure detection, evidence capture and automatic recovery');
    assert.ok(!logs.join('\n').includes('test-secret'));assert.ok(!logs.join('\n').includes('cross-origin-value'));
    const stopAt=Date.now();await run.stop();assert.ok(Date.now()-stopAt<5000);assert.equal(run.browsers.size,0);assert.ok(run.states.every(s=>s.status==='已停止'));
    report.push('PASS: stop interrupts monitoring and closes only task browsers; logs redact form contents');
    run=new Runner({...flow,steps:[{type:'goto',url:site.url,page:0,frame:[],delay:60000}]},config({maxStepDelay:60000,ignoreRecordedDelays:false}),dir);run.start();await sleep(1000);const start=Date.now();await run.stop();assert.ok(Date.now()-start<5000);
    report.push('PASS: stop interrupts long replay wait');
    run=new Runner(flow,config({headless:false,interval:1,grace:0,stepTimeout:7000}),dir);
    const visibleImages=[];run.on('log',(l,m,image)=>{if(image)visibleImages.push(image);});run.start();
    await until(()=>run.states[0]?.status==='正常运行');await run.stop();assert.equal(visibleImages.length,0);
    assert.ok(images.some(x=>x.m.includes('连续失败')));
    report.push('PASS: headless healthy/failed monitoring emits PNG screenshots per instance; visible monitoring emits none');
    fs.writeFileSync(path.join(dir,'e2e-report.txt'),report.join('\n'));console.log(report.join('\n'));
  }finally{await run?.stop();await rec?.stop();await site.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
