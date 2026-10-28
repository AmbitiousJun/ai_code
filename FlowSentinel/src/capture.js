const {PNG}=require('pngjs');
const {crop}=require('./vision');

// Keep compositor frames in memory while recording. Unlike canvas readback,
// these contain the visible result, including CSS backgrounds and other layers.
class ClickCapture {
  constructor(context){this.context=context;this.pages=new Map();}
  async attach(page){
    const state={frames:[],closed:false};this.pages.set(page,state);
    const clear=()=>{state.frames=[];};page.on('framenavigated',clear);
    page.once('close',()=>{state.closed=true;clear();this.pages.delete(page);});
    try{
      const session=await this.context.newCDPSession(page);state.session=session;
      session.on('Page.screencastFrame',event=>{
        if(!state.closed){
          const at=event.metadata.timestamp*1000;
          if(Number.isFinite(at)){state.frames.push({at,data:event.data,metadata:event.metadata});if(state.frames.length>6)state.frames.shift();}
        }
        session.send('Page.screencastFrameAck',{sessionId:event.sessionId}).catch(()=>{});
      });
      await session.send('Page.enable');
      const start=async()=>{await session.send('Page.stopScreencast');await session.send('Page.startScreencast',{format:'png',everyNthFrame:1});};
      page.on('domcontentloaded',()=>start().catch(()=>{}));
      await start();
    }catch{state.unavailable=true;}
  }
  async capture(source,point){
    // Select BEFORE awaiting frame geometry: a later screenshot may already
    // contain the result of the click, not its target.
    const state=this.pages.get(source.page);
    const shot=state?.frames.filter(f=>f.at<=point.at).at(-1);
    if(!shot)throw new Error('尚未取得点击前的页面画面，请等待画面显示后重新录制');
    const viewport=source.page.viewportSize();
    const buffer=Buffer.from(shot.data,'base64'),png=PNG.sync.read(buffer);
    if(png.width!==viewport.width||png.height!==viewport.height||shot.metadata.pageScaleFactor!==1)throw new Error('页面截图比例异常，请恢复浏览器缩放后重新录制');
    let ox=0,oy=0,frame=source.frame;
    while(frame.parentFrame()){
      const handle=await frame.frameElement();
      const offset=await handle.evaluate(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {x:r.x+parseFloat(s.borderLeftWidth)+parseFloat(s.paddingLeft),y:r.y+parseFloat(s.borderTopWidth)+parseFloat(s.paddingTop)};});
      await handle.dispose();ox+=offset.x;oy+=offset.y;frame=frame.parentFrame();
    }
    const x=point.x+ox,y=point.y+oy,r=point.rect;
    const left=Math.max(0,Math.ceil(r.x+ox)),top=Math.max(0,Math.ceil(r.y+oy));
    const right=Math.min(png.width,Math.floor(r.x+ox+r.width)),bottom=Math.min(png.height,Math.floor(r.y+oy+r.height));
    if(right-left<12||bottom-top<12||x<left||x>=right||y<top||y>=bottom)throw new Error('点击区域不可见，请滚动到完整按钮后重新录制');
    const rect={x:Math.max(left,Math.min(right-12,Math.round(x-6))),y:Math.max(top,Math.min(bottom-12,Math.round(y-6))),width:12,height:12};
    const image=crop(buffer,rect).buffer;
    // Preserve a visible low-texture thumbnail too. The matcher must still
    // reject such templates; do not mislabel a readable image as capture failure.
    const pixels=PNG.sync.read(image).data;let distinct=0;
    for(let i=0;i<pixels.length;i+=4)if(Math.max(Math.abs(pixels[i]-pixels[0]),Math.abs(pixels[i+1]-pixels[1]),Math.abs(pixels[i+2]-pixels[2]))>32)distinct++;
    return {visual:{image:image.toString('base64'),offset:{x:x-rect.x,y:y-rect.y},width:12,height:12,source:'compositor'},visualError:distinct<12*12*.08?'截图已获取，但图案特征不足，请点击文字或图标重新录制':undefined};
  }
  async close(){
    const states=[...this.pages.values()];this.pages.clear();
    await Promise.allSettled(states.map(async state=>{state.closed=true;state.frames=[];await state.session?.detach();}));
  }
}
module.exports={ClickCapture};
