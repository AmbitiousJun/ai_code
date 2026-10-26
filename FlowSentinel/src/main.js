const {app,BrowserWindow,ipcMain,dialog,shell,safeStorage}=require('electron');
const path=require('path');
const fs=require('fs');
const {Store}=require('./store');
const transfer=require('./flow-transfer');
const {validateFlow}=require('./flow-schema');
const {SubflowSession,executeSteps}=require('./subflows');
const {sleep}=require('./engine');
let subSession=null;
let pendingImport=null;
function transferIdle(){if(recorder||runner||recordStarting||subSession)throw new Error('请先停止当前录制或任务');}
const {Recorder,Runner,DEFAULTS,config,baseConfig,label}=require('./engine');
const {fields,validateRules,expand}=require('./variables');
let win,store,recorder,runner,recordStarting=false,closing=false;
let logs=[],states=[];
if(process.env.FLOW_SENTINEL_TEST_DATA)app.setPath('userData',process.env.FLOW_SENTINEL_TEST_DATA);
const dataDir=()=>app.getPath('userData');
function emit(event){if(win&&!win.isDestroyed())win.webContents.send('flow:event',event);}
function log(level,message,image){
  const entry={time:new Date().toISOString(),level,message};logs.push(entry);if(logs.length>1500)logs.shift();
  if(image){entry.image=image;entry.hasScreenshot=true;}
  let imageCount=0,imageSize=0;
  for(let i=logs.length-1;i>=0;i--){if(logs[i].image){imageCount++;imageSize+=logs[i].image.length;if(imageCount>64||imageSize>24*1024*1024)delete logs[i].image;}}
  emit({type:'log',entry});
  try{
    const file=path.join(dataDir(),'activity.log');
    if(fs.existsSync(file)&&fs.statSync(file).size>5*1024*1024)fs.renameSync(file,path.join(dataDir(),'activity.previous.log'));
    fs.appendFileSync(file,JSON.stringify({time:entry.time,level,message})+'\n');
  }catch{}
}
function summary(flow){return {...flow,baseFlow:flow.baseFlow?{id:flow.baseFlow.id,name:flow.baseFlow.name,stepCount:flow.baseFlow.steps.length}:undefined,subflows:(flow.subflows||[]).map(sub=>({id:sub.id,name:sub.name,trigger:sub.trigger.type==='image'?{type:'image',trusted:{...sub.trigger.trusted,image:'data:image/png;base64,'+sub.trigger.trusted.image}}:sub.trigger,steps:sub.steps.map((step,i)=>({index:i+1,type:step.type,label:label(step),page:step.page||0}))})),config:config(flow.config),fields:fields(flow),steps:flow.steps.map((s,i)=>({index:i+1,type:s.type,label:label(s),frameDepth:s.frame?.length||0,page:s.page||0,timeout:s.timeout,visualImage:s.visual?'data:image/png;base64,'+s.visual.image:undefined,visualError:s.visualError,checkpointImage:s.type==='checkpoint'?'data:image/png;base64,'+s.trusted.image:undefined})),trusted:flow.trusted?{...flow.trusted,image:'data:image/png;base64,'+flow.trusted.image}:null};}
function status(){return{recording:!!recorder||recordStarting||!!subSession,preparing:recordStarting,subPhase:subSession?.phase,subDraft:subSession?{steps:subSession.recorder?.flow.steps.map((s,i)=>({index:i+1,label:label(s)}))||[],defaultName:'子流程 '+((subSession.flow.subflows?.length||0)+1)}:null,running:!!runner,recordingId:subSession?.flow.id||recorder?.flow.id,states};}
function update(){emit({type:'status',...status()});}
async function command(action,data={}){
  switch(action){
    case 'startSubflow':{
      transferIdle();const source=store.get(data.id);if(source.kind==='base')throw new Error('基础流程不能录入子流程');const session=new SubflowSession(source);subSession=session;
      session.on('log',log);session.on('status',update);session.on('draft',update);
      session.on('closed',()=>{if(subSession===session){subSession=null;update();log('info','子流程录入浏览器已关闭，未保存草稿已丢弃');}});
      update();
      try{await session.start();return status();}catch(e){await session.stop();if(subSession===session)subSession=null;update();throw e;}
    }
    case 'nextSubflow':{
      const session=subSession;if(!session||session.phase!=='saved')throw new Error('请先保存当前子流程');
      try{await session.next();return status();}catch(e){await session.stop();if(subSession===session)subSession=null;update();throw e;}
    }
    case 'subTrigger':{if(!subSession)throw new Error('请先录入子流程');await subSession.setTrigger(data);return status();}
    case 'finishSubflow':{if(!subSession)throw new Error('请先录入子流程');await subSession.finish();return status();}
    case 'resumeSubflow':{if(subSession?.phase!=='review')throw new Error('没有待保存草稿');await subSession.recorder.resumeCapture();subSession.setPhase('recording');return status();}
    case 'saveSubflow':{
      if(!subSession)throw new Error('请先录入子流程');subSession.save(data.name);validateFlow(subSession.flow);store.save(subSession.flow);
      const f=summary(subSession.flow);emit({type:'flow',flow:f});log('info','子流程已保存');return f;
    }
    case 'stopSubflow':{
      const session=subSession;if(session){await session.stop();if(subSession===session)subSession=null;update();}return;
    }
    case 'deleteSubflow':{
      transferIdle();const f=store.get(data.id);f.subflows=(f.subflows||[]).filter(s=>s.id!==data.subId);store.save(f);return summary(f);
    }
    case 'init':return{flows:store.list().map(summary),defaults:DEFAULTS,logs,...status(),dataDir:dataDir()};
    case 'list':return store.list().map(summary);
    case 'exportFlow':{
      transferIdle();
      const f=store.get(data.id),text=transfer.encode(validateFlow(f),app.getVersion());
      const filename=(f.name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,80)||'流程')+'.fs';
      const result=await dialog.showSaveDialog(win,{title:'导出流程（包含表单原值，请妥善保管）',defaultPath:path.join(app.getPath('downloads'),filename),filters:[{name:'FlowSentinel 流程',extensions:['fs']}]});
      if(result.canceled||!result.filePath)return false;
      await fs.promises.writeFile(result.filePath,text,'utf8');return true;
    }
    case 'prepareImport':{
      transferIdle();pendingImport=null;
      const result=await dialog.showOpenDialog(win,{title:'导入 FlowSentinel 流程',defaultPath:app.getPath('downloads'),properties:['openFile'],filters:[{name:'FlowSentinel 流程',extensions:['fs']}]});
      if(result.canceled)return null;
      transferIdle();
      const file=result.filePaths[0];
      if((await fs.promises.stat(file)).size>transfer.MAX_BYTES)throw new Error('流程文件超过 128 MiB 限制');
      const flow=validateFlow(transfer.decode(await fs.promises.readFile(file,'utf8'),app.getVersion()));
      // Validate renderer projection before accepting the pending import.
      summary(flow);pendingImport=flow;
      return {name:flow.name,baseName:flow.baseFlow?.name,names:store.list().map(f=>f.name)};
    }
    case 'cancelImport':pendingImport=null;return;
    case 'confirmImport':{
      transferIdle();if(!pendingImport)throw new Error('请重新选择导入文件');
      const flow=transfer.importedFlow(pendingImport,data.name,store.list().map(f=>f.name));
      if(flow.baseFlow)flow.baseFlow=transfer.importedFlow(flow.baseFlow,data.baseName,[...store.list().map(f=>f.name),flow.name]);
      const result=summary(flow);store.save(flow);try{if(flow.baseFlow)store.save(flow.baseFlow);}catch(e){store.delete(flow.id);throw e;}pendingImport=null;return result;
    }
    case 'record':{
      if(recorder||runner||recordStarting||subSession)throw new Error('请先停止当前录制或任务');
      const name=String(data.name||'').trim();if(!name)throw new Error('请填写流程名称');
      const kind=data.kind||'full';if(!['full','base'].includes(kind))throw new Error('无效的流程类型');
      const base=data.baseId?validateFlow(store.get(data.baseId)):null;
      if(base&&(kind!=='full'||base.kind!=='base'||!base.steps.some(s=>s.type==='goto')))throw new Error('请选择包含网址步骤的基础流程');
      const viewport=base?{...base.viewport}:{width:Number(data.width)||1280,height:Number(data.height)||720};
      if(viewport.width<640||viewport.width>3840||viewport.height<480||viewport.height>2160)throw new Error('视口范围：宽 640–3840，高 480–2160');
      const cfg=config(kind==='base'?baseConfig(data.config):data.config);recordStarting=true;update();
      let flow;
      try{
        flow=store.create(name,viewport,cfg);flow.kind=kind;
        if(base){flow.baseFlow=structuredClone(base);flow.steps=structuredClone(base.steps);flow.variables=structuredClone(base.variables||{});}
        store.save(flow);recorder=new Recorder(flow,cfg);recorder.suppress=!!base;recorder.recordingFloor=flow.steps.length;recorder.preparation=new AbortController();
        const current=recorder;
        current.on('log',log);
        current.on('change',f=>{store.save(f);emit({type:'flow',flow:summary(f)});});
        current.on('closed',async()=>{current.preparation.abort();await current.queue;if(recorder===current){store.save(current.flow);recorder=null;update();log('info','录制浏览器已关闭，流程已自动保存');}});
        await current.start();
        if(base){
          log('info','正在回放基础流程，请等待完成后再操作 Chrome');
          current.context.setDefaultTimeout(cfg.stepTimeout);current.context.setDefaultNavigationTimeout(cfg.stepTimeout);
          await executeSteps(base,current.pages,cfg,current.preparation.signal,log);
          await sleep(cfg.grace*1000,current.preparation.signal);
          await Promise.allSettled([...current.pages.values()].flatMap(p=>p.frames().map(f=>f.evaluate(()=>{window.__flowRecorderPause?.(true);return window.__flowFlush?.();}))));
          await current.queue;if(current.stopped)throw new Error('录制已停止');
          await current.resumeCapture();log('info','基础流程回放完成，现在可以继续录制');
        }
        log('info','流程自动保存已开启');return summary(flow);
      }catch(error){if(recorder)await recorder.stop();recorder=null;throw new Error(base?'基础流程回放未完成，录制已停止；请检查步骤、目标页面或超时配置':'Chrome 启动失败，请检查 Chrome 路径');}
      finally{recordStarting=false;update();}
    }
    case 'stopRecord':{
      const r=recorder;if(!r)return;
      await r.stop();store.save(r.flow);recorder=null;update();log('info','录制结束，已保存 '+r.flow.steps.length+' 个步骤');return summary(r.flow);
    }
    case 'snapshot':{
      if(subSession){if(!['condition','recording'].includes(subSession.phase))throw new Error('当前不能截图');return 'data:image/png;base64,'+(await subSession.recorder.snapshot()).toString('base64');}
      if(!recorder)throw new Error('请先开始录制');
      if(recordStarting||recorder.flow.kind==='base')throw new Error('基础流程或准备阶段不能录制可信截图');
      return 'data:image/png;base64,'+(await recorder.snapshot()).toString('base64');
    }
    case 'trusted':{
      if(!recorder)throw new Error('请先开始录制');
      if(recordStarting||recorder.flow.kind==='base')throw new Error('基础流程或准备阶段不能录制可信截图');
      recorder.setTrusted(data);await recorder.resumeCapture();return summary(recorder.flow);
    }
    case 'checkpoint':{
      if(subSession){if(subSession.phase!=='recording')throw new Error('请先录制动作');subSession.recorder.setCheckpoint(data.rect,data);await subSession.recorder.resumeCapture();return;}
      if(!recorder)throw new Error('请先开始录制');
      if(recordStarting||recorder.flow.kind==='base')throw new Error('基础流程或准备阶段不能录制可信截图');
      recorder.setCheckpoint(data.rect,{timeout:data.timeout,threshold:data.threshold});await recorder.resumeCapture();return summary(recorder.flow);
    }
    case 'cancelCapture':if(recordStarting)return;if(subSession){const r=subSession.recorder;await r.resumeCapture();if(subSession.phase!=='recording')await subSession.pause();}else await recorder?.resumeCapture();return;
    case 'config':{
      if(recorder||runner||recordStarting||subSession)throw new Error('请停止后再修改配置');
      const f=store.get(data.id);f.config=config(f.kind==='base'?baseConfig(data.config):data.config);f.variables=validateRules(f,data.variables);store.save(f);return summary(f);
    }
    case 'start':{
      if(recorder||runner||recordStarting||subSession)throw new Error('请先停止当前录制或任务');
      const f=store.get(data.id);if(f.kind==='base')throw new Error('基础流程不能独立启动巡检');f.config=config(data.config);f.variables=validateRules(f,data.variables);
      if(!f.steps.some(s=>s.type==='goto')||!f.trusted)throw new Error('流程需要至少一个网址和一个可信截图区域');
      store.save(f);states=[];
      const run=new Runner(f,f.config,path.join(dataDir(),'evidence',f.id));runner=run;
      run.on('log',log);run.on('state',s=>{states=[...s];emit({type:'states',states});});
      run.on('done',()=>{if(runner===run){runner=null;update();log('info','所有实例已结束');}});
      run.start().catch(()=>log('error','任务异常结束'));update();log('info','任务启动：'+f.config.count+' 个独立浏览器实例');return summary(f);
    }
    case 'stop':{
      if(runner){const run=runner;log('info','正在停止：中断等待并关闭任务浏览器');await run.stop();if(runner===run)runner=null;update();}return;
    }
    case 'delete':{
      if(recorder||runner||recordStarting||subSession)throw new Error('请停止后再删除');
      const f=store.get(data.id);
      const answer=await dialog.showMessageBox(win,{type:'question',buttons:['取消','删除'],defaultId:0,cancelId:0,message:'删除流程“'+f.name+'”？',detail:'录制步骤、表单数据、可信图像与故障截图将一并删除。'});
      if(answer.response===1){store.delete(f.id);fs.rmSync(path.join(dataDir(),'evidence',f.id),{recursive:true,force:true});log('info','流程已删除');return true;}return false;
    }
    case 'chrome':{const result=await dialog.showOpenDialog(win,{title:'选择 Chrome 浏览器',properties:['openFile'],filters:[{name:'Chrome',extensions:['exe']}]});return result.canceled?null:result.filePaths[0];}
    case 'openData':await shell.openPath(dataDir());return;
    case 'previewTemplate':return expand(data.template,1);
    default:throw new Error('未知操作');
  }
}
if(!app.requestSingleInstanceLock())app.quit();
else{
  app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
  app.whenReady().then(()=>{
    if(!safeStorage.isEncryptionAvailable()){dialog.showErrorBox('FlowSentinel','Windows 数据加密不可用，无法安全保存录制。');app.quit();return;}
    store=new Store(path.join(dataDir(),'flows'),safeStorage);
    ipcMain.handle('flow:call',async(event,action,data)=>{
      if(event.sender!==win?.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('无效调用');
      try{return{ok:true,data:await command(action,data)};}catch(error){log('error',error.message);return{ok:false,error:error.message};}
    });
    win=new BrowserWindow({width:1440,height:960,minWidth:1100,minHeight:760,title:'FlowSentinel · 流程哨兵',backgroundColor:'#0c1220',autoHideMenuBar:true,icon:path.join(__dirname,'ui','icon.png'),webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',event=>event.preventDefault());
    win.loadFile(path.join(__dirname,'ui','index.html'));
    win.on('close',event=>{
      if(closing)return;event.preventDefault();closing=true;
      Promise.allSettled([recorder?.stop(),runner?.stop(),subSession?.stop()]).finally(()=>{win.destroy();app.quit();});
    });
  });
  app.on('window-all-closed',()=>app.quit());
}
