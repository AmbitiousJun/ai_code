const { iconCandidates } = require("./icons");
const path = require("node:path"),
  fs = require("node:fs"),
  { spawn } = require("node:child_process");
const macHelper = path.join(__dirname, "../native/vision");
function recognize(png) {
  const native = process.platform === "darwin" && fs.existsSync(macHelper);
  return new Promise((resolve) => {
    const child = native
      ? spawn(macHelper)
      : spawn("tesseract", [
          "stdin",
          "stdout",
          "--psm",
          "11",
          "-l",
          process.env.GAMETRAIL_OCR_LANG || "eng",
          "tsv",
        ]);
    const chunks = [];
    const timer = setTimeout(() => child.kill(), 5000);
    child.stdin.on("error", () => {});
    child.stderr.resume();
    child.stdout.on("data", (s) => chunks.push(s));
    child.stdin.end(png);
    child.on("error", () => {
      clearTimeout(timer);
      resolve([]);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve([]);
      try {
        const s = Buffer.concat(chunks).toString();
        if (native) return resolve(JSON.parse(s));
        const w = png.readUInt32BE(16),
          h = png.readUInt32BE(20);
        resolve(
          s
            .trim()
            .split("\n")
            .slice(1)
            .map((l) => l.split("\t"))
            .filter((p) => p[0] === "5" && Number(p[10]) >= 75)
            .map((p) => ({
              text: p[11],
              x: (+p[6] + p[8] / 2) / w,
              y: (+p[7] + p[9] / 2) / h,
              rw: +p[8] / w, rh: +p[9] / h,
            })),
        );
      } catch {
        resolve([]);
      }
    });
  });
}
async function scanCanvas(frame) {
  const result = [];
  const canvases = await frame.locator("canvas:visible").all();
  for (const [index, canvas] of canvases.entries()) {
    const png = await canvas.screenshot({ timeout: 2000 }).catch(() => null);
    if (!png) continue;
    const items = await recognize(png);
    const box = await canvas.boundingBox();
    if (!box) continue;
    items.push(...iconCandidates(png, items, box.width, box.height));
    const found = await canvas.evaluate((el, items) => {
      const rect = el.getBoundingClientRect();
      return items.flatMap(({ text, kind = "OCR", shape, x: rx, y: ry, rw, rh }) => {
        const x = rect.x + rx * rect.width, y = rect.y + ry * rect.height;
        if (!text.trim() || document.elementFromPoint(x, y) !== el) return [];
        return [{ name: text.trim(), kind, shape, x, y, rx, ry, rw, rh }];
      });
    }, items).catch(() => []);
    for (const item of found) result.push({ ...item, anchor: String(index) });
  }
  return result;
}
module.exports = { scanCanvas };
