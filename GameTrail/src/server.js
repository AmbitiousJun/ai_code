process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";
const http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { Cache } = require("./cache"),
  { defaults, presets, plan } = require("./config"),
  { runOne } = require("./runner");
const { runManual, ManualPrompt } = require("./manual");
let manualPrompt;
const root =
  process.env.GAMETRAIL_DATA ||
  path.join(
    os.homedir(),
    process.platform === "darwin"
      ? "Library/Application Support/GameTrail"
      : ".gametrail",
  );
const reports = path.join(root, "reports"),
  settings = path.join(root, "settings.json");
fs.mkdirSync(reports, { recursive: true });
// An exclusive transaction in a separate DB releases automatically on process exit.
const { DatabaseSync } = require("node:sqlite");
const lock = new DatabaseSync(path.join(root, "instance.sqlite"));
try {
  lock.exec("BEGIN IMMEDIATE");
} catch {
  try {
    const url = fs.readFileSync(path.join(root, "address"), "utf8");
    if (/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) openUi(url);
  } catch {}
  console.error("该数据目录已有 GameTrail 进程");
  process.exit(1);
}
function openUi(url) {
  if (!process.env.GAMETRAIL_NO_OPEN) {
    const child =
      process.platform === "win32"
        ? spawn("rundll32", ["url.dll,FileProtocolHandler", url])
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url]);
    child.on("error", () => {});
  }
}
const cache = new Cache(path.join(root, "cache"));
let preview = null,
  current = null,
  ctrl = null;
function start(cfg) {
  delete cfg.labels;
  delete cfg.extraGets;
  if (current?.status === "running") throw Error("已有任务正在运行");
  const rows = plan(cfg),
    id = new Date().toISOString().replace(/[:.]/g, "-"),
    dir = path.join(reports, id);
  fs.mkdirSync(dir);
  fs.writeFileSync(settings, JSON.stringify(cfg, null, 2));
  current = {
    id,
    status: "running",
    total: rows.length,
    done: 0,
    active: "",
    events: [],
    seq: 0,
    runs: [],
    success: new Map(),
    errors: 0,
    cacheHits: 0,
  };
  ctrl = new AbortController();
  const job = current,
    signal = ctrl.signal,
    groups = new Map();
  manualPrompt = new ManualPrompt(signal, view => { job.manual = view; });
  const record = (e) => {
    const event = { seq: ++job.seq, time: new Date(Date.now() + 8 * 3600000).toISOString().replace("Z", "+08:00"), ...e };
    job.events.push(event);
    if (job.events.length > 2000) job.events.shift();
    fs.appendFileSync(
      path.join(dir, "events.ndjson"),
      JSON.stringify(event) + "\n",
    );
    if (e.kind === "failed" || e.status >= 400) job.errors++;
    if (e.source === "cache") job.cacheHits++;
    if (e.kind === "response" && e.method === "GET" && e.status === 200) {
      let s = job.success.get(e.url);
      if (!s) {
        s = { url: e.url, runs: new Set(), sources: new Set() };
        job.success.set(e.url, s);
      }
      s.runs.add(e.run);
      s.sources.add(e.source);
    }
  };
  (async () => {
    for (const [i, row] of rows.entries()) {
      if (signal.aborted) break;
      const run = i + 1,
        label = [Object.values(row.vars).join(" / "), row.device.name]
          .filter(Boolean)
          .join(" · ");
      if (!groups.has(row.group)) groups.set(row.group, []);
      const library = groups.get(row.group);
      const groupLabel = row.primary ? row.primary + "=" + row.group : "环境 " + row.group;
      const phaseLabel = row.phase === "record" ? "手动录入" : row.phase === "discover" ? "发现路径" : row.phase === "replay" ? "重放路径" : "加载资源";
      job.active = [groupLabel, phaseLabel, label].join(" · ");
      job.paths = { groupLabel, phaseLabel, count: library.length };
      let issues = 0;
      const emit = (e) => {
        if (e.kind === "warning" || e.kind === "failed" || e.status >= 400)
          issues++;
        if (e.kind === "action") {
          job.paths.count = library.length;
          job.paths.activity = e.message;
        }
        record({ run, ...e });
      };
      const summary = {
        run,
        label,
        url: row.url,
        device: row.device.id,
        vars: row.vars, group: row.group, phase: phaseLabel,
      };
      const shot = path.join(dir, run + ".png");
      emit({ kind: "run", message: job.active });
      const isManual = cfg.explore && cfg.exploreMode === "manual";
      const execute = isManual ? runManual : runOne;
      const extraArgs = isManual ? [manualPrompt] : [];
      const capturePreview = capture => { preview = { jobId: id, run, capture }; };
      try {
        Object.assign(
          summary,
          await execute(row, cfg, cache, signal, emit, library, shot, capturePreview, ...extraArgs),
          { status: "完成" },
        );
      } catch (e) {
        summary.status = signal.aborted ? "取消" : "失败";
        summary.error = e.message;
        emit({ kind: "warning", message: e.message.split("\n")[0] });
      }
      preview = null;
      summary.issues = issues;
      if (summary.status === "完成" && issues)
        summary.status = "完成（有异常）";
      if (fs.existsSync(shot)) summary.screenshot = run + ".png";
      job.runs.push(summary);
      job.done++;
    }
    job.status = signal.aborted
      ? "cancelled"
      : job.runs.some((r) => r.status !== "完成")
        ? "partial"
        : "complete";
  })()
    .catch((e) => {
      job.status = "partial";
      record({ kind: "warning", message: e.message });
    })
    .finally(() => {
      job.active = "";
      fs.writeFileSync(
        path.join(dir, "report.json"),
        JSON.stringify(
          {
            id,
            status: job.status,
            total: job.total,
            done: job.done,
            runs: job.runs,
            primaryVariable: rows[0].primary,
            pathGroups: [...groups].map(([value, paths]) => ({ value, paths })),
            errors: job.errors,
            resources: [...job.success.values()].map((s) => ({
              ...s,
              runs: [...s.runs],
              sources: [...s.sources],
            })),
          },
          null,
          2,
        ),
      );
    });
  return { id };
}
function completedReports() {
  return fs.readdirSync(reports, { withFileTypes: true })
    .filter(entry => entry.isDirectory() &&
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(entry.name) &&
      fs.existsSync(path.join(reports, entry.name, "report.json")))
    .map(entry => entry.name).sort().reverse();
}
async function body(req) {
  let raw = "";
  for await (const c of req) {
    raw += c;
    if (raw.length > 200000) throw Error("配置过大");
  }
  return JSON.parse(raw || "{}");
}
function state(after) {
  if (!current) return null;
  const { events, success, ...s } = current;
  return {
    ...s,
    success: success.size,
    events: events.filter((e) => e.seq > after).slice(0, 400),
  };
}
const server = http.createServer(async (req, res) => {
  function json(v, status = 200) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(v));
  }
  try {
    const host = req.headers.host;
    if (
      !/^127\.0\.0\.1:\d+$/.test(host) ||
      (req.headers.origin && req.headers.origin !== "http://" + host)
    )
      return json({ error: "仅接受本机同源访问" }, 403);
    const u = new URL(req.url, "http://" + host),
      p = u.pathname;
    if (req.method === "POST") {
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return json({ error: "需要 JSON" }, 415);
      const data = await body(req);
      if (p === "/api/start") return json(start({ ...defaults, ...data }));
      if (p === "/api/plan")
        return json({ total: plan({ ...defaults, ...data }).length });
      if (p === "/api/record-input") {
        const page = manualPrompt?.recordPage;
        if (!page || !manualPrompt?.view?.session || manualPrompt.view.token !== data.token)
          throw Error("录制已结束");
        if (manualPrompt.inputBusy) throw Error("请等待当前操作完成");
        if (data.mode === "pause" || data.mode === "resume") {
          manualPrompt.view.paused = data.mode === "pause";
          manualPrompt.view.note = manualPrompt.view.paused ? "已暂停录入。可操作游戏返回上一步，再按 F 框选按钮。" : "正在录制当前预览页面";
          return json({ok:true});
        }
        manualPrompt.inputBusy = true;
        try {
          if (data.mode === "pixels") {
            const {rgb,width,height,viewWidth,viewHeight} = data.template;
            await manualPrompt.recordPixels({rgb,width,height,viewWidth,viewHeight});
            return json({ok:true});
          }
          const size = page.viewportSize();
          if (!size || ![data.x, data.y].every(n => Number.isFinite(n) && n >= 0 && n < 1))
            throw Error("操作位置无效");
          const x = data.x * size.width, y = data.y * size.height;
          if (manualPrompt.hasTouch) await page.touchscreen.tap(x, y);
          else await page.mouse.click(x, y);
          return json({ok:true});
        } finally { manualPrompt.inputBusy = false; }
      }
      if (p === "/api/manual") {
        if (!manualPrompt?.submit) throw Error("当前没有待处理的录入操作");
        manualPrompt.submit(data);
        return json({ok:true});
      }
      if (p === "/api/stop") {
        ctrl?.abort();
        return json({ ok: true });
      }
      if (p === "/api/quit") {
        if (current?.status === "running")
          throw Error("请先停止正在运行的任务");
        json({ ok: true });
        server.close();
        return;
      }
      if (p === "/api/history/delete") {
        const available = new Set(completedReports());
        if (!Array.isArray(data.ids) || !data.ids.length ||
            data.ids.some(id => !available.has(id)))
          return json({ error: "请选择已完成的任务报告，刷新后重试" }, 400);
        for (const id of new Set(data.ids))
          fs.rmSync(path.join(reports, id), { recursive: true });
        return json({ ok: true });
      }
      if (p === "/api/cache") {
        if (data.clear) cache.clear();
        else cache.resize(data.cap);
        return json(cache.stats());
      }
    }
    if (p === "/api/record-state") {
      const view = manualPrompt?.view;
      return json(view?.session && view.session === u.searchParams.get("session")
        ? {token:view.token, note:view.note, paused:!!view.paused, job:current.id, run:current.done+1}
        : null);
    }
    if (req.method === "GET" && p === "/api/preview") {
      const frame = preview;
      const matches = frame && frame.jobId === u.searchParams.get("job") &&
        frame.run === Number(u.searchParams.get("run"));
      const jpeg = matches && await frame.capture();
      res.setHeader("Cache-Control", "no-store");
      if (!jpeg || frame !== preview || ctrl.signal.aborted) {
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      return res.end(jpeg);
    }
    if (p === "/api/config") {
      return json({
        version: require("../package.json").version,
        presets,
        settings: fs.existsSync(settings)
          ? { ...defaults, ...JSON.parse(fs.readFileSync(settings)) }
          : defaults,
      });
    }
    if (p === "/api/state")
      return json({
        job: state(Number(u.searchParams.get("after")) || 0),
        cache: cache.stats(),
      });
    if (p === "/api/history")
      return json(completedReports());
    let file, mt;
    if (
      /^\/reports\/[\dTZ-]+\/(report\.json|events\.ndjson|\d+\.png)$/.test(p)
    ) {
      file = path.join(root, p);
      mt = p.endsWith(".png")
        ? "image/png"
        : p.endsWith(".json")
          ? "application/json"
          : "application/x-ndjson";
    } else if (["/", "/record.html", "/record.js", "/app.js", "/style.css"].includes(p)) {
      file = path.join(
        __dirname,
        "../ui",
        p === "/" ? "index.html" : p.slice(1),
      );
      mt =
        (p === "/" || p.endsWith(".html"))
          ? "text/html"
          : p.endsWith(".js")
            ? "application/javascript"
            : "text/css";
    }
    if (!file || !fs.existsSync(file)) return json({ error: "未找到" }, 404);
    res.writeHead(200, {
      "Content-Type": mt,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    json({ error: e.message }, 400);
  }
});
server.listen(Number(process.env.PORT || 0), "127.0.0.1", () => {
  const url = "http://127.0.0.1:" + server.address().port;
  console.log("GameTrail " + url + "\n数据目录 " + root);
  fs.writeFileSync(path.join(root, "address"), url);
  openUi(url);
});
