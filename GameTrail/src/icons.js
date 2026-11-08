// Find compact, isolated contours at CSS-pixel scale. The shape signature is
// sampled inside the contour so the same graphic can match at another scale.
const { PNG } = require("playwright-core/lib/utilsBundle");
function iconCandidates(bytes, words, cssWidth, cssHeight) {
  const png = PNG.sync.read(bytes);
  const w = Math.ceil(cssWidth / 2), h = Math.ceil(cssHeight / 2);
  if (w < 5 || h < 5 || w * h > 1200000) return [];
  const edges = new Uint8Array(w * h);
  const offset = (x, y) => 4 * (Math.floor(y * png.height / h) * png.width + Math.floor(x * png.width / w));
  const pixels = png.data;
  for (let y = 1; y < h; y++) {
    for (let x = 1; x < w; x++) {
      const p = offset(x,y), left = offset(x-1,y), up = offset(x,y-1);
      for (let c = 0; c < 3; c++) {
        if (Math.max(Math.abs(pixels[p+c]-pixels[left+c]), Math.abs(pixels[p+c]-pixels[up+c])) >= 40) {
          edges[y*w+x] = 1;
          break;
        }
      }
    }
  }
  const icons = [];
  const queue = new Int32Array(edges.length);
  for (let i = 0; i < edges.length; i++) {
    if (edges[i] !== 1) continue;
    let count = 1, left = i % w, right = left, top = Math.floor(i/w), bottom = top;
    queue[0] = i;
    edges[i] = 2;
    for (let j = 0; j < count; j++) {
      const pos = queue[j], x = pos % w, y = Math.floor(pos/w);
      left = Math.min(left,x); right = Math.max(right,x);
      top = Math.min(top,y); bottom = Math.max(bottom,y);
      for (let ny = Math.max(0,y-1); ny <= Math.min(h-1,y+1); ny++) {
        for (let nx = Math.max(0,x-1); nx <= Math.min(w-1,x+1); nx++) {
          const next = ny*w+nx;
          if (edges[next] !== 1) continue;
          edges[next] = 2;
          queue[count++] = next;
        }
      }
    }
    const width = right-left+1, height = bottom-top+1;
    if (Math.min(width,height) < 7 || Math.max(width,height) > 52 ||
        Math.max(width,height) / Math.min(width,height) > 2 || count < width+height) continue;
    const x = (left+width/2)/w, y = (top+height/2)/h, rw = width/w, rh = height/h;
    if (words.some(a => Math.abs(a.x-x) < (rw+a.rw)/2 && Math.abs(a.y-y) < (rh+a.rh)/2)) continue;
    const bins = new Uint8Array(36);
    for (let py = top; py <= bottom; py++) {
      for (let px = left; px <= right; px++) {
        if (edges[py*w+px]) bins[Math.floor((py-top)*6/height)*6 + Math.floor((px-left)*6/width)] = 1;
      }
    }
    icons.push({kind:"Icon", text:"图标", x,y,rw,rh, shape:bins.join("")});
  }
  // Prefer the enclosing button over its glyph and bound trials on textured art.
  icons.sort((a,b) => b.rw*b.rh-a.rw*a.rh);
  const kept = [];
  for (const icon of icons) {
    if (!kept.some(a => Math.abs(icon.x-a.x) < a.rw/2 && Math.abs(icon.y-a.y) < a.rh/2)) kept.push(icon);
    if (kept.length === 12) break;
  }
  return kept;
}
module.exports = { iconCandidates };
