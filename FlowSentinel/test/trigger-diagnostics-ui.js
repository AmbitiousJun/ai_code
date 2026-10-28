const {_electron:electron}=require('playwright-core');
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),{PNG}=require('pngjs');
const {fixture}=require('./subflows-e2e');
(async()=>{const site=await fixture(),packaged=process.argv.includes('--packaged');let app;
 const data=path.resolve('test-results','trigger-diagnostics-'+Date.now());fs.mkdirSync(path.join(data,'flows'),{recursive:true});
 try{
  const flow=site.flow;flow.config.headless=false;const image=new PNG({width:40,height:41});for(let i=0;i<image.data.length;i+=4){image.data[i]=255;image.data[i+3]=255;}
  flow.subflows=[{id:'diagnostic',name:'触发图诊断',trigger:{type:'image',trusted:{rect:{x:8,y:8,width:40,height:41},image:PNG.sync.write(image).toString('base64'),page:0}},steps:[{type:'click',selector:'#add',page:0}]}];
  const env={...process.env,FLOW_SENTINEL_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:packaged?path.resolve('dist/win-unpacked/FlowSentinel.exe'):require('electron'),args:packaged?[]:['.'],env,timeout:60000});
  await app.evaluate(({safeStorage},{flow,data})=>{const require=process.mainModule.require.bind(process.mainModule);require('fs').writeFileSync(require('path').join(data,'flows',flow.id+'.flow'),safeStorage.encryptString(JSON.stringify(flow)));},{flow,data});
  const page=await app.firstWindow();await page.reload();const started=await page.evaluate(flow=>window.flowAPI.call('start',{id:flow.id,config:flow.config}),flow);assert.equal(started.ok,true);
  const entry=page.locator('#logs > div').filter({hasText:'截图条件未满足'}).first();await entry.waitFor({timeout:30000});assert.match(await entry.textContent(),/已扫描当前页面视口/);
  const thumbnail=entry.locator('img');await thumbnail.waitFor();const dims=await thumbnail.evaluate(async i=>{await i.decode();return [i.naturalWidth,i.naturalHeight]});assert.deepEqual(dims,[88,41]);
  await entry.locator('button').click();await page.locator('#logImageDialog').waitFor({state:'visible'});assert.match(await page.locator('#logImageTitle').textContent(),/左：录制模板/);await page.locator('#closeLogImage').click();
  await page.evaluate(()=>window.flowAPI.call('stop'));await page.reload();await page.locator('.log-screenshot').first().waitFor();
  assert.ok(!fs.readFileSync(path.join(data,'activity.log'),'utf8').includes('data:image'));
  console.log('PASS trigger diagnostics UI',packaged?'packaged':'source');
 }finally{await app?.close();await site.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
