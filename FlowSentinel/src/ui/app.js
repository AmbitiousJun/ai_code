const $=id=>document.getElementById(id);
let flows=[],selected=null,state={recording:false,running:false},busy=false,shotImage,selection,dragStart,latestStates=[],captureKind='final';
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
  $('flowList').replaceChildren();$('flowCount').textContent=flows.length;
  flows.forEach(f=>{const b=document.createElement('button');b.className='flow-item'+(selected===f.id?' selected':'');b.textContent=f.name;const small=document.createElement('small');small.textContent=f.steps.length+' 步 · '+(f.trusted?'可信图像就绪':'未设置可信图像');b.append(small);b.onclick=()=>{if(state.recording||state.running)return;selected=f.id;setConfig(f.config);renderList();renderDetail();};$('flowList').append(b);});
}
function renderDetail(){
  const f=flows.find(f=>f.id===selected);
  $('metricSteps').textContent=String(f?.steps.length||0).padStart(2,'0');
  renderVariables(f);
  $('flowTitle').textContent=f?f.name:'录一次，持续守护';$('flowInfo').textContent=f?f.viewport.width+' × '+f.viewport.height+' 固定视口 · 自动保存于本机':'打开独立 Chrome，录制表单、Canvas 与 iframe 操作。';
  $('newPanel').hidden=!!f||state.recording;$('detailPanel').hidden=!f;$('deleteFlow').hidden=!f;
  if(f){$('stepCount').textContent=f.steps.length+' 个步骤';$('steps').replaceChildren();f.steps.forEach(s=>{const div=document.createElement('div');div.textContent=String(s.index).padStart(2,'0')+'  '+s.label+(s.frameDepth?' · iframe 层级 '+s.frameDepth:'')+(s.page?' · 标签页 '+(s.page+1):'');if(s.visualImage){const img=document.createElement('img');img.src=s.visualImage;img.className='click-preview';img.alt='点击位置参考截图';img.title='点击前截图：原位置优先；唯一匹配时重定位；未找到或多个匹配时回退原坐标';div.append(img);}if(s.visualError){const warning=document.createElement('span');warning.className='click-warning';warning.textContent=' · '+s.visualError+'（回放时使用录制原坐标）';div.append(warning);}$('steps').append(div);});$('steps').scrollTop=$('steps').scrollHeight;$('trustedImage').hidden=!f.trusted;if(f.trusted)$('trustedImage').src=f.trusted.image;$('trustedInfo').textContent=f.trusted?f.trusted.rect.width+' × '+f.trusted.rect.height+' · 已保存基准图':'尚未设置可信区域';}
  updateControls();
}
function updateControls(){
  $('status').textContent=state.recording?'● 录制中':state.running?'● 执行与巡检中':'待机';$('recordPanel').hidden=!state.recording;
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
$('newFlow').onclick=()=>{selected=null;renderList();renderDetail();$('name').focus();};
$('record').onclick=()=>task(async()=>{const flow=await call('record',{name:$('name').value,width:$('width').value,height:$('height').value,config:config()});selected=flow.id;upsert(flow);});
$('stopRecord').onclick=()=>task(async()=>upsert(await call('stopRecord')));
$('saveConfig').onclick=()=>task(async()=>{upsert(await call('config',{id:selected,config:config(),variables:variables()}));notice('配置已保存');});
$('start').onclick=()=>task(async()=>upsert(await call('start',{id:selected,config:config(),variables:variables()})));
$('stopNow').onclick=()=>task(async()=>{if(state.recording)upsert(await call('stopRecord'));else await call('stop');});
$('stop').onclick=()=>task(()=>call('stop'));
$('deleteFlow').onclick=()=>task(async()=>{if(await call('delete',{id:selected})){flows=flows.filter(f=>f.id!==selected);selected=null;renderList();renderDetail();}});
$('openData').onclick=()=>task(()=>call('openData'));
$('chooseChrome').onclick=()=>task(async()=>{const p=await call('chrome');if(p)$('chromePath').value=p;});
async function capture(kind){captureKind=kind;let opened=false;try{const data=await call('snapshot');shotImage=new Image();await new Promise((res,rej)=>{shotImage.onload=res;shotImage.onerror=rej;shotImage.src=data;});const canvas=$('captureCanvas');canvas.width=shotImage.width;canvas.height=shotImage.height;selection=null;draw();$('saveTrusted').disabled=true;$('selectionInfo').textContent='尚未选择区域';$('captureTitle').textContent=kind==='checkpoint'?'框选“可继续执行”的可信画面':'框选最终巡检的可信画面';$('saveTrusted').textContent=kind==='checkpoint'?'插入检查点并继续录制':'保存最终巡检截图';$('checkpointOptions').hidden=kind!=='checkpoint';$('captureTimeout').value=$('checkpointTimeout').value;$('captureThreshold').value=$('threshold').value;$('captureDialog').showModal();opened=true;}finally{if(!opened)await call('cancelCapture');}}
$('snapshot').onclick=()=>task(()=>capture('final'));
$('checkpoint').onclick=()=>task(()=>capture('checkpoint'));
function draw(){const c=$('captureCanvas'),ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);ctx.drawImage(shotImage,0,0);if(selection){ctx.fillStyle='#0007';ctx.fillRect(0,0,c.width,c.height);ctx.drawImage(shotImage,selection.x,selection.y,selection.width,selection.height,selection.x,selection.y,selection.width,selection.height);ctx.strokeStyle='#61ffcf';ctx.lineWidth=2;ctx.strokeRect(selection.x,selection.y,selection.width,selection.height);}}
function point(e){const c=$('captureCanvas'),r=c.getBoundingClientRect();return{x:Math.round(Math.max(0,Math.min(c.width,(e.clientX-r.left)*c.width/r.width))),y:Math.round(Math.max(0,Math.min(c.height,(e.clientY-r.top)*c.height/r.height)))};}
$('captureCanvas').onpointerdown=e=>{dragStart=point(e);$('captureCanvas').setPointerCapture(e.pointerId);};
$('captureCanvas').onpointermove=e=>{if(!dragStart)return;const p=point(e);selection={x:Math.min(p.x,dragStart.x),y:Math.min(p.y,dragStart.y),width:Math.abs(p.x-dragStart.x),height:Math.abs(p.y-dragStart.y)};draw();$('selectionInfo').textContent=selection.width+' × '+selection.height+' 像素';$('saveTrusted').disabled=selection.width<12||selection.height<12;};
$('captureCanvas').onpointerup=()=>dragStart=null;
$('cancelCapture').onclick=()=>task(async()=>{await call('cancelCapture');$('captureDialog').close();});
$('captureDialog').addEventListener('cancel',event=>{event.preventDefault();$('cancelCapture').click();});
$('saveTrusted').onclick=()=>task(async()=>{const result=captureKind==='checkpoint'?await call('checkpoint',{rect:selection,timeout:Number($('captureTimeout').value)*1000,threshold:Number($('captureThreshold').value)/100}):await call('trusted',selection);upsert(result);$('captureDialog').close();});
window.flowAPI.onEvent(event=>{
  if(event.type==='log')addLog(event.entry);
  if(event.type==='flow'){if(state.recording&&!selected)selected=event.flow.id;upsert(event.flow);}
  if(event.type==='status'){state={...state,...event};if(event.recordingId)selected=event.recordingId;renderDetail();renderList();}
  if(event.type==='states')renderStates(event.states);
});
task(async()=>{const data=await call('init');flows=data.flows;state=data;setConfig(data.defaults);data.logs.forEach(addLog);renderStates(data.states);renderList();renderDetail();});
