const {EventEmitter}=require('events');
const {randomUUID}=require('crypto');
const {Recorder,config,sleep,replayStep,waitForCheckpoint,label}=require('./engine');
const {RepeatClicks}=require('./repeat-clicks');
const {generateValues,fieldId}=require('./variables');
const {match,crop}=require('./vision');
const {parseCron,cronMatches,cronSlot}=require('./cron');

async function executeSteps(flow,pages,cfg,signal,log=()=>{},instance=1) {
  const repeats=new RepeatClicks(),values=generateValues(flow,instance);
  try{for(let i=0;i<flow.steps.length;i++){
    let step=flow.steps[i];
    if(step.type==='fill'&&values.has(fieldId(step)))step={...step,value:values.get(fieldId(step))};
    await sleep(cfg.ignoreRecordedDelays?cfg.actionInterval:Math.min(step.delay||0,cfg.maxStepDelay),signal);
    const deadline=Date.now()+cfg.stepTimeout;
    while(!pages.has(step.page||0)&&Date.now()<deadline)await sleep(100,signal);
    const page=pages.get(step.page||0);if(!page||page.isClosed())throw new Error('子流程目标标签页未出现或已关闭');
    log('info','#'+(i+1)+' '+label(step));
    if(step.type==='checkpoint'){await repeats.clear();await waitForCheckpoint(page,step,cfg,signal);}
    else await replayStep(page,step,signal,(m,l='info')=>log(l,m),repeats);
  }}finally{await repeats.clear();}
}

class SubflowSession extends EventEmitter {
  constructor(flow){
    super();this.flow=structuredClone(flow);this.cfg=config(flow.config);this.controller=new AbortController();this.phase='restoring';
  }
  setPhase(phase){this.phase=phase;this.emit('status');}
  async start(){
    if(!this.flow.trusted||!this.flow.steps.some(s=>s.type==='goto'))throw new Error('主流程需要网址和最终可信截图');
    const draft={viewport:this.flow.viewport,steps:[]};
    this.recorder=new Recorder(draft,this.cfg);this.recorder.suppress=true;
    this.recorder.on('log',(l,m)=>this.emit('log',l,m));
    this.recorder.on('closed',()=>{this.controller.abort();this.setPhase('closed');this.emit('closed');});
    this.recorder.on('change',()=>this.emit('draft'));
    await this.recorder.start();
    if(this.controller.signal.aborted){await this.recorder.stop();throw new Error('STOPPED');}
    return this.restore();
  }
  async restore(){
    const r=this.recorder,signal=this.controller.signal;
    this.setPhase('restoring');r.suppress=true;this.trigger=null;r.flow.steps=[];
    for(let attempt=0;attempt<=this.cfg.retries;attempt++){
      try{
        await sleep(0,signal);
        // Open replacement first so Chrome remains alive when its previous last tab closes.
        const old=r.context.pages();await r.context.newPage();
        await Promise.all(old.map(p=>p.close()));
        r.pages.clear();r.ids.clear();r.pageId=0;
        for(const p of r.context.pages()){r.pages.set(r.pageId,p);r.ids.set(p,r.pageId++);}
        r.activeId=0;r.context.setDefaultTimeout(this.cfg.stepTimeout);r.context.setDefaultNavigationTimeout(this.cfg.stepTimeout);
        this.emit('log','info','子流程准备：正在恢复主流程，请等待（尝试 '+(attempt+1)+'/'+(this.cfg.retries+1)+'）');
        await executeSteps(this.flow,r.pages,this.cfg,signal,(l,m)=>this.emit('log',l,'恢复主流程 · '+m));
        await sleep(this.cfg.grace*1000,signal);
        const t=this.flow.trusted,p=r.pages.get(t.page||0);
        if(!p)throw new Error('主流程可信图标签页缺失');
        await waitForCheckpoint(p,{trusted:t,timeout:this.cfg.checkpointTimeout},this.cfg,signal);
        await this.pause();r.flow.steps=[];r.activeId=t.page||0;this.pageBase=r.pageId;
        this.setPhase('condition');this.emit('draft');return;
      }catch(error){
        if(signal.aborted)throw error;
        if(attempt===this.cfg.retries)throw new Error('主流程恢复达到重试上限，创建子流程失败');
        this.emit('log','warn','主流程恢复失败，将按配置重试');
        await sleep(Math.min(30000,(attempt+1)*2000),signal);
      }
    }
  }
  async next(){
    if(this.phase!=='saved')throw new Error('请先保存当前子流程');
    await sleep(0,this.controller.signal);
    await this.pause();
    await sleep(0,this.controller.signal);
    const r=this.recorder;
    this.trigger=null;r.flow.steps=[];
    r.snapshotBuffer=null;r.capturePending=false;r.snapshotPage=undefined;r.snapshotIndex=undefined;
    this.setPhase('condition');this.emit('draft');
  }
  async pause(){
    const r=this.recorder;
    await Promise.allSettled([...r.pages.values()].flatMap(p=>p.frames().map(f=>f.evaluate(()=>{window.__flowRecorderPause?.(true);return window.__flowFlush?.();}))));
    await r.queue;r.suppress=true;
  }
  async setTrigger(trigger){
    if(this.phase!=='condition')throw new Error('请等待主流程恢复后设置触发条件');
    if(trigger.type==='cron'){parseCron(trigger.expression);this.trigger={type:'cron',expression:trigger.expression.trim()};}
    else if(trigger.type==='image'){
      const r=this.recorder;if(!r.snapshotBuffer)throw new Error('请先截取触发画面');
      if(r.snapshotPage>=this.pageBase)throw new Error('触发截图需要选择主流程已打开的标签页');
      const result=crop(r.snapshotBuffer,trigger.rect);
      this.trigger={type:'image',trusted:{rect:result.rect,image:result.buffer.toString('base64'),page:r.snapshotPage}};
    }else throw new Error('必须设置截图或定时触发条件');
    this.recordingPageStart=this.recorder.pageId;
    this.recorder.flow.steps=[];await this.recorder.resumeCapture();this.setPhase('recording');
  }
  async finish(){
    if(this.phase!=='recording')throw new Error('请先设置触发条件并录制动作');
    await this.pause();this.setPhase('review');
  }
  save(name){
    if(this.phase!=='review'||!this.trigger)throw new Error('请先完成条件和动作录制');
    name=String(name||'').trim();if(!name||name.length>80)throw new Error('子流程名称需要 1–80 个字符');
    const steps=this.recorder.flow.steps;
    if(!steps.some(s=>s.type!=='checkpoint'))throw new Error('子流程至少需要一个操作动作');
    // Retained popup tabs are not present when this independent subflow replays.
    // Compact newly recorded popup IDs to the scheduler's local page numbering.
    const localPage=id=>{
      id=id||0;
      if(id<this.pageBase)return id;
      if(id<this.recordingPageStart)throw new Error('请在主流程标签页中录制；需要使用新标签页时，请在本次录制中重新打开');
      return this.pageBase+id-this.recordingPageStart;
    };
    const localSteps=structuredClone(steps).map(step=>{
      step.page=localPage(step.page);
      if(step.type==='checkpoint')step.trusted.page=localPage(step.trusted.page);
      return step;
    });
    const sub={id:randomUUID(),name,pageBase:this.pageBase,trigger:structuredClone(this.trigger),steps:localSteps};
    require('./flow-schema').validateFlow({...this.flow,subflows:[...(this.flow.subflows||[]),sub]});
    this.flow.subflows??=[];this.flow.subflows.push(sub);this.setPhase('saved');return sub;
  }
  async stop(){this.controller.abort();await this.recorder?.stop();this.setPhase('closed');}
}

// One scheduler per instance; time-slot receipts survive main-flow recovery.
class SubflowScheduler {
  constructor(subflows=[]){this.subflows=subflows;this.slots=new Map();this.pending=new Set();}
  async tick(pages,cfg,signal,log,instance=1){
    for(const sub of this.subflows){
      await sleep(0,signal);let due=false;
      if(sub.trigger.type==='cron'){
        const now=new Date(),slot=cronSlot(sub.trigger.expression,now);
        due=this.pending.has(sub.id)||(this.slots.get(sub.id)!==slot&&cronMatches(sub.trigger.expression,now));
        if(due){this.slots.set(sub.id,slot);this.pending.add(sub.id);}
      }else{
        const t=sub.trigger.trusted,p=pages.get(t.page||0);
        if(!p||p.isClosed())throw new Error('子流程触发标签页已关闭');
        const shot=await p.screenshot({timeout:cfg.stepTimeout,caret:'hide'});
        due=match(shot,Buffer.from(t.image,'base64'),t.rect,cfg.radius).score>=cfg.threshold;
      }
      if(due){
        log('info','触发子流程：'+sub.name);
        const local=new Map([...pages].filter(([id])=>sub.pageBase===undefined||id<sub.pageBase));
        const context=[...local.values()][0]?.context(),created=[];
        let next=sub.pageBase??Math.max(...local.keys())+1;
        const onPage=p=>{local.set(next++,p);created.push(p);};
        context?.on('page',onPage);
        try{await executeSteps(sub,local,cfg,signal,(l,m)=>log(l,'子流程「'+sub.name+'」 · '+m),instance);}
        catch(e){log('error','子流程「'+sub.name+'」执行失败，进入主流程恢复策略');throw e;}
        finally{
          context?.off('page',onPage);await Promise.allSettled(created.map(p=>p.close()));
          for(const [id,p] of pages)if(created.includes(p))pages.delete(id);
        }
        this.pending.delete(sub.id);
        log('info','子流程完成：'+sub.name);
      }
    }
  }
}
module.exports={SubflowSession,SubflowScheduler,executeSteps};
