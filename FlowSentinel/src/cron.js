// Five-field (legacy minute) or six-field (second), numeric crontab in the Windows local timezone. No background jobs.
function parseCron(expression) {
  if(typeof expression!=='string'||expression.length>200)throw new Error('请输入 crontab：秒 分 时 日 月 星期（兼容五段）');
  const parts=expression.trim().split(/\s+/),ranges=[[0,59],[0,59],[0,23],[1,31],[1,12],[0,7]];
  if(parts.length!==5&&parts.length!==6)throw new Error('crontab 必须包含六段：秒 分 时 日 月 星期，或旧版五段');
  if(parts.length===5)parts.unshift('*');
  return parts.map((part,i)=>{
    const [min,max]=ranges[i],values=new Set();
    for(const piece of part.split(',')){
      const m=/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(piece);
      if(!m)throw new Error('crontab 格式无效');
      const step=m[2]===undefined?1:Number(m[2]);
      let [a,b]=m[1]==='*'?[min,max]:m[1].split('-').map(Number);
      if(b===undefined)b=m[2]===undefined?a:max;
      if(a<min||b>max||a>b||step<1||step>max-min+1)throw new Error('crontab 数值超出范围');
      for(let n=a;n<=b;n+=step)values.add(i===5&&n===7?0:n);
    }
    return {values,wild:part.startsWith('*')};
  });
}
function cronMatches(expression,date=new Date()) {
  const p=parseCron(expression),v=[date.getSeconds(),date.getMinutes(),date.getHours(),date.getDate(),date.getMonth()+1,date.getDay()];
  const matches=p.map((f,i)=>f.values.has(v[i]));
  return matches[0]&&matches[1]&&matches[2]&&matches[4]&&(p[3].wild||p[5].wild?matches[3]&&matches[5]:matches[3]||matches[5]);
}
function cronSlot(expression,date=new Date()){
  return Math.floor(date.getTime()/(expression.trim().split(/\s+/).length===6?1000:60000));
}
module.exports={parseCron,cronMatches,cronSlot};
