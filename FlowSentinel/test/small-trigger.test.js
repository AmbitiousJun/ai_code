const test=require('node:test'),assert=require('node:assert/strict');
const {PNG}=require('pngjs');const {crop,match}=require('../src/vision');
function fixture(){
 const template=new PNG({width:12,height:27});let seed=42;
 for(let i=0;i<template.data.length;i+=4){for(let c=0;c<3;c++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;template.data[i+c]=seed>>>24;}template.data[i+3]=255;}
 const screen=new PNG({width:180,height:120});screen.data.fill(255);
 for(const x of [50,70,90,110]){PNG.bitblt(template,screen,0,0,12,27,x,20);for(let y=0;y<10;y++)for(let dx=0;dx<12;dx++){const i=((20+y)*screen.width+x+dx)*4;screen.data[i]=screen.data[i+1]=screen.data[i+2]=255;}}
 PNG.bitblt(template,screen,0,0,12,27,85,55);
 return {screen:PNG.sync.write(screen),template:PNG.sync.write(template),rect:{x:80,y:50,width:12,height:27}};
}
test('narrow trigger finds odd-pixel offset despite four stronger coarse distractors',()=>{
 const f=fixture();assert.deepEqual(match(f.screen,f.template,f.rect,32),{x:85,y:55,score:1});
 assert.ok(match(f.screen,f.template,f.rect,0).score<.7);
});
test('small template search respects radius and viewport edges',()=>{
 const f=fixture();assert.ok(match(f.screen,f.template,f.rect,4).score<.7);
 const rect={x:168,y:93,width:12,height:27},ref=crop(f.screen,rect);
 assert.equal(match(f.screen,ref.buffer,rect,64).score,1);
});
test('image scheduler reports misses without logging every poll, then executes matching trigger',async()=>{
 const {SubflowScheduler}=require('../src/subflows'),{config}=require('../src/engine');const f=fixture();const blank=new PNG({width:180,height:120});blank.data.fill(255);let clicks=0,shot=PNG.sync.write(blank);
 const logs=[],images=[],page={screenshot:async()=>shot,setDefaultTimeout:()=>{},setDefaultNavigationTimeout:()=>{},mainFrame:()=>page,isClosed:()=>false,context:()=>null,locator:()=>({click:async()=>clicks++})};
 const sub={id:'small',name:'small',trigger:{type:'image',trusted:{rect:f.rect,image:f.template.toString('base64')}},steps:[{type:'click',selector:'#go'}]};
 const scheduler=new SubflowScheduler([sub]),pages=new Map([[0,page]]),cfg=config({actionInterval:0,radius:0,threshold:.7}),signal=new AbortController().signal;
 const tick=()=>scheduler.tick(pages,cfg,signal,(l,m,image)=>{logs.push(m);if(image)images.push(image);});
 await tick();await tick();assert.equal(clicks,0);assert.equal(logs.length,1);assert.match(logs[0],/12×27/);assert.match(logs[0],/70%/);
 assert.match(logs[0],/等待触发/);assert.equal(images.length,1);
 const comparison=PNG.sync.read(Buffer.from(images[0].split(',')[1],'base64'));
 assert.equal(comparison.width,32);assert.equal(comparison.height,27);
 const left=new PNG({width:12,height:27}),right=new PNG({width:12,height:27});
 PNG.bitblt(comparison,left,0,0,12,27,0,0);PNG.bitblt(comparison,right,20,0,12,27,0,0);
 assert.deepEqual(left.data,PNG.sync.read(f.template).data);
 assert.deepEqual(right.data,PNG.sync.read(crop(shot,f.rect).buffer).data);
 shot=f.screen;await tick();assert.equal(clicks,1);assert.ok(logs.some(m=>m.includes('已重新定位')));
 const changed=new PNG({width:180,height:120});changed.data.fill(255);shot=PNG.sync.write(changed);
 await tick();assert.equal(clicks,1,'changed button state must wait, not toggle the button again');
 const controller=new AbortController();controller.abort();await assert.rejects(()=>scheduler.tick(pages,cfg,controller.signal,()=>{}),/STOPPED/);assert.equal(clicks,1);
});
module.exports={fixture};

test('trigger viewport search finds changed seat, rejects duplicates, prioritizes local and cancels',async()=>{
 const {matchTrigger}=require('../src/vision'),f=fixture(),rect={...f.rect,x:140,y:70};
 const found=await matchTrigger(f.screen,f.template,rect,0,.7);
 assert.equal(found.score,1);assert.equal(found.x,85);assert.equal(found.y,55);assert.equal(found.ambiguous,false);
 const duplicate=PNG.sync.read(f.screen),ref=PNG.sync.read(f.template);PNG.bitblt(ref,duplicate,0,0,12,27,5,70);const shot=PNG.sync.write(duplicate);
 assert.equal((await matchTrigger(shot,f.template,rect,0,.7)).ambiguous,true);
 assert.equal((await matchTrigger(shot,f.template,{...rect,x:85,y:55},0,.7)).region,'local');
 const controller=new AbortController();setImmediate(()=>controller.abort());
 await assert.rejects(()=>matchTrigger(f.screen,f.template,rect,0,.7,controller.signal),/STOPPED/);
});
test('trigger conservative colour filters retain threshold-boundary matches',async()=>{
 const {matchTrigger}=require('../src/vision'),f=fixture();const template=PNG.sync.read(f.template),screen=new PNG({width:100,height:80});screen.data.fill(255);
 PNG.bitblt(template,screen,0,0,12,27,60,40);
 // Change exactly 25% of the target, preserving a valid 75% match.
 for(let n=0;n<81;n++){const x=n%12,y=Math.floor(n/12),a=((40+y)*100+60+x)*4,b=n*4;for(let c=0;c<3;c++)screen.data[a+c]=(template.data[b+c]+128)%256;}
 const result=await matchTrigger(PNG.sync.write(screen),f.template,{x:0,y:0,width:12,height:27},0,.75);
 assert.equal(result.score,.75);assert.equal(result.x,60);assert.equal(result.y,40);
});
