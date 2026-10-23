const http=require('http');
const fs=require('fs');
async function fixture(){
  let portA,portB;
  const serverA=http.createServer((req,res)=>{
    res.setHeader('Content-Type','text/html; charset=utf-8');
    if(req.url==='/vue.js'){res.setHeader('Content-Type','application/javascript');res.end(fs.readFileSync(require.resolve('vue/dist/vue.global.prod.js')));return;}
    if(req.url==='/inner'){
      res.end(`<!doctype html><html><style>body{margin:8px;font:14px Arial}canvas{display:block;border:1px solid #444;margin-top:8px}</style><input id="innerText" placeholder="inner input"><label><input id="agree" type="checkbox">Agree</label><canvas id="pad" width="240" height="110" tabindex="0"></canvas><div id="keyResult"></div><script>let drawing=false;const c=document.querySelector('canvas'),ctx=c.getContext('2d');c.onpointerdown=e=>{drawing=true;ctx.beginPath();ctx.moveTo(e.offsetX,e.offsetY)};c.onpointermove=e=>{if(drawing){ctx.lineTo(e.offsetX,e.offsetY);ctx.stroke()}};c.onpointerup=()=>{drawing=false;top.postMessage({type:'canvasDone'},'*')};c.onkeydown=e=>document.querySelector('#keyResult').textContent=e.key;</script></html>`);return;
    }
    res.end(`<!doctype html><html><head><style>body{margin:24px;background:#f5f7fa;font:16px Arial}input,button,select{padding:8px;margin:5px}iframe{display:block;width:600px;height:380px;border:1px solid #aaa}#badge{width:230px;height:56px;background:#126f57;color:white;font:bold 20px Arial;display:flex;align-items:center;justify-content:center;border:4px solid #143955;margin-bottom:12px}h2{margin:10px}</style></head><body><div id="app"><form v-if="!logged" @submit.prevent="login"><h2>Vue login fixture</h2><input id="user" v-model="user" placeholder="Username"><input id="pass" type="password" v-model="pass" placeholder="Password"><select id="mode" v-model="mode"><option value="a">A</option><option value="b">B</option></select><button id="login">Login</button><p>{{error}}</p></form><div v-else><h2>Dashboard</h2><div id="badge" v-if="ready">✓ SYSTEM READY 7X</div><div v-else id="waiting">Waiting for Canvas</div><iframe id="outer" src="http://127.0.0.1:${portB}/outer"></iframe></div></div><script src="/vue.js"></script><script>const app=Vue.createApp({data:()=>({user:'',pass:'',mode:'a',error:'',logged:false,ready:false}),methods:{login(){if(this.user==='test-user'&&this.pass==='test-secret'&&this.mode==='b')this.logged=true;else this.error='Invalid input'}},mounted(){window.addEventListener('message',e=>{if(e.data.type==='canvasDone')this.ready=true})}}).mount('#app');</script></body></html>`);
  });
  const serverB=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html><style>body{margin:8px;font:14px Arial}iframe{width:530px;height:260px;display:block;margin-top:12px}</style><label>Cross-origin input <input id="outerText"></label><iframe id="inner" src="http://127.0.0.1:${portA}/inner"></iframe></html>`);});
  await new Promise(r=>serverA.listen(0,'127.0.0.1',r));portA=serverA.address().port;
  await new Promise(r=>serverB.listen(0,'127.0.0.1',r));portB=serverB.address().port;
  return{url:'http://127.0.0.1:'+portA+'/',close:()=>Promise.all([new Promise(r=>serverA.close(r)),new Promise(r=>serverB.close(r))])};
}
module.exports={fixture};
