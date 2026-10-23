const {randomInt,randomUUID,createHash}=require('crypto');
function fieldId(step){return createHash('sha256').update(JSON.stringify([step.page||0,step.frame||[],step.selector])).digest('hex').slice(0,20);}
function fields(flow){const seen=new Map();flow.steps.forEach((s,index)=>{if(s.type!=='fill')return;const id=fieldId(s);if(!seen.has(id))seen.set(id,{id,step:index+1,selector:s.selector,name:s.fieldName||s.selector,secret:!!s.secret,frameDepth:s.frame?.length||0});});return [...seen.values()];}
function tokenValue(token,instance,generate){
  if(token==='uuid')return generate?randomUUID():'';
  if(token==='instance')return generate?String(instance):'';
  const args=token.split(':');
  if(args[0]==='int'&&args.length===3){const min=Number(args[1]),max=Number(args[2]);if(!Number.isSafeInteger(min)||!Number.isSafeInteger(max)||min>max||min<-2147483648||max>2147483647)throw new Error('随机整数范围需为 -2147483648 至 2147483647，且最小值不能大于最大值');return generate?String(randomInt(min,max+1)):'';}
  if(['digits','letters'].includes(args[0])&&args.length===2){const length=Number(args[1]);if(!Number.isInteger(length)||length<1||length>128)throw new Error('随机字符长度应为 1–128');const alphabet=args[0]==='digits'?'0123456789':'abcdefghijklmnopqrstuvwxyz';return generate?Array.from({length},()=>alphabet[randomInt(alphabet.length)]).join(''):'';}
  throw new Error('未知变量语法。支持 {{int:最小值:最大值}}、{{digits:长度}}、{{letters:长度}}、{{uuid}}、{{instance}}');
}
function expand(template,instance=1,generate=true){
  if(typeof template!=='string'||template.length>2000)throw new Error('字段模板不能超过 2000 字符');
  const remainder=template.replace(/\{\{([^{}]+)\}\}/g,(_,token)=>{tokenValue(token,instance,false);return '';});
  if(remainder.includes('{{')||remainder.includes('}}'))throw new Error('模板变量括号不完整');
  return template.replace(/\{\{([^{}]+)\}\}/g,(_,token)=>tokenValue(token,instance,generate));
}
function validateRules(flow,rules={}){const allowed=new Set(fields(flow).map(f=>f.id));const out={};for(const [id,rule] of Object.entries(rules||{})){if(!allowed.has(id))throw new Error('变量对应的表单字段不存在');if(rule.mode==='fixed')continue;if(rule.mode!=='template')throw new Error('未知字段变量模式');expand(rule.template,1,false);out[id]={mode:'template',template:rule.template};}return out;}
function generateValues(flow,instance){const values=new Map();for(const [id,rule]of Object.entries(validateRules(flow,flow.variables)))values.set(id,expand(rule.template,instance));return values;}
module.exports={fieldId,fields,expand,validateRules,generateValues};
