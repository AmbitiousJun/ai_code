const {_electron:electron}=require('playwright-core');
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {fixture}=require('./subflows-e2e');
(async()=>{
 const site=await fixture(),packaged=process.argv.includes('--packaged');let app;
 const data=path.resolve('test-results','subflows-ui-'+Date.now());fs.mkdirSync(path.join(data,'flows'),{recursive:true});
 try{
  const env={...process.env,FLOW_SENTINEL_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:packaged?path.resolve('dist/win-unpacked/FlowSentinel.exe'):require('electron'),args:packaged?[]:['.'],env,timeout:60000});
  await app.evaluate(({app,safeStorage},{flow,data})=>{
    const require=process.mainModule.require.bind(process.mainModule);
    require('fs').writeFileSync(require('path').join(data,'flows',flow.id+'.flow'),safeStorage.encryptString(JSON.stringify(flow)));
    const {Recorder}=require(require('path').join(app.getAppPath(),'src/engine.js')),start=Recorder.prototype.start;
    Recorder.prototype.start=async function(){globalThis.testRecorder=this;return start.call(this);};
  },{flow:site.flow,data});
  const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.reload();
  await page.getByRole('button',{name:'子流程验收',exact:false}).click();await page.locator('#startSubflow').click();
  await page.locator('#subCondition').waitFor({state:'visible'});assert.equal(await page.locator('#start').isDisabled(),true);
  const blocked=await page.evaluate(id=>window.flowAPI.call('start',{id}),site.flow.id);assert.equal(blocked.ok,false);
  await page.locator('#cronPreset').selectOption('daily');await page.locator('#cronTime').fill('12:34:56');assert.equal(await page.locator('#cronExpression').inputValue(),'56 34 12 * * *');
  await page.locator('#cronPreset').selectOption('seconds');await page.locator('#cronEvery').fill('1');assert.equal(await page.locator('#cronExpression').inputValue(),'*/1 * * * * *');
  for(const theme of ['dark','light']){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    const styles=await page.locator('#cronPreset').evaluate(el=>({height:el.getBoundingClientRect().height,radius:getComputedStyle(el).borderRadius}));
    assert.ok(styles.height>=40);assert.equal(styles.radius,'6px');
    await page.locator('#subCondition').screenshot({path:'test-results/subflow-timer-'+theme+(packaged?'-packaged':'')+'.png'});
  }
  await page.locator('#cronPreset').selectOption('custom');await page.locator('#cronExpression').fill('bad');await page.locator('#subCron').click();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('crontab'));
  await page.locator('#cronExpression').fill('* * * * * *');await page.locator('#subCron').click();await page.locator('#subRecording').waitFor({state:'visible'});
  await page.locator('#finishSubflow').click();await page.locator('#subReview').waitFor({state:'visible'});await page.locator('#saveSubflow').click();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('至少'));
  await page.locator('#resumeSubflow').click();
  await app.evaluate(async()=>{await globalThis.testRecorder.pages.get(0).locator('#value').fill('private-sub-value');await globalThis.testRecorder.pages.get(0).locator('#add').click();});
  await page.locator('#finishSubflow').click();await page.locator('#subReview').waitFor({state:'visible'});await page.locator('#subName').fill('定时子流程');await page.locator('#saveSubflow').click();await page.locator('#nextSubflow').waitFor({state:'visible'});
  let result=await page.evaluate(()=>window.flowAPI.call('list'));assert.equal(result.data[0].subflows.length,1);assert.ok(!JSON.stringify(result).includes('private-sub-value'));
  await app.evaluate(async()=>{globalThis.previousPage=globalThis.testRecorder.pages.get(0);await globalThis.previousPage.locator('#value').fill('manual-position');await globalThis.previousPage.evaluate(()=>window.keepScreen='preserved');});
  await page.locator('#nextSubflow').click();await page.locator('#subCondition').waitFor({state:'visible'});
  assert.deepEqual(await app.evaluate(async()=>{const r=globalThis.testRecorder,p=r.pages.get(0);return {same:p===globalThis.previousPage,value:await p.locator('#value').inputValue(),marker:await p.evaluate(()=>window.keepScreen),steps:r.flow.steps.length};}),{same:true,value:'manual-position',marker:'preserved',steps:0});
  await page.locator('#subImage').click();await page.locator('#captureDialog').waitFor({state:'visible'});await page.keyboard.press('Escape');await page.locator('#captureDialog').waitFor({state:'hidden'});
  await page.locator('#subImage').click();await page.locator('#captureDialog').waitFor({state:'visible'});
  const box=await page.locator('#captureCanvas').boundingBox();await page.mouse.move(box.x+10,box.y+10);await page.mouse.down();await page.mouse.move(box.x+55,box.y+40);await page.mouse.up();await page.locator('#saveTrusted').click();await page.locator('#subRecording').waitFor({state:'visible'});
  await app.evaluate(async()=>{await globalThis.testRecorder.pages.get(0).locator('#add').click();});
  await page.locator('#finishSubflow').click();await page.locator('#saveSubflow').click();await page.locator('#nextSubflow').waitFor({state:'visible'});
  await page.screenshot({path:'test-results/subflows-ui'+(packaged?'-packaged':'')+'.png',fullPage:true});
  await page.locator('#stopSubflow').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='待机');
  const saved=await app.evaluate(({safeStorage},data)=>JSON.parse(safeStorage.decryptString(process.mainModule.require('fs').readFileSync(process.mainModule.require('path').join(data,'flows','11111111-1111-4111-8111-111111111111.flow')))),data);
  const transfer=require('../src/flow-transfer');assert.deepEqual(transfer.decode(transfer.encode(saved,'1.3.2'),'1.3.2').subflows,saved.subflows);
  await page.locator('#startSubflow').click();await page.locator('#subCondition').waitFor({state:'visible'});await app.evaluate(async()=>globalThis.testRecorder.browser.close());await page.waitForFunction(()=>document.querySelector('#status').textContent==='待机');
  result=await page.evaluate(()=>window.flowAPI.call('list'));assert.equal(result.data[0].subflows.length,2);
  await page.locator('#subflowList summary').first().click();page.once('dialog',d=>d.accept());await page.locator('.delete-subflow').first().click();await page.waitForFunction(()=>document.querySelectorAll('#subflowList details').length===1);
  const output=path.join(data,'with-subflows.fs');
  await app.evaluate(({dialog},output)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:output});dialog.showOpenDialog=async()=>({canceled:false,filePaths:[output]});},output);
  await page.locator('#exportFlow').click();await page.waitForFunction(()=>document.querySelector('#notice').textContent==='流程已导出');
  assert.equal(JSON.parse(fs.readFileSync(output,'utf8')).minImporterVersion,'1.3.0');
  await page.locator('#importFlow').click();await page.locator('#importDialog').waitFor({state:'visible'});await page.locator('#importName').fill('导入子流程验收');await page.locator('#confirmImport').click();await page.locator('#importDialog').waitFor({state:'hidden'});
  assert.equal(await page.locator('#subflowList details').count(),1);
  await page.locator('#startSubflow').click();await page.locator('#subCondition').waitFor({state:'visible'});await page.locator('#stopSubflow').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='待机');
  assert.deepEqual(errors,[]);
  fs.writeFileSync('test-results/subflows-ui'+(packaged?'-packaged':'')+'-report.txt','PASS: real Electron/Chrome, mutually exclusive recording, cron editor/validation, action requirement, screenshot/cancel, save/preview/delete, multiple drafts, manual close, persistence and transfer.\n');console.log('PASS subflows UI',packaged?'packaged':'source');
 }finally{await app?.close();await site.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
