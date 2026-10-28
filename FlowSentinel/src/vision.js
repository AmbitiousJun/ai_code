const { PNG } = require('pngjs');

function crop(buffer, rect) {
  const src = PNG.sync.read(buffer);
  const r = Object.fromEntries(Object.entries(rect).map(([k,v]) => [k, Math.round(v)]));
  if (r.width < 12 || r.height < 12 || r.x < 0 || r.y < 0 || r.x + r.width > src.width || r.y + r.height > src.height) throw new Error('请选择至少 12×12 像素、位于图片内的区域');
  const dst = new PNG({ width: r.width, height: r.height });
  PNG.bitblt(src, dst, r.x, r.y, r.width, r.height, 0, 0);
  return { buffer: PNG.sync.write(dst), rect: r };
}

// Compare a template near its recorded viewport position. Sparse sampling ranks
// candidates; exact per-pixel comparison makes the final decision.
function match(screenBuffer, templateBuffer, rect, radius = 12) {
  const screen = PNG.sync.read(screenBuffer), template = PNG.sync.read(templateBuffer);
  if (rect.width !== template.width || rect.height !== template.height) throw new Error('基准图尺寸不一致');
  radius = Math.min(64, Math.max(0, Math.round(radius)));
  const score = (x, y, stride) => {
    let bad = 0, count = 0;
    for (let j = 0; j < template.height; j += stride) {
      for (let i = 0; i < template.width; i += stride) {
        const a = ((y+j)*screen.width+x+i)*4, b = (j*template.width+i)*4;
        if (Math.max(Math.abs(screen.data[a]-template.data[b]),Math.abs(screen.data[a+1]-template.data[b+1]),Math.abs(screen.data[a+2]-template.data[b+2])) > 32) bad++;
        count++;
      }
    }
    return 1 - bad / count;
  };
  // Small/narrow templates are sensitive to a single-pixel displacement.
  // Coarse top-four ranking can discard the neighbours of the true match.
  if (Math.min(template.width, template.height) < 36 && template.width * template.height <= 4096) {
    let best = { score: 0, x: rect.x, y: rect.y };
    const consider = (x, y) => {
      if (x < 0 || y < 0 || x + template.width > screen.width || y + template.height > screen.height) return;
      const s = score(x, y, 1);
      if (s > best.score) best = { score: s, x, y };
    };
    consider(rect.x, rect.y);
    for (let y = Math.max(0, rect.y-radius); y <= Math.min(screen.height-template.height, rect.y+radius); y++) {
      for (let x = Math.max(0, rect.x-radius); x <= Math.min(screen.width-template.width, rect.x+radius); x++) {
        if (best.score === 1) return best;
        consider(x, y);
      }
    }
    return best;
  }
  const candidates = [];
  const add = (x,y) => {
    if (x<0 || y<0 || x+template.width>screen.width || y+template.height>screen.height) return;
    candidates.push({x,y,score:score(x,y,Math.max(1,Math.floor(Math.min(template.width,template.height)/18)))});
  };
  add(rect.x, rect.y);
  for (let y=rect.y-radius;y<=rect.y+radius;y+=2) for (let x=rect.x-radius;x<=rect.x+radius;x+=2) add(x,y);
  candidates.sort((a,b)=>b.score-a.score);
  let best = { score: 0, x: rect.x, y: rect.y };
  for (const c of candidates.slice(0,4)) for (let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
    const x=c.x+dx, y=c.y+dy;
    if(x<0||y<0||x+template.width>screen.width||y+template.height>screen.height) continue;
    const s=score(x,y,1);
    if(s>best.score) best={score:s,x,y};
  }
  return best;
}
// Trigger conditions may move across seats within this instance's page viewport.
async function matchTrigger(screenBuffer, templateBuffer, rect, radius, threshold, signal) {
  const stopped=()=>{if(signal?.aborted)throw new Error('STOPPED');};
  stopped();
  const local=match(screenBuffer,templateBuffer,rect,radius);
  if(local.score>=threshold)return {...local,region:'local'};
  const screen=PNG.sync.read(screenBuffer),template=PNG.sync.read(templateBuffer);
  const w=template.width,h=template.height,total=w*h;
  const allowed=Math.floor(total*(1-threshold)+1e-9);
  // Necessary colour-count bounds cheaply reject most empty backgrounds.
  // ±32 expansion makes these filters conservative, never a new threshold.
  const filters=[],pitch=screen.width+1;
  for(let channel=0;channel<3;channel++){
    const values=[];for(let i=channel;i<template.data.length;i+=4)values.push(template.data[i]);
    values.sort((a,b)=>a-b);const median=values[Math.floor(values.length/2)];
    for(const lower of [true,false]){
      const required=values.filter(v=>lower?v<=median:v>=median).length-allowed;
      if(required<=0)continue;
      const limit=median+(lower?32:-32),table=new Int32Array(pitch*(screen.height+1));
      for(let y=0;y<screen.height;y++){
        if(y%32===0){await new Promise(resolve=>setImmediate(resolve));stopped();}
        let row=0;for(let x=0;x<screen.width;x++){
          const value=screen.data[(y*screen.width+x)*4+channel];row+=Number(lower?value<=limit:value>=limit);
          table[(y+1)*pitch+x+1]=table[y*pitch+x+1]+row;
        }
      }
      filters.push({table,required});
    }
  }
  // Exact rejection: every differing pixel counts towards the same final budget.
  // Sample distinctive positions first, then visit remaining pixels once.
  const offsets=[],seen=new Set();
  const stride=Math.max(1,Math.floor(Math.min(w,h)/8));
  for(let y=0;y<h;y+=stride)for(let x=0;x<w;x+=stride){const n=y*w+x;offsets.push(n);seen.add(n);}
  for(let n=0;n<total;n++)if(!seen.has(n))offsets.push(n);
  const screenOffsets=offsets.map(n=>(Math.floor(n/w)*screen.width+n%w)*4);
  let best=null;
  for(let y=0;y<=screen.height-h;y++){
    if(y%8===0){await new Promise(resolve=>setImmediate(resolve));stopped();}
    for(let x=0;x<=screen.width-w;x++){
      if(filters.some(({table,required})=>table[(y+h)*pitch+x+w]-table[y*pitch+x+w]-table[(y+h)*pitch+x]+table[y*pitch+x]<required))continue;
      let bad=0;
      const origin=(y*screen.width+x)*4;
      for(let i=0;i<offsets.length;i++){
        const a=origin+screenOffsets[i],b=offsets[i]*4;
        if((Math.abs(screen.data[a]-template.data[b])>32||Math.abs(screen.data[a+1]-template.data[b+1])>32||Math.abs(screen.data[a+2]-template.data[b+2])>32)&&++bad>allowed)break;
      }
      if(bad>allowed)continue;
      const score=1-bad/total;
      if(best&&Math.hypot(x-best.x,y-best.y)>8)return {...best,region:'viewport',ambiguous:true};
      if(!best||score>best.score)best={x,y,score};
    }
  }
  stopped();
  return best?{...best,region:'viewport',ambiguous:false}: {...local,region:'local'};
}

// Search only this instance's canvas; yield to keep Stop and other instances responsive.
async function locateClick(screenBuffer, visual, point, bounds, signal) {
  const fail=code=>{const e=new Error(code);e.code=code;throw e;};
  let screen,template;
  try{screen=PNG.sync.read(screenBuffer);template=PNG.sync.read(Buffer.from(visual.image,'base64'));}catch{fail('VISUAL_INVALID');}
  if(template.width!==48||template.height!==48||!Number.isFinite(visual.offset?.x)||!Number.isFinite(visual.offset?.y))fail('VISUAL_INVALID');
  const w=template.width,h=template.height,threshold=.90;
  let distinct=0;
  for(let i=0;i<template.data.length;i+=4){
    if(template.data[i+3]<240)fail('VISUAL_INVALID');
    if(Math.max(...[0,1,2].map(c=>Math.abs(template.data[i+c]-template.data[c])))>32)distinct++;
  }
  if(distinct<w*h*.08)fail('VISUAL_INVALID');
  const minX=Math.max(0,Math.ceil(bounds.x)),minY=Math.max(0,Math.ceil(bounds.y));
  const maxX=Math.min(screen.width-w,Math.floor(bounds.x+bounds.width-w));
  const maxY=Math.min(screen.height-h,Math.floor(bounds.y+bounds.height-h));
  const inside=(x,y)=>x>=minX&&y>=minY&&x<=maxX&&y<=maxY;
  let inset=0;
  function score(x,y,stride,limit) {
    let bad=0,total=Math.ceil((w-2*inset)/stride)*Math.ceil((h-2*inset)/stride);
    for(let j=inset;j<h-inset;j+=stride)for(let i=inset;i<w-inset;i+=stride){
      const a=((y+j)*screen.width+x+i)*4,b=(j*w+i)*4;
      if(Math.max(Math.abs(screen.data[a]-template.data[b]),Math.abs(screen.data[a+1]-template.data[b+1]),Math.abs(screen.data[a+2]-template.data[b+2]))>32)bad++;
      if(bad>total*(1-limit))return 0;
    }
    return 1-bad/total;
  }
  const original={x:Math.round(point.x-visual.offset.x),y:Math.round(point.y-visual.offset.y)};
  if(signal?.aborted)throw new Error('STOPPED');
  async function search(){
    if(inside(original.x,original.y)&&score(original.x,original.y,1,threshold)>=threshold)return {...point,relocated:false};
    let best=null;
    for(let y=minY;y<=maxY;y++){
      if(y%8===0){await new Promise(resolve=>setImmediate(resolve));if(signal?.aborted)throw new Error('STOPPED');}
      for(let x=minX;x<=maxX;x++){
        if(score(x,y,6,.70)<.70)continue;
        const s=score(x,y,1,threshold);if(s<threshold)continue;
        if(best&&Math.hypot(x-best.x,y-best.y)>8)fail('VISUAL_AMBIGUOUS');
        if(!best||s>best.score)best={x,y,score:s};
      }
    }
    if(!best)return null;
    return {x:best.x+visual.offset.x,y:best.y+visual.offset.y,relocated:true};
  }
  const full=await search();if(full)return full;
  // Ignore animated scenery / scrollbars around a feature-bearing central patch.
  // Keep the same threshold and ambiguity checks as the full template.
  inset=8;let features=0;const base=(inset*w+inset)*4;
  for(let y=inset;y<h-inset;y++)for(let x=inset;x<w-inset;x++){
    const i=(y*w+x)*4;
    if(Math.max(...[0,1,2].map(c=>Math.abs(template.data[i+c]-template.data[base+c])))>32)features++;
  }
  if(features<32*32*.08)fail('VISUAL_NOT_FOUND');
  const core=await search();if(!core)fail('VISUAL_NOT_FOUND');
  return {...core,region:'center'};
}
// Diagnostic only: original template at left, current recorded region at right.
function triggerComparison(screenBuffer, templateBuffer, rect) {
  const screen=PNG.sync.read(screenBuffer),template=PNG.sync.read(templateBuffer);
  if(rect.x<0||rect.y<0||rect.x+template.width>screen.width||rect.y+template.height>screen.height)return;
  const output=new PNG({width:template.width*2+8,height:template.height});
  output.data.fill(255);
  PNG.bitblt(template,output,0,0,template.width,template.height,0,0);
  PNG.bitblt(screen,output,rect.x,rect.y,template.width,template.height,template.width+8,0);
  return PNG.sync.write(output);
}
module.exports = { crop, match, matchTrigger, locateClick, triggerComparison };
