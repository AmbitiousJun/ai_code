const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";
const { chromium } = require("playwright");

test("关闭探索时，工作台按默认和自定义并发数加载资源并显示各实例画面", { timeout: 90000 }, async t => {
  const site = http.createServer((req, res) => res.end("<body style='background:teal'>GameTrail</body>"));
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  t.after(() => site.close());

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-load-"));
  const child = spawn(process.execPath, [require.resolve("../src/server")], {
    env: { ...process.env, GAMETRAIL_DATA: dir, GAMETRAIL_NO_OPEN: "1", PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(async () => {
    const closed = once(child, "exit");
    child.kill();
    await closed;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const [line] = await once(child.stdout, "data");
  const base = String(line).match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(base);
  await page.locator("#devices input[value=win]").waitFor();
  await page.locator("#theme-trigger").click();
  await page.getByRole("option",{name:"适应系统"}).click();
  await page.emulateMedia({colorScheme:"dark"});
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.emulateMedia({colorScheme:"light"});
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.locator("#explore").uncheck();
  await page.locator("#template").fill("http://127.0.0.1:" + site.address().port + "/{gameId}");
  await page.locator("#variables").fill("gameId=a,b,c");
  await page.locator("summary").filter({hasText:"自定义机型与探索参数"}).click();
  await page.locator("#quietSeconds").fill("3");
  for (const [limit, twoDevices, expected] of [["", true, 2], ["2", false, 2], ["1", false, 1]]) {
    await page.locator("#devices input[value=ios]").setChecked(twoDevices);
    await page.locator("#replayConcurrency").fill(limit);
    const observed = [];
    const sample = async response => {
      if (response.url().startsWith(base + "/api/state")) {
        const {job} = await response.json();
        if (job?.status === "running") observed.push(job.instances.length);
      }
    };
    page.on("response", sample);
    await page.locator("#start").click();
    try {
      await page.waitForFunction(n => document.querySelectorAll("#screens img").length === n, expected);
    } catch (err) {
      const {job} = await (await fetch(base + "/api/state")).json();
      throw Error(JSON.stringify({limit, status:job?.status, runs:job?.runs, err:await page.locator("#err").innerText()}), {cause:err});
    }
    await page.waitForFunction(() => document.querySelector("#status").textContent === "已完成");
    const { job } = await (await fetch(base + "/api/state")).json();
    assert.equal(job.done, twoDevices ? 6 : 3);
    assert.ok(job.runs.every(row => row.phase === "加载资源" && row.status === "完成"));
    const link = page.locator("#events a").first();
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.ok((await link.getAttribute("href")).startsWith("http://127.0.0.1:"));
    page.off("response", sample);
    assert.equal(Math.max(...observed), expected);
  }
});
