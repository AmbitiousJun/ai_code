const test=require('node:test');
const assert=require('node:assert/strict');
const {PNG}=require('pngjs');
const {locateClick}=require('../src/vision');
const tile=new PNG({width:48,height:48});
for(let y=0;y<48;y++)for(let x=0;x<48;x++){const i=(y*48+x)*4;tile.data[i]=(x*17+y*31)%256;tile.data[i+1]=(x*7+y*11)%256;tile.data[i+2]=120;tile.data[i+3]=255;}
const visual={image:PNG.sync.write(tile).toString('base64'),offset:{x:17,y:29}};
function screen(positions){const p=new PNG({width:400,height:220});p.data.fill(255);for(const [x,y] of positions)PNG.bitblt(tile,p,0,0,48,48,x,y);return PNG.sync.write(p);}
const bounds={x:0,y:0,width:400,height:220},original={x:37,y:49};
test('原位置优先，远距离偏移保留点击锚点',async()=>{
  assert.deepEqual(await locateClick(screen([[20,20],[300,100]]),visual,original,bounds),{...original,relocated:false});
  assert.deepEqual(await locateClick(screen([[301,101]]),visual,original,bounds),{x:318,y:130,relocated:true});
});
test('匹配器报告重复、缺失及范围外目标，供回放决定坐标回退',async()=>{
  await assert.rejects(locateClick(screen([[120,50],[300,100]]),visual,original,bounds),{code:'VISUAL_AMBIGUOUS'});
  await assert.rejects(locateClick(screen([]),visual,original,bounds),{code:'VISUAL_NOT_FOUND'});
  await assert.rejects(locateClick(screen([[300,100]]),visual,original,{x:0,y:0,width:200,height:220}),{code:'VISUAL_NOT_FOUND'});
});
test('搜索可取消',async()=>{const c=new AbortController();const promise=locateClick(screen([]),visual,original,bounds,c.signal);c.abort();await assert.rejects(promise,/STOPPED/);});
test('匹配器拒绝使用空白或透明模板定位',async()=>{
  const blank=new PNG({width:48,height:48});blank.data.fill(255);
  await assert.rejects(locateClick(screen([]),{...visual,image:PNG.sync.write(blank).toString('base64')},original,bounds),{code:'VISUAL_INVALID'});
  blank.data.fill(0);
  await assert.rejects(locateClick(screen([]),{...visual,image:PNG.sync.write(blank).toString('base64')},original,bounds),{code:'VISUAL_INVALID'});
});

test('完整模板未通过时不使用中央裁剪绕过校验',async()=>{
 const changed=PNG.sync.read(screen([[120,50]]));
 for(let y=0;y<48;y++)for(let x=0;x<48;x++)if(x<8||x>=40||y<8||y>=40){const i=((50+y)*400+120+x)*4;changed.data.fill(255,i,i+4);}
 await assert.rejects(locateClick(PNG.sync.write(changed),visual,original,bounds),{code:'VISUAL_NOT_FOUND'});
 PNG.bitblt(changed,changed,120,50,48,48,300,100);
 await assert.rejects(locateClick(PNG.sync.write(changed),visual,original,bounds),{code:'VISUAL_NOT_FOUND'});
 const flat=PNG.sync.read(Buffer.from(visual.image,'base64'));
 for(let y=8;y<40;y++)for(let x=8;x<40;x++)flat.data.fill(255,(y*48+x)*4,(y*48+x)*4+4);
 await assert.rejects(locateClick(screen([]),{...visual,image:PNG.sync.write(flat).toString('base64')},original,bounds),{code:'VISUAL_NOT_FOUND'});
});


test('full-pixel threshold retains targets rejected by the former sparse sample filter',async()=>{
 const shot=PNG.sync.read(screen([[301,101]]));
 // 64 sampled pixels differ, but over 97% of the complete template still matches.
 for(let y=0;y<48;y+=6)for(let x=0;x<48;x+=6){const i=((101+y)*400+301+x)*4,j=(y*48+x)*4;for(let c=0;c<3;c++)shot.data[i+c]=(tile.data[j+c]+128)%256;}
 assert.deepEqual(await locateClick(PNG.sync.write(shot),visual,original,bounds),{x:318,y:130,relocated:true});
});
