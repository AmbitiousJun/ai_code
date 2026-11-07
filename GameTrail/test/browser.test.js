const test = require("node:test"),
  assert = require("node:assert/strict"),
  http = require("node:http"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { runOne } = require("../src/runner"),
  { Cache } = require("../src/cache"),
  { defaults, plan } = require("../src/config");
test("真实点击加载双层 iframe、递归 CSS 与跨运行缓存", async (t) => {
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
      labels: ["Game Guide"],
      actions: 1,
      extraGets: 5,
    };
    const events = [];
    const r = await runOne(
      plan(cfg)[0],
      cfg,
      cache,
      new AbortController().signal,
      (e) => events.push(e),
      new Set(),
      path.join(dir, i + ".png"),
    );
    assert.equal(r.clicks, 1);
    assert.ok(r.frames >= 2);
    assert.ok(
      events.some((e) => e.url?.endsWith("/zh.json") && e.status === 200),
    );
    assert.ok(
      events.some(
        (e) => e.url?.endsWith("/unseen.png") && e.source === "supplement",
      ),
    );
    assert.ok(
      events.some((e) => e.url?.endsWith("/hidden.png") && e.status === 200),
    );
    if (i === 1) {
      assert.equal(scripts, 1);
      assert.ok(events.some((e) => e.source === "cache"));
    }
  }
});
