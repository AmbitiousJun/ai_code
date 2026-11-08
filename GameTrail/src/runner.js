process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";
const pw = require("playwright"),
  fs = require("node:fs"),
  path = require("node:path");
const { explore, sleep, loadEntry } = require("./explore");
const staticType = new Set(["script", "stylesheet", "image", "font", "media"]);
const assetExtension = /\.(?:js|mjs|css|json|wasm|bin|atlas|plist|zip|png|jpe?g|webp|avif|gif|svg|ktx2?|pvr|mp3|ogg|wav|m4a|mp4|webm|woff2?|ttf|otf)$/i;
const reusable = (req) =>
  staticType.has(req.resourceType()) || assetExtension.test(new URL(req.url()).pathname);
function frameUrl(req) {
  try {
    return req.frame().url();
  } catch {
    return undefined;
  }
}
// WebKit has no Playwright mute launch flag. Silence media playback and divert
// real-time Web Audio output while allowing the game's audio graph to keep running.
function muteWebKit() {
  const media = HTMLMediaElement.prototype;
  const muted = Object.getOwnPropertyDescriptor(media, "muted");
  Object.defineProperty(media, "muted", {
    ...muted,
    set() { muted.set.call(this, true); },
  });
  const play = media.play;
  media.play = function(...args) {
    muted.set.call(this, true);
    return play.apply(this, args);
  };
  document.addEventListener("play", event => {
    if (event.target instanceof HTMLMediaElement) muted.set.call(event.target, true);
  }, true);

  const originalConnect = AudioNode.prototype.connect;
  const sinks = new WeakMap();
  for (const method of ["connect", "disconnect"]) {
    const original = AudioNode.prototype[method];
    AudioNode.prototype[method] = function(...args) {
      const context = this.context;
      if (context instanceof AudioContext && args[0] === context.destination) {
        if (!sinks.has(context)) {
          const sink = context.createGain();
          sink.gain.value = 0;
          // Use the native connect to reach the actual audio output.
          originalConnect.call(sink, context.destination);
          sinks.set(context, sink);
        }
        const destination = args[0];
        args[0] = sinks.get(context);
        const result = original.apply(this, args);
        return result === args[0] ? destination : result;
      }
      return original.apply(this, args);
    };
  }
}
async function runOne(row, cfg, cache, signal, emit, library, shot, onPreviewReady, manual) {
  const { device: d } = row;
  const opts = { headless: true };
  if (d.engine === "chromium" && !fs.existsSync(pw.chromium.executablePath()))
    opts.channel = "chrome";
  const browser = await pw[d.engine].launch(opts);
  const stop = () => browser.close().catch(() => {});
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    const { id, name, engine, defaultBrowserType, ...device } = d;
    const locale = row.vars.lang || d.locale || "en-US";
    const ctx = await browser.newContext({
      ...device,
      locale,
      serviceWorkers: "block",
    });
    if (engine === "webkit") await ctx.addInitScript(muteWebKit);
    // Headless Chromium includes --mute-audio in Playwright's launch arguments.
    const observed = { quietMs: (cfg.quietSeconds ?? 1) * 1000, hasTouch: !!d.hasTouch, active: new Set(), paths: new Set(), lastGET: 0, frames: 0, entry: row.url },
      seen = new Set(),
      pending = new Set(),
      hits = new WeakSet();
    if (cfg.explore && cfg.exploreMode === "source")
      await ctx.addInitScript(require("./frame-functions").installFrameScanner);
    else if (cfg.explore && !manual) await ctx.addInitScript(() => {
      const targets = new WeakSet();
      Object.defineProperty(window, "__gameTrailTargets", { value: targets });
      const register = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function(type, listener, options) {
        if (listener && this instanceof Element && ["click", "pointerup", "touchend"].includes(type))
          targets.add(this);
        return register.call(this, type, listener, options);
      };
    });
    const page = await ctx.newPage();
    if (manual?.install) await manual.install(ctx, page);
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
          const url = req.url(), headers = await req.allHeaders();
          const cached = !cache.bypassReason(url, headers) && cache.get(cache.key(url));
          if (cached) {
            hits.add(req);
            await route.fulfill(cached);
            return;
          }
        }
        await route.continue();
      } catch (e) {
        hits.delete(route.request());
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
        const url = new URL(r.url());
        const key = url.origin + url.pathname;
        if (!observed.paths.has(key)) {
          observed.paths.add(key);
          observed.active.add(r);
          observed.lastGET = Date.now();
        }
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
    function finished(r) {
      if (observed.active.delete(r)) observed.lastGET = Date.now();
    }
    ctx.on("requestfinished", finished);
    ctx.on("requestfailed", finished);
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
      if (hit || req.method() !== "GET" || status !== 200 || !reusable(req)) return;
      const decision = (message) => emit({kind: "cacheDecision", method: "GET", url, message});
      track(
        (async () => {
          const requestHeaders = await req.allHeaders();
          const bypass = cache.bypassReason(url, requestHeaders);
          if (bypass) return decision("跳过缓存 · " + bypass);
          const headers = await r.allHeaders();
          const key = cache.key(url);
          const ttl = cache.policy(headers, url);
          if (!ttl) {
            const reason = cache.responseRestricted(headers)
              ? "响应限制缓存" : "缺少有效期或已过期";
            return decision("跳过缓存 · " + reason);
          }
          const limit = Math.min(cache.cap, 16 * 1024 ** 2);
          let size = Number(headers["content-length"]);
          if (!Number.isFinite(size)) {
            if (await r.finished()) return decision("跳过缓存 · 下载未完成");
            size = (await req.sizes()).responseBodySize;
          }
          if (size > limit) return decision("跳过缓存 · 超出大小限制");
          const body = await r.body();
          if (!body.length || body.length > limit) return decision("跳过缓存 · 正文为空或超出大小限制");
          decision(cache.put(key, headers, body, ttl) ? "已写入本地缓存" : "未写入 · 已有条目或容量已调整");
        })().catch(() => decision("未写入 · 读取响应正文或缓存操作失败")),
      );
    });
    if (onPreviewReady) {
      let pendingFrame;
      onPreviewReady(() => {
        const target = manual?.previewMain ? page : ctx.pages().at(-1);
        if (!target || signal.aborted) return null;
        pendingFrame ||= target.screenshot({
          type: "jpeg", quality: 60, scale: "css", timeout: 1800,
        }).catch(() => null).finally(() => { pendingFrame = null; });
        return pendingFrame;
      });
    }
    await loadEntry(page, observed, cfg.waitSeconds, signal);
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
    let clicks = 0;
    if (manual) await manual.interact(page, observed);
    else if (cfg.explore) clicks = await explore(page, ctx, cfg, signal, emit, library, observed, row.phase);
    if (!signal.aborted)
      await page.screenshot({ path: shot, timeout: 4000 }).catch(() => {});
    await Promise.race([Promise.allSettled([...pending]), sleep(1500)]);
    signal.throwIfAborted();
    return { clicks, frames: observed.frames, uniqueGET: seen.size };
  } finally {
    signal.removeEventListener("abort", stop);
    await browser.close().catch(() => {});
  }
}
module.exports = { runOne };
