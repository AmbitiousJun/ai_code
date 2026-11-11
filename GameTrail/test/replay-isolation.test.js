const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const {spawn} = require("node:child_process");
const {once} = require("node:events");
const {setTimeout:delay} = require("node:timers/promises");
const {defaults} = require("../src/config");
const {ReplayStore} = require("../src/replay-store");
const {cachedPreview} = require("../src/preview");

test("慢预览只保留一次在途采集，立即返回旧帧", async () => {
  let finish, calls = 0;
  const read = cachedPreview(() => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  });
  assert.equal(read(), undefined);
  await delay(0);
  assert.equal(read(0), undefined);
  assert.equal(calls, 1);
  finish(Buffer.from("frame"));
  await delay(0);
  const cached = read(0);
  await delay(0);
  assert.equal(calls, 2);
  assert.equal(read(0), cached);
  assert.equal(cached.bytes.toString(), "frame");
  finish(null);
});

test("Android 竖屏匹配超时时，并发实例持续回源，两个窗口仍能更新预览", {timeout:60000}, async t => {
  const beats = [];
  let held;
  const site = http.createServer((req,res) => {
    if (req.url === "/hold") { held = res; return; }
    if (req.url.startsWith("/beat?")) beats.push(Date.now());
    res.setHeader("Content-Type","text/html");
    res.end(req.url === "/network"
      ? '<script>fetch("/hold");setInterval(()=>fetch("/beat?"+Date.now()),150)</script>'
      : '<meta name="viewport" content="width=device-width"><body style="background:rgb(108,108,108)">');
  });
  site.listen(0,"127.0.0.1");
  await once(site,"listening");
  t.after(() => { site.closeAllConnections(); site.close(); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"gt-isolation-"));
  const cfg = {...defaults, selected:["android"], template:"http://127.0.0.1:"+site.address().port+"/{gameId}",
    variables:{gameId:["scan","network"]}, waitSeconds:20, quietSeconds:0.2, pixelTimeout:6, pixelSimilarity:100, replayConcurrency:2};
  const rgb = Buffer.from(Array.from({length:32*32*3}, (_,i) => Math.floor(i/3)%2 ? 120 : 96));
  const pixels = {side:32, width:32,height:32,viewWidth:412,viewHeight:839,rgb:rgb.toString("base64")};
  const groups = new Map([["scan",[{steps:[{name:"缺失按钮",pixels}],frames:[]}]]]);
  const store = new ReplayStore(path.join(dir,"replays.sqlite"));
  const id = store.create(cfg,groups,2,cfg.template);
  store.db.close();
  const exe = process.env.GAMETRAIL_TEST_EXE;
  const child = spawn(exe || process.execPath,exe ? [] : [require.resolve("../src/server")],{
    env:{...process.env,GAMETRAIL_DATA:dir,GAMETRAIL_NO_OPEN:"1",PORT:"0"},
    stdio:"ignore",windowsHide:true,
  });
  const closed = once(child,"exit");
  let base;
  const post = (route,data) => fetch(base+route,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
  t.after(async () => {
    if (base && child.exitCode === null) {
      await post("/api/stop",{}).catch(()=>{});
      await post("/api/quit",{}).catch(()=>{});
    }
    if (!exe && child.exitCode === null) child.kill();
    await closed;
    fs.rmSync(dir,{recursive:true,force:true});
  });
  const address = path.join(dir,"address");
  for (let i=0; i<250 && !fs.existsSync(address); i++) await delay(100);
  base = fs.readFileSync(address,"utf8").trim();
  const {version, presets} = await (await fetch(base+"/api/config")).json();
  assert.equal(version,require("../package.json").version);
  const android = presets.find(device => device.id === "android");
  const iphone = presets.find(device => device.id === "ios");
  for (const key of ["viewport", "screen", "deviceScaleFactor"]) assert.deepEqual(android[key], iphone[key]);
  const response = await post("/api/replays/start",{id,mode:"continue"});
  assert.equal(response.status,200);
  const jobId = (await response.json()).id;
  const frames = [[],[]], polls = [];
  let job, failure;
  const deadline = Date.now()+28000;
  while (Date.now()<deadline) {
    polls.push(Date.now());
    job = (await (await fetch(base+"/api/state")).json()).job;
    failure ||= job.events.find(e => e.diagnostic);
    if (failure && held && !held.writableEnded) held.end();
    if (job.status !== "running") break;
    await Promise.all(job.instances.map(async ({run}) => {
      const res = await fetch(base+"/api/preview?job="+jobId+"&run="+run);
      if (res.status === 200) {
        const bytes = Buffer.from(await res.arrayBuffer());
        assert.equal(bytes.readUInt16BE(0),0xffd8);
        frames[run-1].push(Number(res.headers.get("X-Frame-Time")));
      }
    }));
    await delay(100);
  }
  assert.equal(job.done,2);
  const compact = (await (await fetch(base+"/api/state?compact=1")).json()).job;
  assert.equal(compact.done, job.runs.length);
  assert.equal(Object.hasOwn(compact, "runs"), false);
  assert.match(failure?.message || "",/等待唯一截图匹配超时/);
  assert.ok(fs.readFileSync(path.join(dir,"reports",jobId,failure.diagnostic),"utf8").includes("data:image/jpeg;base64,"));
  const end = Date.parse(failure.time), start = end-4500;
  for (const samples of [beats,polls,...frames]) {
    const within = samples.filter(t => t>=start && t<=end);
    assert.ok(new Set(within).size >= 2,"扫描期间有多次独立活动");
    const times = [start,...within,end];
    assert.ok(times.slice(1).every((t,i)=>t-times[i]<3000),"扫描期间无连续 3 秒停顿");
  }
});
