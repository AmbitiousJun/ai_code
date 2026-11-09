const test = require("node:test");
const assert = require("node:assert/strict");
const {spawn} = require("node:child_process");
const {once, EventEmitter} = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const {setTimeout: delay} = require("node:timers/promises");
const {PNG} = require("playwright-core/lib/utilsBundle");
const {replay} = require("../src/manual");
const {ReplayStore} = require("../src/replay-store");

test("降阈值后唯一目标点击，两个目标继续等待，三个目标快速失败", async t => {
  const rgb = Buffer.alloc(1200);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 37) % 200;
  const pixels = {rgb:rgb.toString("base64"),width:20,height:20,viewWidth:100,viewHeight:30};
  let now = 0;
  t.mock.method(Date, "now", () => now);
  for (const count of [1,2,3]) {
    now = 0;
    const img = new PNG({width:100,height:30});
    for (let n=0; n<count; n++) for (let i=0; i<400; i++) {
      const offset = 4 * ((5+Math.floor(i/20))*100 + 5+n*30+i%20);
      for (let c=0;c<3;c++) img.data[offset+c] = rgb[i*3+c]+2;
      img.data[offset+3] = 255;
    }
    const bytes = PNG.sync.write(img), page = new EventEmitter();
    let scans = 0, clicks = 0;
    page.viewportSize = () => ({width:img.width,height:img.height});
    page.screenshot = async () => { now += ++scans === 1 ? 10000 : 1000; return bytes; };
    page.mouse = {click: async () => clicks++};
    const events = [];
    const run = replay(page, {steps:[{name:"按钮",pixels}], frames:[]}, new AbortController().signal,
      e=>events.push(e.message), {paths:new Set(),active:new Set(),quietMs:0,lastGET:0},
      "en-US", {pixelTimeout:14,pixelSimilarity:100});
    if (count === 1) await run;
    else await assert.rejects(run, count === 2 ? /匹配超时/ : /至少 3 个目标/);
    assert.equal(clicks, count === 1 ? 1 : 0);
    assert.equal(scans, count === 2 ? 5 : 2);
    assert.ok(events.some(message=>message.includes("99%")));
  }
});

test("保存任务支持区分名称、重命名及批量删除，运行中的任务保护整批", () => {
  const store = new ReplayStore(":memory:");
  try {
    const add = () => store.create({}, new Map(), 3, "https://game.invalid");
    const a = add(), b = add();
    assert.notEqual(store.load(a).name, store.load(b).name);
    store.rename(a,"测试一");
    assert.equal(store.load(a).name,"测试一");
    assert.throws(()=>store.remove([b,a],a));
    assert.equal(store.list().length,2);
    store.remove([a,b]);
    assert.deepEqual(store.list(),[]);
  } finally { store.db.close(); }
});

test("工作台保存录入结果，中断第二条路径后重启服务可续跑和全量重跑", {timeout:90000}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"gt-replay-"));
  const site = http.createServer((req,res) => res.end('<button id="go" style="position:fixed;inset:0;width:100%;height:100%">Go</button>'));
  await new Promise(resolve => site.listen(0,"127.0.0.1",resolve));
  let child, base;
  async function boot() {
    child = spawn(process.execPath,[require.resolve("../src/server")],{
      env:{...process.env, GAMETRAIL_DATA:dir,GAMETRAIL_NO_OPEN:"1",PORT:"0"},stdio:["ignore","pipe","inherit"]
    });
    const [line] = await once(child.stdout,"data");
    base = String(line).match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  }
  async function api(route, data) {
    const res = await fetch(base+"/api/"+route, data === undefined ? {} : {
      method:"POST", headers:{"Content-Type":"application/json"},body:JSON.stringify(data)
    });
    const value = await res.json();
    assert.ok(res.ok, JSON.stringify(value));
    return value;
  }
  async function until(check) {
    const end = Date.now()+20000;
    while (Date.now()<end) {
      const job = (await api("state")).job;
      if (check(job)) return job;
      await delay(30);
    }
    throw Error("等待任务状态超时");
  }
  async function command(action) {
    const {manual} = await until(j=>j.manual?.allowed.includes(action));
    await api("manual",{action,token:manual.token});
  }
  async function recordStep() {
    await command("record");
    const {manual} = await until(j=>j.manual?.session);
    await api("record-input",{token:manual.token,x:0.25,y:0.25});
    await command("finish");
  }
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child,"exit");
      child.kill();
      await closed;
    }
    site.close();
    fs.rmSync(dir,{recursive:true,force:true});
  });
  await boot();
  await api("start",{template:"http://127.0.0.1:"+site.address().port+"/{gameId}?lang={lang}",
    variables:{gameId:["demo"],lang:["en-US","fr-FR"]},waitSeconds:2,quietSeconds:0.15});
  await recordStep();
  await recordStep();
  await command("done");
  await until(j=>j.events.some(e=>e.message === "批量重放路径 2"));
  await api("stop",{});
  await until(j=>j.status === "cancelled");
  const [saved] = await api("replays");
  assert.equal(saved.pathIndex,1);
  const closed = once(child,"exit");
  await api("quit",{});
  await closed;
  await boot();
  for (const mode of ["continue","all"]) {
    const variables = {gameId:["demo"], lang:["de-DE"]};
    const {id} = await api("replays/start",{id:saved.id, mode, ...(mode === "all" ? {variables} : {})});
    const job = await until(j=>j?.id === id && j.status !== "running");
    assert.equal(job.status,"complete");
    assert.equal(job.runs.length,mode === "all" ? 1 : 2);
    if (mode === "all") {
      assert.equal(job.runs[0].vars.lang,"de-DE");
      assert.deepEqual((await api("replays/config?id="+saved.id)).variables,variables);
    } else assert.equal(job.runs[1].replayedPaths,2);
    assert.equal(job.runs[0].replayedPaths, mode === "all" ? 2 : 1);
    const [updated] = await api("replays");
    assert.equal(updated.rowIndex,job.runs.length);
    assert.equal(updated.total,job.runs.length);
  }
});
