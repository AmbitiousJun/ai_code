const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { Cache } = require("../src/cache"),
  { plan, defaults } = require("../src/config");
test("多变量与机型组合、转义和输入验证", () => {
  assert.equal(plan(defaults).length, 9);
  assert.equal(plan({...defaults, quietSeconds:0.3}).length, 9);
  assert.equal(plan({...defaults, waitSeconds:86400}).length, 9);
  for (const waitSeconds of [0, -1, 1.5, Infinity]) assert.throws(() => plan({...defaults, waitSeconds}));
  for (const quietSeconds of [0,31,NaN]) assert.throws(() => plan({...defaults,quietSeconds}));
  assert.equal(
    plan({ ...defaults, selected: ["mac", "ios", "android"] }).length,
    21,
  );
  const [r] = plan({
    ...defaults,
    variables: { gameId: ["a&b"], lang: ["zh-CN"] },
  });
  assert.match(r.url, /a%26b/);
  assert.throws(() => plan({ ...defaults, selected: [] }));
});
test("超过 2000 个模板组合或设备运行时生成完整计划", () => {
  for (const [count, selected] of [[2001, ["win"]], [1001, ["win", "mac"]]]) {
    const gameId = Array.from({ length: count }, (_, i) => String(i + 1));
    const runs = plan({ variables: { gameId, lang: ["en-US"] }, selected, explore: false });
    assert.equal(runs.length, count * selected.length);
    assert.equal(runs.at(-1).vars.gameId, String(count));
    assert.equal(runs.at(-1).device.id, selected.at(-1));
  }
});
test("LFU、持久命中数、容量下调、手动清空和隐私约束", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-cache-"));
  const c = new Cache(dir);
  t.after(() => {
    c.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const h = { "cache-control": "public,max-age=120" },
    buf = Buffer.alloc(4);
  c.resize(8);
  const key = (i) => c.key("http://test/" + i);
  for (const k of ["a", "b"]) c.put(key(k), h, buf);
  c.get(key("a"));
  c.put(key("c"), h, buf);
  assert.ok(!c.get(key("b")));
  assert.ok(c.get(key("a")));
  const again = new Cache(dir);
  assert.equal(again.stats().hits, 2);
  again.db.close();
  assert.equal(c.key("https://cdn.test/a.png?v=1#img"), c.key("https://cdn.test/a.png?v=2"));
  assert.notEqual(c.key("https://cdn.test/a.png"), c.key("https://other.test/a.png"));
  assert.notEqual(c.key("https://cdn.test/a.png"), c.key("https://cdn.test:8080/a.png"));
  assert.equal(c.policy({ "cache-control": "no-store" }), 0);
  const versioned = "https://cdn.test/main.4dab3.zip";
  assert.equal(c.policy({}, versioned), 3600000);
  for (const headers of [
    {"cache-control":"max-age=0"}, {"cache-control":"private"}, {"set-cookie":"session=x"},
    {vary:"*"}, {expires:"Thu, 01 Jan 1970 00:00:00 GMT"}, {age:"3601"}
  ]) assert.equal(c.policy(headers, versioned), 0);
  assert.equal(c.policy({}, "https://cdn.test/main.zip?hash=.4dab3.zip"), 0);
  assert.ok(c.bypassReason(versioned, {pragma:"no-cache"}));
  c.resize(4);
  assert.equal(c.stats().bytes, 4);
  c.clear();
  assert.equal(c.stats().entries, 0);
});
