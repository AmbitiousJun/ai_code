process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";
const { devices } = require("playwright");
const presets = [
  ["win", "Windows · Chrome", "Desktop Chrome", "chromium"],
  ["mac", "macOS · Safari", "Desktop Safari", "webkit"],
  ["ios", "iPhone · 竖屏", "iPhone 13", "webkit"],
  ["ios-wide", "iPhone · 横屏", "iPhone 13 landscape", "webkit"],
  ["android", "Android · 竖屏", "Pixel 7", "chromium"],
  ["android-wide", "Android · 横屏", "Pixel 7 landscape", "chromium"],
].map(([id, name, model, engine]) => ({ id, name, engine, ...devices[model] }));
const defaults = {
  template:
    "https://jili-lobby.1b12.pro/games/enter?id={gameId}&lang={lang}&token=test",
  variables: { gameId: ["573", "2", "403"], lang: ["zh-CN", "en-US"] },
  selected: ["win"],
  custom: [],
  explore: true,
  labels: [],
  waitSeconds: 60,
  actions: 8,
  extraGets: 40,
};
function plan(input) {
  const cfg = { ...defaults, ...input };
  if (
    !Array.isArray(cfg.labels) ||
    cfg.labels.length > 40 ||
    cfg.labels.some((v) => typeof v !== "string" || !v.trim() || v.length > 80)
  )
    throw Error("额外入口最多 40 个，每项 1–80 字符");
  const keys = [
    ...new Set([...cfg.template.matchAll(/\{([\w-]+)\}/g)].map((m) => m[1])),
  ];
  if (/[{}]/.test(cfg.template.replace(/\{[\w-]+\}/g, "")))
    throw Error("模板占位符格式无效");
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
    if (rows.length * unique.length > 2000)
      throw Error("单任务最多 2000 个组合");
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
  if (!selected.length || rows.length * selected.length > 2000)
    throw Error("请选择机型，且运行数不超过 2000");
  for (const [k, min, max] of [
    ["waitSeconds", 1, 120],
    ["actions", 0, 40],
    ["extraGets", 0, 200],
  ])
    if (!Number.isInteger(cfg[k]) || cfg[k] < min || cfg[k] > max)
      throw Error("参数超出范围 " + k);
  return rows.flatMap((vars) => {
    const u = new URL(
      cfg.template.replace(/\{([\w-]+)\}/g, (_, k) =>
        encodeURIComponent(vars[k]),
      ),
    );
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      throw Error("请输入 HTTP(S) 入口");
    return selected.map((device) => ({ url: u.href, vars, device }));
  });
}
module.exports = { presets, defaults, plan };
