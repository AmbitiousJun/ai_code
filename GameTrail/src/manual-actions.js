// This function runs separately inside every game frame, including after navigation.
function installManualActions() {
  let gesture = false, cocosAction = false, dispatching = false, finishGesture, timer;
  const clickTargets = new WeakSet();
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, fn, options) {
    if (type === "click" && fn && this instanceof Element) clickTargets.add(this);
    return add.call(this, type, fn, options);
  };
  function report(action) {
    window.__gtReport?.(action).then(message => {
      if (!message || !document.body) return;
      let banner = document.getElementById("__gameTrailRecordingStatus");
      if (!banner) {
        banner = document.createElement("div");
        banner.id = "__gameTrailRecordingStatus";
        banner.setAttribute("role", "status");
        banner.style.cssText = "position:fixed;top:8px;left:8px;z-index:2147483647;pointer-events:none;background:#24332c;color:white;padding:6px 12px;font:14px system-ui;border-radius:6px";
        document.body.append(banner);
      }
      banner.textContent = message;
    }).catch(() => {});
  }
  function scene() { return window.cc?.director?.getScene?.(); }
  function walk(node, visit) {
    if (!node) return;
    visit(node);
    for (const child of node.children || []) walk(child, visit);
  }
  function pathOf(node) {
    const path = [];
    while (node?.parent) {
      if (node.parent.children.filter(c => c.name === node.name).length !== 1) return;
      path.unshift(node.name);
      node = node.parent;
    }
    return path;
  }
  const className = c => c.__classname__ || c.constructor?.name;
  function bindingId(h) {
    return JSON.stringify([h.handler, h._componentId || h.component || "", pathOf(h.target)]);
  }
  function bindings(node) {
    return (node._components || []).flatMap(c => Array.isArray(c.clickEvents) ? c.clickEvents : []);
  }
  // Wrap engine dispatch, preserving the original event, receiver and return value.
  const wrapped = new WeakSet();
  function arm() {
    walk(scene(), node => {
      for (const h of bindings(node)) {
        if (!h || wrapped.has(h) || typeof h.emit !== "function") continue;
        const original = h.emit;
        h.emit = function(args) {
          if (!gesture || dispatching) return original.apply(this, arguments);
          const path = pathOf(node), key = bindingId(h);
          if (!path || !h.handler || !h.target || !pathOf(h.target) ||
              bindings(node).filter(other => bindingId(other) === key).length !== 1)
            bindingError = "Cocos 按钮或组件绑定无法唯一定位";
          else {
            const types = Array.isArray(args) ? args.map(arg => {
              if (arg?.node === node) return { kind: "component", type: className(arg) };
              if (arg && typeof arg.type === "string") return { kind: "event", type: arg.type };
              if (arg == null || ["string","number","boolean"].includes(typeof arg)) return { kind: "value", value: arg };
              return null;
            }) : [];
            if (types.includes(null)) bindingError = "Cocos 监听器参数无法重建";
            else {
              cocosAction = true;
              report({ kind: "CocosBinding", name: h.handler, path, key, args: types });
            }
          }
          dispatching = true;
          try { return original.apply(this, arguments); }
          finally { dispatching = false; }
        };
        wrapped.add(h);
      }
    });
  }
  let touchStep, ambiguousTouch, bindingError;
  function targetBox(node, canvas) {
    const cc = window.cc, view = cc?.view;
    if (!canvas || !node?.activeInHierarchy || node.opacity === 0 || view?._isRotated) return;
    const vp = view?.getViewportRect?.(), box = node.getBoundingBoxToWorld?.();
    if (!vp || !box || !canvas.width || !canvas.height) return;
    const camera = cc.Camera?.findCamera?.(node);
    function project(x,y) {
      let p = cc.v2(x,y);
      if (camera?.getWorldToScreenPoint) p = camera.getWorldToScreenPoint(p);
      return {x:(p.x*view.getScaleX()+vp.x)/canvas.width,
        y:1-(p.y*view.getScaleY()+vp.y)/canvas.height};
    }
    const a = project(box.x, box.y+box.height), b = project(box.x+box.width, box.y);
    const width = b.x-a.x, height = b.y-a.y;
    if (width > 0 && height > 0 && width*height < 0.8) return {...a,width,height};
  }
  function canvasForGame() { return window.cc?.game?.canvas || document.querySelector("#GameCanvas,canvas"); }
  function armTouch(e) {
    const proto = window.cc?.Node?.prototype, canvas = canvasForGame();
    if (!proto || e.target !== canvas || typeof proto.dispatchEvent !== "function") return;
    const r = canvas.getBoundingClientRect();
    const pointer = {x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height};
    // Wrap only for this gesture. Capture before game handlers can move or destroy the node.
    const original = proto.dispatchEvent;
    const dispatch = function(event) {
      if (gesture && /^(touch(start|end)|mouse(down|up))$/i.test(event?.type)) {
        try {
          const path = pathOf(this), box = targetBox(this,canvas);
          if (box && path?.length) {
            const x = (pointer.x-box.x)/box.width, y = (pointer.y-box.y)/box.height;
            if (x>=0 && x<=1 && y>=0 && y<=1) {
              if (touchStep && JSON.stringify(path)!==JSON.stringify(touchStep.path)) ambiguousTouch=true;
              touchStep = {kind:"CocosTouch",name:this.name,path,x,y};
            }
          }
        } catch { /* Unknown engine projection: preserve normal input. */ }
      }
      return original.apply(this,arguments);
    };
    proto.dispatchEvent = dispatch;
    restoreDispatch = () => { if (proto.dispatchEvent === dispatch) proto.dispatchEvent = original; };
  }
  let restoreDispatch;
  function start(e) {
    if (!e.isTrusted || !window.__gtReport) return;
    finishGesture?.();
    clearTimeout(timer);
    gesture = true;
    cocosAction = false;
    restoreDispatch?.();
    bindingError = undefined;
    touchStep = undefined;
    ambiguousTouch = false;
    armTouch(e);
    arm();
  }
  function end(e) {
    if (!e.isTrusted || !gesture) return;
    clearTimeout(timer);
    finishGesture = () => {
      finishGesture = undefined;
      if (!cocosAction && e.target instanceof HTMLCanvasElement)
        report(touchStep && !ambiguousTouch ? touchStep : { error: bindingError || "画布操作没有可重新定位的 Cocos 按钮绑定或触摸节点" });
      restoreDispatch?.();
      gesture = false;
    };
    timer = setTimeout(finishGesture, 160);
  }
  window.addEventListener("pointerdown", start, true);
  window.addEventListener("pointerup", end, true);
  window.addEventListener("click", e => {
    if (!e.isTrusted || !window.__gtReport || (gesture && cocosAction) || e.target instanceof HTMLCanvasElement) return;
    const el = e.composedPath().find(n => n instanceof HTMLElement &&
      (n.matches('button,a[href],input[type=button],input[type=submit],[role=button],[onclick]') ||
       typeof n.onclick === "function" || clickTargets.has(n)));
    if (el) {
      for (const attr of ["id","data-testid","name","aria-label"]) {
        const value = el.getAttribute(attr);
        if (!value) continue;
        const selector = el.localName + "[" + attr + "=" + CSS.escape(value) + "]";
        if (document.querySelectorAll(selector).length === 1) {
          report({ kind: "DOMAction", name: el.innerText?.trim().slice(0,80) || value, selector });
          return;
        }
      }
    }
    report({ error: "此点击缺少唯一的 DOM 控件标识" });
  }, true);
  window.addEventListener("keydown", e => {
    if (e.isTrusted && window.__gtReport && !["Shift","Control","Alt","Meta"].includes(e.key))
      report({error:"暂不支持录入键盘操作"});
  }, true);
  window.addEventListener("change", e => {
    if (e.isTrusted && window.__gtReport) report({error:"暂不支持录入表单值变化"});
  }, true);
  function invoke(step) {
    if (step.kind === "DOMAction") {
      const matches = document.querySelectorAll(step.selector);
      const el = matches[0];
      if (matches.length !== 1 || !el.getClientRects().length || el.matches(':disabled,[aria-disabled=true]')) return false;
      el.click();
      return true;
    }
    if (!["CocosTouch","CocosBinding"].includes(step.kind)) return false;
    let node = scene();
    for (const part of step.path) {
      const matches = node?.children?.filter(c => c.name === part);
      if (matches?.length !== 1) return false;
      node = matches[0];
    }
    if (!node?.activeInHierarchy) return false;
    if (step.kind === "CocosTouch") {
      const canvas = canvasForGame(), box = targetBox(node,canvas);
      if (!box) return false;
      const r = canvas.getBoundingClientRect();
      const x = (box.x+box.width*step.x)*r.width, y = (box.y+box.height*step.y)*r.height;
      if (document.elementFromPoint(r.left+x,r.top+y) !== canvas) return false;
      return {index:Array.from(document.querySelectorAll("canvas")).indexOf(canvas),x,y};
    }
    const matches = bindings(node).filter(h => bindingId(h) === step.key);
    if (matches.length !== 1) return false;
    const h = matches[0];
    const button = node._components.find(c => c.clickEvents?.includes(h));
    if (!button || button.interactable === false || button.enabled === false) return false;
    const cls = window.cc?.js?.getClassById?.(h._componentId) || h.component;
    const receiver = cls && h.target?.getComponent?.(cls);
    if (typeof receiver?.[h.handler] !== "function") return false;
    const args = step.args.map(a => {
      if (a.kind === "value") return a.value;
      if (a.kind === "component") {
        const comps = node._components.filter(c => className(c) === a.type);
        return comps.length === 1 ? comps[0] : null;
      }
      const event = new window.cc.Event(a.type, true);
      event.target = event.currentTarget = node;
      return event;
    });
    if (args.some((value,i) => step.args[i].kind === "component" && !value)) return false;
    matches[0].emit(args);
    return true;
  }
  Object.defineProperty(window, "__gtManual", { value: { invoke } });
}
module.exports = { installManualActions };
