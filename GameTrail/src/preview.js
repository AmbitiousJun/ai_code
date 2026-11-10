const priorityCaptures = new WeakMap();

async function capturePng(page, timeout) {
  priorityCaptures.set(page, (priorityCaptures.get(page) || 0) + 1);
  try {
    return await page.screenshot({type:"png", scale:"css", timeout});
  } finally {
    const left = priorityCaptures.get(page) - 1;
    if (left) priorityCaptures.set(page, left);
    else priorityCaptures.delete(page);
  }
}

// Polling supplies demand. A slow capture never holds the HTTP response open.
function cachedPreview(capture) {
  let latest, pending = false, lastAttempt = -Infinity;
  return function read(interval = 1000) {
    const now = Date.now();
    if (!pending && now - lastAttempt >= interval) {
      pending = true;
      lastAttempt = now;
      Promise.resolve().then(capture).then(bytes => {
        if (bytes) latest = {bytes, time:now};
      }).catch(() => {}).finally(() => { pending = false; });
    }
    return latest;
  };
}
function capturingPng(page) { return priorityCaptures.has(page); }
module.exports = {cachedPreview, capturePng, capturingPng};
