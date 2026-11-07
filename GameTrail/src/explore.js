const { scanCanvas } = require("./ocr");
// Executed inside each frame. Only visible, named information controls qualify.
function candidates(labels) {
  const words =
    /^(?:btn|button|icon|open|show)?(?:help|rules?|paytable|info|information|settings?|menu|more|history|notice|announcements?|events?|language|soundsettings|instructions|back|close)(?:btn|button|icon|panel)?$/i;
  const zh =
    /^(?:帮助|幫助|游戏规则|遊戲規則|规则|規則|玩法说明|玩法說明|赔付表|賠付表|设置|設置|設定|菜单|菜單|更多|公告|活动|活動|历史记录|歷史紀錄|语言|語言|关闭|關閉|返回)$/;
  const normalize = (v) =>
    String(v || "")
      .trim()
      .replace(/[\s_\-]/g, "");
  const tutorial =
    /下次不[再要]|下次不要|不再[显顯]示|do(n.t| not) show (again|next)/i.test(
      document.body?.innerText || "",
    );
  const safe = (v) =>
    (v &&
      labels.some(
        (label) =>
          normalize(label).toLowerCase() === normalize(v).toLowerCase(),
      )) ||
    words.test(normalize(v)) ||
    zh.test(normalize(v)) ||
    (tutorial && /^(continue|继续|繼續)$/i.test(normalize(v)));
  const result = [];
  for (const el of document.querySelectorAll(
    "button,[role=button],a[href],input[type=button],[aria-label],[title],[onclick]",
  )) {
    const name = [
      el.innerText,
      el.value,
      el.getAttribute("aria-label"),
      el.title,
      el.id,
      el.querySelector("img")?.alt,
    ].find(safe);
    if (!name || el.disabled) continue;
    const r = el.getBoundingClientRect(),
      x = r.x + r.width / 2,
      y = r.y + r.height / 2;
    if (!r.width || !r.height || !el.contains(document.elementFromPoint(x, y)))
      continue;
    result.push({ name: normalize(name), kind: "DOM", x, y });
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
      ].find(safe);
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
      if (document.elementFromPoint(x, y) === canvas)
        result.push({ name: normalize(name), kind: "Cocos", x, y });
    }
  }
  return result;
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
async function explore(page, ctx, cfg, signal, emit, learned, observed) {
  const tried = new Set();
  let clicks = 0,
    reset = false;
  for (let i = 0; i < cfg.actions && !signal.aborted; i++) {
    const all = [];
    for (const p of ctx.pages())
      for (const frame of p.frames()) {
        const found = await frame
          .evaluate(candidates, cfg.labels || [])
          .catch(() => []);
        for (const c of found) {
          const key = [
            new URL(frame.url(), "http://local").pathname,
            c.kind,
            c.name,
          ].join("|");
          if (!tried.has(key)) all.push({ ...c, frame, key });
        }
      }
    if (!all.length) {
      for (const c of await scanCanvas(page, cfg.labels || []).catch(() => []))
        if (!tried.has(c.key)) all.push(c);
    }
    const rank = (c) =>
      (/close|back|关闭|關閉|返回/i.test(c.name) ? 10 : 0) -
      (learned.has(c.name) ? 1 : 0);
    all.sort((a, b) => rank(a) - rank(b));
    const c = all[0];
    if (!c) {
      if (
        clicks &&
        !reset &&
        i + 1 < cfg.actions &&
        (observed.frames || page.url() !== observed.landing)
      ) {
        reset = true;
        await page
          .goto(observed.entry, {
            waitUntil: "domcontentloaded",
            timeout: 25000,
          })
          .catch(() => {});
        await page.waitForTimeout(cfg.waitSeconds * 1000);
        continue;
      }
      break;
    }
    tried.add(c.key);
    // Frame-local hit testing prevents targeting an underlying control in an overlay.

    const before = observed.serial,
      frameCount = observed.frames;
    try {
      const target = await c.frame.evaluateHandle(
        ({ x, y }) => document.elementFromPoint(x, y),
        { x: c.x, y: c.y },
      );
      try {
        const el = target.asElement();
        if (!el) throw Error("入口已移出画面");
        const position = await el.evaluate(
          (node, { x, y }) => {
            const r = node.getBoundingClientRect();
            return {
              x: x - r.left - node.clientLeft,
              y: y - r.top - node.clientTop,
            };
          },
          { x: c.x, y: c.y },
        );
        await el.click({ position, timeout: 2500 });
      } finally {
        await target.dispose();
      }
      clicks++;
      await sleep(1400);
      const change =
        observed.frames > frameCount
          ? "iframe 导航"
          : observed.serial > before
            ? "新增 GET"
            : "未观察到新请求";
      if (observed.serial > before || observed.frames > frameCount)
        learned.add(c.name);
      emit({
        kind: "action",
        message: c.kind + " · " + c.name + " · " + change,
      });
    } catch (e) {
      emit({
        kind: "warning",
        message: c.name + " · " + e.message.split("\n")[0],
      });
    }
  }
  if (clicks && !observed.frames)
    emit({
      kind: "warning",
      message: "已执行浏览点击，尚未观察到子 iframe 导航，请查看结束截图",
    });
  if (!clicks)
    emit({
      kind: "warning",
      message: "未识别到可操作的浏览类按钮，请查看截图",
    });
  return clicks;
}
module.exports = { explore, sleep };
