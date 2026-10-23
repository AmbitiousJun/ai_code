const {app,BrowserWindow,ipcMain,dialog,shell,safeStorage}=require('electron');
const path=require('path');
const fs=require('fs');
const {Store}=require('./store');
const {Recorder,Runner,DEFAULTS,config,label}=require('./engine');
const {fields,validateRules,expand}=require('./variables');
let win,store,recorder,runner,recordStarting=false,closing=false;
let logs=[],states=[];
if(process.env.FLOW_SENTINEL_TEST_DATA)app.setPath('userData',process.env.FLOW_SENTINEL_TEST_DATA);
const dataDir=()=>app.getPath('userData');
function emit(event){if(win&&!win.isDestroyed())win.webContents.send('flow:event',event);}
function log(level,message){
  const entry={time:new Date().toISOString(),level,message};logs.push(entry);if(logs.length>1500)logs.shift();
  emit({type:'log',entry});
  try{
    const file=path.join(dataDir(),'activity.log');
    if(fs.existsSync(file)&&fs.statSync(file).size>5*1024*1024)fs.renameSync(file,path.join(dataDir(),'activity.previous.log'));
    fs.appendFileSync(file,JSON.stringify(entry)+'\n');
  }catch{}
}
function summary(flow){return {...flow,config:config(flow.config),fields:fields(flow),steps:flow.steps.map((s,i)=>({index:i+1,type:s.type,label:label(s),frameDepth:s.frame?.length||0,page:s.page||0,timeout:s.timeout,visualImage:s.visual?'data:image/png;base64,'+s.visual.image:undefined,visualError:s.visualError,checkpointImage:s.type==='checkpoint'?'data:image/png;base64,'+s.trusted.image:undefined})),trusted:flow.trusted?{...flow.trusted,image:'data:image/png;base64,'+flow.trusted.image}:null};}
function status(){return{recording:!!recorder||recordStarting,running:!!runner,recordingId:recorder?.flow.id,states};}
function update(){emit({type:'status',...status()});}
async function command(action,data={}){
  switch(action){
    case 'init':return{flows:store.list().map(summary),defaults:DEFAULTS,logs,...status(),dataDir:dataDir()};
    case 'list':return store.list().map(summary);
    case 'record':{
      if(recorder||runner||recordStarting)throw new Error('请先停止当前录制或任务');
      const name=String(data.name||'').trim();if(!name)throw new Error('请填写流程名称');
      const viewport={width:Number(data.width)||1280,height:Number(data.height)||720};
      if(viewport.width<640||viewport.width>3840||viewport.height<480||viewport.height>2160)throw new Error('视口范围：宽 640–3840，高 480–2160');
      const cfg=config(data.config);recordStarting=true;update();
      let flow;
      try{
        flow=store.create(name,viewport,cfg);recorder=new Recorder(flow,cfg);
        const current=recorder;
        current.on('log',log);
        current.on('change',f=>{store.save(f);emit({type:'flow',flow:summary(f)});});
        current.on('closed',async()=>{await current.queue;if(recorder===current){store.save(current.flow);recorder=null;update();log('info','录制浏览器已关闭，流程已自动保存');}});
        await current.start();log('info','流程自动保存已开启');return summary(flow);
      }catch(error){if(recorder)await recorder.stop();recorder=null;throw new Error('Chrome 启动失败，请确认已安装 Chrome，或选择 chrome.exe 路径');}
      finally{recordStarting=false;update();}
    }
    case 'stopRecord':{
      const r=recorder;if(!r)return;
      await r.stop();store.save(r.flow);recorder=null;update();log('info','录制结束，已保存 '+r.flow.steps.length+' 个步骤');return summary(r.flow);
    }
    case 'snapshot':{
      if(!recorder)throw new Error('请先开始录制');
      return 'data:image/png;base64,'+(await recorder.snapshot()).toString('base64');
    }
    case 'trusted':{
      if(!recorder)throw new Error('请先开始录制');
      recorder.setTrusted(data);await recorder.resumeCapture();return summary(recorder.flow);
    }
    case 'checkpoint':{
      if(!recorder)throw new Error('请先开始录制');
      recorder.setCheckpoint(data.rect,{timeout:data.timeout,threshold:data.threshold});await recorder.resumeCapture();return summary(recorder.flow);
    }
    case 'cancelCapture':await recorder?.resumeCapture();return;
    case 'config':{
      if(recorder||runner)throw new Error('请停止后再修改配置');
      const f=store.get(data.id);f.config=config(data.config);f.variables=validateRules(f,data.variables);store.save(f);return summary(f);
    }
    case 'start':{
      if(recorder||runner||recordStarting)throw new Error('请先停止当前录制或任务');
      const f=store.get(data.id);f.config=config(data.config);f.variables=validateRules(f,data.variables);
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
      if(recorder||runner)throw new Error('请停止后再删除');
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
      Promise.allSettled([recorder?.stop(),runner?.stop()]).finally(()=>{win.destroy();app.quit();});
    });
  });
  app.on('window-all-closed',()=>app.quit());
}
