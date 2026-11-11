const {scanTiles} = require("./scan-tiles");
// Match a user-selected 20 × 20 RGB thumbnail against the current viewport.
// Candidate positions are discovered from the current image on every replay.
const {captureMatchFrame} = require("./preview");
const {scanInWorker} = require("./pixel-pool");
const side = 20;
function prepare(template) {
  const rgb = Buffer.from(template.rgb || "", "base64");
  if (rgb.length !== side * side * 3 ||
      ![template.width,template.height,template.viewWidth,template.viewHeight].every(Number.isFinite) ||
      template.width < 8 || template.height < 8 || template.width > template.viewWidth ||
      template.height > template.viewHeight || template.viewWidth > 8192 || template.viewHeight > 8192)
    throw Error("框选区域无效，请重新框选");
  const mean = [0,0,0];
  for (let i=0; i<rgb.length; i++) mean[i%3] += rgb[i]/(side*side);
  const contrast = [];
  for (let i=0; i<side*side; i++) {
    const d = mean.reduce((sum,v,c) => sum + Math.abs(v-rgb[i*3+c]),0);
    contrast.push({i,d});
  }
  if (contrast.filter(p => p.d > 60).length < 12) throw Error("选区特征太少，请框入按钮图案或文字");
  // Start with distinctive, spatially separated colors so empty backgrounds fail cheaply.
  const anchors = [];
  for (const {i} of contrast.sort((a,b)=>b.d-a.d)) {
    if (anchors.every(j=>Math.hypot(i%side-j%side,Math.floor(i/side)-Math.floor(j/side))>=4)) anchors.push(i);
    if (anchors.length === 8) break;
  }
  return {rgb, anchors};
}
function candidates(image, template, similarity = 94, uniqueOnly = false) {
  const {rgb, anchors} = prepare(template);
  const {width, height, data} = image;
  const scales = new Set([1,width/template.viewWidth,height/template.viewHeight,0.5,0.75,1.25,1.5,2]);
  const maxError = (100 - similarity) * 255 / 100;
  const maxSum = maxError * side * side * 3;
  const anchorLimit = Math.max(105, maxError * 7);
  const hits = [];
  const sizes = new Set();
  for (const scale of scales) {
    const w = Math.round(template.width*scale), h = Math.round(template.height*scale);
    if (w<6 || h<6 || w>width || h>height || sizes.has(w+"x"+h)) continue;
    sizes.add(w+"x"+h);
    const offsets = Array.from({length:side*side},(_,i)=>
      4*(Math.floor((i%side+0.5)*w/side)+width*Math.floor((Math.floor(i/side)+0.5)*h/side)));
    function diff(base,i) {
      const p = base + offsets[i], t = 3*i;
      return Math.abs(data[p]-rgb[t])+Math.abs(data[p+1]-rgb[t+1])+Math.abs(data[p+2]-rgb[t+2]);
    }
    const stride = Math.max(1,Math.min(5,Math.floor(Math.min(w,h)/24)));
    for (const tile of scanTiles(image, template, w, h, stride)) {
      for (let y=tile.top;y<=tile.bottom;y+=stride) for (let x=tile.left;x<=tile.right;x+=stride) {
        const base = 4*(y*width+x);
        let misses = 0;
        for (const i of anchors) {
          if (diff(base,i)>anchorLimit && ++misses>2) break;
        }
        if (misses>2) continue;
        let sum=0;
        for (let i=0;i<side*side;i++) {
          sum+=diff(base,i);
          if (sum>maxSum) break;
        }
        if (sum>maxSum) continue;
        const hit={x:x+w/2,y:y+h/2,w,h,score:sum/(side*side*3)};
        const index=hits.findIndex(a => Math.abs(a.x-hit.x)<Math.min(a.w,w)*0.4 &&
          Math.abs(a.y-hit.y)<Math.min(a.h,h)*0.4);
        if (index<0) hits.push(hit);
        else if (hit.score<hits[index].score) hits[index]=hit;
        if (hits.length > 100 || (uniqueOnly && hits.length >= 3)) return hits;
      }
    }
  }
  return hits;
}
function match(image, template, similarity) {
  const hits = candidates(image, template, similarity).sort((a,b)=>a.score-b.score);
  if (hits.length > 100 || !hits.length || (hits[1] && hits[1].score<hits[0].score+4)) return null;
  return hits[0];
}
async function screenshot(page, timeout) {
  const view = page.viewportSize();
  if (!view || view.width*view.height>8_500_000) throw Error("当前视口过大，无法进行像素匹配");
  return captureMatchFrame(page, timeout);
}
async function gameArea(canvas) {
  const bounds = await canvas.boundingBox({timeout:500});
  if (!bounds) return;
  const vp = await canvas.evaluate(el => {
    const cc = window.cc;
    if (cc?.game?.canvas !== el || cc.view?._isRotated) return;
    const v = cc.view?.getViewportRect?.();
    if (v && el.width && el.height)
      return {x:v.x/el.width,y:1-(v.y+v.height)/el.height,w:v.width/el.width,h:v.height/el.height};
  },undefined,{timeout:500});
  if (!vp) return bounds;
  const left=Math.max(0,vp.x), top=Math.max(0,vp.y);
  return {x:bounds.x+left*bounds.width,y:bounds.y+top*bounds.height,
    width:bounds.width*(Math.min(1,vp.x+vp.w)-left),height:bounds.height*(Math.min(1,vp.y+vp.h)-top)};
}
async function locatePixels(page, template, similarity, timeout = 3000, signal) {
  const bytes = await screenshot(page, timeout);
  const result = await scanInWorker({bytes, template, similarity, locate:true}, signal);
  if (template.side !== 32) return result.point;
  return result.hits.length === 1 ? result.hits[0] : null;
}
async function scanPixels(page, template, similarity, timeout, gameScale, signal) {
  const bytes = await screenshot(page, timeout);
  const image = {bytes, ...page.viewportSize()};
  try {
    const result = await scanInWorker({bytes, template, similarity, gameScale}, signal);
    return {...result, image};
  } catch (error) {
    if (signal?.aborted && error.name === "TimeoutError") return {image, hits:[], interrupted:true};
    throw error;
  }
}
module.exports = { locatePixels, scanPixels, match, candidates, gameArea };
