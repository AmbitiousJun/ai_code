process.env.PLAYWRIGHT_BROWSERS_PATH ||= "0";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const windows = process.platform === "win32";
const verifyOnly = process.argv.includes("--verify");
const installs = windows
  ? [["playwright", ["chromium"]], ["webkit-win", ["webkit"]]]
  : [["playwright", ["chromium", "webkit"]]];
for (const [pkg, engines] of installs) {
  if (!verifyOnly) {
    const cli = path.join(path.dirname(require.resolve(pkg + "/package.json")), "cli.js");
    const result = spawnSync(process.execPath, [cli, "install", ...engines], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  for (const engine of engines) fs.accessSync(require(pkg)[engine].executablePath());
}

if (windows) {
  const dir = path.dirname(require("webkit-win").webkit.executablePath());
  const target = path.join(dir, "ssl-60.dll");
  const patched = path.resolve(__dirname, "../native/windows-webkit/ssl-60.dll");
  const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (hash(target) !== hash(patched)) {
    if (verifyOnly || hash(target) !== "18c8063233856ad95225e7caf342c1242672a5f3640c2fe04cb98e5f950d8a3c")
      throw Error("Windows WebKit TLS 组件版本不匹配，请核对锁定的浏览器并运行 npm run browsers");
    fs.copyFileSync(patched, target);
  }
  fs.copyFileSync(path.join(path.dirname(patched), "COPYING"), path.join(dir, "LibreSSL-COPYING.txt"));
}
