const {_electron:electron}=require('playwright-core');
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {encode}=require('../src/flow-transfer');
(async()=>{
 const packaged=process.argv.includes('--packaged'),root=path.resolve('test-results','filter-'+Date.now());fs.mkdirSync(root,{recursive:true});
 const env={...process.env,FLOW_SENTINEL_TEST_DATA:root};delete env.ELECTRON_RUN_AS_NODE;
 let app;
 try{
  app=await electron.launch({executablePath:packaged?path.resolve('dist/win-unpacked/FlowSentinel.exe'):require('electron'),args:packaged?[]:['.'],env});
  const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>document.querySelector('#record')&&!document.querySelector('#record').disabled);
  assert.match(await page.textContent('#flowEmpty'),/暂无流程/);
  await page.fill('#name','登录 Alpha');await page.click('#record');await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('录制中'));
  await page.fill('#flowSearch','不存在');await page.click('#stopNow');await page.waitForFunction(()=>document.querySelector('#status').textContent==='待机');
  assert.equal(await page.locator('.flow-item').count(),0);assert.equal(await page.textContent('#flowCount'),'0 / 1');
  await page.fill('#flowSearch','  ALPHA  ');assert.equal(await page.locator('.flow-item').count(),1);
  const source=path.join(root,'input.fs');fs.writeFileSync(source,encode({version:1,id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',name:'导入 Beta',viewport:{width:1280,height:720},config:{},steps:[{type:'goto',url:'https://example.com',page:0,frame:[]}],trusted:null},'1.2.7'));
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},source);
  await page.click('#importFlow');await page.waitForSelector('#importDialog[open]');await page.click('#confirmImport');await page.waitForFunction(()=>!document.querySelector('#importDialog').open);
  assert.equal(await page.textContent('#flowCount'),'1 / 2');assert.equal(await page.textContent('#flowTitle'),'导入 Beta');
  await page.fill('#flowSearch','ｂｅｔａ');assert.equal(await page.locator('.flow-item').count(),1);assert.match(await page.locator('.flow-item').textContent(),/导入 Beta/);
  await page.fill('#flowSearch','登录');await page.locator('.flow-item').click();assert.equal(await page.textContent('#flowTitle'),'登录 Alpha');
  await page.fill('#flowSearch','<script>');assert.equal(await page.locator('.flow-item').count(),0);assert.equal(await page.isVisible('#flowEmpty'),true);assert.equal(await page.textContent('#flowTitle'),'登录 Alpha');
  await page.press('#flowSearch','Escape');assert.equal(await page.locator('.flow-item').count(),2);
  await page.fill('#flowSearch','   ');assert.equal(await page.locator('.flow-item').count(),2);await page.click('#clearFlowSearch');assert.equal(await page.inputValue('#flowSearch'),'');
  for(const theme of ['light','dark']){await page.selectOption('#themeSelect',theme);await page.fill('#flowSearch','登录');await page.screenshot({path:path.join(root,theme+'.png')});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
  assert.deepEqual(errors,[]);console.log('PASS filter smoke '+(packaged?'packaged':'source')+' '+root);
 }finally{if(app)await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
