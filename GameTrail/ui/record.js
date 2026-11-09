const game = document.querySelector("#game"), statusText = document.querySelector("#status");
const finish = document.querySelector("#finish"), discard = document.querySelector("#discard");
const session = location.hash.slice(1);
const pick = document.querySelector("#pick"), pause = document.querySelector("#pause"), box = document.querySelector("#selection");
let selecting = false, paused = false, anchor, message = "";
let token, objectUrl, busy = false, ended = false;
async function post(url, data) {
  const response = await fetch(url, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(data)});
  if (!response.ok) throw Error((await response.json()).error);
}
async function watch() {
  const started = Date.now();
  while (!ended) {
    try {
      const state = await (await fetch("/api/record-state?session=" + encodeURIComponent(session))).json();
      if (!state) {
        if (token || Date.now() - started > 10000) {
          statusText.textContent = "录制已结束，可返回工作台";
          break;
        }
      } else {
        token = state.token;
        paused = state.paused;
        pause.textContent = paused ? "继续录入" : "暂停录入";
        pause.disabled = busy || selecting;
        pick.disabled = busy || !objectUrl;
        statusText.textContent = selecting && !frozen ? "正在获取无损画面…" : selecting ? "拖框选中完整按钮，松开即录入并点击。Esc 取消。" : message || state.note;
        finish.disabled = busy || selecting;
        discard.disabled = busy;
        if (selecting) { await new Promise(r => setTimeout(r,100)); continue; }
        const response = await fetch("/api/preview?job=" + state.job + "&run=" + state.run);
        if (response.status === 200) {
          const next = URL.createObjectURL(await response.blob());
          const img = new Image();
          img.src = next;
          await img.decode();
          if (selecting) { URL.revokeObjectURL(next); continue; }
          game.src = next;
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = next;
        }
      }
    } catch (err) { statusText.textContent = err.message; }
    await new Promise(r => setTimeout(r,100));
  }
  ended = true;
  pick.disabled = pause.disabled = finish.disabled = discard.disabled = true;
}
let freezeId = 0, frozen = false;
function select(active) {
  freezeId++;
  frozen = false;
  selecting = active;
  anchor = null;
  box.hidden = true;
  game.parentElement.classList.toggle("selecting", active);
  pick.textContent = active ? "取消框选" : "框选按钮 (F)";
  message = "";
}
pick.onclick = async () => {
  if (ended || busy || !objectUrl) return;
  select(!selecting);
  if (!selecting) return;
  const id = freezeId;
  let url;
  try {
    const response = await fetch("/api/record-freeze?token=" + encodeURIComponent(token));
    if (!response.ok) throw Error("冻结画面失败，请重新框选");
    url = URL.createObjectURL(await response.blob());
    const img = new Image();
    img.src = url;
    await img.decode();
    if (id !== freezeId || ended) return;
    game.src = url;
    URL.revokeObjectURL(objectUrl);
    objectUrl = url;
    url = null;
    await game.decode();
    if (id === freezeId) frozen = true;
  } catch (err) {
    if (id === freezeId) { select(false); message = err.message; }
  } finally { if (url) URL.revokeObjectURL(url); }
};
window.addEventListener("keydown", e => {
  if (e.key === "Escape") select(false);
  if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    pick.click();
  }
});
async function input(data) {
  if (!token || ended || busy) return;
  busy = true;
  message = "";
  finish.disabled = discard.disabled = pause.disabled = pick.disabled = true;
  try { await post("/api/record-input",{token,...data}); }
  catch (err) { message = err.message; statusText.textContent = message; }
  finally { busy = false; }
}
pause.onclick = () => input({mode:paused ? "resume" : "pause"});
function coords(e) {
  const r = game.getBoundingClientRect();
  return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)), y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};
}
game.onpointerdown = e => {
  if (!selecting || !frozen || busy || e.button !== 0) return;
  e.preventDefault();
  game.setPointerCapture(e.pointerId);
  anchor = coords(e);
};
game.onpointermove = e => {
  if (!anchor) return;
  const p = coords(e), r = game.getBoundingClientRect();
  Object.assign(box.style,{left:(r.left+Math.min(anchor.x,p.x)*r.width)+"px",top:(r.top+Math.min(anchor.y,p.y)*r.height)+"px",
    width:(Math.abs(p.x-anchor.x)*r.width)+"px",height:(Math.abs(p.y-anchor.y)*r.height)+"px"});
  box.hidden = false;
};
game.onpointercancel = () => select(false);
game.onpointerup = async e => {
  if (busy || ended || !objectUrl || e.button !== 0) return;
  const p = coords(e);
  if (!selecting) { await input(p); return; }
  if (!anchor) return;
  const viewWidth = game.naturalWidth, viewHeight = game.naturalHeight;
  const left = Math.round(Math.min(anchor.x,p.x)*viewWidth), top = Math.round(Math.min(anchor.y,p.y)*viewHeight);
  const width = Math.round(Math.abs(anchor.x-p.x)*viewWidth), height = Math.round(Math.abs(anchor.y-p.y)*viewHeight);
  select(false);
  if (Math.min(width,height)<8) { message="选区太小，请按 F 重新框选"; return; }
  const canvas = document.createElement("canvas");
  const side = 32;
  canvas.width = canvas.height = side;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(game,left,top,width,height,0,0,side,side);
  const rgba = ctx.getImageData(0,0,side,side).data;
  const rgb = btoa(String.fromCharCode(...rgba.filter((_,i)=>i%4!==3)));
  const detailScale = Math.min(1,128/Math.max(width,height));
  canvas.width = Math.max(1,Math.round(width*detailScale));
  canvas.height = Math.max(1,Math.round(height*detailScale));
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(game,left,top,width,height,0,0,canvas.width,canvas.height);
  const detail = canvas.toDataURL("image/png").split(",")[1];
  await input({mode:"pixels",template:{side,left,top,rgb,detail,width,height,viewWidth,viewHeight}});
};
for (const [button,action] of [[finish,"finish"],[discard,"discard"]]) {
  button.onclick = async () => {
    if (busy || ended) return;
    busy = true;
    finish.disabled = discard.disabled = true;
    try { await post("/api/manual",{token,action}); ended = true; window.close(); }
    catch (err) { busy = false; statusText.textContent = err.message; }
  };
}
window.addEventListener("hashchange", () => location.reload());
watch();
