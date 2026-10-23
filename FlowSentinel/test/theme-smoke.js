const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
(async () => {
  const packaged = process.argv.includes('--packaged');
  const data = path.resolve('test-results', 'theme-data-' + Date.now());
  fs.mkdirSync(data, { recursive: true });
  const env = { ...process.env, FLOW_SENTINEL_TEST_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const options = { executablePath: packaged ? path.resolve('dist/win-unpacked/FlowSentinel.exe') : require('electron'), args: packaged ? [] : ['.'], env };
  let app;
  try {
    app = await electron.launch(options);
    let page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.waitForSelector('#themeSelect');
    assert.equal(await page.locator('#themeSelect').inputValue(), 'system');
    const check = theme => page.waitForFunction(t => document.documentElement.dataset.theme === t, theme);
    await page.emulateMedia({ colorScheme: 'light' }); await check('light');
    await page.emulateMedia({ colorScheme: 'dark' }); await check('dark');
    for (const theme of ['light', 'dark']) {
      await page.locator('#themeSelect').selectOption(theme); await check(theme);
      await page.emulateMedia({ colorScheme: theme === 'light' ? 'dark' : 'light' }); await check(theme);
      await page.evaluate(() => {
        addLog({ time: new Date().toISOString(), level: 'info', message: '巡检正常 · 匹配 100%' });
        addLog({ time: new Date().toISOString(), level: 'warn', message: '正在等待检查点' });
        addLog({ time: new Date().toISOString(), level: 'error', message: '执行异常 · 示例' });
        renderStates([{ id: 1, status: '正常运行', score: 1 }, { id: 2, status: '需要人工处理' }]);
      });
      await page.screenshot({ path: `test-results/theme-${theme}${packaged ? '-packaged' : ''}.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await page.locator('#themeSelect').selectOption('light');
    await page.reload(); await check('light');
    assert.equal(await page.locator('#themeSelect').inputValue(), 'light');
    await app.close();
    app = await electron.launch(options); page = await app.firstWindow();
    await page.waitForSelector('#themeSelect'); await check('light');
    assert.equal(await page.locator('#themeSelect').inputValue(), 'light');
    await page.locator('#themeSelect').selectOption('system');
    await page.emulateMedia({ colorScheme: 'dark' }); await check('dark');
    await page.emulateMedia({ colorScheme: 'light' }); await check('light');
    await page.evaluate(() => localStorage.setItem('flow-sentinel-theme', 'invalid'));
    await page.reload();
    assert.equal(await page.locator('#themeSelect').inputValue(), 'system');
    assert.deepEqual(errors, []);
    console.log('PASS: three theme modes, live system changes, explicit override, reload/restart persistence, invalid preference fallback, layout.');
  } finally { await app?.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
