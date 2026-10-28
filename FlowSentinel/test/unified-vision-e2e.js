const assert=require('node:assert/strict'),http=require('http'),fs=require('fs');
const {PNG}=require('pngjs');
const {Runner,config,sleep}=require('../src/engine');
const tile=new PNG({width:48,height:48});
for(let y=0;y<48;y++)for(let x=0;x<48;x++){
  const i=(y*48+x)*4;tile.data[i]=(x*17+y*31)%256;tile.data[i+1]=(x*7+y*11)%256;tile.data[i+2]=120;tile.data[i+3]=255;
}
const image=PNG.sync.write(tile).toString('base64');
async function until(fn){const end=Date.now()+20000;while(Date.now()<end){if(fn())return;await sleep(50);}throw new Error('Timed out');}
(async()=>{
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<!doctype html><style>body{margin:0}canvas{display:block}</style><canvas width="800" height="400"></canvas><input id="after"><button id="sub" onclick="window.hits++">Subflow</button><script>
  window.hits=0;const ctx=document.querySelector('canvas').getContext('2d'),img=new Image();
  window.paint=mode=>{ctx.fillStyle='white';ctx.fillRect(0,0,800,400);if(mode!=='missing')ctx.drawImage(img,500,200);if(mode==='duplicate')ctx.drawImage(img,200,100);if(mode==='original')ctx.drawImage(img,20,20);};
  img.onload=()=>paint('moved');img.src='data:image/png;base64,${image}';</script>`);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));let runner;
  try{
    const trusted={page:0,rect:{x:20,y:20,width:48,height:48},image};
    const flow={id:'unified-vision',viewport:{width:800,height:600},trusted,steps:[
      {type:'goto',url:'http://127.0.0.1:'+server.address().port},
      {type:'checkpoint',trusted,timeout:5000,threshold:.9},
      {type:'fill',selector:'#after',value:'checkpoint passed'}
    ],subflows:[{id:'moved-trigger',name:'Moved',trigger:{type:'image',trusted},steps:[
      {type:'checkpoint',trusted,timeout:5000,threshold:.9},{type:'click',selector:'#sub'}
    ]}]};
    runner=new Runner(flow,config({grace:0,interval:1,actionInterval:0,retries:0,failures:1}));
    const logs=[];runner.on('log',(level,message)=>logs.push(message));const running=runner.start();
    await until(()=>logs.some(m=>m.includes('子流程完成')));
    const page=[...runner.browsers][0].contexts()[0].pages()[0];
    assert.equal(await page.locator('#after').inputValue(),'checkpoint passed');
    assert.ok(await page.evaluate(()=>window.hits)>0);
    assert.ok(logs.some(m=>m.includes('全视口定位 (500, 200)')));
    await page.evaluate(()=>paint('original'));
    await until(()=>logs.some(m=>m.includes('原位置')&&m.includes('正常')));
    await page.evaluate(()=>paint('duplicate'));
    await running;
    assert.equal(runner.states[0].status,'需要人工处理');
    assert.ok(logs.some(m=>m.includes('多个匹配目标')&&m.includes('连续失败')));
    fs.writeFileSync('test-results/unified-vision-e2e-report.txt','PASS: real Chrome moved main checkpoint, final inspection, image subflow trigger and subflow checkpoint; original wins despite duplicate; displaced duplicates fail inspection.\n');
    console.log('Unified vision E2E PASS');
  }finally{await runner?.stop();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
