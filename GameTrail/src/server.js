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
const {cachedPreview, captureMatchFrame} = require("./preview");
const previews = new Map();
let current = null,
  ctrl = null;
const {ReplayStore} = require("./replay-store");
const replayStore = new ReplayStore(path.join(root, "replays.sqlite"));
let replayRevision = 0;
function start(cfg, saved, full = false) {
  delete cfg.labels;
  delete cfg.extraGets;
  if (current?.status === "running") throw Error("已有任务正在运行");
  // Older checkpoints use environment indexes from the primary-first plan.
  const legacyOrder = saved && !full && !cfg.variableOrder;
  if (!legacyOrder) cfg.variableOrder ??= Object.keys(saved?.config.variables ?? cfg.variables);
  const planned = plan(cfg, legacyOrder);
  const firstReplay = planned.findIndex(row => row.phase === "replay");
  const startRow = saved && !full ? saved.rowIndex : 0;
  const rows = saved ? planned.slice(firstReplay + startRow).map((row,i) => ({
    ...row, replayIndex:startRow+i,
  })).filter(row => full || saved.progress.get(row.replayIndex) !== -1) : planned;
  const concurrency = cfg.replayConcurrency ?? new Set(planned.map(row => row.device.id)).size;
  const active = new Map();
  if (!rows.length) throw Error("已完成全部重放，可选择全量重跑");
  let groups = saved?.groups ?? new Map();
  if (saved && !rows[0].primary && cfg.recordedVariables) {
    // Legacy independent environments are numbered in the original plan's order.
    const identity = row => JSON.stringify([row.device.id, Object.keys(row.vars).sort().map(k => [k,row.vars[k]])]);
    const original = plan({...cfg, variables:cfg.recordedVariables, variableOrder:cfg.recordedVariableOrder}, !cfg.recordedVariableOrder);
    const byEnvironment = new Map(original.filter(row => row.phase === "replay")
      .map(row => [identity(row), saved.groups.get(row.group)]));
    groups = new Map(planned.slice(firstReplay).map(row => [row.group, byEnvironment.get(identity(row)) ?? []]));
  }
  const id = new Date().toISOString().replace(/[:.]/g, "-"),
    dir = path.join(reports, id);
  fs.mkdirSync(dir);
  if (!saved) fs.writeFileSync(settings, JSON.stringify(cfg, null, 2));
  if (saved && full) replayStore.restart(saved.id, cfg, rows.length);
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
    signal = ctrl.signal;
  if (saved) {
    job.replayId = saved.id;
    replayRevision++;
  }
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
    async function executeRow(i) {
      const row = rows[i];
      const run = i + 1,
        label = [Object.values(row.vars).join(" / "), row.device.name]
          .filter(Boolean)
          .join(" · ");
      if (!groups.has(row.group)) groups.set(row.group, []);
      const library = groups.get(row.group);
      const groupLabel = row.primary ? row.primary + "=" + row.group : "环境 " + row.group;
      const phaseLabel = row.phase === "record" ? "手动录入" : row.phase === "discover" ? "发现路径" : row.phase === "replay" ? "重放路径" : "加载资源";
      const title = [groupLabel, phaseLabel, label].join(" · ");
      const paths = { groupLabel, phaseLabel, count: library.length };
      active.set(run, {run, title, paths});
      const syncActive = () => {
        job.instances = [...active.values()];
        job.active = active.size > 1 ? active.size + " 个实例运行中" : job.instances[0]?.title || "";
        job.paths = active.size === 1 ? job.instances[0].paths : null;
      };
      syncActive();
      let issues = 0;
      const emit = (e) => {
        if (e.kind === "warning" || e.kind === "failed" || e.status >= 400)
          issues++;
        if (e.kind === "action") {
          paths.count = library.length;
          paths.activity = e.message;
        }
        if (e.diagnostic) (summary.diagnostics ||= []).push({message:e.message,file:e.diagnostic});
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
      emit({ kind: "run", message: title });
      const isManual = cfg.explore && cfg.exploreMode === "manual";
      const execute = isManual ? runManual : runOne;
      let checkpoint;
      if (isManual && row.phase === "replay") {
        if (!job.replayId) {
          job.replayId = replayStore.create(cfg, groups, planned.length - firstReplay, row.url);
          replayRevision++;
        }
        const index = row.replayIndex ?? (i - firstReplay);
        const advance = pathIndex => {
          replayStore.checkpoint(job.replayId, index, pathIndex);
          replayRevision++;
        };
        checkpoint = {
          pathIndex: saved && !full ? (saved.progress.get(index) ?? (index === startRow ? saved.pathIndex : 0)) : 0,
          advance,
          finish: () => advance(-1),
        };
      }
      const extraArgs = isManual ? [manualPrompt, checkpoint] : [];
      const capturePreview = capture => { previews.set(run, { jobId: id, run, read:cachedPreview(capture) }); };
      try {
        Object.assign(
          summary,
          await execute(row, cfg, cache, signal, emit, library, shot, capturePreview, ...extraArgs),
          { status: "完成" },
        );
      } catch (e) {
        // runManual handles individual replay failures. A checkpoint failure
        // must stop scheduling so the next attempt resumes at the saved path.
        if (checkpoint && library.length && !signal.aborted) throw e;
        summary.status = signal.aborted ? "取消" : "失败";
        summary.error = e.message;
        emit({ kind: "warning", message: e.message.split("\n")[0] });
      } finally {
        previews.delete(run);
        active.delete(run);
        syncActive();
      }
      if (checkpoint && !signal.aborted) checkpoint.finish();
      summary.issues = issues;
      if (summary.status === "完成" && issues)
        summary.status = "完成（有异常）";
      if (fs.existsSync(shot)) summary.screenshot = run + ".png";
      job.runs.push(summary);
      job.done++;
    }
    // Recording and discovery must finish before dependent environments start.
    for (let i = 0; i < rows.length && !signal.aborted;) {
      const phase = rows[i].phase;
      if (phase !== "load" && phase !== "replay") {
        await executeRow(i++);
        continue;
      }
      let end = i + 1;
      while (end < rows.length && rows[end].phase === phase &&
        (phase !== "replay" || rows[end].batch === rows[i].batch)) end++;
      const worker = async () => {
        try {
          while (!signal.aborted && i < end) await executeRow(i++);
        } catch (error) {
          ctrl.abort();
          throw error;
        }
      };
      const workers = Array.from({length:Math.min(concurrency,end-i)}, worker);
      const results = await Promise.allSettled(workers);
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
    }
    job.runs.sort((a,b) => a.run-b.run);
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
      if (job.replayId) replayRevision++;
      job.active = "";
      fs.writeFileSync(
        path.join(dir, "report.json"),
        JSON.stringify(
          {
            id,
            replayId: job.replayId,
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
function state(after, compact) {
  if (!current) return null;
  const { events, success, runs, ...s } = current;
  return {
    ...s,
    ...(compact ? {} : { runs }),
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
      if (p === "/api/start") {
        delete data.recordedVariables;
        delete data.recordedVariableOrder;
        return json(start({ ...defaults, ...data }));
      }
      if (p === "/api/replays/start") {
        if (!["all","continue"].includes(data.mode)) throw Error("重放方式无效");
        const task = replayStore.load(data.id);
        const cfg = {...task.config};
        if (Object.hasOwn(data, "replayConcurrency")) cfg.replayConcurrency = data.replayConcurrency;
        if (data.variables !== undefined) {
          if (data.mode !== "all") throw Error("只有全量重跑可以调整模板变量");
          if (!data.variables || typeof data.variables !== "object" || Array.isArray(data.variables))
            throw Error("模板变量格式无效");
          cfg.variables = data.variables;
        }
        const primary = cfg.primaryVariable ?? (cfg.template.includes("{gameId}") ? "gameId" : "");
        if (data.mode === "all" && !primary && !cfg.recordedVariables) {
          cfg.recordedVariables = task.config.variables;
          cfg.recordedVariableOrder = task.config.variableOrder;
        }
        return json(start(cfg, task, data.mode === "all"));
      }
      if (p === "/api/replays/rename" || p === "/api/replays/delete") {
        if (p.endsWith("/rename")) replayStore.rename(data.id, data.name);
        else replayStore.remove(data.ids, current?.status === "running" ? current.replayId : null);
        replayRevision++;
        return json({ok:true});
      }
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
            const {rgb,width,height,viewWidth,viewHeight,side,left,top,detail} = data.template;
            await manualPrompt.recordPixels({rgb,width,height,viewWidth,viewHeight,side,left,top,detail});
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
    if (req.method === "GET" && p === "/api/record-freeze") {
      const prompt = manualPrompt;
      const page = prompt?.recordPage;
      if (!page || !prompt.view?.session || prompt.view.token !== u.searchParams.get("token"))
        return json({error:"录制已结束"}, 409);
      const image = await captureMatchFrame(page, 3000);
      if (prompt.recordPage !== page) return json({error:"录制已结束"}, 409);
      res.writeHead(200, {"Content-Type":"image/jpeg","Cache-Control":"no-store"});
      return res.end(image);
    }
    if (p === "/api/record-state") {
      const view = manualPrompt?.view;
      return json(view?.session && view.session === u.searchParams.get("session")
        ? {token:view.token, note:view.note, paused:!!view.paused, job:current.id, run:current.done+1}
        : null);
    }
    if (req.method === "GET" && p === "/api/preview") {
      const run = Number(u.searchParams.get("run"));
      const frame = previews.get(run);
      const matches = frame && frame.jobId === u.searchParams.get("job");
      const recording = manualPrompt?.view?.session && u.searchParams.get("session") === manualPrompt.view.session;
      const jpeg = matches && !ctrl.signal.aborted && frame.read(recording ? 100 : 1000);
      res.setHeader("Cache-Control", "no-store");
      if (!jpeg || frame !== previews.get(run) || ctrl.signal.aborted) {
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "image/jpeg", "X-Frame-Time": String(jpeg.time) });
      return res.end(jpeg.bytes);
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
        replayRevision,
        job: state(Number(u.searchParams.get("after")) || 0, u.searchParams.has("compact")),
        cache: cache.stats(),
      });
    if (p === "/api/replays") return json(replayStore.list());
    if (p === "/api/replays/config") return json(replayStore.variables(u.searchParams.get("id")));
    if (p === "/api/history")
      return json(completedReports());
    let file, mt;
    if (
      /^\/reports\/[\dTZ-]+\/(report\.json|events\.ndjson|\d+\.png|match-[0-9a-f-]{36}\.svg)$/.test(p)
    ) {
      file = path.join(root, p);
      mt = p.endsWith(".svg") ? "image/svg+xml" : p.endsWith(".png")
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
