const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runManual, ManualPrompt } = require("../src/manual");
const { plan, defaults } = require("../src/config");
const { Cache } = require("../src/cache");
const { chromium } = require("playwright");

test("手动回放立即检查下一回调，未就绪时重试并只成功调用一次", async () => {
  const { replay } = require("../src/manual");
  const calls = [];
  let attempts = 0;
  const frame = {evaluate: async (_, step) => {
    if (step.name === "second" && ++attempts === 1) return false;
    calls.push(step.name);
    return true;
  }};
  const page = new (require("node:events").EventEmitter)();
  page.mainFrame = () => frame;
  const steps = ["first", "second"].map(name => ({ name, kind:"CocosBinding", route:[] }));
  const active = new Set(["slow download"]);
  await replay(page, {steps, frames:[]}, AbortSignal.timeout(3000), event => {
    if (event.message.includes("第 2 步")) active.clear();
  }, {active, paths:new Set(), lastGET:0, quietMs:0});
  assert.equal(attempts, 2);
  assert.deepEqual(calls, ["first", "second"]);
});

test("手动任务先录完两组，多路径从独立入口试播，无标识操作后继续录制，跳过组仍加载", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"gt-manual-"));
  const cache = new Cache(dir);
  const server = http.createServer((req,res) => {
    res.setHeader("content-type","text/html");
    if (req.url.startsWith("/panel/")) return res.end('<button id="next" onclick="document.body.insertAdjacentHTML(\'beforeend\',\'<iframe src=/leaf></iframe>\')">Next</button>');
    if (req.url === "/leaf") return res.end("leaf");
    res.end(`<canvas width="80" height="80"></canvas>
      <button id="help" onclick="openPanel(this.id)">Help</button>
      <button id="bonus" onclick="openPanel(this.id)">Bonus</button>
      <script>function openPanel(id){
        if(sessionStorage.used) throw Error("stale session");
        sessionStorage.used = "1";
        document.body.insertAdjacentHTML("beforeend",'<iframe src="/panel/'+id+'"></iframe>');
      }</script>`);
  });
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(()=>{server.close();cache.db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const cfg = {...defaults, exploreMode:"manual", waitSeconds:1, actions:0,
    variables:{gameId:["2","3"]}, template:"http://127.0.0.1:"+server.address().port+"/?id={gameId}",
    selected:["win","small"], custom:[{id:"small",name:"small",engine:"chromium",viewport:{width:800,height:600}}]};
  const rows = plan(cfg);
  assert.deepEqual(rows.map(r=>r.phase),["record","record","replay","replay","replay","replay"]);
  let browser, capture, previewPage;
  const headless = [];
  const launch = chromium.launch.bind(chromium);
  t.mock.method(chromium,"launch",async opts => {
    headless.push(opts.headless);
    return browser = await launch(opts);
  });
  const signal = new AbortController().signal;
  const groups = new Map(), events = [];
  const commands = ["record","help","reset","record","bonus","trial","record","bonus","done","done"];
  let interruptTrial = false, interruptedPage;
  for (const row of rows) {
    if (!groups.has(row.group)) groups.set(row.group,[]);
    const library = groups.get(row.group);
    const prompt = new ManualPrompt(signal,()=>{});
    const ask = prompt.ask.bind(prompt);
    prompt.ask = async (view,allowed) => {
      if (!view.note) assert.ok((await capture()).length > 0, "初始后台预览有画面");
      const pending = ask(view,allowed);
      const command = commands.shift();
      if (["help","bonus"].includes(command)) {

        const page = browser.contexts()[0].pages()[0];
        assert.equal(page, previewPage);
        assert.equal(await page.evaluate(() => window.previewMarker), "preview");
        if (command === "help") {
          await page.locator("canvas").click();
          await page.waitForFunction(() => document.body.textContent.includes("可继续录入"));
          assert.match(prompt.view.note,/可能无法完整重放/);
        }
        await page.locator("#"+command).click();
        await page.frameLocator("iframe").locator("body").waitFor();
        if (command === "bonus") {
          await page.frameLocator("iframe").locator("#next").click();
          await page.frameLocator("iframe").frameLocator("iframe").locator("body").waitFor();
        }
        await page.waitForTimeout(280);
        prompt.submit({token:prompt.view.token,action:"finish"});
      } else {
        if (command === "record") {
          previewPage = browser.contexts()[0].pages()[0];
          if (interruptedPage) {
            assert.notEqual(previewPage, interruptedPage);
            assert.equal(await previewPage.locator("iframe").count(), 0);
            assert.equal(library.length, 1);
          }
          await previewPage.evaluate(() => { window.previewMarker = "preview"; });
        }
        if (command === "trial") { assert.equal(library.length,2,view.note); interruptTrial = true; }
        prompt.submit({token:prompt.view.token,action:command,index:1});
      }
      return pending;
    };
    const result = await runManual(row,cfg,cache,signal,e=>{
      events.push(e);
      if (interruptTrial && e.message?.startsWith("已调用第 1 步")) {
        interruptTrial = false;
        interruptedPage = browser.contexts()[0].pages()[0];
        prompt.submit({token:prompt.view.token,action:"rerecord"});
      }
    },library,path.join(dir,"end.png"),fn => { capture = fn; },prompt);
    assert.equal(browser.isConnected(), false, "环境结束后浏览器已关闭");
    if (row.phase === "replay") assert.equal(result.frames,row.group==="2"?3:0);
  }
  assert.deepEqual(groups.get("2").map(p=>p.steps[0].selector),["button[id=help]","button[id=bonus]"]);
  assert.equal(groups.get("2")[0].skipped,1);
  assert.equal(groups.get("3").length,0);
  assert.ok(headless.every(Boolean), "录制复用后台预览实例");
  assert.ok(headless[0]);
  assert.deepEqual(commands,[]);
  assert.ok(!events.some(e=>e.message?.includes("失败")));
});

test("移动和缩放后唯一匹配按钮图样，重复图样拒绝点击", () => {
  const {match} = require("../src/pixel-button");
  const rgb = Buffer.alloc(20*20*3);
  for (let y=0;y<20;y++) for (let x=0;x<20;x++) {
    const p=3*(y*20+x);
    rgb[p]=x<10?220:30; rgb[p+1]=y<12?35:190; rgb[p+2]=(x+y)%7*24;
  }
  const template={rgb:rgb.toString("base64"),width:40,height:40,viewWidth:200,viewHeight:100};
  const image={width:300,height:150,data:Buffer.alloc(300*150*4)};
  const draw=left=>{
    for (let y=0;y<60;y++) for (let x=0;x<60;x++) {
      const p=3*(Math.floor(y/3)*20+Math.floor(x/3));
      rgb.copy(image.data,4*((y+18)*300+left+x),p,p+3);
    }
  };
  draw(130);
  const found=match(image,template);
  assert.ok(found && Math.abs(found.x-160)<3 && Math.abs(found.y-48)<3);
  for (let i=0;i<image.data.length;i+=4) image.data[i]+=6;
  assert.equal(match(image,template,100),null);
  assert.ok(match(image,template,98));
  draw(20);
  assert.equal(match(image,template),null);
});

test("框选动作等待唯一图案，超时跳过，出现后点击当前位置", async () => {
  const {replay} = require("../src/manual");
  const {installManualActions} = require("../src/manual-actions");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({viewport:{width:400,height:200}});
    await page.setContent('<style>button,div{position:absolute;top:40px;width:60px;height:60px;border:0;padding:0;background:linear-gradient(to bottom,#57b 0 20%,transparent 20% 80%,#ca6 80%),linear-gradient(90deg,#e31 50%,#254 50%)}</style><button id="go" style="left:40px" onclick="window.clicks++"></button><div style="left:150px"></div>');
    await page.evaluate(installManualActions);
    await page.evaluate(()=>{window.clicks=0;});
    const rgb=Buffer.alloc(1200);
    for (let i=0;i<400;i++) rgb.set(i<80?[85,119,187]:i>=320?[204,170,102]:i%20<10?[238,51,17]:[34,85,68],i*3);
    const path={steps:[{kind:"DOMAction",selector:"#go",name:"按钮",route:[],
      pixels:{rgb:rgb.toString("base64"),width:60,height:60,viewWidth:400,viewHeight:200}}],frames:[]};
    const events=[];
    const play=(pixelTimeout=2)=>replay(page,path,new AbortController().signal,e=>events.push(e),{active:new Set(),paths:new Set(),lastGET:0,quietMs:100}, "en-US", {pixelTimeout});
    await assert.rejects(play(1), /等待唯一截图匹配超时/);
    assert.equal(await page.evaluate(()=>window.clicks),0);
    await page.evaluate(()=>{document.querySelector("div").remove();const b=document.querySelector("button");b.id="moved";b.style.left="224px";b.hidden=true;setTimeout(()=>b.hidden=false,400);});
    await play();
    assert.equal(await page.evaluate(()=>window.clicks),1);
    assert.ok(events.some(e=>e.message.includes("像素图")));
  } finally {await browser.close();}
});
test("无绑定 Cocos 触摸节点在子 frame 移位后以真实触屏操作重放", async () => {
  const {installManualActions} = require("../src/manual-actions");
  const {replay} = require("../src/manual");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({hasTouch:true,viewport:{width:640,height:480}});
    const steps=[];
    await page.exposeBinding("__gtReport",(_,s)=>{ steps.push(s); });
    async function scene(left) {
      await page.setContent('<iframe name="game" style="position:absolute;left:72px;top:31px;width:320px;height:220px"></iframe>');
      const frame=page.frame({name:"game"});
      await frame.setContent('<style>*{margin:0}</style><canvas width="300" height="200"></canvas>');
      await frame.evaluate(left=>{
        const canvas=document.querySelector("canvas");
        class Node {
          dispatchEvent(event) { if (event.type==="touchend" && event.trusted) window.taps++; }
        }
        const target=Object.assign(new Node(),{name:"奖励",activeInHierarchy:true,
          getBoundingBoxToWorld:()=>({x:left,y:80,width:40,height:40})});
        const root={children:[target]};
        target.parent=root;
        window.cc={Node,game:{canvas},director:{getScene:()=>root},v2:(x,y)=>({x,y}),
          view:{getScaleX:()=>1,getScaleY:()=>1,getViewportRect:()=>({x:0,y:0,width:300,height:200})}};
        window.taps=0;
        canvas.addEventListener("touchend",e=>{
          const t=e.changedTouches[0], r=canvas.getBoundingClientRect();
          if (t.clientX-r.x>=left && t.clientX-r.x<=left+40 && Math.abs(t.clientY-r.y-100)<20)
            target.dispatchEvent({type:"touchend",trusted:e.isTrusted});
        });
      },left);
      await frame.evaluate(installManualActions);
      return frame;
    }
    let frame=await scene(44);
    await frame.locator("canvas").tap({position:{x:55,y:96}});
    await page.waitForTimeout(250);
    assert.equal(steps.length,1);
    assert.equal(steps[0].kind,"CocosTouch");
    frame=await scene(201);
    await replay(page,{steps:[{...steps[0],route:[{name:"game"}]}],frames:[]},new AbortController().signal,
      ()=>{}, {active:new Set(),paths:new Set(),lastGET:0,quietMs:0,hasTouch:true},"");
    assert.equal(await frame.evaluate(()=>window.taps),1);
  } finally { await browser.close(); }
});

test("无损选区匹配同一视口中移动、非预设缩放和亮度变化的按钮，标记重复目标", async () => {
  const {scan} = require("../src/visual-match");
  const size=32, rgb=Buffer.alloc(size*size*3);
  for (let y=0;y<size;y++) for (let x=0;x<size;x++) {
    const i=3*(size*y+x);
    rgb[i]=x<8 || y>20 ? 195:30;
    rgb[i+1]=x+y>31 ? 159:32;
    rgb[i+2]=y<6 ? 170:75;
  }
  const template={side:size,width:80,height:80,viewWidth:360,viewHeight:180,rgb:rgb.toString("base64")};
  const image={width:360,height:180,data:Buffer.alloc(360*180*4)};
  function draw(left) {
    for(let y=0;y<69;y++) for(let x=0;x<69;x++) {
      const i=3*(Math.floor(y*size/69)*size+Math.floor(x*size/69));
      for(let c=0;c<3;c++) image.data[4*((40+y)*360+x+left)+c]=rgb[i+c]+8;
    }
  }
  draw(177);
  const found=scan(image,template,94);
  assert.equal(found.hits.length,1);
  assert.ok(Math.abs(found.best.x-211.5)<4);
  draw(32);
  assert.equal(scan(image,template,94).hits.length,2);
});
