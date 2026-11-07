const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { Cache } = require("../src/cache"),
  { plan, defaults } = require("../src/config"),
  { references } = require("../src/discover");
test("多变量与机型组合、转义和输入验证", () => {
  assert.equal(plan(defaults).length, 6);
  assert.equal(
    plan({ ...defaults, selected: ["mac", "ios", "android"] }).length,
    18,
  );
  const [r] = plan({
    ...defaults,
    variables: { gameId: ["a&b"], lang: ["zh-CN"] },
  });
  assert.match(r.url, /a%26b/);
  assert.throws(() => plan({ ...defaults, selected: [] }));
});
test("同源 HTML srcset、CSS import 与 JSON 资源", () => {
  assert.deepEqual(
    references(
      '<img srcset="a.png 1x,b.png 2x"><script src="https://other.test/x.js"></script>',
      "text/html",
      "http://a.test/x",
    ),
    ["http://a.test/a.png", "http://a.test/b.png"],
  );
  assert.equal(
    references(
      '@import "a.css"; b{background:url(b.png)}',
      "text/css",
      "http://a.test/css/x.css",
    ).length,
    2,
  );
  assert.deepEqual(
    references(
      '{"nested":["ui/zh.json","buy"]}',
      "application/json",
      "http://a.test/",
    ),
    ["http://a.test/ui/zh.json"],
  );
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
  const key = (i) => c.key("http://test/" + i, {}, "p");
  for (const k of ["a", "b"]) c.put(key(k), h, buf);
  c.get(key("a"));
  c.put(key("c"), h, buf);
  assert.ok(!c.get(key("b")));
  assert.ok(c.get(key("a")));
  const again = new Cache(dir);
  assert.equal(again.stats().hits, 2);
  again.db.close();
  assert.equal(c.key("http://a", { cookie: "x" }, "p"), undefined);
  assert.equal(c.policy({ "cache-control": "no-store" }), 0);
  c.resize(4);
  assert.equal(c.stats().bytes, 4);
  c.clear();
  assert.equal(c.stats().entries, 0);
});
