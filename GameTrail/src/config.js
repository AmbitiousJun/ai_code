process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";
const { devices } = require("playwright");
const presets = [
  ["win", "Windows · Chrome", "Desktop Chrome", "chromium"],
  ["mac", "macOS · Safari", "Desktop Safari", "webkit"],
  ["ios", "iPhone · 竖屏", "iPhone 13", "webkit"],
  ["ios-wide", "iPhone · 横屏", "iPhone 13 landscape", "webkit"],
  ["android", "Android · 竖屏", "Pixel 7", "chromium"],
  ["android-wide", "Android · 横屏", "Pixel 7 landscape", "chromium"],
].map(([id, name, model, engine]) => {
  const device = { id, name, engine, ...devices[model] };
  if (id === "android") {
    const { viewport, screen, deviceScaleFactor } = devices["iPhone 13"];
    Object.assign(device, { viewport, screen, deviceScaleFactor });
  }
  return device;
});
const defaults = {
  template:
    "https://game.example.invalid/play/{gameId}?lang={lang}",
  variables: { gameId: ["demo-a", "demo-b", "demo-c"], lang: ["en-US", "fr-FR"] },
  selected: ["win"],
  custom: [],
  explore: true,
  exploreMode: "manual",
  waitSeconds: 60,
  quietSeconds: 1,
  pixelTimeout: 15,
  pixelSimilarity: 94,
  actions: 8,
};
function plan(input, legacyOrder = false) {
  const cfg = { ...defaults, ...input };
  const placeholders = [
    ...new Set([...cfg.template.matchAll(/\{([\w-]+)\}/g)].map((m) => m[1])),
  ];
  if (/[{}]/.test(cfg.template.replace(/\{[\w-]+\}/g, "")))
    throw Error("模板占位符格式无效");
  const primary = cfg.primaryVariable ?? (placeholders.includes("gameId") ? "gameId" : "");
  if (primary && !placeholders.includes(primary)) throw Error("主隔离变量必须是模板中的占位符");
  const order = cfg.variableOrder ?? Object.keys(cfg.variables);
  if (!Array.isArray(order)) throw Error("模板变量顺序无效");
  const keys = legacyOrder ? placeholders : [...new Set([...order, ...placeholders])].filter(key => placeholders.includes(key));
  if (legacyOrder && primary) keys.unshift(...keys.splice(keys.indexOf(primary), 1));
  const groups = new Set();
  let rows = [{}];
  for (const key of keys) {
    const values = cfg.variables[key];
    if (
      !Array.isArray(values) ||
      !values.length ||
      values.some((v) => !["number", "string"].includes(typeof v))
    )
      throw Error("请填写模板变量 " + key);
    const unique = [...new Set(values.map(String))];
    rows = rows.flatMap((r) => unique.map((v) => ({ ...r, [key]: v })));
  }
  for (const p of cfg.custom) {
    if (
      !p.id ||
      !p.name ||
      !["webkit", "chromium"].includes(p.engine) ||
      !["height", "width"].every(
        (k) =>
          Number.isInteger(p.viewport?.[k]) &&
          p.viewport[k] >= 100 &&
          p.viewport[k] <= 8192,
      )
    )
      throw Error("自定义机型需要 id、name、engine、viewport");
  }
  const available = [...presets, ...cfg.custom];
  if (new Set(available.map((p) => p.id)).size !== available.length)
    throw Error("机型 id 重复");
  const selected = available.filter((p) => cfg.selected.includes(p.id));
  if (cfg.replayConcurrency != null && (!Number.isSafeInteger(cfg.replayConcurrency) || cfg.replayConcurrency < 1))
    throw Error("并发实例数必须为正整数");
  if (!selected.length) throw Error("请选择机型");
  for (const [k, min, max] of [
    ["waitSeconds", 1, Infinity],
    ["pixelTimeout", 1, 120],
    ["pixelSimilarity", 1, 100],
    ["actions", 0, 40],
  ])
    if (!Number.isInteger(cfg[k]) || cfg[k] < min || cfg[k] > max)
      throw Error("参数超出范围 " + k);
  if (!Number.isFinite(cfg.quietSeconds) || cfg.quietSeconds < 0.1 || cfg.quietSeconds > 30)
    throw Error("GET 静默窗口应在 0.1–30 秒之间");
  const manual = cfg.explore && cfg.exploreMode === "manual";
  const recordings = [];
  const runs = rows.flatMap((vars) => {
    const u = new URL(
      cfg.template.replace(/\{([\w-]+)\}/g, (_, k) =>
        encodeURIComponent(vars[k]),
      ),
    );
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      throw Error("请输入 HTTP(S) 入口");
    return selected.flatMap((device) => {
      const group = primary ? vars[primary] : String(groups.size + 1);
      const row = { url: u.href, vars, device, group, primary };
      if (!legacyOrder && keys.length > 1) row.batch = vars[keys[0]];
      const discover = cfg.explore && cfg.actions > 0 && !groups.has(group);
      if (manual && !groups.has(group)) recordings.push({ ...row, phase: "record" });
      groups.add(group);
      if (manual) return [{ ...row, phase: "replay" }];
      const run = { ...row, phase: cfg.explore && cfg.actions ? "replay" : "load" };
      return discover ? [{ ...row, phase: "discover" }, run] : [run];
    });
  });
  return [...recordings, ...runs];
}
module.exports = { presets, defaults, plan };
