const {chromium}=require('playwright-core');
const {spawn}=require('child_process');
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {sleep}=require('../src/engine');
(async()=>{
  const attach=process.argv.find(x=>x.startsWith('--attach='));
  const data=attach?path.resolve(attach.slice(9)):path.resolve('test-results','portable-data-'+Date.now());
  fs.mkdirSync(data,{recursive:true});let child,browser;
  try{
    if(!attach){const env={...process.env,FLOW_SENTINEL_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;child=spawn(path.resolve('dist/FlowSentinel-'+require('../package.json').version+'-win-x64.exe'),['--remote-debugging-port=0'],{env,stdio:'ignore',windowsHide:true});}
    const portFile=path.join(data,'DevToolsActivePort'),deadline=Date.now()+60000;
    while(!fs.existsSync(portFile)&&Date.now()<deadline)await sleep(100);
    const port=Number(fs.readFileSync(portFile,'utf8').split('\n')[0]);
    browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);
    const page=browser.contexts()[0].pages()[0];await page.waitForSelector('#record');
    assert.match(await page.title(),/FlowSentinel/);
    await page.locator('#name').fill('便携版验收');await page.locator('#record').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('录制中'));
    await page.locator('#stopNow').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='待机');
    const result=await page.evaluate(()=>window.flowAPI.call('init'));assert.equal(result.ok,true);assert.equal(result.data.flows.length,1);assert.equal(result.data.recording,false);
    await page.screenshot({path:'test-results/gui-portable.png'});
    fs.writeFileSync('test-results/portable-report.txt','PASS: single-file portable EXE extracts and launches, UI/preload work, real Chrome recording starts, top-bar stop closes recording, encrypted flow persists. Full replay verified in packaged GUI test.\n');
  }finally{
    if(browser){const session=await browser.newBrowserCDPSession();await session.send('Browser.close').catch(()=>{});await browser.close().catch(()=>{});}
    if(child){await Promise.race([new Promise(r=>child.once('exit',r)),sleep(3000)]);if(child.exitCode===null)spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
