process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";
const pw = require("playwright"),
  fs = require("node:fs"),
  path = require("node:path");
const { explore, sleep } = require("./explore");
const { references } = require("./discover");
const staticType = new Set(["script", "stylesheet", "image", "font", "media"]);
const reusable = (req) =>
  staticType.has(req.resourceType()) ||
  /\.(json|wasm|bin|atlas|plist)(?:[?#]|$)/i.test(req.url());
function frameUrl(req) {
  try {
    return req.frame().url();
  } catch {
    return undefined;
  }
}
const parseable = (t) => /html|css|json/i.test(t);
async function runOne(row, cfg, cache, signal, emit, learned, shot, onPreviewReady) {
  const { device: d } = row;
  const opts = { headless: true };
  if (d.engine === "chromium" && !fs.existsSync(pw.chromium.executablePath()))
    opts.channel = "chrome";
  const browser = await pw[d.engine].launch(opts);
  const stop = () => browser.close().catch(() => {});
  signal.addEventListener("abort", stop, { once: true });
  let timer,
    expired = false;
  try {
    if (signal.aborted) throw Error("已取消");
    timer = setTimeout(
      () => {
        expired = true;
        stop();
      },
      (100 + cfg.waitSeconds * 3 + cfg.actions * 5 + cfg.extraGets * 5) * 1000,
    );
    const { id, name, engine, defaultBrowserType, ...device } = d;
    const locale = row.vars.lang || d.locale || "en-US";
    const ctx = await browser.newContext({
      ...device,
      locale,
      serviceWorkers: "block",
    });
    const observed = { serial: 0, frames: 0, entry: row.url },
      seen = new Set(),
      queue = new Set(),
      pending = new Set(),
      hits = new WeakSet();
    const profile = JSON.stringify([d, locale]);
    const page = await ctx.newPage();
    ctx.on("weberror", (e) =>
      emit({ kind: "warning", message: "页面脚本 · " + e.error().message }),
    );
    const frames = (p) =>
      p.on("framenavigated", (f) => {
        if (f.parentFrame()) {
          observed.frames++;
          emit({ kind: "frame", url: f.url(), message: "子页面导航" });
        }
      });
    frames(page);
    ctx.on("page", frames);
    const track = (job) => {
      pending.add(job);
      job.catch(() => {}).finally(() => pending.delete(job));
    };
    await ctx.route("**/*", async (route) => {
      try {
        const req = route.request();
        if (req.method() === "GET" && reusable(req)) {
          const k = cache.key(req.url(), await req.allHeaders(), profile),
            cached = cache.get(k);
          if (cached) {
            hits.add(req);
            await route.fulfill(cached);
            return;
          }
        }
        await route.continue();
      } catch (e) {
        emit({
          kind: "warning",
          message: "请求拦截回退 · " + e.message.split("\n")[0],
        });
        await route.continue().catch(() => {});
      }
    });
    ctx.on("request", (r) => {
      if (r.method() === "GET") {
        seen.add(r.url());
        observed.serial++;
      }
      emit({
        kind: "request",
        method: r.method(),
        url: r.url(),
        message: "请求中",
      });
    });
    ctx.on("requestfailed", (r) =>
      emit({
        kind: "failed",
        method: r.method(),
        url: r.url(),
        message: r.failure()?.errorText,
      }),
    );
    function collect(body, type, url) {
      for (const u of references(body.toString("utf8"), type, url))
        if (queue.size < 5000) queue.add(u);
    }
    ctx.on("response", (r) => {
      const req = r.request(),
        url = r.url(),
        hit = hits.has(req),
        status = r.status();
      emit({
        kind: "response",
        method: req.method(),
        url,
        status,
        frame: frameUrl(req),
        source: hit ? "cache" : "network",
        message: hit ? "本地缓存" : "网络响应",
      });
      if (req.method() !== "GET" || status !== 200) return;
      track(
        (async () => {
          const h = await r.allHeaders(),
            type = h["content-type"] || "",
            size =
              Number(h["content-length"]) ||
              (reusable(req) && cache.policy(h)
                ? (await req.sizes().catch(() => ({}))).responseBodySize
                : 0);
          const parse =
            cfg.extraGets &&
            parseable(type) &&
            (!size || size <= 2 * 1024 ** 2);
          const key =
            !hit &&
            reusable(req) &&
            cache.policy(h) &&
            size > 0 &&
            size <= 16 * 1024 ** 2
              ? cache.key(url, await req.allHeaders(), profile)
              : null;
          if (parse || key) {
            const buf = await r.body();
            if (parse && buf.length <= 2 * 1024 ** 2) collect(buf, type, url);
            if (key) cache.put(key, h, buf);
          }
        })(),
      );
    });
    if (onPreviewReady) {
      let pendingFrame;
      onPreviewReady(() => {
        const target = ctx.pages().at(-1);
        if (!target || signal.aborted) return null;
        pendingFrame ||= target.screenshot({
          type: "jpeg", quality: 60, scale: "css", timeout: 1800,
        }).catch(() => null).finally(() => { pendingFrame = null; });
        return pendingFrame;
      });
    }
    const nav = await page.goto(row.url, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    if (!nav || nav.status() >= 400)
      throw Error("入口 HTTP " + (nav?.status() || "无响应"));
    observed.landing = page.url();
    await page.waitForTimeout(cfg.waitSeconds * 1000);
    if (signal.aborted) throw Error("已取消");
    if (cfg.explore) {
      for (const frame of page.frames()) {
        // Reveal explicitly lazy frames while preserving the game's initial viewport.
        const lazy = frame.locator("iframe[loading=lazy]");
        for (const item of (await lazy.all().catch(() => [])).slice(0, 8)) {
          await item.scrollIntoViewIfNeeded({ timeout: 600 }).catch(() => {});
        }
        if (await lazy.count().catch(() => 0))
          await frame.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      }
    }
    const clicks = cfg.explore
      ? await explore(page, ctx, cfg, signal, emit, learned, observed)
      : 0;
    if (!signal.aborted)
      await page.screenshot({ path: shot, timeout: 4000 }).catch(() => {});
    await Promise.race([Promise.allSettled([...pending]), sleep(1500)]);
    let extra = 0;
    for (const u of queue) {
      if (signal.aborted || extra >= cfg.extraGets) break;
      if (seen.has(u)) continue;
      seen.add(u);
      extra++;
      emit({ kind: "request", method: "GET", url: u, message: "静态候选" });
      try {
        const headers = {
          "accept-language": locale,
          "user-agent": device.userAgent || "GameTrail",
          referer: page.url(),
        };
        const cookies = await ctx.cookies(u);
        const key =
          !cookies.length && cache.key(u, headers, "supplement:" + profile);
        const cached = cache.get(key);
        if (cached) {
          emit({
            kind: "response",
            method: "GET",
            url: u,
            status: 200,
            source: "cache",
            message: "静态补抓 · 本地缓存",
          });
          if (parseable(cached.headers["content-type"] || ""))
            collect(cached.body, cached.headers["content-type"], u);
          continue;
        }
        const r = await ctx.request.get(u, {
          headers,
          timeout: 5000,
          maxRedirects: 0,
        });
        try {
          emit({
            kind: "response",
            method: "GET",
            url: u,
            status: r.status(),
            source: "supplement",
            message: "静态补抓",
          });
          const h = r.headers(),
            parse = parseable(h["content-type"] || "");
          if (r.status() === 200 && (parse || (key && cache.policy(h)))) {
            const b = await r.body();
            if (parse && b.length <= 2 * 1024 ** 2)
              collect(b, h["content-type"], u);
            if (!/html/i.test(h["content-type"] || "")) cache.put(key, h, b);
          }
        } finally {
          await r.dispose();
        }
      } catch (e) {
        emit({
          kind: "failed",
          method: "GET",
          url: u,
          message: e.message.split("\n")[0],
        });
      }
    }
    if (expired || signal.aborted) throw Error(expired ? "运行超时" : "已取消");
    return { clicks, frames: observed.frames, extra, uniqueGET: seen.size };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    await browser.close().catch(() => {});
  }
}
module.exports = { runOne };
