const { chromium } = require('playwright-core');
const { EventEmitter } = require('events');
const { installRecorder } = require('./recorder-script');
const {ClickCapture}=require('./capture');
const {RepeatClicks}=require('./repeat-clicks');
const { match, crop, locateClick } = require('./vision');
const {fieldId,generateValues}=require('./variables');
const fs = require('fs');
const path = require('path');
const SUBFLOW_POLL_INTERVAL = 200;

const DEFAULTS = { count: 1, interval: 15, threshold: 0.90, failures: 3, retries: 5, grace: 5, radius: 12, stepTimeout: 15000, maxStepDelay: 10000, ignoreRecordedDelays: true, actionInterval: 200, checkpointTimeout: 60000, mute: true, noThrottle: true, headless: true, chromePath: '' };
function config(input = {}) {
  const out = { ...DEFAULTS, ...input };
  for (const [k,min,max] of [['count',1,64],['interval',1,3600],['threshold',0.5,1],['failures',1,20],['retries',0,100],['grace',0,300],['radius',0,64],['stepTimeout',1000,120000],['maxStepDelay',0,300000],['actionInterval',0,10000],['checkpointTimeout',1000,600000]]) {
    if (!Number.isFinite(Number(out[k])) || Number(out[k])<min || Number(out[k])>max) throw new Error('配置超出范围：' + k);
    out[k]=Number(out[k]);
    if(k!=='threshold' && !Number.isInteger(out[k])) throw new Error('配置需要整数：'+k);
  }
  return out;
}
function launchOptions(cfg, headless) {
  const args = [];
  if (cfg.mute) args.push('--mute-audio');
  if (cfg.noThrottle) args.push('--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding');
  const opts={headless,args,timeout:30000};
  if (cfg.chromePath) opts.executablePath=cfg.chromePath;
  else opts.channel='chrome';
  return opts;
}
function check(signal) { if(signal?.aborted) throw new Error('STOPPED'); }
function sleep(ms, signal) {
  check(signal);
  return new Promise((resolve,reject)=>{
    const stop=()=>{clearTimeout(timer);reject(new Error('STOPPED'));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},ms);
    signal?.addEventListener('abort',stop,{once:true});
  });
}
function elementSelector(el) {
  if(el.id && el.ownerDocument.querySelectorAll('#'+CSS.escape(el.id)).length===1) return '#'+CSS.escape(el.id);
  const parts=[];
  for(let n=el;n&&n.nodeType===1;n=n.parentElement){
    let p=n.localName;
    const siblings=n.parentElement?[...n.parentElement.children].filter(x=>x.localName===p):[];
    if(siblings.length>1)p+=':nth-of-type('+(siblings.indexOf(n)+1)+')';
    parts.unshift(p);
  }
  return parts.join(' > ');
}
async function framePath(frame) {
  const frames=[];
  while(frame.parentFrame()) {
    const handle=await frame.frameElement();
    frames.unshift(await handle.evaluate(elementSelector));
    await handle.dispose();
    frame=frame.parentFrame();
  }
  return frames;
}
async function resolveFrame(page, route) {
  let frame=page.mainFrame();
  for(const selector of route||[]) {
    const element=await frame.locator(selector).elementHandle();
    const child=await element.contentFrame();
    await element.dispose();
    if(!child)throw new Error('iframe 尚未加载');
    frame=child;
  }
  return frame;
}

async function canvasBox(frame, el) {
  const box=await el.evaluate(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
  while(frame.parentFrame()){
    const handle=await frame.frameElement();
    const offset=await handle.evaluate(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {x:r.x+parseFloat(s.borderLeftWidth)+parseFloat(s.paddingLeft),y:r.y+parseFloat(s.borderTopWidth)+parseFloat(s.paddingTop)};});
    await handle.dispose();box.x+=offset.x;box.y+=offset.y;frame=frame.parentFrame();
  }
  if(box.width<=0||box.height<=0)throw new Error('Canvas 不可见');
  return box;
}

class Recorder extends EventEmitter {
  constructor(flow, cfg = {}) {
    super(); this.flow=flow;this.cfg=config(cfg);this.pages=new Map();this.ids=new Map();this.queue=Promise.resolve();this.stopped=false;this.lastAt=Date.now();this.pageId=0;this.suppress=false;
  }
  enqueue(fn) { this.queue=this.queue.then(fn).catch(()=>this.emit('log','warn','有一个页面事件未能记录（页面可能已经关闭）'));return this.queue; }
  async start() {
    const browser=await chromium.launch(launchOptions(this.cfg,false));this.browser=browser;
    if(this.stopped){await browser.close();return;}
    this.context=await browser.newContext({viewport:this.flow.viewport,deviceScaleFactor:1,locale:'zh-CN'});
    this.clickCapture=new ClickCapture(this.context);
    await this.context.exposeBinding('__flowVisual',async(source,point)=>{
      if(this.stopped||this.suppress)return {visualError:'截图采集已暂停'};
      try{return await this.clickCapture.capture(source,point);}catch(error){return {visualError:error.message};}
    });
    await this.context.exposeBinding('__flowRecord',(source,data)=>{
      if(this.stopped||this.suppress)return;
      const id=this.ids.get(source.page);this.activeId=id;
      return this.enqueue(async()=>{
        if(data.type==='unsupported'){this.emit('log','warn',data.reason);return;}
        if(data.visualError)this.emit('log','warn',data.visualError);
        this.append({...data,page:id,frame:await framePath(source.frame)});
      });
    });
    await this.context.addInitScript(installRecorder);
    this.context.on('page',page=>{
      this.clickCapture.attach(page).catch(()=>{});
      const id=this.pageId++;this.ids.set(page,id);this.pages.set(id,page);this.activeId=id;
      page.on('framenavigated',frame=>{
        if(this.stopped||this.suppress||frame!==page.mainFrame()||!/^https?:/.test(frame.url()))return;
        const url=frame.url();
        this.enqueue(()=>this.append({type:'goto',url,page:this.ids.get(page),frame:[],at:Date.now()}));
      });
      page.on('dialog',async dialog=>{this.emit('log','warn','录制页面出现浏览器对话框，请在浏览器中处理');});
      page.on('close',()=>{this.emit('log','info','录制标签页已关闭');});
    });
    this.page=await this.context.newPage();
    browser.on('disconnected',()=>{if(!this.stopped){this.stopped=true;this.emit('closed');}});
    this.emit('log','info',this.suppress?'Chrome 已打开，操作采集暂停，等待主流程恢复':'录制已开始：请在 Chrome 地址栏输入网址，然后正常操作');
  }
  append(data) {
    const at=data.at||Date.now();delete data.at;
    const last=this.flow.steps.at(-1);
    const same=last&&last.page===data.page&&last.selector===data.selector&&JSON.stringify(last.frame)===JSON.stringify(data.frame);
    if(same && last.type==='click' && data.type==='click' && data.count===2) Object.assign(last,data);
    else if(same && last.type===data.type && ['fill','scroll'].includes(data.type)) Object.assign(last,data);
    else {
      this.flow.steps.push({...data,delay:Math.max(0,Math.min(300000,at-this.lastAt))});
      this.emit('log','info','已录制 #'+this.flow.steps.length+' '+label(data));
    }
    this.lastAt=at;this.emit('change',this.flow);
  }
  async snapshot() {
    if(this.stopped)throw new Error('录制浏览器未运行');
    if(this.capturePending)throw new Error('已有截图正在选择，请先完成或取消');
    this.capturePending=true;
    try {
    await Promise.allSettled([...this.pages.values()].flatMap(p=>p.frames().map(f=>f.evaluate(()=>{window.__flowRecorderPause?.(true);return window.__flowFlush?.();}))));
    await this.queue;this.suppress=true;
    for(const [id,p] of this.pages){if(!p.isClosed()&&await p.evaluate(()=>document.hasFocus()).catch(()=>false))this.activeId=id;}
    const page=this.pages.get(this.activeId);
    if(!page||page.isClosed())throw new Error('请先在需要截图的标签页中点击一次');
    this.snapshotBuffer=await page.screenshot({type:'png',timeout:15000,caret:'hide'});
    this.snapshotPage=this.activeId;
    this.snapshotIndex=this.flow.steps.length;
    return this.snapshotBuffer;
    } catch(e) {await this.resumeCapture();throw e;}
  }
  async resumeCapture() {
    this.snapshotBuffer=null;this.capturePending=false;this.suppress=false;this.lastAt=Date.now();
    await Promise.allSettled([...this.pages.values()].flatMap(p=>p.frames().map(f=>f.evaluate(()=>window.__flowRecorderPause?.(false)))));
  }
  setTrusted(rect) {
    if(!this.snapshotBuffer)throw new Error('请先获取页面截图');
    const result=crop(this.snapshotBuffer,rect);
    this.flow.trusted={rect:result.rect,image:result.buffer.toString('base64'),page:this.snapshotPage};
    this.emit('change',this.flow);
    this.emit('log','info','可信图像已保存：'+result.rect.width+' × '+result.rect.height);
    return this.flow.trusted;
  }
  setCheckpoint(rect,options={}) {
    if(!this.capturePending||!this.snapshotBuffer)throw new Error('请先获取检查点截图');
    const result=crop(this.snapshotBuffer,rect);
    const timeout=Number(options.timeout??this.cfg.checkpointTimeout),threshold=Number(options.threshold??this.cfg.threshold);
    if(!Number.isFinite(timeout)||timeout<1000||timeout>600000||!Number.isFinite(threshold)||threshold<0.5||threshold>1)throw new Error('检查点超时或匹配率超出范围');
    const step={type:'checkpoint',page:this.snapshotPage,frame:[],delay:0,timeout,threshold,trusted:{rect:result.rect,image:result.buffer.toString('base64'),page:this.snapshotPage}};
    this.flow.steps.splice(this.snapshotIndex,0,step);this.emit('change',this.flow);
    this.emit('log','info','已插入 #'+(this.snapshotIndex+1)+' 继续执行检查点，最长等待 '+timeout/1000+' 秒');
    return step;
  }
  async stop() {
    if(!this.stopped) {
      await sleep(180);
      await Promise.allSettled([...this.pages.values()].flatMap(p=>p.frames().map(f=>f.evaluate(()=>window.__flowFlush?.()))));
    }
    this.stopped=true;await this.queue;await this.clickCapture?.close();await this.browser?.close().catch(()=>{});
  }
}
function label(step) {
  return ({goto:'页面导航',fill:step.secret?'填写密码（已隐藏）':'填写表单',click:'点击',check:'勾选',select:'选择选项',key:'键盘',canvas:'Canvas 轨迹（'+(step.points?.length||0)+' 点）',wheel:'Canvas 滚轮',scroll:'滚动',hover:'悬停',checkpoint:'等待可信截图后继续'})[step.type]||step.type;
}

async function waitForCheckpoint(page,step,cfg,signal,onSample=()=>{}) {
  const end=Date.now()+(step.timeout||cfg.checkpointTimeout),reference=Buffer.from(step.trusted.image,'base64');
  let lastShot,lastScore=0;
  while(Date.now()<end) {
    check(signal);
    lastShot=await page.screenshot({timeout:Math.max(1,Math.min(cfg.stepTimeout,end-Date.now())),caret:'hide'});check(signal);
    lastScore=match(lastShot,reference,step.trusted.rect,cfg.radius).score;
    onSample(lastScore);
    if(lastScore>=(step.threshold??cfg.threshold))return {score:lastScore};
    await sleep(Math.min(500,Math.max(0,end-Date.now())),signal);
  }
  const error=new Error('检查点等待超时');error.code='CHECKPOINT_TIMEOUT';error.lastShot=lastShot;error.score=lastScore;throw error;
}

async function replayStep(page, step, signal, onVisual=()=>{}, repeats) {
  check(signal);
  if(step.type!=='canvas')await repeats?.clear();
  if(step.type==='goto') {
    if(page.url()!==step.url) await page.goto(step.url,{waitUntil:'domcontentloaded'});
    return;
  }
  const frame=await resolveFrame(page,step.frame);
  const el=step.selector?frame.locator(step.selector):null;
  switch(step.type) {
    case 'fill': await el.fill(step.value);break;
    case 'check': await el.setChecked(step.checked);break;
    case 'select': await el.selectOption(step.values);break;
    case 'click': await el.click({button:step.button||'left',clickCount:step.count||1});break;
    case 'hover': await el.hover();break;
    case 'wheel': {await el.scrollIntoViewIfNeeded();const box=await el.boundingBox();if(!box)throw new Error('Canvas 不可见');await page.mouse.move(box.x+step.x*box.width,box.y+step.y*box.height);await page.mouse.wheel(step.deltaX,step.deltaY);break;}
    case 'key':
      if(el)await el.press(step.key);else await page.keyboard.press(step.key);break;
    case 'scroll':
      if(el)await el.evaluate((e,p)=>e.scrollTo(p.x,p.y),step);
      else await frame.evaluate(p=>window.scrollTo(p.x,p.y),step);
      break;
    case 'canvas': {
      await el.waitFor({state:'visible'});await el.scrollIntoViewIfNeeded();
      const box=await canvasBox(frame,el);
      const points=step.points;if(!points.length)break;
      const original={x:box.x+points[0].x*box.width,y:box.y+points[0].y*box.height};
      const coordinates=p=>'('+p.x.toFixed(1)+', '+p.y.toFixed(1)+')';
      const fallback=reason=>onVisual(reason+'，回退录制原坐标 '+coordinates(original),'warn');
      let dx=0,dy=0,confirmed=null;
      const repeated=await repeats?.reuse(page,frame,el,step,box,original);check(signal);
      if(repeated){
        dx=repeated.x-original.x;dy=repeated.y-original.y;confirmed=repeated;
        onVisual('连续同点点击第 '+repeated.count+' 次，复用本段已确认坐标 '+coordinates(repeated)+'（录制坐标 '+coordinates(original)+'）','info');
      }
      else if(step.visualError)fallback('录制点击图像不可用');
      else if(step.visual){
        let shot;
        try{shot=await page.screenshot({caret:'hide'});}
        catch(error){check(signal);if(page.isClosed())throw error;fallback('回放截图失败');}
        check(signal);
        if(shot){
          try{
            const found=await locateClick(shot,step.visual,original,box,signal);
            if(found.region==='center')onVisual('完整点击图未匹配，中央 32×32 特征区域校验通过（阈值 90%）','info');
            dx=found.x-original.x;dy=found.y-original.y;confirmed={x:found.x,y:found.y,count:1};
            onVisual(found.relocated?'点击图像已重新定位：原坐标 '+coordinates(original)+' → 点击坐标 '+coordinates(found):'点击图像原位置校验通过，点击坐标 '+coordinates(original),'info');
          }catch(error){
            check(signal);
            const reason={VISUAL_NOT_FOUND:'扫描当前画布后未找到匹配图像',VISUAL_AMBIGUOUS:'扫描当前画布发现多个匹配目标',VISUAL_INVALID:'点击参考图像无效或图案特征不足'}[error.code];
            if(!reason)throw error;
            fallback(reason);
          }
        }
      }else onVisual('没有点击参考图，使用录制原坐标 '+coordinates(original),'info');
      check(signal);
      const move=point=>page.mouse.move(box.x+point.x*box.width+dx,box.y+point.y*box.height+dy);
      const clickedElement=confirmed&&repeats?await el.elementHandle():null;
      try {
      await move(points[0]);await page.mouse.down({button:step.button});
      try {
        for(let i=1;i<points.length;i++) {
          await sleep(Math.min(1000,Math.max(0,points[i].t-points[i-1].t)),signal);await move(points[i]);
        }
      } finally {await page.mouse.up({button:step.button});}
      check(signal);
      if(confirmed)await repeats?.remember(page,frame,el,step,box,original,confirmed,confirmed.count,clickedElement);
      else await repeats?.clear();
      }catch(error){await repeats?.clear();throw error;}
      finally{await clickedElement?.dispose().catch(()=>{});}
      break;
    }
    default:throw new Error('未知操作：'+step.type);
  }
}

class Runner extends EventEmitter {
  constructor(flow, cfg, evidenceDir) {
    super();this.flow=structuredClone(flow);this.cfg=config(cfg);this.evidenceDir=evidenceDir;this.controller=new AbortController();this.browsers=new Set();this.states=[];
  }
  log(id,level,message,image){this.emit('log',level,'实例 '+id+' · '+message,image);}
  state(id,status,extra={}){this.states[id-1]={...this.states[id-1],id,status,...extra};this.emit('state',this.states);}
  start() {
    if(!this.flow.steps.some(s=>s.type==='goto'))throw new Error('流程没有录制网址');
    if(!this.flow.trusted)throw new Error('请先截图并保存可信区域');
    this.done=Promise.all(Array.from({length:this.cfg.count},(_,i)=>this.run(i+1))).finally(()=>this.emit('done'));
    return this.done;
  }
  async stop() {
    this.controller.abort();
    await Promise.allSettled([...this.browsers].map(b=>b.close()));
    await this.done;
  }
  async run(id) {
    const signal=this.controller.signal,cfg=this.cfg;
    const scheduler=new (require('./subflows').SubflowScheduler)(this.flow.subflows);
    let attempts=0,browser,context,onPage,currentPage,currentStep=0,repeats;
    this.state(id,'等待启动',{recoveries:0});
    try {
      await sleep((id-1)*350,signal);
      while(!signal.aborted) {
        let pageReady=false;
        try {
          repeats=new RepeatClicks();
          currentPage=null;currentStep=0;
          this.state(id,attempts?'恢复中':'启动中',{recoveries:attempts});
          if(!browser?.isConnected()||!context||!browser.contexts().includes(context)) {
            if(browser){this.browsers.delete(browser);await browser.close().catch(()=>{});}
            context=null;check(signal);
            browser=await chromium.launch(launchOptions(cfg,cfg.headless));this.browsers.add(browser);check(signal);
            context=await browser.newContext({viewport:this.flow.viewport,deviceScaleFactor:1,locale:'zh-CN'});
          }
          context.setDefaultTimeout(cfg.stepTimeout);context.setDefaultNavigationTimeout(cfg.stepTimeout);
          const pages=new Map();let nextId=0;
          onPage=p=>{
            pages.set(nextId++,p);
            p.on('dialog',d=>{this.log(id,'warn','自动关闭浏览器对话框');d.dismiss().catch(()=>{});});
          };
          context.on('page',onPage);
          await context.newPage();
          pageReady=true;
          const values=generateValues(this.flow,id);
          for(let i=0;i<this.flow.steps.length;i++) {
            let step=this.flow.steps[i];
            if(step.type==='fill'&&values.has(fieldId(step)))step={...step,value:values.get(fieldId(step))};
            await sleep(cfg.ignoreRecordedDelays?cfg.actionInterval:Math.min(step.delay||0,cfg.maxStepDelay),signal);
            currentStep=i+1;
            this.state(id,'回放 '+(i+1)+' / '+this.flow.steps.length);
            this.log(id,'info','#'+(i+1)+' '+label(step));
            const deadline=Date.now()+cfg.stepTimeout;
            while(!pages.has(step.page||0)&&Date.now()<deadline)await sleep(100,signal);
            const page=pages.get(step.page||0);if(!page)throw new Error('弹出标签页未出现');
            currentPage=page;
            if(step.type==='checkpoint') {
              await repeats.clear();
              this.state(id,'等待检查点 #'+(i+1));
              let lastLog=0;
              await waitForCheckpoint(page,step,cfg,signal,score=>{
                this.state(id,'等待检查点 #'+(i+1),{checkpointScore:score});
                if(Date.now()-lastLog>3000){this.log(id,'info','检查点 #'+(i+1)+' 匹配 '+(score*100).toFixed(1)+'%，等待达到 '+((step.threshold??cfg.threshold)*100).toFixed(0)+'%');lastLog=Date.now();}
              });
              this.log(id,'info','检查点 #'+(i+1)+' 已通过，继续执行');
            } else await replayStep(page,step,signal,(message,level='info')=>this.log(id,level,message),repeats);
          }
          this.state(id,'等待页面稳定');await sleep(cfg.grace*1000,signal);
          if(this.flow.subflows?.length)await waitForCheckpoint(pages.get(this.flow.trusted.page||0),{trusted:this.flow.trusted},cfg,signal);
          let failures=0,healthy=0,nextInspection=0,nextSubflowCheck=0;
          const hasSubflows=!!this.flow.subflows?.length;
          const trusted=this.flow.trusted;
          while(!signal.aborted) {
            const page=pages.get(trusted.page||0);
            if(!page||page.isClosed()||!browser.isConnected())throw new Error('浏览器或目标页面已关闭');
            if(performance.now()>=nextInspection) {
              const shot=await page.screenshot({timeout:cfg.stepTimeout,caret:'hide'});check(signal);
              const found=match(shot,Buffer.from(trusted.image,'base64'),trusted.rect,cfg.radius);
              const ok=found.score>=cfg.threshold;
              if(ok){failures=0;healthy++;}else{failures++;healthy=0;}
              this.state(id,ok?'正常运行':'检查未通过',{score:found.score,checkedAt:new Date().toISOString(),failures});
              this.log(id,ok?'info':'warn','可信图像匹配 '+(found.score*100).toFixed(1)+'%'+(ok?' · 正常':' · 连续失败 '+failures+'/'+cfg.failures),cfg.headless?'data:image/png;base64,'+shot.toString('base64'):undefined);
              if(healthy>=5)attempts=0;
              if(failures>=cfg.failures) {
                if(this.evidenceDir){fs.mkdirSync(this.evidenceDir,{recursive:true});fs.writeFileSync(path.join(this.evidenceDir,'instance-'+id+'-last-failure.png'),shot);}
                throw new Error('可信图像连续缺失');
              }
              nextInspection=performance.now()+cfg.interval*1000;
            }
            // Separate deadlines keep subflow polling fast without increasing inspection work.
            // Await each tick, then rest: slow actions never overlap or queue catch-up ticks.
            if(hasSubflows&&performance.now()>=nextSubflowCheck) {
              await scheduler.tick(pages,cfg,signal,(l,m)=>this.log(id,l,m),id);
              nextSubflowCheck=performance.now()+SUBFLOW_POLL_INTERVAL;
            }
            const nextWake=hasSubflows?Math.min(nextInspection,nextSubflowCheck):nextInspection;
            await sleep(Math.max(0,nextWake-performance.now()),signal);
          }
        } catch(error) {
          if(signal.aborted)break;
          if(this.evidenceDir&&currentPage&&!currentPage.isClosed()) {
            try{fs.mkdirSync(this.evidenceDir,{recursive:true});const shot=error.lastShot||await currentPage.screenshot({timeout:3000,caret:'hide'});fs.writeFileSync(path.join(this.evidenceDir,'instance-'+id+'-last-error.png'),shot);fs.writeFileSync(path.join(this.evidenceDir,'instance-'+id+'-last-error.json'),JSON.stringify({step:currentStep,type:this.flow.steps[currentStep-1]?.type,headless:cfg.headless,error:error.code||error.name,score:error.score,at:new Date().toISOString()},null,2));}catch{}
          }
          // Playwright errors can include input values in call logs: never expose them.
          const reason=error.code?.startsWith('VISUAL_')?({VISUAL_INVALID:'点击图像不可用，请重新录制',VISUAL_NOT_FOUND:'未找到点击图像，未执行点击',VISUAL_AMBIGUOUS:'点击图像存在多个目标，未执行点击'}[error.code]||'点击图像校验失败'):error.code==='CHECKPOINT_TIMEOUT'?'检查点等待超时，未执行后续步骤':error.message.includes('可信图像')?'可信图像连续缺失':error.message.includes('关闭')?'浏览器或页面关闭':error.name==='TimeoutError'?'操作等待超时':'页面执行失败';
          this.log(id,'error','#'+currentStep+' '+reason);
          if(attempts>=cfg.retries){this.state(id,'需要人工处理');this.log(id,'error','已达到恢复上限，请停止任务并检查流程');break;}
          attempts++;this.state(id,'准备恢复',{recoveries:attempts});
          this.log(id,'warn','第 '+attempts+' 次恢复：关闭旧标签页并从头回放，保留实例缓存；浏览器不可用时重新启动');
        } finally {
          await repeats?.clear();
          if(context&&onPage)context.off('page',onPage);
          onPage=null;
          // Keep the BrowserContext (and its HTTP cache) across recovery rounds.
          // Close every page, including popups, without running beforeunload handlers.
          if(context) {
            const closed=await Promise.allSettled(context.pages().map(p=>p.close({runBeforeUnload:false})));
            if(closed.some(r=>r.status==='rejected')) {
              this.log(id,'warn','旧标签页清理失败，下轮重新启动浏览器');
              context=null;
            }
          }
          if(!pageReady)context=null;
        }
        await sleep(Math.min(30000,attempts*2000),signal);
      }
    } catch(error) {if(!signal.aborted){this.state(id,'启动失败');this.log(id,'error','启动失败，请检查 Chrome 安装路径');}}
    finally {
      if(browser){this.browsers.delete(browser);await browser.close().catch(()=>{});}
      if(signal.aborted)this.state(id,'已停止');
    }
  }
}
module.exports={DEFAULTS,config,Recorder,Runner,replayStep,resolveFrame,framePath,sleep,launchOptions,label,waitForCheckpoint};
