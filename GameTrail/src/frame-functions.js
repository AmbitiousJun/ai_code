// Installed in each document before the game's scripts run. Keep callable references
// in their original realm so closures and method receivers survive invocation.
function installFrameScanner() {
  const initial = new Set(Object.getOwnPropertyNames(window));
  const sourceOf = Function.prototype.toString;
  const evidence = /\bcreateElement\s*\(\s*["'`]iframe["'`]|<iframe\b|\bquerySelector\s*\(\s*["'`]iframe\b|\bgetElementsByTagName\s*\(\s*["']iframe["']|\bnew\s+cc\.WebView\b|\baddComponent\s*\(\s*cc\.WebView\b/i;
  const setFrameUrl = /(?:iframe|webview)\w*\s*\.\s*(?:src|url)\s*=(?!=)/i;
  const sourceCache = new WeakMap();
  function match(fn) {
    if (typeof fn !== "function") return false;
    if (!sourceCache.has(fn)) {
      const source = sourceOf.call(fn);
      sourceCache.set(fn, source.length <= 16000 && !/^class\s/.test(source) &&
        (evidence.test(source) || setFrameUrl.test(source)));
    }
    return sourceCache.get(fn);
  }
  const handlers = [];
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, fn, options) {
    const result = add.call(this, type, fn, options);
    if (handlers.length < 128 && ["click", "touchend", "pointerup"].includes(type) && match(fn))
      handlers.push({ owner: this, type, fn });
    return result;
  };
  let calls = new Map();
  function scan() {
    calls = new Map();
    const seen = new WeakMap();
    function consider(name, owner, fn, type, indirect = false) {
      if ((!indirect && !match(fn)) || (!type && fn.length) || calls.has(name)) return;
      if (!seen.has(owner)) seen.set(owner, new Set());
      if (seen.get(owner).has(fn)) return;
      seen.get(owner).add(fn);
      calls.set(name, () => fn.apply(owner, type ? [new Event(type)] : []));
    }
    function inspect(prefix, owner, obj, keys, global = false) {
      const methods = new Map();
      for (const key of keys) {
        const value = Object.getOwnPropertyDescriptor(obj, key)?.value;
        if (key !== "constructor" && typeof value === "function") methods.set(key, value);
      }
      const sinks = new Set();
      for (const [key, fn] of methods) {
        if (match(fn)) {
          sinks.add(key);
          consider(prefix + "." + key, owner, fn);
        }
      }
      if (!sinks.size) return;
      for (const [key, fn] of methods) {
        if (fn.length || sinks.has(key)) continue;
        const source = sourceOf.call(fn);
        if (source.length > 4000 || /^class\s/.test(source)) continue;
        // Limit delegation to a named call on the same receiver (or a global).
        const calls = global ? /(?:^|[^\w$.])(?:window\.)?([\w$]+)\s*\(/g :
          /\bthis\s*\.\s*([\w$]+)\s*\(/g;
        if (Array.from(source.matchAll(calls)).some(m => sinks.has(m[1])))
          consider(prefix + "." + key, owner, fn, undefined, true);
      }
    }
    const globals = Object.getOwnPropertyNames(window).filter(key => !initial.has(key));
    inspect("window", window, window, globals, true);
    let count = 0;
    for (const key of globals) {
      const obj = Object.getOwnPropertyDescriptor(window, key)?.value;
      try {
        if (!obj || typeof obj !== "object" || obj instanceof Node || Array.isArray(obj)) continue;
        inspect("window." + key, obj, obj, Object.getOwnPropertyNames(obj).slice(0, 1000));
        if (++count >= 256) break;
      } catch { /* A window proxy can deny inspection. */ }
    }
    const scene = window.cc?.director?.getScene?.();
    if (scene) {
      const stack = [[scene, "scene"]];
      for (let i = 0; stack.length && i < 8000; i++) {
        const [node, route] = stack.pop();
        for (const [j, component] of (node._components || []).entries()) {
          const proto = component && Object.getPrototypeOf(component);
          if (proto) inspect(route + ".component[" + j + "]", component, proto, Object.getOwnPropertyNames(proto));
        }
        (node.children || []).forEach((child, j) => stack.push([child, route + "/" + j]));
      }
    }
    for (const [i, h] of handlers.entries()) {
      if (!(h.owner instanceof Node) || h.owner.isConnected)
        consider("listener[" + i + "]." + h.type + "." + (h.fn.name || "anonymous"), h.owner, h.fn, h.type);
    }
    for (const [i, el] of Array.from(document.querySelectorAll("[onclick]")).entries())
      consider("onclick." + (el.id || i), el, el.onclick, "click");
    return [...calls.keys()];
  }
  Object.defineProperty(window, "__gameTrailFrameFunctions", { value: {
    scan,
    invoke(name) {
      const call = calls.get(name);
      if (!call) throw Error("函数已消失");
      // A game's promise can outlive the navigation observation window.
      Promise.resolve(call()).catch(err => console.warn("GameTrail", String(err)));
    },
  } });
}

async function exploreFrameFunctions({ ctx, cfg, phase, signal, emit, library, reset, settle, observed, frameRoute }) {
  async function scan() {
    const result = [];
    for (const [tab, page] of ctx.pages().entries()) {
      for (const frame of page.frames()) {
        signal.throwIfAborted();
        const names = await frame.evaluate(() => window.__gameTrailFrameFunctions.scan()).catch(err => {
          signal.throwIfAborted();
          emit({ kind: "warning", message: "无法扫描 frame 函数 · " + err.message.split("\n")[0] });
          return [];
        });
        for (const name of names)
          result.push({ frame, step: { kind: "FrameFunction", name, tab, route: frameRoute(frame) } });
      }
    }
    return result;
  }
  let candidates = await scan();
  const replay = phase === "replay";
  const steps = replay ? library.map(p => p.steps[0]) : candidates.slice(0, cfg.actions).map(c => c.step);
  if (!steps.length) emit({ kind: "action", message: replay ? "没有已验证的 iframe 函数可重放" : "未找到可直接调用的 iframe 函数" });
  const start = replay ? observed.progress.path : 0;
  for (let i = start; i < steps.length; i++) {
    if (replay) observed.progress.path = i;
    const step = steps[i];
    signal.throwIfAborted();
    if (i > start) {
      await reset();
      candidates = await scan();
    }
    const target = candidates.find(c => c.step.tab === step.tab && c.step.route === step.route && c.step.name === step.name);
    if (!target) {
      emit({ kind: "warning", message: "找不到 iframe 函数 · " + step.name });
      continue;
    }
    const { frame } = target;
    const page = frame.page();
    let url;
    function navigated(child) {
      if (!/^https?:/.test(child.url())) return;
      for (let parent = child.parentFrame(); parent; parent = parent.parentFrame()) {
        if (parent === frame) { url ||= child.url(); break; }
      }
    }
    emit({ kind: "action", message: (replay ? "重放" : "尝试") + " iframe 函数 · " + step.name });
    observed.paths.clear();
    page.on("framenavigated", navigated);
    try {
      await frame.evaluate(name => window.__gameTrailFrameFunctions.invoke(name), step.name);
      const until = Date.now() + 4000;
      while (!url && Date.now() < until) {
        signal.throwIfAborted();
        await page.waitForTimeout(100);
      }
      if (url) {
        await settle();
        if (!replay) library.push({ steps: [step] });
        emit({ kind: "action", url, message: "已观察到子页面导航 · " + step.name });
      } else emit({ kind: replay ? "warning" : "action", message: "未观察到子页面导航 · " + step.name });
    } catch (err) {
      signal.throwIfAborted();
      emit({ kind: "warning", message: "函数调用失败 · " + step.name + " · " + err.message.split("\n")[0] });
    } finally {
      page.off("framenavigated", navigated);
    }
  }
  return 0; // Direct invocations do not contribute to the physical click count.
}
module.exports = { installFrameScanner, exploreFrameFunctions };
