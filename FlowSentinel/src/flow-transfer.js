// Portable envelope: independent of step types and local encrypted storage.
const {randomUUID}=require('crypto');
const FORMAT='FlowSentinel';
const PROTOCOL=1;
const MIN_VERSION='1.2.7';
const MAX_BYTES=128*1024*1024;
function version(value){
  if(typeof value!=='string'||!/^\d+\.\d+\.\d+$/.test(value))throw new Error('无效的导入版本声明');
  const parts=value.split('.').map(Number);
  if(!parts.every(Number.isSafeInteger))throw new Error('无效的导入版本声明');
  return parts;
}
function older(a,b){const x=version(a),y=version(b);for(let i=0;i<3;i++){if(x[i]!==y[i])return x[i]<y[i];}return false;}
function encode(flow,appVersion){
  version(appVersion);
  if(flow.kind==='base')throw new Error('只能导出全流程');
  const text=JSON.stringify({format:FORMAT,protocolVersion:PROTOCOL,minImporterVersion:flow.baseFlow?'1.4.0':flow.subflows?.some(s=>s.trigger?.type==='cron'&&s.trigger.expression.trim().split(/\s+/).length===6)?'1.3.2':flow.subflows?.length?'1.3.0':MIN_VERSION,exporterVersion:appVersion,flow});
  if(Buffer.byteLength(text)>MAX_BYTES)throw new Error('流程文件超过 128 MiB 限制');
  return text;
}
function decode(text,appVersion){
  if(Buffer.byteLength(text)>MAX_BYTES)throw new Error('流程文件超过 128 MiB 限制');
  let file;try{file=JSON.parse(text);}catch{throw new Error('无法读取 .fs 文件：JSON 格式损坏');}
  if(!file||file.format!==FORMAT)throw new Error('不是受支持的 FlowSentinel 流程协议');
  version(file.minImporterVersion);version(file.exporterVersion);
  if(!Number.isSafeInteger(file.protocolVersion)||file.protocolVersion<1)throw new Error('无效的流程协议版本');
  if(file.protocolVersion!==PROTOCOL||older(appVersion,file.minImporterVersion))throw new Error('流程协议不兼容，最低导入版本：FlowSentinel '+file.minImporterVersion+'；当前版本：'+appVersion);
  if(file.flow?.kind==='base')throw new Error('只能导入全流程');
  return file.flow;
}
function nameError(name,names){
  if(typeof name!=='string'||!name.trim())return '请填写流程名称';
  if(name.trim().length>80)return '流程名称不能超过 80 个字符';
  const key=s=>s.trim().normalize('NFKC').toLowerCase();
  return names.some(n=>key(n)===key(name))?'流程名称已存在，请调整名称':'';
}
function importedFlow(flow,name,names){
  const error=nameError(name,names);if(error)throw new Error(error);
  return {...structuredClone(flow),id:randomUUID(),name:name.trim(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
}
module.exports={encode,decode,nameError,importedFlow,MAX_BYTES};
