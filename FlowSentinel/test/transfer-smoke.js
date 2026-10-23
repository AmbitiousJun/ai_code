const {_electron:electron}=require('playwright-core');
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {encode}=require('../src/flow-transfer');
(async()=>{
 const packaged=process.argv.includes('--packaged'),root=path.resolve('test-results','transfer-'+Date.now());fs.mkdirSync(root,{recursive:true});
 const source=path.join(root,'source.fs'),output=path.join(root,'export.fs');
 const original={version:1,id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',name:'跨机器流程',viewport:{width:1280,height:720},config:{},steps:[{type:'goto',url:'https://example.com',page:0,frame:[]},{type:'fill',selector:'#password',value:'test-secret',secret:true}],trusted:null};fs.writeFileSync(source,encode(original,'1.2.7'));
 let app;
 async function launch(dir){const env={...process.env,FLOW_SENTINEL_TEST_DATA:path.join(root,dir)};delete env.ELECTRON_RUN_AS_NODE;app=await electron.launch({executablePath:packaged?path.resolve('dist/win-unpacked/FlowSentinel.exe'):require('electron'),args:packaged?[]:['.'],env});const page=await app.firstWindow();await page.waitForFunction(()=>document.querySelector('#importFlow')&&!document.querySelector('#importFlow').disabled);return page;}
 async function open(file){await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);}
 try{
 let page=await launch('first');await open(source);await page.click('#importFlow');await page.waitForSelector('#importDialog[open]');assert.equal(await page.inputValue('#importName'),original.name);await page.click('#confirmImport');await page.waitForFunction(()=>!document.querySelector('#importDialog').open);
 const first=(await page.evaluate(()=>window.flowAPI.call('list'))).data[0];assert.notEqual(first.id,original.id);
 await page.click('#importFlow');await page.waitForSelector('#importDialog[open]');assert.equal(await page.isDisabled('#confirmImport'),true);assert.match(await page.textContent('#importNameError'),/已存在/);await page.fill('#importName','副本');assert.equal(await page.isDisabled('#confirmImport'),false);
 const duplicate=await page.evaluate(name=>window.flowAPI.call('confirmImport',{name}),original.name);assert.equal(duplicate.ok,false);
 await page.click('#cancelImport');await page.waitForFunction(()=>!document.querySelector('#importDialog').open);assert.equal((await page.evaluate(()=>window.flowAPI.call('list'))).data.length,1);
 await app.evaluate(({dialog},output)=>{dialog.showSaveDialog=async(_win,options)=>{global.exportOptions=options;return {canceled:false,filePath:output};};},output);await page.click('#exportFlow');await page.waitForFunction(()=>document.querySelector('#notice').textContent==='流程已导出');assert.deepEqual(JSON.parse(fs.readFileSync(output)).flow.steps,original.steps);
 const paths=await app.evaluate(({app})=>({file:global.exportOptions.defaultPath,downloads:app.getPath('downloads')}));assert.equal(path.dirname(paths.file),paths.downloads);
 await app.close();page=await launch('second');await open(output);await page.click('#importFlow');await page.waitForSelector('#importDialog[open]');await page.fill('#importName','另一台机器');await page.click('#confirmImport');await page.waitForFunction(()=>!document.querySelector('#importDialog').open);assert.equal((await page.evaluate(()=>window.flowAPI.call('list'))).data[0].name,'另一台机器');
 const bad=JSON.parse(fs.readFileSync(output));bad.protocolVersion=2;bad.minImporterVersion='2.0.0';const invalid=path.join(root,'new.fs');fs.writeFileSync(invalid,JSON.stringify(bad));await open(invalid);await page.click('#importFlow');await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('最低导入版本'));assert.equal(await page.locator('#importDialog').getAttribute('open'),null);
 await page.screenshot({path:path.join(root,'result.png')});console.log('PASS: import/export, default Downloads path, duplicate/rename/cancel, new identity, separate encrypted stores, incompatible protocol rejection'+(packaged?' (packaged)':''));
 }finally{await app?.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
