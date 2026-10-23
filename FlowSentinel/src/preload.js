const { contextBridge, ipcRenderer }=require('electron');
contextBridge.exposeInMainWorld('flowAPI',{
  call:(action,data)=>ipcRenderer.invoke('flow:call',action,data),
  onEvent:callback=>{const handler=(_,event)=>callback(event);ipcRenderer.on('flow:event',handler);return()=>ipcRenderer.removeListener('flow:event',handler);}
});
