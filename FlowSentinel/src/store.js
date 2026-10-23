const fs=require('fs');
const path=require('path');
const {randomUUID}=require('crypto');
class Store {
  constructor(dir,crypto){this.dir=dir;this.crypto=crypto;fs.mkdirSync(dir,{recursive:true});}
  file(id){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('无效流程 ID');return path.join(this.dir,id+'.flow');}
  create(name,viewport,cfg){const flow={version:1,id:randomUUID(),name,viewport,config:cfg,steps:[],trusted:null,createdAt:new Date().toISOString()};this.save(flow);return flow;}
  save(flow){flow.updatedAt=new Date().toISOString();const file=this.file(flow.id);const encrypted=this.crypto.encryptString(JSON.stringify(flow));fs.writeFileSync(file+'.tmp',encrypted);fs.renameSync(file+'.tmp',file);}
  get(id){return JSON.parse(this.crypto.decryptString(fs.readFileSync(this.file(id))));}
  list(){return fs.readdirSync(this.dir).filter(f=>f.endsWith('.flow')).map(f=>this.get(f.slice(0,-5))).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
  delete(id){fs.unlinkSync(this.file(id));}
}
module.exports={Store};
