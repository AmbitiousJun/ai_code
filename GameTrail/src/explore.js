const { scanCanvas } = require("./ocr");
const { PNG } = require("playwright-core/lib/utilsBundle");

// Compare 8 CSS-pixel tiles in the visible canvas, including feedback away from the label.
async function observeCanvas(c, signal) {
  const page = c.frame.page();
  const canvas = c.frame.locator("canvas:visible").nth(Number(c.anchor));
  const box = await canvas.boundingBox({ timeout: 2000 });
  if (!box) throw Error("画布已移出画面");
  const viewport = page.viewportSize();
  const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
  const width = Math.min(viewport.width, Math.ceil(box.x + box.width)) - x;
  const height = Math.min(viewport.height, Math.ceil(box.y + box.height)) - y;
  if (width <= 0 || height <= 0) throw Error("画布已移出画面");
  const clip = { x, y, width, height };
  const columns = Math.ceil(width / 8), rows = Math.ceil(height / 8);
  async function capture() {
    signal.throwIfAborted();
    const png = PNG.sync.read(await page.screenshot({ clip, scale: "css", timeout: 3000 }));
    if (png.width !== width || png.height !== height) throw Error("画布采样尺寸已改变");
    const tiles = new Uint8Array(columns * rows * 3);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        let r = 0, g = 0, b = 0, count = 0;
        for (let py = row * 8; py < Math.min(height, row * 8 + 8); py += 2) {
          for (let px = col * 8; px < Math.min(width, col * 8 + 8); px += 2) {
            const i = (py * width + px) * 4;
            r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; count++;
          }
        }
        const k = (row * columns + col) * 3;
        tiles[k] = r / count; tiles[k + 1] = g / count; tiles[k + 2] = b / count;
      }
    }
    return tiles;
  }
  const baseline = await capture();
  const moving = new Uint8Array(columns * rows);
  function differs(a, b, k, tolerance) {
    return Math.abs(a[k] - b[k]) > tolerance || Math.abs(a[k+1] - b[k+1]) > tolerance ||
      Math.abs(a[k+2] - b[k+2]) > tolerance;
  }
  function learn(sample) {
    for (let k = 0; k < sample.length; k += 3) {
      if (differs(baseline, sample, k, 10)) moving[k / 3] = 1;
    }
  }
  // A shared no-input window lets slower slides advance before evaluating siblings.
  for (const delay of [350, 650, 1000, 1400, 1800]) {
    await page.waitForTimeout(delay);
    learn(await capture());
  }
  return {
    async beforeClick() {
      const before = await capture();
      learn(before);
      return async () => {
        const first = await capture();
        await page.waitForTimeout(300);
        const last = await capture();
        const adjacent = new Uint8Array(moving.length);
        for (let i = 0; i < moving.length; i++) {
          const k = i * 3;
          if (moving[i] || !differs(before, first, k, 18) || !differs(before, last, k, 18) ||
              differs(first, last, k, 12)) continue;
          adjacent[i] = 1;
          if ((i % columns && adjacent[i - 1]) || adjacent[i - columns]) return true;
        }
        // New motion seen on a rejected trial is noise for subsequent siblings too.
        learn(first); learn(last);
        return false;
      };
    }
  };
}

// Runs inside each frame. Keep a structural address for translated and unnamed buttons.
function candidates() {
  function address(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    const parent = el.parentElement;
    if (!parent) return el.localName;
    return address(parent) + ">" + el.localName + ":nth-child(" +
      (Array.prototype.indexOf.call(parent.children, el) + 1) + ")";
  }
  const ids = window.__gameTrailControlIds ||= { nodes: new WeakMap(), next: 0 };
  function nodeId(node) {
    if (!ids.nodes.has(node)) ids.nodes.set(node, ++ids.next);
    return ids.nodes.get(node);
  }
  const result = [];
  for (const el of document.querySelectorAll("*")) {
    if (el.matches(":disabled,[aria-disabled=true],canvas,iframe")) continue;
    const semantic = el.matches("button,a[href],[role=button],[role=link],[role=menuitem],[role=tab],summary,input:is([type=button],[type=submit],[type=image],[type=checkbox],[type=radio]),[onclick]") || typeof el.onclick === "function" || window.__gameTrailTargets?.has(el);
    if (!semantic && !(getComputedStyle(el).cursor === "pointer" &&
        (!el.parentElement || getComputedStyle(el.parentElement).cursor !== "pointer"))) continue;
    const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (!r.width || !r.height || !el.contains(document.elementFromPoint(x, y))) continue;
    const anchor = address(el);
    const name = el.getAttribute("aria-label") || el.innerText || el.title || el.value || el.id || anchor;
    result.push({ name: String(name).trim().slice(0, 120), kind: "DOM", nodeId: nodeId(el), anchor, x, y });
  }
  const cc = window.cc,
    canvas = document.querySelector("#GameCanvas,canvas");
  const scene = cc?.director?.getScene?.();
  if (scene && canvas && cc.view && !cc.view._isRotated) {
    const r = canvas.getBoundingClientRect(),
      vp = cc.view.getViewportRect?.();
    const stack = [scene];
    let count = 0;
    while (stack.length && count++ < 15000) {
      const n = stack.pop();
      if (!n.activeInHierarchy || n.opacity === 0) continue;
      for (const child of n.children || []) stack.push(child);
      const b = n.getComponent?.(cc.Button || "cc.Button");
      if (!b?.interactable || b.enabled === false) continue;
      const name = [
        n.name,
        ...(n.children || []).map((c) => c.getComponent?.("cc.Label")?.string),
      ].find(Boolean) || "Button";
      if (!name || !vp || !canvas.width || !canvas.height) continue;
      const box = n.getBoundingBoxToWorld?.();
      if (!box) continue;
      let p = cc.v2(box.x + box.width / 2, box.y + box.height / 2);
      const camera = cc.Camera?.findCamera?.(n);
      if (camera?.getWorldToScreenPoint) p = camera.getWorldToScreenPoint(p);
      const x =
        r.x + ((p.x * cc.view.getScaleX() + vp.x) * r.width) / canvas.width;
      const y =
        r.bottom -
        ((p.y * cc.view.getScaleY() + vp.y) * r.height) / canvas.height;
      if (document.elementFromPoint(x, y) === canvas) {
          let node = n;
          const route = [];
          while (node.parent) {
            route.unshift(node.parent.children.indexOf(node));
            node = node.parent;
          }
          result.push({ name, kind: "Cocos", nodeId: nodeId(n), anchor: route.join("/"), x, y });
        }
    }
  }
  return { controls: result, documentId: performance.timeOrigin };
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
function frameRoute(frame) {
  const route = [];
  while (frame.parentFrame()) {
    const parent = frame.parentFrame();
    route.unshift(parent.childFrames().indexOf(frame));
    frame = parent;
  }
  return route.join("/");
}
async function scan(ctx, signal) {
  const all = [];
  for (const [tab, page] of ctx.pages().entries()) {
    for (const frame of page.frames()) {
      signal.throwIfAborted();
      const { controls, documentId } = await frame.evaluate(candidates).catch(() => ({ controls: [] }));
      const words = await scanCanvas(frame).catch(() => []);
      for (const c of [...controls, ...words]) {
        if (c.kind === "Icon" && controls.some(item => Math.hypot(item.x-c.x,item.y-c.y) < 10)) continue;
        if (c.kind === "OCR" && all.some(item => item.frame === frame &&
          Math.hypot(item.x - c.x, item.y - c.y) < 4)) continue;
        all.push({ ...c, frame, documentId, route: frameRoute(frame), tab });
      }
    }
  }
  return all;
}
function stepOf({ frame, documentId, nodeId, ...step }) { return step; }
function sameButton(a, b) {
  if (!a || a.frame !== b.frame || a.documentId !== b.documentId || a.kind !== b.kind) return false;
  if (a.kind === "Icon") return a.anchor === b.anchor && matchesIcon(a,b,0.025);
  if (a.kind !== "OCR") {
    return a.nodeId === b.nodeId || (a.anchor === b.anchor && a.name === b.name);
  }
  const label = s => s.normalize("NFKC").replace(/[\s☐☑✓✔]/gu, "");
  return a.anchor === b.anchor && label(a.name) === label(b.name) &&
    Math.abs(a.rx - b.rx) <= Math.max(0.005, Math.min(a.rw, b.rw) / 2) &&
    Math.abs(a.ry - b.ry) <= Math.max(0.005, Math.min(a.rh, b.rh) / 2);
}
function matchesIcon(a, b, radius) {
  if (Math.hypot(a.rx-b.rx, a.ry-b.ry) > radius) return false;
  let differences = 0;
  for (let i = 0; i < a.shape.length; i++) if (a.shape[i] !== b.shape[i]) differences++;
  return differences <= 5;
}
function locate(all, step) {
  const peers = all.filter(c => c.kind === step.kind && c.route === step.route && c.tab === step.tab);
  const same = peers.filter(c => c.anchor === step.anchor);
  if (step.kind === "Icon") {
    const matches = same.filter(c => matchesIcon(c,step,0.075));
    return matches.length === 1 ? matches[0] : matches.find(c => matchesIcon(c,step,0.01));
  }
  if (step.kind === "OCR") {
    const near = same.filter(c => Math.hypot(c.rx - step.rx, c.ry - step.ry) < 0.075);
    return same.find(c => c.name === step.name && near.includes(c)) ||
      (near.length === 1 ? near[0] : undefined);
  }
  const named = peers.filter(c => c.name === step.name);
  return same.find(c => c.name === step.name) || (named.length === 1 ? named[0] : same[0]);
}
async function click(c) {
  const handle = await c.frame.evaluateHandle(({ x, y }) => document.elementFromPoint(x, y), { x: c.x, y: c.y });
  try {
    const el = handle.asElement();
    if (!el) throw Error("入口已移出画面");
    const position = await el.evaluate((node, { x, y }) => {
      const rect = node.getBoundingClientRect();
      return { x: x - rect.left - node.clientLeft, y: y - rect.top - node.clientTop };
    }, { x: c.x, y: c.y });
    await el.click({ position, timeout: 2500 });
  } finally { await handle.dispose(); }
}

// A slow parser-blocking script can postpone DOMContentLoaded indefinitely.
async function loadEntry(page, observed, seconds, signal) {
  signal.throwIfAborted();
  while (true) {
    try {
      await loadOnce(page, observed, seconds, signal);
      return;
    } catch (error) {
      signal.throwIfAborted();
      if (!observed.entryRetry || page.isClosed()) throw error;
      observed.entryRetry(error);
      await require("node:timers/promises").setTimeout(3000, undefined, {signal});
    }
  }
}
async function loadOnce(page, observed, seconds, signal) {
  const start = Date.now();
  const budget = seconds * 1000;
  const deadline = start + budget;
  observed.paths.clear();
  observed.active.clear();
  const response = await page.goto(observed.entry, {waitUntil:"commit", timeout:Math.min(45000, budget)});
  if (!response || !response.ok())
    throw Error("入口 HTTP " + (response?.status() || "无响应"));
  while (true) {
    signal.throwIfAborted();
    const now = Date.now();
    const quietAt = Math.max(start, observed.lastGET) + observed.quietMs;
    if (now >= deadline || (!observed.active.size && now >= quietAt)) return;
    await page.waitForTimeout(Math.min(100, deadline - now));
  }
}
async function explore(page, ctx, cfg, signal, emit, library, observed, phase) {
  if (!cfg.actions) return 0;
  let clicks = 0;
  let previousButton;
  // Keep only OCR text and geometry; browser frames from previous branches can be released.
  const rejectedIcons = new Map();
  const unresponsive = new Map();
  const canvasKey = c => JSON.stringify([c.tab, c.route, c.anchor]);
  const normalized = name => name.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
  function alreadyTried(c) {
    if (c.kind === "Icon") return rejectedIcons.get(canvasKey(c))?.some(icon => matchesIcon(c,icon,0.025));
    if (c.kind !== "OCR") return false;
    const entries = unresponsive.get(canvasKey(c));
    if (!entries) return false;
    const label = normalized(c.name);
    if (entries.has(label)) return true;
    // Vision occasionally drops a letter at the same location (e.g. Title / Tite).
    for (const [seen, bounds] of entries) {
      if (Math.abs(c.rx - bounds.rx) > 0.015 || Math.abs(c.ry - bounds.ry) > 0.01) continue;
      const [short, long] = label.length < seen.length ? [label, seen] : [seen, label];
      if (short.length < 4 || long.length !== short.length + 1) continue;
      let i = 0;
      while (short[i] === long[i]) i++;
      if (/\p{L}/u.test(long[i]) && short.slice(i) === long.slice(i + 1)) return true;
    }
    return false;
  }
  function rememberUnresponsive(c) {
    const key = canvasKey(c);
    if (c.kind === "Icon") {
      if (!rejectedIcons.has(key)) rejectedIcons.set(key, []);
      rejectedIcons.get(key).push(stepOf(c));
      return;
    }
    if (!unresponsive.has(key)) unresponsive.set(key, new Map());
    unresponsive.get(key).set(normalized(c.name), { rx: c.rx, ry: c.ry });
  }
  const names = steps => steps.map(s => s.name).join(" → ");
  const enumerate = () => scan(ctx, signal);

  async function settle(after = Date.now()) {
    // Require a full quiet window after each click, even if it issues no GET.
    const start = Date.now();
    while (observed.active.size || Date.now() - Math.max(after, observed.lastGET) < observed.quietMs) {
      signal.throwIfAborted();
      if (phase === "discover" && Date.now() - start >= Math.max(3000, observed.quietMs)) return;
      if (Date.now() - start >= 45000) throw Error("等待 GET 请求结束超时");
      await page.waitForTimeout(100);
    }
  }
  async function reset() {
    emit({ kind: "action", message: "重新载入游戏入口" });
    for (const popup of ctx.pages().filter(p => p !== page)) await popup.close();
    await loadEntry(page, observed, cfg.waitSeconds, signal);
    previousButton = undefined;
  }
  async function press(c) {
    if (sameButton(previousButton, c)) throw Error("已跳过连续点击同一按钮 · " + c.name);
    observed.paths.clear();
    await click(c);
    previousButton = c;
    clicks++;
    await settle();
  }
  async function apply(steps) {
    for (const step of steps) {
      const c = locate(await enumerate(), step);
      if (!c) throw Error("找不到 " + step.name);
      await press(c);
    }
  }
  async function readyControls() {
    const available = async () => (await enumerate()).filter(c => !sameButton(previousButton, c) && !alreadyTried(c));
    let visible = await available();
    for (let i = 0; !visible.length && i < 2; i++) {
      await page.waitForTimeout(650);
      visible = await available();
    }
    return visible;
  }
  if (cfg.exploreMode === "source")
    return require("./frame-functions").exploreFrameFunctions({ ctx, cfg, phase, signal, emit, library, reset, settle, observed, frameRoute });
  if (phase === "replay") {
    const start = observed.progress.path;
    for (let i = start; i < library.length; i++) {
      observed.progress.path = i;
      const {steps} = library[i];
      emit({ kind: "action", message: "重放路径 · " + names(steps) });
      try {
        if (i > start) await reset();
        await apply(steps);
        emit({ kind: "action", message: "重放成功 · " + names(steps) });
      } catch (err) {
        signal.throwIfAborted();
        emit({ kind: "warning", message: "重放失败 · " + names(steps) + " · " + err.message.split("\n")[0] });
      }
    }
    return clicks;
  }
  function record(prefix) {
    if (!prefix.length) return;
    library.push({ steps: prefix });
    emit({ kind: "action", message: "记录路径 · " + names(prefix) });
  }
  async function visit(prefix, visible) {
    if (prefix.length === cfg.actions || !visible.length) {
      record(prefix);
      return;
    }
    let skipped = 0;
    let needsReset = false;
    let current = visible;
    const baselines = new Map();
    for (const step of visible.map(stepOf)) {
      signal.throwIfAborted();
      // A descendant may have rejected a candidate in this older sibling list.
      if (alreadyTried(step)) {
        skipped++;
        continue;
      }
      const steps = [...prefix, step];
      emit({ kind: "action", message: "尝试路径 · " + names(steps) });
      try {
        if (needsReset) {
          baselines.clear();
          await reset();
          await apply(prefix);
          current = await enumerate();
        }
        let target = locate(current, step);
        if (!target) throw Error("找不到 " + step.name);
        if (alreadyTried(target)) {
          skipped++;
          needsReset = false;
          continue;
        }
        needsReset = true;
        let check;
        const pages = ctx.pages();
        const url = target.frame.url();
        if (target.kind === "OCR" || target.kind === "Icon") {
          const key = [target.tab, target.route, target.anchor].join(":");
          if (!baselines.has(key)) baselines.set(key, await observeCanvas(target, signal));
          // OCR coordinates can be stale after watching a carousel advance.
          const words = await scanCanvas(target.frame);
          const word = words.find(w => w.anchor === target.anchor && w.kind === target.kind && w.name === target.name &&
            (target.kind !== "Icon" || matchesIcon(target,w,0.025)) &&
            Math.hypot(w.rx - target.rx, w.ry - target.ry) < 0.025);
          if (!word) {
            skipped++;
            needsReset = false;
            emit({ kind: "action", message: "跳过已移动或消失的画布" + (target.kind === "Icon" ? "图标" : "文字") + " · " + names(steps) });
            continue;
          }
          target = { ...target, ...word };
          check = await baselines.get(key).beforeClick();
        }
        await press(target);
        const navigated = target.frame.isDetached() || url !== target.frame.url() ||
          ctx.pages().some(p => !pages.includes(p));
        if (check && !navigated && !await check()) {
          rememberUnresponsive(target);
          skipped++;
          needsReset = false;
          emit({ kind: "action", message: "跳过无稳定反馈的画布" + (target.kind === "Icon" ? "图标" : "文字") + " · " + names(steps) });
          continue;
        }
      } catch (err) {
        signal.throwIfAborted();
        emit({ kind: "warning", message: "探索失败 · " + names(steps) + " · " + err.message.split("\n")[0] });
        continue;
      }
      await visit(steps, steps.length < cfg.actions ? await readyControls() : []);
    }
    if (skipped === visible.length) record(prefix);
  }
  await visit([], await readyControls());
  return clicks;
}
module.exports = { explore, sleep, loadEntry };
