// Runs in every document, including cross-origin child frames, through Playwright.
function installRecorder() {
  if (window.__flowRecorderInstalled) return;
  window.__flowRecorderInstalled = true;
  const selector = el => {
    if (!(el instanceof Element)) return 'html';
    const root = el.getRootNode();
    const unique = s => { try { return root.querySelectorAll(s).length === 1; } catch { return false; } };
    let s;
    if (el.id && unique(s = '#' + CSS.escape(el.id))) return s;
    for (const a of ['data-testid', 'name', 'aria-label']) {
      if (el.getAttribute(a) && unique(s = el.localName + '[' + a + '=' + JSON.stringify(el.getAttribute(a)) + ']')) return s;
    }
    const parts = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      let p = n.localName;
      const siblings = n.parentElement ? [...n.parentElement.children].filter(x => x.localName === p) : [];
      if (siblings.length > 1) p += ':nth-of-type(' + (siblings.indexOf(n) + 1) + ')';
      parts.unshift(p);
      if (unique(parts.join(' > '))) break;
    }
    const path = parts.join(' > ');
    return root instanceof ShadowRoot ? selector(root.host) + ' >> ' + path : path;
  };
  let pending = Promise.resolve();
  let paused=false;
  window.__flowRecorderPause=value=>{paused=!!value;clearTimeout(hoverTimer);for(const timer of scrollTimers.values())clearTimeout(timer);scrollTimers.clear();};
  const send = (data, visualPromise) => {
    if(paused)return;
    data.at = Date.now();
    pending = pending.then(async() => {if(visualPromise)Object.assign(data,await visualPromise);return window.__flowRecord(data);}).catch(() => {});
  };
  window.__flowFlush = () => pending;
  const target = e => e.composedPath()[0];
  const editable = el => el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable);
  document.addEventListener('input', e => {
    const el = target(e);
    if (!editable(el) || el.type === 'file') return;
    if (['checkbox', 'radio'].includes(el.type)) send({ type: 'check', selector: selector(el), checked: el.checked });
    else if (el.tagName === 'SELECT') send({ type: 'select', selector: selector(el), values: [...el.selectedOptions].map(x => x.value) });
    else send({ type: 'fill', selector: selector(el), fieldName: el.getAttribute('aria-label') || el.labels?.[0]?.textContent?.trim().slice(0,60) || el.getAttribute('placeholder') || el.name || el.id || selector(el), value: el.isContentEditable ? el.textContent : el.value, secret: el.type === 'password' });
  }, true);
  document.addEventListener('change', e => {
    const el = target(e);
    if (el.type === 'file') send({ type: 'unsupported', reason: '文件上传需要手动配置，未录入文件内容' });
  }, true);
  document.addEventListener('click', e => {
    const el = target(e);
    if (!el || el.tagName === 'CANVAS' || el.tagName === 'SELECT' || ['checkbox','radio'].includes(el.type)) return;
    send({ type: 'click', selector: selector(el), button: 'left', count: e.detail > 1 ? 2 : 1 });
  }, true);
  let gesture = null;
  // Read before game handlers; compositor frames cover unreadable WebGL and layers.
  function patch(el, x, y) {
    const r=el.getBoundingClientRect(), style=getComputedStyle(el);
    const left=r.left+parseFloat(style.borderLeftWidth)+parseFloat(style.paddingLeft);
    const top=r.top+parseFloat(style.borderTopWidth)+parseFloat(style.paddingTop);
    const width=el.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
    const height=el.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
    if(width<48||height<48)return null;
    const px=Math.max(0,Math.min(width-48,Math.round(x-left-24)));
    const py=Math.max(0,Math.min(height-48,Math.round(y-top-24)));
    const c=document.createElement('canvas');c.width=48;c.height=48;
    const ctx=c.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(el,px*el.width/width,py*el.height/height,48*el.width/width,48*el.height/height,0,0,48,48);
    const pixels=ctx.getImageData(0,0,48,48).data;
    let opaque=0,distinct=0;
    for(let i=0;i<pixels.length;i+=4){if(pixels[i+3]>240)opaque++;if(Math.max(Math.abs(pixels[i]-pixels[0]),Math.abs(pixels[i+1]-pixels[1]),Math.abs(pixels[i+2]-pixels[2]))>32)distinct++;}
    if(opaque<48*48*.95||distinct<48*48*.08)return null;
    return {image:c.toDataURL('image/png').split(',')[1],offset:{x:x-left-px,y:y-top-py},width:48,height:48};
  }
  document.addEventListener('pointerdown', e => {
    clearTimeout(hoverTimer);
    const el = target(e);
    if (paused || el?.tagName !== 'CANVAS') return;
    const r = el.getBoundingClientRect();
    gesture = { type: 'canvas', selector: selector(el), button: ['left', 'middle', 'right'][e.button] || 'left', points: [], started: performance.now(), rect: r };
    try{gesture.visual=patch(el,e.clientX,e.clientY);}catch{}
    if(!gesture.visual){
      const point={x:e.clientX,y:e.clientY,at:Date.now(),rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
      gesture.visualPromise=window.__flowVisual(point).catch(()=>({visualError:'未能获取点击前画面，请重新录制'}));
    }
    point(e);
  }, true);
  function point(e) {
    if (!gesture) return;
    const r = gesture.rect;
    gesture.points.push({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, t: Math.round(performance.now() - gesture.started) });
  }
  document.addEventListener('pointermove', e => {
    if (gesture && (gesture.points.length < 2 || performance.now() - gesture.started - gesture.points.at(-1).t >= 12)) point(e);
  }, true);
  document.addEventListener('pointerup', e => {
    if (!gesture) return;
    point(e);
    const { rect, started, visualPromise, ...data } = gesture;
    const dragged=data.points.some(p=>Math.hypot((p.x-data.points[0].x)*rect.width,(p.y-data.points[0].y)*rect.height)>8);
    // A drag is a relative trajectory, not a button lookup.
    if(dragged){delete data.visual;delete data.visualError;}
    gesture = null;
    send(data,dragged?null:visualPromise);
  }, true);
  document.addEventListener('contextmenu', e => {
    const el = target(e);
    if (el?.tagName !== 'CANVAS') send({ type: 'click', selector: selector(el), button: 'right', count: 1 });
  }, true);
  document.addEventListener('wheel', e => {
    const el=target(e);if(el?.tagName!=='CANVAS')return;
    const r=el.getBoundingClientRect();const scale=e.deltaMode===1?16:e.deltaMode===2?innerHeight:1;
    send({type:'wheel',selector:selector(el),x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height,deltaX:e.deltaX*scale,deltaY:e.deltaY*scale});
  },{capture:true,passive:true});
  document.addEventListener('keydown', e => {
    const el = target(e);
    if (e.isComposing || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    if (editable(el) && !(e.ctrlKey || e.altKey || e.metaKey || ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key))) return;
    const key = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.metaKey && 'Meta', e.shiftKey && 'Shift', e.key === ' ' ? 'Space' : e.key].filter(Boolean).join('+');
    send({ type: 'key', selector: selector(el), key });
  }, true);
  const scrollTimers = new Map();
  document.addEventListener('scroll', e => {
    const el = e.target;
    clearTimeout(scrollTimers.get(el));
    scrollTimers.set(el, setTimeout(() => {
      const isWindow = el === document;
      send({ type: 'scroll', selector: isWindow ? null : selector(el), x: isWindow ? scrollX : el.scrollLeft, y: isWindow ? scrollY : el.scrollTop });
      scrollTimers.delete(el);
    }, 120));
  }, true);
  let hoverTimer;
  document.addEventListener('pointerover', e => {
    clearTimeout(hoverTimer);
    const el = target(e);
    if (!el || editable(el) || el.tagName === 'CANVAS') return;
    hoverTimer = setTimeout(() => { if(el.isConnected) send({ type: 'hover', selector: selector(el) }); }, 600);
  }, true);
}
module.exports = { installRecorder };
