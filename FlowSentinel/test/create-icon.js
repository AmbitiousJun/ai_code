const fs=require('fs');const {PNG}=require('pngjs');
const png=new PNG({width:256,height:256});
const polygon=(x,y,p)=>{let inside=false;for(let i=0,j=p.length-1;i<p.length;j=i++){const [xi,yi]=p[i],[xj,yj]=p[j];if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside;}return inside;};
const outer=[[128,30],[209,63],[201,153],[174,190],[128,224],[82,190],[55,153],[47,63]];
const inner=[[128,51],[187,77],[181,145],[158,175],[128,198],[98,175],[75,145],[69,77]];
for(let y=0;y<256;y++)for(let x=0;x<256;x++){const i=(y*256+x)*4;const r=34;const cx=Math.max(r,Math.min(255-r,x)),cy=Math.max(r,Math.min(255-r,y));const inside=(x-cx)**2+(y-cy)**2<=r*r;if(!inside)continue;let rgb=[14,29,44];if(polygon(x,y,outer))rgb=[85,215,187];if(polygon(x,y,inner))rgb=[17,43,53];if((x>=97&&x<=112&&y>=104&&y<=151)||(x>=112&&x<=159&&y>=104&&y<=118)||(x>=112&&x<=147&&y>=131&&y<=145))rgb=[221,251,244];png.data.set([...rgb,255],i);}
const data=PNG.sync.write(png);fs.writeFileSync('src/ui/icon.png',data);const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header[6]=0;header[7]=0;header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(data.length,14);header.writeUInt32LE(22,18);fs.writeFileSync('src/ui/icon.ico',Buffer.concat([header,data]));
