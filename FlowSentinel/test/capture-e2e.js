const assert=require('node:assert/strict'),http=require('http'),fs=require('fs');
const {PNG}=require('pngjs');const {Recorder,replayStep,sleep}=require('../src/engine');const {crop}=require('../src/vision');
const picture=new PNG({width:500,height:280});picture.data.fill(255);
for(let y=70;y<150;y++)for(let x=80;x<160;x++){const i=(y*500+x)*4;picture.data[i]=(x*17+y*31)%256;picture.data[i+1]=(x*7+y*11)%256;picture.data[i+2]=120;}
const png=PNG.sync.write(picture);
async function until(fn){for(let i=0;i<100;i++){if(await fn())return;await sleep(50);}throw new Error('capture timeout');}
(async()=>{
 const server=http.createServer((req,res)=>{
  if(req.url==='/image'){res.setHeader('Content-Type','image/png');res.end(png);return;}
  res.setHeader('Content-Type','text/html');
  if(req.url.startsWith('/host')){res.end('<iframe style="width:600px;height:400px;border:3px solid" src="http://localhost:'+server.address().port+req.url.replace('/host','')+'"></iframe>');return;}
  if(req.url==='/staticwebgl'){res.end('<canvas width="500" height="280"></canvas><script>const c=document.querySelector("canvas"),gl=c.getContext("webgl");gl.clearColor(.1,.2,.3,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.enable(gl.SCISSOR_TEST);for(let y=0;y<10;y++)for(let x=0;x<10;x++){gl.scissor(80+x*8,130+y*8,8,8);gl.clearColor(((x*73+y*37)%255)/255,((x*31+y*97)%255)/255,(x+y)%2,1);gl.clear(gl.COLOR_BUFFER_BIT);}window.ready=true;c.onpointerdown=()=>{gl.disable(gl.SCISSOR_TEST);gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);};</script>');return;}
  const tainted=req.url==='/tainted',flat=req.url==='/flat';
  res.setHeader('Content-Type','text/html');res.end('<style>body{margin:19px}canvas{border:2px solid black;background:'+(flat?'#456':'url(/image)')+'}</style><canvas id="game" width="500" height="280"></canvas><script>window.hits=0;const c=document.querySelector("canvas"),ctx=c.getContext("2d");window.ready=false;'+(tainted?'const img=new Image();img.onload=()=>{ctx.drawImage(img,0,0);window.ready=true};img.src="http://127.0.0.1:'+server.address().port+'/image";':'window.ready=true;')+'c.onpointerdown=()=>{hits++;c.style.background="black";ctx.fillStyle="black";ctx.fillRect(0,0,500,280)};</script>');
 });await new Promise(r=>server.listen(0,r));let rec;
 try{
  for(const mode of ['layer','tainted','flat','staticwebgl']){
   const flow={viewport:{width:900,height:600},steps:[]};rec=new Recorder(flow);await rec.start();
   await rec.page.goto('http://127.0.0.1:'+server.address().port+'/host/'+mode);
   const frame=rec.page.frames().find(f=>f.url().includes('localhost'));await frame.waitForFunction(()=>window.ready);
   await until(()=>rec.clickCapture.pages.get(rec.page).frames.length>0);
   const el=frame.locator('canvas');const before=await rec.page.screenshot();await sleep(150);
   const b=await el.boundingBox();await rec.page.mouse.click(b.x+110,b.y+110);await sleep(100);await rec.stop();
   const step=flow.steps.find(s=>s.type==='canvas');assert.equal(step?.visual?.source,'compositor',mode);assert.equal(step.frame.length,1);
   if(mode==='flat'){assert.match(step.visualError,/特征不足/);continue;}
   assert.equal(step.visualError,undefined,mode);
   const pixels=PNG.sync.read(Buffer.from(step.visual.image,'base64'));const unique=new Set();for(let i=0;i<pixels.data.length;i+=4)unique.add(pixels.data[i]);assert.ok(unique.size>1,'not post-click black frame');
   const expected=crop(before,{x:b.x+110-6,y:b.y+110-6,width:12,height:12});assert.deepEqual(pixels.data,PNG.sync.read(expected.buffer).data,'viewport and iframe coordinate alignment');
  }
  fs.writeFileSync('test-results/capture-report.txt','PASS: transparent canvas over visible CSS image; cross-origin tainted canvas; nested frame coordinates; captured image predates immediate click replacement; low-texture capture retained with accurate warning; static WebGL without animation callbacks.\n');console.log('PASS compositor capture');
 }finally{await rec?.stop();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
