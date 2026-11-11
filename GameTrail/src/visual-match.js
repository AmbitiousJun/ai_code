const {scanTiles} = require("./scan-tiles");
// Match area-averaged luminance and colour at the same sampling resolution as the frozen crop.
const SIDE = 32;
const {PNG} = require("playwright-core/lib/utilsBundle");
const patterns = new WeakMap();
function pattern(template) {
  if (patterns.has(template)) return patterns.get(template);
  const rgb = Buffer.from(template.rgb || "", "base64");
  if (rgb.length !== SIDE*SIDE*3 || ![template.width,template.height,template.viewWidth,template.viewHeight].every(Number.isFinite)
      || template.width<8 || template.height<8 || template.width>template.viewWidth || template.height>template.viewHeight)
    throw Error("框选区域无效，请重新框选");
  const luma = new Float32Array(SIDE*SIDE);
  let mean = 0;
  for (let i=0;i<luma.length;i++) mean += luma[i] = (rgb[3*i]*2+rgb[3*i+1]*5+rgb[3*i+2])/8;
  // Preserve the exact crop for small controls and use the same cell filter on both images.
  if (template.detail) {
    const bytes = Buffer.from(template.detail,"base64");
    if (bytes.length<24 || bytes.readUInt32BE(16)>128 || bytes.readUInt32BE(20)>128)
      throw Error("按钮截图尺寸无效");
    const crop = PNG.sync.read(bytes);
    mean = 0;
    for (let i=0;i<luma.length;i++) {
      const cell = sampleCell(i,crop.width,crop.height);
      let sum=0;
      for (let y=cell.y;y<cell.bottom;y++) for (let x=cell.x;x<cell.right;x++) {
        const p=4*(y*crop.width+x);
        sum+=(2*crop.data[p]+5*crop.data[p+1]+crop.data[p+2])/8;
      }
      mean += luma[i] = sum/((cell.right-cell.x)*(cell.bottom-cell.y));
      crop.data.copy(rgb,3*i,cell.pixel,cell.pixel+3);
    }
  }
  mean /= luma.length;
  const ranks = Array.from(luma, (v,i) => ({i, weight:Math.abs(v-mean)+Math.abs(v-luma[i%SIDE ? i-1 : i])}));
  const anchors = [];
  for (const {i} of ranks.sort((a,b)=>b.weight-a.weight)) {
    if (anchors.every(j=>Math.hypot(i%SIDE-j%SIDE,(i>>5)-(j>>5))>=5)) anchors.push(i);
    if (anchors.length===8) break;
  }
  if (ranks.filter(r=>r.weight>14).length<20 && !rgb.some((v,i)=>Math.abs(v-rgb[i%3])>55))
    throw Error("选区特征太少，请框入有轮廓的按钮图案");
  const result = {rgb,luma,anchors};
  patterns.set(template,result);
  return result;
}

function sampleCell(i,w,h) {
  const col=i%SIDE, row=i>>5;
  const x=Math.min(w-1,Math.round(col*w/SIDE)), y=Math.min(h-1,Math.round(row*h/SIDE));
  const right=Math.min(w,Math.max(x+1,Math.round((col+1)*w/SIDE)));
  const bottom=Math.min(h,Math.max(y+1,Math.round((row+1)*h/SIDE)));
  return {x,y,right,bottom,pixel:4*(((y+bottom-1)>>1)*w+((x+right-1)>>1))};
}
// Integral luminance allows the same thin edges to be compared after resizing.
function scan(image, template, minimum, gameScale = []) {
  const {rgb,luma,anchors} = pattern(template);
  const {width,height,data} = image, pitch = width+1;
  const integral = new Float64Array(pitch*(height+1));
  for (let y=0;y<height;y++) {
    let sum=0;
    for (let x=0;x<width;x++) {
      const p=4*(y*width+x), k=(y+1)*pitch+x+1;
      sum+=(2*data[p]+5*data[p+1]+data[p+2])/8;
      integral[k]=integral[k-pitch]+sum;
    }
  }
  const scales = new Set([1,0.5,0.75,1.25,1.5,2]);
  for (const base of [1,width/template.viewWidth,height/template.viewHeight,...gameScale])
    for (const factor of [0.85,0.90,0.95,1,1.05,1.10,1.15]) scales.add(base*factor);
  const sizes = new Set(), hits=[];
  let best, nearest, nearestError=Infinity;
  const limit=(100-minimum)*2.55;
  for (const scale of scales) {
    const w=Math.round(template.width*scale), h=Math.round(template.height*scale);
    const key=w+"x"+h;
    if (w<6 || h<6 || w>width || h>height || sizes.has(key)) continue;
    sizes.add(key);
    const cells = Array.from(luma,(_,i)=>{
      const {x,y,right,bottom}=sampleCell(i,w,h);
      return {a:y*pitch+x,b:y*pitch+right,c:bottom*pitch+x,d:bottom*pitch+right,
        weight:1/((right-x)*(bottom-y)),pixel:4*(((y+bottom-1)>>1)*width+((x+right-1)>>1))};
    });
    function light(base,i) {
      const {a,b,c,d,weight}=cells[i];
      return (integral[base+d]-integral[base+c]-integral[base+b]+integral[base+a])*weight;
    }
    function score(x,y,indices) {
      const base=y*pitch+x, pixel=4*(y*width+x);
      let error=0, bias=0, colour=0;
      for (const i of indices) {
        const diff=light(base,i)-luma[i], p=pixel+cells[i].pixel;
        error+=Math.abs(diff); bias+=diff;
        for (let c=0;c<3;c++) colour+=Math.abs(data[p+c]-rgb[i*3+c]);
      }
      // Signed bias discounts a mild, uniform glow; luminance differences retain edge detail.
      return (0.8*error-0.22*Math.min(Math.abs(bias),indices.length*32)+colour/15)/indices.length;
    }
    const stride=Math.max(1,Math.min(6,Math.floor(Math.min(w,h)/12)));
    for (const tile of scanTiles(image, template, w, h, stride)) {
      for (let y=tile.top;y<=tile.bottom;y+=stride) for (let x=tile.left;x<=tile.right;x+=stride) {
        const base=y*pitch+x;
        let err=0;
        for (const i of anchors) {
          err+=Math.abs(light(base,i)-luma[i]);
          if (err>(limit+36)*anchors.length && err>=nearestError) break;
        }
        if (err<nearestError) {
          nearestError=err;
          nearest={x:x+w/2,y:y+h/2,w,h,score:score(x,y,all)};
        }
        if (err>(limit+36)*anchors.length) continue;
        if (score(x,y,coarse)>Math.max(limit+24,35)) continue;
        let bx=x,by=y,local=Infinity;
        for (let dy=0;dy<stride && y+dy<=height-h;dy++) for (let dx=0;dx<stride && x+dx<=width-w;dx++) {
          const error=score(x+dx,y+dy,coarse);
          if (error<local) {local=error;bx=x+dx;by=y+dy;}
        }
        if (local>Math.max(limit+12,25)) continue;
        const error=0.8*score(bx,by,all)+0.2*score(bx,by,anchors);
        const hit={x:bx+w/2,y:by+h/2,w,h,score:error};
        if (!best || best.score>error) best=hit;
        if (error>limit) continue;
        const index=hits.findIndex(p=>Math.abs(p.x-hit.x)<Math.min(p.w,w)*0.4 && Math.abs(p.y-hit.y)<Math.min(p.h,h)*0.4);
        if (index<0) hits.push(hit);
        else if (error<hits[index].score) hits[index]=hit;
        if (hits.length>=3) return {hits,best};
      }
    }
  }
  return {hits,best:best || nearest};
}
const all = Array.from({length:SIDE*SIDE},(_,i)=>i);
const coarse = all.filter(i=>i%4===2 && (i>>5)%4===2);
module.exports = {scan};
