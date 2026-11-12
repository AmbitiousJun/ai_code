const test = require("node:test"),
  assert = require("node:assert/strict"),
  http = require("node:http"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { runOne } = require("../src/runner"),
  { Cache } = require("../src/cache"),
  { defaults: appDefaults, plan } = require("../src/config");
const defaults = { ...appDefaults, exploreMode: "buttons" };
test("浏览器初始化时静音 Chromium 和 WebKit 子 frame", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-mute-"));
  const cache = new Cache(dir);
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(req.url === "/" ? '<iframe src="/frame"></iframe>' : "<audio></audio>");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    cache.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const id of ["win", "ios"]) {
    const cfg = { ...defaults, explore: false, selected: [id], waitSeconds: 2,
      template: "http://127.0.0.1:" + server.address().port + "/" };
    await runOne(plan(cfg)[0], cfg, cache, new AbortController().signal, () => {},
      [], path.join(dir, id + ".png"), null, { async interact(page) {
        if (id === "win") {
          const session = await page.context().newCDPSession(page);
          const command = await session.send("Browser.getBrowserCommandLine");
          assert.ok(command.arguments.includes("--mute-audio"));
          if (process.platform === "win32") assert.ok(command.arguments.includes("--headless=new"));
        } else {
          const audio = page.frameLocator("iframe").locator("audio");
          assert.equal(await audio.evaluate(element => {
            element.dispatchEvent(new Event("loadstart"));
            return element.muted;
          }), true);
          assert.equal(await audio.evaluate(element => {
            element.muted = false;
            return element.muted;
          }), true);
        }
      } });
  }
});
test("真实点击加载双层 iframe、浏览器原生请求与跨运行缓存", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-browse-")),
    cache = new Cache(dir);
  let scripts = 0;
  const server = http.createServer((req, res) => {
    let data = "",
      type = "text/html";
    switch (req.url) {
      case "/":
        data =
          '<script src="/app.js"></script><button onclick="openHelp()">Game Guide</button><link rel="stylesheet" href="/base.css">';
        break;
      case "/app.js":
        type = "text/javascript";
        scripts++;
        data =
          "function openHelp(){document.body.insertAdjacentHTML('beforeend','<iframe src=/outer></iframe>')}";
        res.setHeader("cache-control", "public,max-age=600");
        break;
      case "/outer":
        data = '<iframe src="/inner"></iframe>';
        break;
      case "/inner":
        data = '<script>fetch("/zh.json")</script>';
        break;
      case "/zh.json":
        type = "application/json";
        data = '{"icon":"hidden.png"}';
        break;
      case "/base.css":
        type = "text/css";
        data = ".unused{background-image:url(/unseen.png)}";
        break;
      default:
        type = "image/png";
        data = "x";
    }
    res.setHeader("content-type", type);
    res.end(data);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.close();
    cache.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const [i, id] of ["win", "win", "ios"].entries()) {
    const cfg = {
      ...defaults,
      template: "http://127.0.0.1:" + server.address().port + "/",
      selected: [id],
      waitSeconds: 1,
      actions: 1,
    };
    const events = [];
    const r = await runOne(
      plan(cfg)[0],
      cfg,
      cache,
      new AbortController().signal,
      (e) => events.push(e),
      [],
      path.join(dir, i + ".png"),
    );
    assert.equal(r.clicks, 1);
    assert.ok(r.frames >= 2);
    assert.ok(
      events.some((e) => e.url?.endsWith("/zh.json") && e.status === 200),
    );
    assert.ok(!events.some(e => /(?:unseen|hidden)\.png$/.test(e.url)));
    if (i === 1) {
      assert.equal(scripts, 1);
      assert.ok(events.some((e) => e.source === "cache"));
    }
  }
});

test("重新载入时复用 fetch 游戏资源，遵守有效期和隐私限制", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-reload-"));

  const assets = ["/sound.mp3", "/bundle.4dab3.zip", "/plain.zip", "/private.8052e.png"];
  const counts = new Map();
  const caches = [];
  const server = http.createServer((req, res) => {
    if (req.url === "/") {
      res.setHeader("content-type", "text/html");
      return res.end(`<script>
        async function load() {
          for (const url of ${JSON.stringify(assets)}) await (await fetch(url)).text();
          if (!sessionStorage.loaded) {
            sessionStorage.loaded = 1;
            setTimeout(() => location.reload(), 150);
          }
        }
        load();
      </script>`);
    }
    counts.set(req.url, (counts.get(req.url) || 0) + 1);
    if (req.url === assets[0]) res.setHeader("cache-control", "max-age=300");
    if (req.url === assets[3]) res.setHeader("cache-control", "no-store");
    res.write("game");
    res.end(" asset");
  });
  t.after(() => { server.close(); for (const cache of caches) cache.db.close(); fs.rmSync(dir, {recursive:true, force:true}); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  for (const id of ["win", "ios"]) {
    const cache = new Cache(path.join(dir, id));
    caches.push(cache);
    counts.clear();
    const cfg = {...defaults, selected:[id], template:"http://127.0.0.1:" + server.address().port,
      explore:false, waitSeconds:2};
    const events = [];
    await runOne(plan(cfg)[0], cfg, cache, new AbortController().signal, e => events.push(e),
      [], path.join(dir, id + ".png"));
    for (const [i, asset] of assets.entries()) {
      // Playwright's WebKit sends no-cache when request interception is active.
      const expectHit = i < 2;
      assert.equal(counts.get(asset), expectHit ? 1 : 2, id + asset);
      assert.equal(events.some(e => e.url?.endsWith(asset) && e.source === "cache"), expectHit);
    }
  }
});

test("128 个静态资源按路径命中，忽略查询参数、来源页和 Cookie", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-session-"));
  const cache = new Cache(dir);
  const downloads = new Map();
  let completed = false;
  const server = http.createServer((req, res) => {
    if (req.url === "/") {
      res.setHeader("content-type", "text/html");
      return res.end(`<script>
        async function load() {
          const step = Number(sessionStorage.step || 0);
          document.cookie = "session=" + (step < 2 ? "A" : "B") + ";path=/";
          document.cookie = "_ga_TEST=" + step + ";path=/";
          history.replaceState(null, "", "/?launch=" + step);
          const names = step < 2 ? Array.from({length:128}, (_, i) => "/" + i + ".png") : ["/0.png"];
          for (const name of names) {
            const body = await (await fetch(name + "?v=" + step)).text();
            if (body !== "asset " + name) return;
          }
          await fetch("/api/profile?q=account");
          await fetch("/private.png");
          await fetch("/varied.png");
          if (step < 2) {
            sessionStorage.step = step + 1;
            setTimeout(() => location.assign("/"), 80);
          } else await fetch("/done", {method:"POST"});
        }
        load();
      </script>`);
    }
    if (req.url === "/done") completed = true;
    const pathname = new URL(req.url, "http://localhost").pathname;
    downloads.set(pathname, (downloads.get(pathname) || 0) + 1);
    res.setHeader("cache-control", req.url === "/private.png" ? "private,max-age=900" : "max-age=900");
    if (req.url === "/varied.png") res.setHeader("vary", "Cookie, Referer");
    res.end("asset " + pathname);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {server.close(); cache.db.close(); fs.rmSync(dir, {recursive:true, force:true});});
  const cfg = {...defaults, template:"http://127.0.0.1:" + server.address().port,
    explore:false, waitSeconds:15, quietSeconds:3};
  const events = [];
  await runOne(plan(cfg)[0], cfg, cache, new AbortController().signal, e => events.push(e),
    [], path.join(dir, "session.png"));
  assert.ok(completed);
  assert.equal(cache.stats().entries, 128);
  assert.equal(downloads.get("/varied.png"), 3);
  assert.equal(downloads.get("/0.png"), 1);
  assert.equal(downloads.get("/api/profile"), 3);
  assert.equal(downloads.get("/private.png"), 3);
  assert.equal(events.filter(e => e.source === "cache").length, 129);
  assert.ok(events.some(e => e.kind === "cacheDecision" && e.message.includes("响应限制缓存")));
});

test("隔离变量优先分组，无 GET 分支和防连续点击，跨语言重放子 frame 深度路径", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-paths-"));
  const cache = new Cache(dir);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://local");
    const lang = u.searchParams.get("lang"), game = u.searchParams.get("game");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (u.pathname === "/") res.end(`<button id="local" onclick="document.body.innerHTML='&lt;button id=close onclick=document.body.replaceChildren()&gt;Close&lt;/button&gt;'">本地菜单</button>
      <button id="menu" onclick="document.body.innerHTML='<iframe src=/panel?game=${game}&amp;lang=${lang}></iframe>'">${lang === "en" ? "Open" : "打开"}</button>`);
    else if (u.pathname === "/panel") res.end(`<button id="deep" onclick="fetch('/asset/${game}/${lang}').then(r=>r.text()).then(()=>this.parentElement.innerHTML='&lt;button id=leaf onclick=fetch(&quot;/leaf&quot;)&gt;Leaf&lt;/button&gt;')">${lang === "en" ? "Read" : "查看"}</button><button id="sibling" onclick="fetch('/sibling/${game}/${lang}')">Sibling</button>`);
    else if (u.pathname.startsWith("/asset/")) {
      res.write("loading");
      setTimeout(() => res.end("done"), 1700);
    } else res.end("ok");
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.close(); cache.db.close(); fs.rmSync(dir, {recursive:true,force:true}); });
  const cfg = { ...defaults, template: "http://127.0.0.1:" + server.address().port + "/?lang={lang}&game={game}",
    primaryVariable: "game", variables: {lang:["zh","en"], game:["a","b"]}, actions: 3, waitSeconds: 1 };
  const rows = plan(cfg);
  assert.deepEqual(rows.map(r => [r.group, r.phase]), [["a","discover"],["a","replay"],["b","discover"],["b","replay"],["a","replay"],["b","replay"]]);
  assert.throws(() => plan({...cfg, primaryVariable:"absent"}));
  for (const group of ["a","b"]) {
    const paths = [];
    for (const row of rows.filter(r => r.group === group)) {
      const events = [];
      await runOne(row,cfg,cache,new AbortController().signal,e => events.push(e),paths,path.join(dir, "shot.png"));
      assert.ok(events.some(e => e.url?.endsWith("/asset/" + group + "/" + row.vars.lang)));
      assert.ok(events.some(e => e.url?.endsWith("/sibling/" + group + "/" + row.vars.lang)));
      assert.ok(events.some(e => e.url?.endsWith("/leaf")));
      if (row.phase === "replay") {
        assert.equal(events.filter(e => e.message?.startsWith("重放成功")).length,3);
        assert.ok(!events.some(e => e.message?.startsWith("重放失败")));
      }
    }
    assert.deepEqual(paths.map(p => p.steps.map(s => s.anchor).join("/")), [
      "#local/#close", "#menu/#deep/#leaf", "#menu/#sibling/#deep"
    ]);
    assert.ok(paths.every(p => p.steps.every(s => Number.isFinite(s.x) && Number.isFinite(s.y))));
  }
});

test("Vision 跨分支只试点一次移动过的静态标题，并保留两个有效分支", {
  skip: process.platform !== "darwin" || !fs.existsSync(path.join(__dirname, "../native/vision")),
}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-canvas-"));
  const cache = new Cache(dir);
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/") return res.end('<iframe src="/board" width="660" height="220"></iframe>');
    if (req.url !== "/board") return res.end("ok");
    res.end(`<canvas width="640" height="180"></canvas><script>
      const canvas = document.querySelector("canvas"), g = canvas.getContext("2d");
      let open = false;
      function paint() {
        g.fillStyle = "white"; g.fillRect(0,0,640,180);
        g.font = "bold 38px Helvetica"; g.fillStyle = "black";
        g.fillText(open ? "Rules" : "Menu", 35,65);
        if(open) g.fillText("History", 330,140);
        g.fillText("Title", open ? 370 : 455,65);
      }
      paint();
      canvas.onclick = e => {
        if (e.offsetX > 250 && e.offsetY < 90) { fetch("/title-click"); return; }
        if (open) { g.clearRect(0,0,640,180); g.fillText("Title", 370,65); return; }
        fetch("/" + (open ? e.offsetX < 250 ? "rules" : "history" : "menu"));
        open = true; paint();
      };
    </script>`);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.close(); cache.db.close(); fs.rmSync(dir, {recursive:true,force:true}); });
  const cfg = {...defaults, template:"http://127.0.0.1:" + server.address().port,
    actions:3, waitSeconds:1};
  const paths = [];
  const events = [];
  await runOne(plan(cfg)[0], cfg, cache, new AbortController().signal, event => events.push(event), paths, path.join(dir, "canvas.png"));
  assert.equal(events.filter(e => e.kind === "request" && e.url?.endsWith("/title-click")).length, 1);
  assert.equal(events.filter(e => e.message?.startsWith("跳过无稳定反馈的画布文字") && e.message.endsWith("Title")).length, 1);
  assert.deepEqual(paths.map(p => p.steps.map(s => s.name).join("/")).sort(), ["Menu/History","Menu/Rules"]);
  assert.ok(paths.every(p => p.steps.every(s => s.kind === "OCR")));
});

test("自动轮播不产生路径，按钮只更新远处面板仍能记录", {
  skip: process.platform !== "darwin" || !fs.existsSync(path.join(__dirname, "../native/vision")),
}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-carousel-"));
  const cache = new Cache(dir);
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<meta charset="utf-8"><canvas width="600" height="300"></canvas><script>
      const canvas = document.querySelector("canvas"), g = canvas.getContext("2d");
      g.fillStyle = "white"; g.fillRect(0,0,600,300);
      g.font = "bold 36px Helvetica"; g.fillStyle = "black"; g.fillText("下次不要显示",35,240);
      function slide() {
        g.fillStyle = "rgb(" + Math.round(180 + 70*Math.sin(performance.now()/140)) + ",220,185)";
        g.fillRect(110,40,360,85);
        g.fillStyle = "black"; g.fillText("Bonus",190,100);
        requestAnimationFrame(slide);
      }
      slide();
      let toggled = false;
      canvas.onclick = e => {
        if (e.offsetY > 190 && e.offsetX < 180) {
          toggled = !toggled;
          fetch("/toggle");
          g.fillStyle = toggled ? "blue" : "white"; g.fillRect(420,175,130,80);
        }
      };
    </script>`);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.close(); cache.db.close(); fs.rmSync(dir, {recursive:true,force:true}); });
  const cfg = {...defaults, template:"http://127.0.0.1:" + server.address().port, actions:3, waitSeconds:1};
  const paths = [], events = [];
  await runOne(plan(cfg)[0], cfg, cache, new AbortController().signal, e => events.push(e), paths, path.join(dir,"end.png"));
  assert.ok(events.some(e => e.message === "跳过无稳定反馈的画布文字 · Bonus"));
  assert.equal(events.filter(e => e.kind === "response" && e.url?.endsWith("/toggle")).length, 1);
  assert.deepEqual(paths.map(p => p.steps.map(s => s.kind)), [["OCR"]]);
  assert.match(paths[0].steps[0].name, /^下次不要/);
});

test("同名的两个按钮可交替点击，路径内保留 A → B → A", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-alternating-"));
  const cache = new Cache(dir);
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end('<button id="a">Toggle</button><button id="b">Toggle</button>');
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.close(); cache.db.close(); fs.rmSync(dir, {recursive:true,force:true}); });
  const cfg = {...defaults, template:"http://127.0.0.1:" + server.address().port, actions:3, waitSeconds:1};
  const paths = [];
  await runOne(plan(cfg)[0], cfg, cache, new AbortController().signal, () => {}, paths, path.join(dir,"end.png"));
  assert.deepEqual(paths.map(p => p.steps.map(s => s.anchor)), [["#a","#b","#a"], ["#b","#a","#b"]]);
});

test("重复心跳期间发现并重放 iframe 中的无文字图标，排除装饰", {timeout:60000}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-icons-"));
  const cache = new Cache(dir);
  const server = http.createServer((req,res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.url === "/") return res.end('<iframe width="340" height="160" src="/board"></iframe>');
    if (req.url !== "/board") return res.end("ok");
    res.end(`<canvas width="300" height="120"></canvas><script>
      setInterval(() => fetch("/heartbeat?t="+Date.now()), 180);
      const canvas=document.querySelector("canvas"), g=canvas.getContext("2d");
      g.fillStyle="#295bb5"; g.fillRect(20,20,50,50);
      g.fillStyle="white"; g.beginPath(); g.moveTo(38,31); g.lineTo(57,45); g.lineTo(38,59); g.fill();
      g.fillStyle="#ba5730"; g.beginPath(); g.arc(220,45,18,0,2*Math.PI); g.fill();
      canvas.onclick=e=>{
        if(e.offsetX>=20 && e.offsetX<=70 && e.offsetY>=20 && e.offsetY<=70){
          fetch("/played"); g.clearRect(0,0,300,120);
        }
      };
    </script>`);
  });
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(() => { server.close(); cache.db.close(); fs.rmSync(dir,{recursive:true,force:true}); });
  const cfg = {...defaults, template:"http://127.0.0.1:"+server.address().port, actions:1, waitSeconds:1};
  const paths = [];
  for (const phase of ["discover","replay"]) {
    const events = [];
    await runOne({...plan(cfg)[0],phase},cfg,cache,new AbortController().signal,e=>events.push(e),paths,path.join(dir,"end.png"));
    assert.ok(events.filter(e=>e.kind==="request" && e.url.includes("/heartbeat?")).length > 2);
    assert.equal(events.filter(e=>e.kind==="request" && e.url.endsWith("/played")).length,1);
    assert.deepEqual(paths.map(p=>p.steps.map(s=>s.kind)),[["Icon"]]);
    if (phase==="discover") assert.ok(events.some(e=>e.message.startsWith("跳过无稳定反馈的画布图标")));
  }
});

test("源码模式在子 frame 中直接调用方法，跳过无反馈候选，跨语言重放", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-source-"));
  const cache = new Cache(dir);
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url.startsWith("/?")) return res.end('<iframe src="/game"></iframe>');
    if (req.url === "/game") return res.end(`<button onclick="fetch('/noise')">无关按钮</button>
      <script src="/app.js"></script>`);
    if (req.url === "/app.js") {
      res.setHeader("content-type", "text/javascript");
      return res.end(`window.panels = {
        ignore(){ document.createElement('iframe') },
        route:'/bonus/',
        open(url){const f=document.createElement('iframe');f.src=url;document.body.append(f)},
        bonus(){this.open(this.route+navigator.language)}
      }`);
    }
    res.end("ok");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); cache.db.close(); fs.rmSync(dir, {recursive:true, force:true}); });
  const cfg = { ...appDefaults, exploreMode: "source", template:"http://127.0.0.1:" + server.address().port + "/?game={gameId}&lang={lang}",
    variables:{gameId:["1"], lang:["en-US","fr-FR"]}, waitSeconds:1, actions:4 };
  for (const device of ["win", "mac"]) {
    const library = [];
    for (const row of plan({...cfg, selected:[device]})) {
      const events = [];
      const result = await runOne(row, cfg, cache, new AbortController().signal, e => events.push(e), library, path.join(dir,"end.png"));
      assert.deepEqual(library.map(p => p.steps[0].name), ["window.panels.bonus"]);
      assert.equal(result.clicks, 0);
      assert.ok(events.some(e => e.kind === "frame" && e.url.endsWith("/bonus/" + row.vars.lang)));
      assert.ok(!events.some(e => e.url?.endsWith("/noise")));
      assert.equal(events.some(e => e.message?.includes("未观察到子页面导航 · window.panels.ignore")), row.phase === "discover");
    }
  }
});

test("入口 GET 静默提前完成，重复心跳不续时，慢正文受等待上限约束", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"gt-idle-"));
  const cache = new Cache(dir);
  let heartbeats = 0;
  const server = http.createServer((req,res) => {
    if (req.url.startsWith("/beat?")) { heartbeats++; return res.end("ok"); }
    if (req.url === "/slow") {
      res.write("start");
      const timer = setTimeout(() => res.end("end"), 10000);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    res.setHeader("content-type","text/html");
    res.end('<script>setInterval(()=>fetch("/beat?t="+Date.now()),100);' +
      '</script>' + (req.url === "/limit" ? '<script src="/slow"></script>' : ''));
  });
  await new Promise(r => server.listen(0,"127.0.0.1",r));
  t.after(()=>{server.close();cache.db.close();fs.rmSync(dir,{recursive:true,force:true});});
  for (const limited of [false,true]) {
    const cfg = {...appDefaults, explore:false, quietSeconds:limited ? 0.4 : 2, waitSeconds:limited ? 2 : 8,
      template:"http://127.0.0.1:"+server.address().port+(limited ? "/limit" : "/idle")};
    let elapsed;
    await runOne(plan(cfg)[0],cfg,cache,new AbortController().signal,()=>{},[],path.join(dir,"end.png"),null,{
      interact: async page => { elapsed = await page.evaluate(() =>
        performance.now()); }
    });
    assert.ok(elapsed >= 1900 && elapsed < (limited ? 4000 : 6000), "等待毫秒 " + elapsed);
  }
  assert.ok(heartbeats >= 10);
});

test("Windows WebKit 在 TLS 握手中发送含下划线的原始 SNI", {
  skip: process.platform !== "win32",
}, async t => {
  const host = "assets_api.example.invalid";
  let serverName;
  const tls = require("node:tls").createServer({
    SNICallback(name, callback) {
      serverName = name;
      callback(new Error("测试握手到此结束"));
    },
  });
  const proxy = http.createServer();
  proxy.on("connect", (request, socket) => {
    if (request.url !== host + ":443") return socket.destroy();
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    tls.emit("connection", socket);
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => proxy.close());
  const browser = await require("webkit-win").webkit.launch({
    proxy: { server: "http://127.0.0.1:" + proxy.address().port },
  });
  try {
    const page = await browser.newPage();
    await assert.rejects(page.goto("https://" + host, {timeout: 10000}));
    assert.equal(serverName, host);
  } finally {
    await browser.close();
  }
});

test("WebKit 回放先重试 503，在渲染线程卡死后重建当前环境", {timeout:90000}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-recovery-"));
  const cache = new Cache(dir);
  let entries = 0;
  const site = http.createServer((req,res) => {
    if (req.url !== "/") return res.end();
    entries++;
    res.writeHead(entries === 1 ? 503 : 200, {"content-type":"text/html"});
    res.end(entries === 2 ? "<script>while(true){}</script>" : "<p>ready</p>");
  });
  await new Promise(resolve => site.listen(0,"127.0.0.1",resolve));
  t.after(() => { site.close(); cache.db.close(); fs.rmSync(dir,{recursive:true,force:true}); });
  const cfg = {...defaults,template:"http://127.0.0.1:"+site.address().port,
    selected:["ios"], explore:false, waitSeconds:2, quietSeconds:0.1};
  const events = [];
  await runOne({...plan(cfg)[0], phase:"replay"},cfg,cache,new AbortController().signal,
    e=>events.push(e.message),[],path.join(dir,"end.png"),null,{
      async interact(page) { assert.equal(await page.locator("p").innerText({timeout:60000}),"ready"); }
    });
  assert.equal(entries,3);
  assert.ok(events.some(m=>m?.includes("入口加载失败")));
  assert.ok(events.some(m=>m?.includes("无响应")));
});
