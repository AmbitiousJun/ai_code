const $=id=>document.getElementById(id);
let flows=[],selected=null,state={recording:false,running:false},busy=false,shotImage,selection,dragStart,latestStates=[],captureKind='final';
let flowTab='full';
const numeric=['count','interval','threshold','failures','retries','grace','radius','stepTimeout','maxStepDelay','actionInterval','checkpointTimeout'];
const checks=['headless','mute','noThrottle','ignoreRecordedDelays'];
let noticeTimer;
function notice(message){$('notice').textContent=message;$('notice').hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('notice').hidden=true,8000);}
async function call(action,data){const result=await window.flowAPI.call(action,data);if(!result.ok)throw new Error(result.error);return result.data;}
function config(){const c={};numeric.forEach(k=>c[k]=Number($(k).value));c.threshold/=100;c.stepTimeout*=1000;c.maxStepDelay*=1000;c.checkpointTimeout*=1000;checks.forEach(k=>c[k]=$(k).checked);c.chromePath=$('chromePath').value.trim();return c;}
function setConfig(c){numeric.forEach(k=>$(k).value=k==='threshold'?Math.round(c[k]*100):['stepTimeout','maxStepDelay','checkpointTimeout'].includes(k)?c[k]/1000:c[k]);checks.forEach(k=>$(k).checked=!!c[k]);$('chromePath').value=c.chromePath||'';}
function variables(){const out={};document.querySelectorAll('.variable-field').forEach(row=>{if(row.querySelector('select').value==='template')out[row.dataset.id]={mode:'template',template:row.querySelector('input').value};});return out;}
function renderVariables(flow){
  const fields=flow?.fields||[];$('variablesPanel').hidden=!fields.length;$('variableFields').replaceChildren();
  fields.forEach(field=>{const row=document.createElement('div');row.className='variable-field';row.dataset.id=field.id;
    const heading=document.createElement('div');heading.className='variable-heading';const title=document.createElement('strong');title.textContent=field.name+(field.secret?' · 密码字段':'');const meta=document.createElement('small');meta.textContent='步骤 '+field.step+' · '+field.selector+(field.frameDepth?' · iframe '+field.frameDepth+' 层':'');heading.append(title,meta);
    const controls=document.createElement('div');controls.className='variable-controls';const select=document.createElement('select');[['fixed','使用录制原值'],['template','使用字段模板']].forEach(([value,text])=>{const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option);});
    const input=document.createElement('input');input.setAttribute('list','templateExamples');input.placeholder='例如：user_{{digits:6}}';input.maxLength=2000;const rule=flow.variables?.[field.id];select.value=rule?'template':'fixed';input.value=rule?.template||'';input.hidden=select.value==='fixed';
    select.onchange=()=>{input.hidden=select.value==='fixed';if(select.value==='template'&&!input.value)input.value='{{int:1000:9999}}';};
    controls.append(select,input);row.append(heading,controls);$('variableFields').append(row);
  });
}
function upsert(flow){if(!flow)return;const index=flows.findIndex(f=>f.id===flow.id);if(index>=0)flows[index]=flow;else flows.unshift(flow);renderList();if(selected===flow.id)renderDetail();}
function renderList(){
  const key=value=>value.trim().normalize('NFKC').toLowerCase(),query=key($('flowSearch').value);
  const category=flows.filter(f=>(f.kind||'full')===flowTab);
  const visible=category.filter(f=>key(f.name).includes(query));
  $('fullTab').setAttribute('aria-pressed',String(flowTab==='full'));$('baseTab').setAttribute('aria-pressed',String(flowTab==='base'));
  const previous=$('baseId').value;$('baseId').replaceChildren(new Option('不嵌入',''));for(const f of flows.filter(f=>f.kind==='base'&&f.steps.some(s=>s.type==='goto')))$('baseId').add(new Option(f.name,f.id));$('baseId').value=previous;
  $('flowList').replaceChildren();$('flowCount').textContent=query?visible.length+' / '+category.length:category.length;
  $('clearFlowSearch').disabled=!$('flowSearch').value;
  $('flowEmpty').hidden=visible.length>0;
  $('flowEmpty').textContent=flows.length?'没有匹配的流程，请调整或清空筛选。':'暂无流程，请新建录制或导入流程。';
  visible.forEach(f=>{const b=document.createElement('button');b.className='flow-item'+(selected===f.id?' selected':'');b.textContent=f.name;const small=document.createElement('small');small.textContent=f.steps.length+' 步 · '+(f.kind==='base'?'基础流程 · 可嵌入':f.trusted?'可信图像就绪':'未设置可信图像');b.append(small);b.onclick=()=>{if(state.recording||state.running)return;selected=f.id;setConfig(f.config);renderList();renderDetail();};$('flowList').append(b);});
}
$('flowSearch').oninput=renderList;
$('clearFlowSearch').onclick=()=>{$('flowSearch').value='';renderList();$('flowSearch').focus();};
$('flowSearch').onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();$('clearFlowSearch').click();}};
function renderDetail(){
  const f=flows.find(f=>f.id===selected);
  $('metricSteps').textContent=String(f?.steps.length||0).padStart(2,'0');
  renderVariables(f);
  $('flowTitle').textContent=f?f.name:'录一次，持续守护';$('flowInfo').textContent=f?f.viewport.width+' × '+f.viewport.height+' 固定视口 · 自动保存于本机':'打开独立 Chrome，录制表单、Canvas 与 iframe 操作。';
  $('newPanel').hidden=!!f||state.recording;$('detailPanel').hidden=!f;$('deleteFlow').hidden=!f;$('exportFlow').hidden=!f||f.kind==='base';
  if(f?.baseFlow)$('flowInfo').textContent+=' · 内嵌基础流程：'+f.baseFlow.name;
  $('trustedInfo').parentElement.hidden=f?.kind==='base';
  if(f){$('stepCount').textContent=f.steps.length+' 个步骤';$('steps').replaceChildren();f.steps.forEach(s=>{const div=document.createElement('div');div.textContent=String(s.index).padStart(2,'0')+'  '+s.label+(s.frameDepth?' · iframe 层级 '+s.frameDepth:'')+(s.page?' · 标签页 '+(s.page+1):'');if(s.visualImage){const img=document.createElement('img');img.src=s.visualImage;img.className='click-preview';img.alt='点击位置参考截图';img.title='点击前截图：原位置优先；唯一匹配时重定位；未找到或多个匹配时回退原坐标';div.append(img);}if(s.visualError){const warning=document.createElement('span');warning.className='click-warning';warning.textContent=' · '+s.visualError+'（回放时使用录制原坐标）';div.append(warning);}$('steps').append(div);});$('steps').scrollTop=$('steps').scrollHeight;$('trustedImage').hidden=!f.trusted;if(f.trusted)$('trustedImage').src=f.trusted.image;$('trustedInfo').textContent=f.trusted?f.trusted.rect.width+' × '+f.trusted.rect.height+' · 已保存基准图':'尚未设置可信区域';}
  renderSubflows(f);updateControls();
}
function updateControls(){
  const isBase=(flows.find(f=>f.id===selected)?.kind||(!selected?$('flowKind').value:'full'))==='base';
  for(const id of ['count','interval','failures','retries','grace','headless','mute','noThrottle'])$(id).closest('label').hidden=isBase;
  $('configTitle').textContent=isBase?'执行配置':'执行与巡检配置';
  $('chromeConfig').hidden=isBase;$('inspectionHint').hidden=isBase;$('baseConfigHint').hidden=!isBase;
  $('detailTitle').textContent=isBase?'基础流程步骤':'流程与可信图像';
  $('snapshot').hidden=isBase;$('checkpoint').hidden=isBase;$('start').hidden=isBase;$('stop').hidden=isBase;
  $('fullTab').disabled=busy||state.recording||state.running;$('baseTab').disabled=$('fullTab').disabled;
  $('startSubflow').disabled=busy||state.running||state.recording||!selected;
  for(const id of ['subImage','subCron','subCheckpoint','finishSubflow','resumeSubflow','saveSubflow','nextSubflow'])$(id).disabled=busy;
  document.querySelectorAll('.delete-subflow').forEach(b=>b.disabled=busy||state.running||state.recording);
  $('importFlow').disabled=busy||state.running||state.recording;$('exportFlow').disabled=busy||state.running||state.recording||!selected;
  $('status').textContent=state.preparing?'● 基础流程准备中':state.recording?'● 录制中':state.running?'● 执行与巡检中':'待机';$('recordPanel').hidden=!state.recording||!!state.subPhase;
  $('stopNow').hidden=!state.recording&&!state.running;
  document.querySelectorAll('.variable-field select,.variable-field input').forEach(el=>el.disabled=state.recording||state.running);
  $('record').disabled=busy||state.running||state.recording;$('newFlow').disabled=busy||state.running||state.recording;
  $('start').disabled=busy||state.running||state.recording||!selected;$('stop').disabled=!state.running;
  $('stopRecord').disabled=!state.recording;$('snapshot').disabled=busy||!state.recording;
  $('checkpoint').disabled=busy||!state.recording;
  $('deleteFlow').disabled=busy||state.running||state.recording;$('saveConfig').disabled=busy||state.running||state.recording||!selected;
  [...numeric,...checks,'chromePath','chooseChrome'].forEach(k=>$(k).disabled=state.running||state.recording);
}
function addLog(entry){
  const line=document.createElement('div');line.className='log-'+entry.level;
  const t=document.createElement('span');t.className='log-time';t.textContent=new Date(entry.time).toLocaleTimeString();
  line.append(t,document.createTextNode(entry.message));
  if(entry.image){
    const button=document.createElement('button');button.className='log-screenshot';button.title='点击放大巡检截图';
    const img=document.createElement('img');img.src=entry.image;img.alt='巡检页面截图，点击放大';button.append(img);
    button.onclick=()=>{ $('logImage').src=img.src;$('logImageTitle').textContent=t.textContent+' · '+entry.message;$('logImageDialog').showModal(); };
    line.append(button);
  }else if(entry.hasScreenshot){const note=document.createElement('small');note.className='log-image-expired';note.textContent='截图已释放';line.append(note);}
  $('logs').append(line);while($('logs').children.length>1500)$('logs').firstChild.remove();
  let count=0,size=0;
  for(const img of [...$('logs').querySelectorAll('.log-screenshot img')].reverse()){
    count++;size+=img.src.length;
    if(count>64||size>24*1024*1024){const note=document.createElement('small');note.className='log-image-expired';note.textContent='截图已释放';img.parentElement.replaceWith(note);}
  }
  if($('autoScroll').checked)$('logs').scrollTop=$('logs').scrollHeight;
}
$('closeLogImage').onclick=()=>$('logImageDialog').close();
$('logImageDialog').addEventListener('close',()=>$('logImage').removeAttribute('src'));
$('logImage').onclick=()=>$('logImage').classList.toggle('original-size');
$('logImageDialog').addEventListener('close',()=>$('logImage').classList.remove('original-size'));
function renderStates(states){latestStates=states.filter(Boolean);const healthy=latestStates.filter(s=>s.status==='正常运行').length;$('metricHealthy').textContent=healthy+' / '+latestStates.length;const scores=latestStates.filter(s=>s.score!=null);$('metricScore').textContent=scores.length?(scores.reduce((sum,s)=>sum+s.score,0)/scores.length*100).toFixed(1)+'%':'—';$('instancesPanel').hidden=!states.length;$('instances').replaceChildren();latestStates.forEach(s=>{const div=document.createElement('div');div.className='instance'+(s.status==='正常运行'?' good':['需要人工处理','检查未通过'].includes(s.status)?' bad':'');const title=document.createElement('strong');title.textContent='#'+s.id+' · '+s.status;const detail=document.createElement('small');detail.textContent=(s.score==null?'尚未巡检':'匹配 '+(s.score*100).toFixed(1)+'%')+' · 恢复 '+(s.recoveries||0)+' 次';const time=document.createElement('small');time.textContent=s.checkedAt?'检查于 '+new Date(s.checkedAt).toLocaleTimeString():'';div.append(title,detail,time);$('instances').append(div);});}
async function task(fn){busy=true;updateControls();try{await fn();}catch(e){notice(e.message);}finally{busy=false;updateControls();}}
$('newFlow').onclick=()=>{selected=null;$('flowKind').value=flowTab;syncBaseChoice();renderList();renderDetail();$('name').focus();};
$('record').onclick=()=>task(async()=>{const flow=await call('record',{kind:$('flowKind').value,baseId:$('flowKind').value==='full'?$('baseId').value:'',name:$('name').value,width:$('width').value,height:$('height').value,config:config()});selected=flow.id;flowTab=flow.kind||'full';setConfig(flow.config);upsert(flow);});
$('stopRecord').onclick=()=>task(async()=>upsert(await call('stopRecord')));
$('saveConfig').onclick=()=>task(async()=>{upsert(await call('config',{id:selected,config:config(),variables:variables()}));notice('配置已保存');});
$('start').onclick=()=>task(async()=>upsert(await call('start',{id:selected,config:config(),variables:variables()})));
$('stopNow').onclick=()=>task(async()=>{if(state.subPhase)await call('stopSubflow');else if(state.recording)upsert(await call('stopRecord'));else await call('stop');});
$('stop').onclick=()=>task(()=>call('stop'));
$('deleteFlow').onclick=()=>task(async()=>{if(await call('delete',{id:selected})){flows=flows.filter(f=>f.id!==selected);selected=null;renderList();renderDetail();}});
$('openData').onclick=()=>task(()=>call('openData'));
$('chooseChrome').onclick=()=>task(async()=>{const p=await call('chrome');if(p)$('chromePath').value=p;});
async function capture(kind){captureKind=kind;let opened=false;try{const data=await call('snapshot');shotImage=new Image();await new Promise((res,rej)=>{shotImage.onload=res;shotImage.onerror=rej;shotImage.src=data;});const canvas=$('captureCanvas');canvas.width=shotImage.width;canvas.height=shotImage.height;selection=null;draw();$('saveTrusted').disabled=true;$('selectionInfo').textContent='尚未选择区域';$('captureTitle').textContent=kind==='trigger'?'框选子流程触发画面':kind==='checkpoint'?'框选“可继续执行”的可信画面':'框选最终巡检的可信画面';$('saveTrusted').textContent=kind==='trigger'?'确认条件并开始录制动作':kind==='checkpoint'?'插入检查点并继续录制':'保存最终巡检截图';$('checkpointOptions').hidden=kind!=='checkpoint';$('captureTimeout').value=$('checkpointTimeout').value;$('captureThreshold').value=$('threshold').value;$('captureDialog').showModal();opened=true;}finally{if(!opened)await call('cancelCapture');}}
$('snapshot').onclick=()=>task(()=>capture('final'));
$('checkpoint').onclick=()=>task(()=>capture('checkpoint'));
function draw(){const c=$('captureCanvas'),ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);ctx.drawImage(shotImage,0,0);if(selection){ctx.fillStyle='#0007';ctx.fillRect(0,0,c.width,c.height);ctx.drawImage(shotImage,selection.x,selection.y,selection.width,selection.height,selection.x,selection.y,selection.width,selection.height);ctx.strokeStyle='#61ffcf';ctx.lineWidth=2;ctx.strokeRect(selection.x,selection.y,selection.width,selection.height);}}
function point(e){const c=$('captureCanvas'),r=c.getBoundingClientRect();return{x:Math.round(Math.max(0,Math.min(c.width,(e.clientX-r.left)*c.width/r.width))),y:Math.round(Math.max(0,Math.min(c.height,(e.clientY-r.top)*c.height/r.height)))};}
$('captureCanvas').onpointerdown=e=>{dragStart=point(e);$('captureCanvas').setPointerCapture(e.pointerId);};
$('captureCanvas').onpointermove=e=>{if(!dragStart)return;const p=point(e);selection={x:Math.min(p.x,dragStart.x),y:Math.min(p.y,dragStart.y),width:Math.abs(p.x-dragStart.x),height:Math.abs(p.y-dragStart.y)};draw();$('selectionInfo').textContent=selection.width+' × '+selection.height+' 像素';$('saveTrusted').disabled=selection.width<12||selection.height<12;};
$('captureCanvas').onpointerup=()=>dragStart=null;
$('cancelCapture').onclick=()=>task(async()=>{await call('cancelCapture');$('captureDialog').close();});
$('captureDialog').addEventListener('cancel',event=>{event.preventDefault();$('cancelCapture').click();});
$('saveTrusted').onclick=()=>task(async()=>{const result=captureKind==='trigger'?await call('subTrigger',{type:'image',rect:selection}):captureKind==='checkpoint'?await call('checkpoint',{rect:selection,timeout:Number($('captureTimeout').value)*1000,threshold:Number($('captureThreshold').value)/100}):await call('trusted',selection);if(captureKind!=='trigger')upsert(result);$('captureDialog').close();});
window.flowAPI.onEvent(event=>{
  if(event.type==='log')addLog(event.entry);
  if(event.type==='flow'){if(state.recording&&!selected)selected=event.flow.id;upsert(event.flow);}
  if(event.type==='status'){state={...state,...event};if(event.recordingId)selected=event.recordingId;renderDetail();renderList();}
  if(event.type==='states')renderStates(event.states);
});
task(async()=>{const data=await call('init');flows=data.flows;state=data;setConfig(data.defaults);data.logs.forEach(addLog);renderStates(data.states);renderList();renderDetail();});

let importNames=[];
function checkImportName(){
  const name=$('importName').value.trim(),key=s=>s.trim().normalize('NFKC').toLowerCase();
  let error=!name?'请填写流程名称':name.length>80?'流程名称不能超过 80 个字符':importNames.some(n=>key(n)===key(name))?'流程名称已存在，请调整名称':'';
  if(!error&&!$('importBaseLabel').hidden){const base=$('importBaseName').value.trim();error=!base?'请填写基础流程名称':base.length>80?'基础流程名称不能超过 80 个字符':key(base)===key(name)||importNames.some(n=>key(n)===key(base))?'基础流程名称已存在，请调整名称':'';}
  $('importNameError').textContent=error;$('importName').setAttribute('aria-invalid',String(!!error));$('confirmImport').disabled=!!error;return !error;
}
$('importName').oninput=checkImportName;
$('exportFlow').onclick=()=>task(async()=>{if(await call('exportFlow',{id:selected}))notice('流程已导出');});
$('importFlow').onclick=()=>task(async()=>{const result=await call('prepareImport');if(!result)return;importNames=result.names;$('importBaseLabel').hidden=!result.baseName;$('importBaseName').value=result.baseName||'';$('importName').value=result.name;checkImportName();$('importDialog').showModal();$('importName').select();});
$('cancelImport').onclick=()=>task(async()=>{await call('cancelImport');$('importDialog').close();});
$('importDialog').addEventListener('cancel',event=>{event.preventDefault();if(!busy)$('cancelImport').click();});
$('confirmImport').onclick=()=>task(async()=>{
  if(!checkImportName())return;
  $('confirmImport').disabled=true;$('cancelImport').disabled=true;$('importName').disabled=true;
  try{const flow=await call('confirmImport',{name:$('importName').value,baseName:$('importBaseName').value});selected=flow.id;flowTab='full';flows=await call('list');setConfig(flow.config);upsert(flow);$('importDialog').close();notice('流程已导入');}
  finally{$('cancelImport').disabled=false;$('importName').disabled=false;checkImportName();}
});

function renderSubflows(flow){
  $('subflowsPanel').hidden=!flow||flow.kind==='base';$('subEditor').hidden=!state.subPhase;
  const phase=state.subPhase;
  $('subStatus').textContent=({restoring:'正在恢复主流程，请等待。此阶段不记录操作。',condition:'录制已暂停，可手动调整当前页面；确认触发条件后开始录制动作。',recording:'正在录制子流程动作。至少录入一个动作后完成并保存。',review:'录制已暂停，请检查步骤并命名保存。',saved:'子流程已保存，当前画面保持不变。可先手动调整页面，再继续录入新的子流程；调整操作不会记录。'})[phase]||'';
  for(const [id,value] of [['subCondition','condition'],['subRecording','recording'],['subReview','review'],['nextSubflow','saved']])$(id).hidden=phase!==value;
  if(phase==='review'&&$('subName').dataset.phase!=='review')$('subName').value=state.subDraft?.defaultName||'子流程';
  $('subName').dataset.phase=phase||'';
  $('subDraftSteps').replaceChildren();
  for(const step of state.subDraft?.steps||[]){const row=document.createElement('p');row.textContent=step.index+'. '+step.label;$('subDraftSteps').append(row);}
  $('subflowList').replaceChildren();
  for(const sub of flow?.subflows||[]){
    const box=document.createElement('details'),title=document.createElement('summary');title.textContent=sub.name+' · '+sub.steps.length+' 步 · '+(sub.trigger.type==='cron'?sub.trigger.expression:'截图触发');box.append(title);
    if(sub.trigger.type==='image'){const img=document.createElement('img');img.src=sub.trigger.trusted.image;img.alt='子流程触发截图';img.className='sub-trigger-preview';box.append(img);const r=sub.trigger.trusted.rect,info=document.createElement('p');info.textContent='触发图 '+r.width+' × '+r.height+' 像素'+(Math.min(r.width,r.height)<24?' · 选区较窄，建议重新录入并框选完整稳定图标，避开动画边缘':'');box.append(info);}
    for(const step of sub.steps){const row=document.createElement('p');row.textContent=step.index+'. '+step.label+' · 标签页 '+(step.page+1);box.append(row);}
    const remove=document.createElement('button');remove.textContent='删除子流程';remove.className='danger delete-subflow';remove.onclick=()=>{if(confirm('删除子流程“'+sub.name+'”？'))task(async()=>upsert(await call('deleteSubflow',{id:selected,subId:sub.id})));};box.append(remove);$('subflowList').append(box);
  }
}
function syncCron(){
  const mode=$('cronPreset').value;
  $('cronEveryLabel').hidden=!['seconds','minutes'].includes(mode);
  $('cronEveryUnit').textContent=mode==='seconds'?'间隔秒数':'间隔分钟';
  $('cronTimeLabel').hidden=mode!=='daily';$('cronMinuteLabel').hidden=mode!=='hourly';
  $('cronSecondLabel').hidden=!['minutes','hourly'].includes(mode);$('cronExpression').readOnly=mode!=='custom';
  const [hour,minute,second=0]=$('cronTime').value.split(':').map(Number);
  if(mode==='seconds')$('cronExpression').value='*/'+$('cronEvery').value+' * * * * *';
  if(mode==='minutes')$('cronExpression').value=$('cronSecond').value+' */'+$('cronEvery').value+' * * * *';
  if(mode==='hourly')$('cronExpression').value=$('cronSecond').value+' '+$('cronMinute').value+' * * * *';
  if(mode==='daily')$('cronExpression').value=second+' '+minute+' '+hour+' * * *';
}
for(const id of ['cronPreset','cronEvery','cronTime','cronMinute','cronSecond'])$(id).oninput=syncCron;
syncCron();
$('startSubflow').onclick=()=>task(async()=>{upsert(await call('config',{id:selected,config:config(),variables:variables()}));await call('startSubflow',{id:selected});});
$('subImage').onclick=()=>task(()=>capture('trigger'));
$('subCron').onclick=()=>task(()=>call('subTrigger',{type:'cron',expression:$('cronExpression').value}));
$('subCheckpoint').onclick=()=>task(()=>capture('checkpoint'));
$('finishSubflow').onclick=()=>task(()=>call('finishSubflow'));
$('resumeSubflow').onclick=()=>task(()=>call('resumeSubflow'));
$('saveSubflow').onclick=()=>task(async()=>upsert(await call('saveSubflow',{name:$('subName').value})));
$('nextSubflow').onclick=()=>task(()=>call('nextSubflow'));
$('stopSubflow').onclick=()=>task(()=>call('stopSubflow'));

function syncBaseChoice(){const base=$('flowKind').value==='base';$('baseChoice').hidden=base;const source=!base&&flows.find(f=>f.id===$('baseId').value);$('width').disabled=!!source;$('height').disabled=!!source;if(source){$('width').value=source.viewport.width;$('height').value=source.viewport.height;}}
$('flowKind').onchange=()=>{syncBaseChoice();updateControls();};$('baseId').onchange=syncBaseChoice;
for(const [id,kind] of [['fullTab','full'],['baseTab','base']])$(id).onclick=()=>{flowTab=kind;selected=null;$('flowKind').value=kind;syncBaseChoice();renderList();renderDetail();};
$('importBaseName').oninput=checkImportName;
