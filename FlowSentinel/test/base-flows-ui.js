const {_electron:electron}=require('playwright-core');
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),http=require('http');
const {fieldId}=require('../src/variables');
(async()=>{
 const root=path.resolve('test-results','base-'+Date.now());fs.mkdirSync(root,{recursive:true});
 const seen=[];const server=http.createServer((req,res)=>{if(req.url.startsWith('/value/')){seen.push(decodeURIComponent(req.url.slice(7)));res.end('ok');return;}res.setHeader("Content-Type","text/html; charset=utf-8");res.end(`<!doctype html><input id="name"><script>document.querySelector('input').oninput=e=>fetch('/value/'+encodeURIComponent(e.target.value))</script>`);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let app;try{
 const env={...process.env,FLOW_SENTINEL_TEST_DATA:root};delete env.ELECTRON_RUN_AS_NODE;
 const packaged=process.argv.includes('--packaged');app=await electron.launch({executablePath:packaged?path.resolve('dist/win-unpacked/FlowSentinel.exe'):require('electron'),args:packaged?[]:['.'],env});
 const page=await app.firstWindow();await page.waitForFunction(()=>document.querySelector('#record')&&!document.querySelector('#record').disabled);
 const fill={type:'fill',page:0,frame:[],selector:'#name',value:'private-value',delay:0};
 const base={version:1,id:require('crypto').randomUUID(),kind:'base',name:'基础登录',viewport:{width:900,height:650},config:{grace:0,actionInterval:0},steps:[{type:'goto',url:'http://127.0.0.1:'+server.address().port,page:0,frame:[],delay:0},fill],variables:{[fieldId(fill)]:{mode:'template',template:'base_{{instance}}'}},trusted:null};
 await app.evaluate(({app,safeStorage},base)=>{const require=process.mainModule.require.bind(process.mainModule);const {Store}=require(require('path').join(app.getAppPath(),'src/store'));new Store(require('path').join(app.getPath('userData'),'flows'),safeStorage).save(base);},base);
 await page.reload();await page.waitForFunction(()=>document.querySelector('#baseId').options.length===2);
 await page.click('#baseTab');await page.locator('.flow-item').click();assert.equal(await page.isVisible('#start'),false);assert.equal(await page.isVisible('#exportFlow'),false);assert.equal(await page.isVisible('#subflowsPanel'),false);
 for(const action of ['start','startSubflow','exportFlow'])assert.equal((await page.evaluate(({action,id})=>window.flowAPI.call(action,{id}),{action,id:base.id})).ok,false);
 for(const id of ['threshold','stepTimeout','maxStepDelay','actionInterval','checkpointTimeout','ignoreRecordedDelays'])assert.equal(await page.isVisible('#'+id),true,id);
 for(const id of ['radius','count','interval','failures','retries','grace','headless','mute','noThrottle','chromePath','chooseChrome'])assert.equal(await page.isVisible('#'+id),false,id);
 assert.equal(await page.textContent('#configTitle'),'执行配置');
 await page.click('#fullTab');assert.equal(await page.isVisible('#grace'),true);await page.fill('#name','完整流程');await page.selectOption('#baseId',base.id);await page.fill('#grace','0');await page.click('#record');await page.waitForFunction(()=>document.querySelector('#status').textContent==='● 录制中');
 assert.deepEqual(seen,['base_1']);await page.click('#stopNow');await page.waitForFunction(()=>document.querySelector('#status').textContent==='待机');
 let list=(await page.evaluate(()=>window.flowAPI.call('list'))).data;const full=list.find(f=>f.kind==='full');assert.equal(full.steps.length,2);assert.equal(full.viewport.width,900);assert.equal(full.baseFlow.name,base.name);assert.equal(JSON.stringify(full).includes('private-value'),false);
 const output=path.join(root,'bundle.fs');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},output);
 await page.click('#exportFlow');await page.waitForFunction(()=>document.querySelector('#notice').textContent==='流程已导出');const bundle=JSON.parse(fs.readFileSync(output));assert.equal(bundle.minImporterVersion,'1.4.0');assert.deepEqual(bundle.flow.baseFlow.steps,base.steps);
 await page.click('#importFlow');await page.waitForSelector('#importDialog[open]');await page.fill('#importName','完整副本');assert.equal(await page.isDisabled('#confirmImport'),true);await page.fill('#importBaseName','基础副本');await page.click('#confirmImport');await page.waitForFunction(()=>!document.querySelector('#importDialog').open);
 list=(await page.evaluate(()=>window.flowAPI.call('list'))).data;assert.equal(list.length,4);const imported=list.find(f=>f.name==='完整副本'),importBase=list.find(f=>f.name==='基础副本');assert.equal(imported.baseFlow.id,importBase.id);assert.notEqual(importBase.id,base.id);
 await page.click('#baseTab');await page.click('#newFlow');assert.equal(await page.isVisible('#threshold'),true);assert.equal(await page.isVisible('#mute'),false);await page.fill('#name','新基础');await page.click('#record');await page.waitForFunction(()=>document.querySelector('#status').textContent==='● 录制中');assert.equal((await page.evaluate(()=>window.flowAPI.call('snapshot'))).ok,false);await page.click('#stopNow');await page.waitForFunction(()=>document.querySelector('#status').textContent==='待机');
 const preparing=page.evaluate(id=>window.flowAPI.call('record',{name:'停止准备',kind:'full',baseId:id,config:{grace:10}}),base.id);
 await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('准备中'));
 const stopped=await page.evaluate(()=>window.flowAPI.call('stopRecord'));assert.equal(stopped.ok,true);assert.equal((await preparing).ok,false);
 assert.equal((await page.evaluate(()=>window.flowAPI.call('init'))).data.recording,false);
 for(const theme of ['light','dark']){await page.selectOption('#themeSelect',theme);await page.screenshot({path:path.join(root,theme+'.png')});}
 console.log('PASS base workflow, inherited templates, no duplicate recording, restrictions, bundled export/import rename '+root);
 }finally{await app?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});

