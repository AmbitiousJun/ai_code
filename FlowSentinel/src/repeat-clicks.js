const {PNG}=require('pngjs');

function sameImage(a,b){
  if(!a?.image||!b?.image||!a.offset||!b.offset)return false;
  if(Math.hypot(a.offset.x-b.offset.x,a.offset.y-b.offset.y)>1)return false;
  if(a.image===b.image)return true;
  try{
    const x=PNG.sync.read(Buffer.from(a.image,'base64')),y=PNG.sync.read(Buffer.from(b.image,'base64'));
    if(x.width!==48||x.height!==48||y.width!==48||y.height!==48)return false;
    let bad=0;
    for(let i=0;i<x.data.length;i+=4){if(Math.max(Math.abs(x.data[i]-y.data[i]),Math.abs(x.data[i+1]-y.data[i+1]),Math.abs(x.data[i+2]-y.data[i+2]),Math.abs(x.data[i+3]-y.data[i+3]))>32)bad++;}
    return bad/(48*48)<=.02;
  }catch{return false;}
}
function shortClick(step,box){
  const p=step.points?.[0];
  return step.type==='canvas'&&p&&!step.visualError&&!!step.visual&&(step.points.at(-1).t-p.t)<=1000&&step.points.every(q=>Math.hypot((q.x-p.x)*box.width,(q.y-p.y)*box.height)<=8);
}
// One tracker per replay attempt. Only genuinely confirmed clicks can seed it.
class RepeatClicks {
  constructor(){this.last=null;}
  async clear(){const last=this.last;this.last=null;await last?.element?.dispose().catch(()=>{});}
  async reuse(page,frame,el,step,box,original){
    const s=this.last;
    if(!s)return null;
    const same=shortClick(step,box)&&s.page===page&&s.frame===frame&&s.selector===step.selector&&s.button===(step.button||'left')&&
      Date.now()-s.at<=5000&&(step.delay||0)<=1500&&Math.hypot(original.x-s.original.x,original.y-s.original.y)<=1&&
      ['x','y','width','height'].every(k=>Math.abs(box[k]-s.box[k])<.5)&&sameImage(step.visual,s.visual);
    let sameElement=false;
    if(same)try{sameElement=await el.evaluate((current,previous)=>current===previous,s.element);}catch{}
    if(!sameElement){await this.clear();return null;}
    return {x:s.target.x,y:s.target.y,count:s.count+1};
  }
  async remember(page,frame,el,step,box,original,target,count,clickedElement){
    const previous=count>1?this.last:null;
    await this.clear();
    if(!shortClick(step,box))return;
    if(!clickedElement)return;
    try{if(!await el.evaluate((current,clicked)=>current===clicked&&current.isConnected,clickedElement))return;}catch{return;}
    const element=await el.elementHandle();if(!element)return;
    this.last={page,frame,element,selector:step.selector,button:step.button||'left',box:{...(previous?.box||box)},original:{...(previous?.original||original)},target:{x:target.x,y:target.y},visual:previous?.visual||step.visual,count,at:Date.now()};
  }
}
module.exports={RepeatClicks,sameImage,shortClick};
