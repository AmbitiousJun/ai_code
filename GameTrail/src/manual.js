const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { installManualActions } = require("./manual-actions");
const { locatePixels } = require("./pixel-button");
const { defaults } = require("./config");
const { runOne } = require("./runner");

function address(url, lang) {
  const u = new URL(url);
  const parts = u.pathname.split("/").map(p => lang && p === encodeURIComponent(lang) ? "{lang}" : p);
  return u.origin + parts.join("/");
}
function frameKey(frame, lang) {
  if (frame.name()) return { name: frame.name() };
  return { path: address(frame.url(), lang) };
}
function sameKey(frame, key, lang) {
  const actual = frameKey(frame, lang);
  return key.name ? actual.name === key.name : actual.path === key.path;
}
function routeOf(frame, lang) {
  const route = [];
  while (frame.parentFrame()) {
    const key = frameKey(frame, lang);
    const parent = frame.parentFrame();
    if (parent.childFrames().filter(f => sameKey(f, key, lang)).length !== 1)
      throw Error("子页面无法唯一定位");
    route.unshift(key);
    frame = parent;
  }
  return route;
}
function resolveFrame(page, route, lang) {
  let frame = page.mainFrame();
  for (const key of route) {
    const matches = frame.childFrames().filter(f => sameKey(f, key, lang));
    if (matches.length !== 1) return;
    frame = matches[0];
  }
  return frame;
}
function watchFrames(page, lang, callback) {
  const listener = f => {
    if (f.parentFrame() && /^https?:/.test(f.url())) {
      callback(address(f.url(), lang));
    }
  };
  page.on("framenavigated", listener);
  return () => page.off("framenavigated", listener);
}
async function replay(page, path, signal, emit, observed, lang, cfg = defaults) {
  const seen = new Set();
  const stop = watchFrames(page, lang, url => seen.add(url));
  try {
    for (const [i, step] of path.steps.entries()) {
      const until = Date.now() + (step.pixels ? cfg.pixelTimeout ?? defaults.pixelTimeout : 15) * 1000;
      let ok = false;
      observed.paths.clear();
      while (!ok && Date.now() < until) {
        signal.throwIfAborted();
        if (step.pixels) {
          const timeout = Math.max(1, Math.min(3000, until - Date.now()));
          const point = await locatePixels(page, step.pixels, cfg.pixelSimilarity, timeout)
            .catch(err => { if (err.name !== "TimeoutError") throw err; });
          signal.throwIfAborted();
          if (point && Date.now() < until) {
            await clickPoint(page, point, observed.hasTouch);
            ok = true;
            const similarity = (100 * (1 - point.score / 255)).toFixed(1);
            emit({kind:"action",message:"已匹配像素图并点击 · " + step.name + " · 相似度 " + similarity + "%"});
          }
        } else {
          const frame = resolveFrame(page, step.route, lang);
          if (frame) ok = await frame.evaluate(s => window.__gtManual.invoke(s), step);
        }
        if (!ok) await delay(Math.max(0, Math.min(200, until - Date.now())), undefined, { signal });
      }
      if (!ok) throw Error("第 " + (i + 1) + (step.pixels ? " 步等待唯一截图匹配超时 · " : " 步无法定位 · ") + step.name);
      emit({ kind: "action", message: "已调用第 " + (i + 1) + " 步 · " + step.name });
      if (path.steps[i + 1]?.pixels) continue;
      const start = Date.now();
      while (observed.active.size || Date.now() - Math.max(start, observed.lastGET) < observed.quietMs) {
        if (Date.now() - start > 45000) throw Error("第 " + (i + 1) + " 步等待 GET 超时");
        await delay(100, undefined, { signal });
      }
    }
    const until = Date.now() + 12000;
    for (const url of path.frames) {
      while (!seen.has(url) && Date.now() < until) await delay(150, undefined, { signal });
      if (!seen.has(url)) throw Error("未重现录制中的子页面 · " + url);
    }
  } finally { stop(); }
}

// Only the current prompt accepts commands. A reload or delayed second click
// cannot submit an old decision to a different game or recording.
async function clickPoint(page, point, touch) {
  if (touch) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
}

class ManualPrompt {
  constructor(signal, update) { this.signal = signal; this.update = update; }
  offer(view, allowed, receive) {
    const token = randomUUID();
    const clear = () => {
      if (this.view?.token !== token) return;
      this.submit = null;
      this.view = null;
      this.update(null);
    };
    this.submit = cmd => {
      if (cmd.token !== token || !allowed.includes(cmd.action) ||
          (cmd.action === "trial" && (!Number.isInteger(cmd.index) || !view.paths[cmd.index])))
        throw Error("操作已过期，请刷新");
      if (this.inputBusy) throw Error("请等待当前点击完成");
      clear();
      receive(cmd);
    };
    this.view = { ...view, token, allowed };
    this.update(this.view);
    return clear;
  }
  ask(view, allowed) {
    this.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => { clear(); reject(Error("已取消")); };
      const clear = this.offer(view, allowed, cmd => {
        this.signal.removeEventListener("abort", abort);
        resolve(cmd);
      });
      this.signal.addEventListener("abort", abort, { once: true });
    });
  }
}

async function runManual(row, cfg, cache, signal, emit, library, shot, preview, prompt) {
  const lang = row.vars.lang;
  const urls = new Set();
  let frames = 0, replayedPaths = 0;
  const log = e => {
    if (e.kind === "request" && e.method === "GET") urls.add(e.url);
    if (e.kind === "frame") frames++;
    emit(e);
  };
  const launch = (hooks, runSignal = signal) => runOne(row, cfg, cache, runSignal, log, library, shot, preview, hooks);
  const list = () => library.map((p,i) => "路径 " + (i+1) + " · " + p.steps.map(s => s.name).join(" → "));
  if (row.phase === "record") {
    let action = "open", draft, index, note = "";
    while (action !== "done") {
      let recording = false;
      let stopWatching, pixelIndex = -1, pixelBindings = 0;

      const testing = action === "verify" || action === "trial";
      const path = action === "trial" ? library[index] : draft;
      const restart = new AbortController();
      const runSignal = AbortSignal.any([signal, restart.signal]);
      const rerecord = () => {
        const oldIndex = library.indexOf(path);
        if (oldIndex >= 0) library.splice(oldIndex, 1);
        draft = undefined;
        action = "open";
        note = "已重新打开入口，准备好后点击“录入当前画面”。";
        emit({kind:"action", message:"从入口重新录制当前路径"});
      };
      let clearReplayControl;
      if (testing) {
        const message = "正在从入口试播路径";
        emit({kind:"action", message});
        clearReplayControl = prompt.offer({note:message, paths:list()}, ["rerecord"], () => {
          rerecord();
          restart.abort();
        });
      }
      const hooks = {
        previewMain: true,
        async install(ctx, page) {
          await ctx.addInitScript(installManualActions);

          await ctx.exposeBinding("__gtReport", ({frame, page: source}, step) => {
            if (!recording || !draft || prompt.view?.paused) return;
            if (pixelIndex >= 0 && step.error) return;
            try {
              if (source !== page) throw Error("暂不支持新标签页中的操作");
              if (step.error) throw Error(step.error);
              if (!["CocosBinding","DOMAction"].includes(step.kind) || typeof step.name !== "string")
                throw Error("无法识别的动作");
              if (pixelIndex >= 0) {
                const pixels = draft.steps[pixelIndex].pixels;
                if (++pixelBindings === 1) {
                  draft.steps[pixelIndex] = { ...step, route:routeOf(frame, lang), pixels };
                  return "已录入 · " + step.name + "（按截图重放）";
                }
                // A single physical click dispatched several handlers. One image
                // click lets the game dispatch all of them exactly once on replay.
                draft.steps[pixelIndex] = {kind:"PixelButton", name:"框选按钮 " + (pixelIndex+1), route:[], pixels};
                return;
              }
              if (draft.steps.length >= 100) throw Error("单条路径最多 100 个动作");
              draft.steps.push({ ...step, route: routeOf(frame, lang) });
              if (prompt.view) prompt.view.note = "已录入 " + draft.steps.length + " 步 · " + step.name;
              emit({kind:"action", message:"已录入 · " + step.name});
              return "已录入 · " + step.name;
            } catch (err) {
              draft.skipped++;
              const note = "已跳过此步 · " + err.message + "。路径可能无法完整重放，可继续录入；也可点“暂停录入”，在游戏中退回上一步，再按 F 框选按钮。";
              if (prompt.view) prompt.view.note = note;
              emit({kind:"action", message:note});
              return note;
            }
          });
        },
        async interact(page, observed) {
          let prefix;
          if (testing) {
            try {
              await replay(page, path, runSignal, emit, observed, lang, cfg);
              runSignal.throwIfAborted();
              prefix = path;
              replayedPaths++;
              if (action === "verify") library.push(path);
              note = "入口试播通过 · " + path.steps.length + " 个动作，" + path.frames.length + " 个子页面地址" + (path.skipped ? "，录入时跳过 " + path.skipped + " 步" : "");
              emit({kind:"action",message:note});
            } catch (err) {
              runSignal.throwIfAborted();
              note = "入口试播失败 · " + err.message.split("\n")[0];
              emit({kind:"warning",message:note});
            }
          }
          const options = ["done"];
          if (action === "open" || prefix) options.unshift("record");
          if (testing) options.push("rerecord", "reset");
          if (library.length) options.push("trial");
          const cmd = await prompt.ask({note, paths:list()}, options);
          if (cmd.action === "rerecord") {
            rerecord();
            return;
          }
          index = cmd.index;
          if (cmd.action !== "record") {
            action = cmd.action === "reset" ? "open" : cmd.action;
            if (action === "open") note = "";
            return;
          }
          // Stay inside this runOne invocation: the preview's page and JS heap are live.
          draft = {steps:[...(prefix?.steps || [])], frames:[...(prefix?.frames || [])], skipped:prefix?.skipped || 0};
          const initialSteps = draft.steps.length;
          recording = true;
          stopWatching = watchFrames(page, lang, url => {
            if (!prompt.view?.paused && (draft.steps.length > initialSteps || draft.skipped > (prefix?.skipped || 0)) && !draft.frames.includes(url)) draft.frames.push(url);
          });
          prompt.recordPage = page;
          prompt.hasTouch = !!row.device.hasTouch;
          prompt.recordPixels = async template => {
            if (draft.steps.length >= 100) throw Error("单条路径最多 100 个动作");
            const point = await locatePixels(page, template, cfg.pixelSimilarity);
            if (!point) throw Error("无法唯一匹配选区，请框入更有辨识度的完整图案");
            const wasPaused = prompt.view.paused;
            prompt.view.paused = false;
            pixelBindings = 0;
            pixelIndex = draft.steps.length;
            draft.steps.push({kind:"PixelButton", name:"框选按钮 " + (pixelIndex+1), route:[], pixels:template});
            try {
              await clickPoint(page, point, prompt.hasTouch);
              await delay(250, undefined, {signal});
              const step = draft.steps[pixelIndex];
              prompt.view.note = "已录入 · " + step.name + (step.kind === "PixelButton" ? "（像素匹配）" : "（按截图重放）");
              emit({kind:"action",message:prompt.view.note});
            } catch (err) {
              draft.steps.splice(pixelIndex);
              if (prompt.view) prompt.view.paused = wasPaused;
              throw err;
            } finally { pixelIndex = -1; }
          };
          try {
            const decision = await prompt.ask({session:cmd.token, note:"正在录制当前预览页面", paths:list()}, ["finish","discard"]);
            await delay(200, undefined, {signal});
            if (decision.action === "finish" && draft.steps.length > initialSteps) {
              action = "verify";
              return;
            }
            note = decision.action === "discard" ? "已放弃这次录入" : "没有录到可重放的新动作";
            action = "open";
          } finally {
            recording = false;
            prompt.recordPixels = null;
            prompt.recordPage = null;
            stopWatching();
          }
        }
      };
      try {
        await launch(hooks, runSignal);
      } catch (err) {
        signal.throwIfAborted();
        if (!restart.signal.aborted) throw err;
      } finally {
        clearReplayControl?.();
      }
    }
  } else if (library.length) {
    for (const [i,path] of library.entries()) {
      try {
        emit({kind:"action",message:"批量重放路径 " + (i+1)});
        await launch({install: ctx => ctx.addInitScript(installManualActions),
          interact: (page, observed) => replay(page, path, signal, emit, observed, lang, cfg)});
        replayedPaths++;
      } catch (err) {
        signal.throwIfAborted();
        emit({kind:"warning",message:"批量重放路径 " + (i+1) + " 失败 · " + err.message.split("\n")[0]});
      }
    }
  } else {
    await launch({ interact: async () => {} });
  }
  return { clicks:0, replayedPaths, frames, uniqueGET:urls.size };
}
module.exports = { runManual, ManualPrompt, replay };
