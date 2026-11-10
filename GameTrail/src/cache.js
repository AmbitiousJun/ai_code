const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
class Cache {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, "index.sqlite"));
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS items(k TEXT PRIMARY KEY, size INTEGER, hits INTEGER, used INTEGER, expires INTEGER, headers TEXT); CREATE TABLE IF NOT EXISTS prefs(cap INTEGER); INSERT INTO prefs SELECT 1073741824 WHERE NOT EXISTS(SELECT 1 FROM prefs)",
    );
    this.cap = this.db.prepare("SELECT cap FROM prefs").get().cap;
    for (const f of fs.readdirSync(dir))
      if (
        /^[a-f0-9]{64}$/.test(f) &&
        !this.db.prepare("SELECT 1 FROM items WHERE k=?").get(f)
      )
        fs.unlinkSync(path.join(dir, f));
  }
  stats() {
    return {
      ...this.db
        .prepare(
          "SELECT count(*) entries, coalesce(sum(size),0) bytes, coalesce(sum(hits),0) hits FROM items",
        )
        .get(),
      cap: this.cap,
    };
  }
  drop(k) {
    fs.rmSync(path.join(this.dir, k), { force: true });
    this.db.prepare("DELETE FROM items WHERE k=?").run(k);
  }
  trim(space = 0) {
    while (this.stats().bytes + space > this.cap) {
      const r = this.db
        .prepare("SELECT k FROM items ORDER BY hits ASC, used ASC LIMIT 1")
        .get();
      if (!r) break;
      this.drop(r.k);
    }
  }
  resize(cap) {
    if (!Number.isSafeInteger(cap) || cap < 0 || cap > 100 * 1024 ** 3)
      throw Error("缓存范围 0–100 GiB");
    this.cap = cap;
    this.db.prepare("UPDATE prefs SET cap=?").run(cap);
    this.trim();
  }
  clear() {
    for (const { k } of this.db.prepare("SELECT k FROM items").all())
      this.drop(k);
  }
  bypassReason(url, h, engine) {
    if (!this.cap) return "缓存容量为 0";
    if (h.authorization || h.range || Object.keys(h).some(k => k.startsWith("if-")))
      return "鉴权、范围或条件请求";
    const control = h["cache-control"] || "";
    if (/no-store/i.test(control) ||
        (engine !== "webkit" && (/no-cache/i.test(h.pragma || "") || /no-cache|max-age=0/i.test(control))))
      return "请求要求回源";
    if (/[?&](?:token|ssokey|session|signature|access_token)=/i.test(url))
      return "URL 含凭据参数";
  }
  key(url) {
    const resource = new URL(url);
    return sha(resource.origin + resource.pathname);
  }
  get(k) {
    if (!k) return;
    const row = this.db.prepare("SELECT * FROM items WHERE k=?").get(k);
    if (!row) return;
    if (row.expires <= Date.now() || !fs.existsSync(path.join(this.dir, k))) {
      this.drop(k);
      return;
    }
    const body = fs.readFileSync(path.join(this.dir, k));
    this.db
      .prepare("UPDATE items SET hits=hits+1, used=? WHERE k=?")
      .run(Date.now(), k);
    return { body, headers: JSON.parse(row.headers), status: 200 };
  }
  responseRestricted(h) {
    return Boolean(/no-store|no-cache|private/i.test(h["cache-control"] || "") ||
      h["set-cookie"] || /(?:^|,)\s*(?:\*|cookie|authorization)\s*(?:,|$)/i.test(h.vary || ""));
  }
  policy(h, url) {
    const cc = h["cache-control"] || "";
    if (this.responseRestricted(h)) return 0;
    const maxAge = cc.match(/(?:^|,)\s*max-age=(\d+)/i);
    const lifetime = maxAge
      ? (Number(maxAge[1]) - Number(h.age || 0)) * 1000
      : Date.parse(h.expires) - Date.now();
    if (Number.isFinite(lifetime)) return Math.max(0, lifetime);
    const modified = Date.parse(h["last-modified"]);
    if (Number.isFinite(modified))
      return Math.max(0, Math.min(86400000, (Date.now() - modified) * 0.1));
    // Game builds often embed a short content hash immediately before the extension.
    if (!h.expires && !/max-age/i.test(cc) && url &&
        /[.-][a-f0-9]{5,64}\.[a-z0-9]+$/i.test(new URL(url).pathname))
      return Math.max(0, 3600000 - Number(h.age || 0) * 1000);
    return 0;
  }
  put(k, h, body, ttl = this.policy(h)) {
    if (
      !k ||
      !ttl ||
      !this.cap ||
      !body.length ||
      body.length > Math.min(this.cap, 16 * 1024 ** 2) ||
      this.db.prepare("SELECT 1 FROM items WHERE k=?").get(k)
    )
      return false;
    this.trim(body.length);
    const headers = { ...h };
    for (const n of [
      "content-encoding",
      "content-length",
      "transfer-encoding",
      "connection",
    ])
      delete headers[n];
    fs.writeFileSync(path.join(this.dir, k), body);
    this.db
      .prepare("INSERT INTO items VALUES(?,?,0,?,?,?)")
      .run(
        k,
        body.length,
        Date.now(),
        Date.now() + ttl,
        JSON.stringify(headers),
      );
    return true;
  }
}
module.exports = { Cache };
