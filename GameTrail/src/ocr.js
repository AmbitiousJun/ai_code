const path = require("node:path"),
  fs = require("node:fs"),
  { spawn } = require("node:child_process");
const macHelper = path.join(__dirname, "../native/vision");
const safe =
  /^(help|rules?|pay\s?table|menu|settings?|information|history|notice|events?|more|back|close|帮助|幫助|规则|規則|游戏规则|遊戲規則|菜单|菜單|设置|設定|公告|活动|活動|返回|关闭|關閉)$/i;
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
            })),
        );
      } catch {
        resolve([]);
      }
    });
  });
}
async function scanCanvas(page, labels) {
  const canvas = page.locator("canvas:visible").first();
  if (!(await canvas.count())) return [];
  const png = await page.screenshot({ timeout: 3000 }),
    view = page.viewportSize();
  if (!view) return [];
  const out = [];
  const items = await recognize(png);
  const tutorial = items.some((i) =>
    /下次不[再要]|不再[显顯]示|do(n.t| not) show/i.test(i.text),
  );
  for (const item of items) {
    if (
      !safe.test(item.text.trim()) &&
      !labels.some(
        (label) =>
          label.trim().toLowerCase() === item.text.trim().toLowerCase(),
      ) &&
      !(tutorial && /^(continue|继续|繼續)$/i.test(item.text.trim()))
    )
      continue;
    const x = item.x * view.width,
      y = item.y * view.height;
    if (
      await page.evaluate(
        ([x, y]) => document.elementFromPoint(x, y)?.tagName === "CANVAS",
        [x, y],
      )
    )
      out.push({
        name: item.text.trim(),
        x,
        y,
        kind: "OCR",
        frame: page.mainFrame(),
        key: "ocr|" + item.text,
      });
  }
  return out;
}
module.exports = { scanCanvas };
