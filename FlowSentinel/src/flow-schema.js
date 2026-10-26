// Payload validation belongs to the flow model, not the portable envelope.
const {config}=require('./engine');
const {validateRules}=require('./variables');
const types=new Set(['goto','fill','click','check','select','key','hover','scroll','canvas','wheel','checkpoint']);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function validateFlow(f){
  const requireValue=(ok)=>{if(!ok)throw new Error('流程数据损坏或包含不支持的字段结构');};
  const finite=v=>typeof v==='number'&&Number.isFinite(v);
  const image=t=>{requireValue(object(t)&&object(t.rect)&&typeof t.image==='string'&&t.image.length>0);for(const k of ['x','y','width','height'])requireValue(finite(t.rect[k]));requireValue(t.rect.x>=0&&t.rect.y>=0&&t.rect.width>=12&&t.rect.height>=12);};
  requireValue(object(f));
  if(f.version!==1)throw new Error('不支持的流程数据版本；请使用文件声明的最低导入版本或更新版本');
  requireValue(typeof f.name==='string'&&object(f.viewport)&&Number.isInteger(f.viewport.width)&&Number.isInteger(f.viewport.height)&&f.viewport.width>=640&&f.viewport.width<=3840&&f.viewport.height>=480&&f.viewport.height<=2160&&Array.isArray(f.steps)&&object(f.config));
  requireValue(f.kind===undefined||['base','full'].includes(f.kind));
  if(f.kind==='base')requireValue(!f.trusted&&!f.subflows?.length&&!f.baseFlow&&!f.steps.some(s=>s.type==='checkpoint'));
  if(f.baseFlow!==undefined){
    requireValue(object(f.baseFlow)&&f.baseFlow.kind==='base'&&!f.baseFlow.baseFlow);validateFlow(f.baseFlow);
    requireValue(f.viewport.width===f.baseFlow.viewport.width&&f.viewport.height===f.baseFlow.viewport.height&&f.steps.length>=f.baseFlow.steps.length);
    requireValue(JSON.stringify(f.steps.slice(0,f.baseFlow.steps.length))===JSON.stringify(f.baseFlow.steps));
  }
  config(f.config);
  if(f.trusted!=null)image(f.trusted);
  for(const s of f.steps){
    requireValue(object(s)&&types.has(s.type));
    if(s.page!==undefined)requireValue(Number.isInteger(s.page)&&s.page>=0);
    if(s.frame!==undefined)requireValue(Array.isArray(s.frame)&&s.frame.every(x=>typeof x==='string'));
    if(s.delay!==undefined)requireValue(finite(s.delay)&&s.delay>=0);
    if(!['goto','checkpoint','scroll'].includes(s.type))requireValue(typeof s.selector==='string');
    if(s.type==='goto'){requireValue(typeof s.url==='string');let url;try{url=new URL(s.url);}catch{}requireValue(url&&['http:','https:','about:'].includes(url.protocol));}
    if(s.type==='fill')requireValue(typeof s.value==='string');
    if(s.type==='check')requireValue(typeof s.checked==='boolean');
    if(s.type==='select')requireValue(Array.isArray(s.values)&&s.values.every(x=>typeof x==='string'));
    if(s.type==='key')requireValue(typeof s.key==='string');
    if(s.type==='canvas')requireValue(Array.isArray(s.points)&&s.points.length>0&&s.points.every(p=>object(p)&&finite(p.x)&&finite(p.y)&&finite(p.t)));
    if(s.type==='checkpoint'){image(s.trusted);requireValue(finite(s.timeout)&&s.timeout>0&&finite(s.threshold)&&s.threshold>=0.5&&s.threshold<=1);}
  }
  if(f.subflows!==undefined){
    requireValue(Array.isArray(f.subflows));const ids=new Set();
    for(const sub of f.subflows){
      requireValue(object(sub)&&typeof sub.id==='string'&&!ids.has(sub.id)&&typeof sub.name==='string'&&sub.name.trim().length>0&&sub.name.length<=80&&object(sub.trigger)&&Array.isArray(sub.steps)&&sub.steps.some(s=>s&&s.type!=='checkpoint')&&sub.subflows===undefined);
      ids.add(sub.id);
      if(sub.trigger.type==='cron')require('./cron').parseCron(sub.trigger.expression);
      else {requireValue(sub.trigger.type==='image');image(sub.trigger.trusted);requireValue(Number.isInteger(sub.trigger.trusted.page)&&sub.trigger.trusted.page>=0);}
      if(sub.pageBase!==undefined)requireValue(Number.isInteger(sub.pageBase)&&sub.pageBase>=1);
      validateFlow({...sub,version:1,viewport:f.viewport,config:f.config});
    }
  }
  validateRules(f,f.variables);
  return f;
}
module.exports={validateFlow};
