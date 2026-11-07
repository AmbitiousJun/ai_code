const { spawnSync } = require("node:child_process"),
  path = require("node:path");
const cli = path.join(
  path.dirname(require.resolve("playwright/package.json")),
  "cli.js",
);
const result = spawnSync(
  process.execPath,
  [cli, "install", "chromium", "webkit"],
  { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" }, stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
