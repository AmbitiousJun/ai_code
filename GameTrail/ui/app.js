const $ = (id) => document.getElementById(id);
const create = (tag, text) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
};
async function api(route, data) {
  const r = await fetch(
    route,
    data === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  const j = await r.json();
  if (!r.ok) throw Error(j.error);
  return j;
}
let presets,
  seq = 0,
  currentId = "",
  recent = [],
  lastStatus = "",
  estimateId = 0;
function devices(selected) {
  $("devices").replaceChildren();
  for (const d of [...presets, ...JSON.parse($("custom").value || "[]")]) {
    const l = create("label"),
      box = create("input");
    box.type = "checkbox";
    box.value = d.id;
    box.checked = selected.includes(d.id);
    l.append(box, d.name);
    $("devices").append(l);
  }
}
function selected() {
  return [...$("devices").querySelectorAll(":checked")].map((x) => x.value);
}
function replayConcurrency() {
  const input = $("replayConcurrency");
  if (!input.validity.valid) throw Error("并发实例数必须为正整数");
  return input.value === "" ? null : input.valueAsNumber;
}
function config() {
  const variables = Object.create(null);
  const variableOrder = [];
  for (const line of $("variables")
    .value.split("\n")
    .filter((x) => x.trim())) {
    const eq = line.indexOf("=");
    if (eq < 1) throw Error("变量格式示例：gameId=demo-a,demo-b");
    const key = line.slice(0, eq).trim();
    if (!Object.hasOwn(variables, key)) variableOrder.push(key);
    variables[key] = line
      .slice(eq + 1)
      .split(/[,，]/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return {
    template: $("template").value.trim(),
    variables,
    variableOrder,
    primaryVariable: $("primaryVariable").value.trim(),
    selected: selected(),
    replayConcurrency: replayConcurrency(),
    custom: JSON.parse($("custom").value || "[]"),
    explore: $("explore").checked,
    exploreMode: $("exploreMode").value,
    ...Object.fromEntries(
      ["waitSeconds", "quietSeconds", "pixelTimeout", "pixelSimilarity", "actions"].map((k) => [
        k,
        Number($(k).value),
      ]),
    ),
  };
}
async function estimate() {
  $("replayConcurrency").placeholder = "自动（" + selected().length + "）";
  const n = ++estimateId;
  try {
    const { total } = await api("/api/plan", config());
    if (n === estimateId)
      $("estimate").textContent = "预计运行 " + total + " 次（含录入或发现阶段）";
  } catch (e) {
    if (n === estimateId) $("estimate").textContent = e.message;
  }
}
function color(e) {
  if (e.kind === "failed" || e.status >= 400) return "bad";
  if (e.kind === "warning" || e.status >= 300) return "warn";
  return e.status === 200 ? "good" : "info";
}
const beijingTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", hourCycle: "h23",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});
function render() {
  const f = $("filter").value,
    fragment = document.createDocumentFragment();
  for (const e of recent
    .filter(
      (e) =>
        !f ||
        e.kind === f ||
        e.source === f ||
        (f === "bad" && ["warn", "bad"].includes(color(e))),
    )
    .slice(-250)
    .reverse()) {
    const tr = create("tr"),
      s = create(
        "td",
        e.status ||
          {
            action: "探索",
            warning: "提示",
            frame: "iframe",
            run: "环境",
            failed: "失败",
            request: "发送",
            cacheDecision: "缓存",
          }[e.kind] ||
          e.kind,
      );
    s.className = color(e);
    tr.append(
      create("td", beijingTime.format(new Date(e.time))),
      s,
      create(
        "td",
        "#" +
          e.run +
          " " +
          (e.method || "") +
          " " +
          (e.url || "") +
          " " +
          (e.message || ""),
      ),
    );
    if (e.diagnostic) {
      const a = create("a"," 查看诊断图"); a.href = "/reports/"+currentId+"/"+e.diagnostic; a.target = "_blank"; tr.lastElementChild.append(a);
    }
    fragment.append(tr);
  }
  $("events").replaceChildren(fragment);
}
let viewedReport = "";
async function report(id) {
  viewedReport = id;
  const root = "/reports/" + id + "/",
    j = await api(root + "report.json"),
    box = $("report");
  if (viewedReport !== id) return;
  box.replaceChildren();
  const links = [
    ["完整 JSON", "report.json"],
    ["逐请求日志", "events.ndjson"],
  ];
  for (const [label, file] of links) {
    const a = create("a", label);
    a.href = root + file;
    a.download = file;
    box.append(a, "　");
  }
  box.append(
    create(
      "p",
      "GET 200 去重资源 " +
        j.resources.length +
        " 个 · 异常请求 " +
        j.errors +
        " 次",
    ),
  );
  for (const group of j.pathGroups || []) {
    const detail = create("details");
    detail.append(create("summary", (j.primaryVariable || "环境") + "=" + group.value + " · " + group.paths.length + " 条探索记录"));
    for (const p of group.paths) {
      const legacy = p.status ? (p.status === "valid" ? "有效 · " : "无效 · ") : "";
      detail.append(create("div", legacy + p.steps.map(s => s.name).join(" → ")));
    }
    box.append(detail);
  }
  for (const r of j.runs) {
    const p = create(
      "p",
      "#" +
        r.run +
        " " +
        [r.phase, r.label].filter(Boolean).join(" · ") +
        " · " +
        r.status +
        " · " +
        (r.error || (r.replayedPaths === undefined ? "探索点击 " + r.clicks : "成功试播或重放 " + r.replayedPaths + " 条") + " / 子页面导航 " + r.frames),
    );
    if (r.screenshot) {
      const a = create("a", " 截图");
      a.href = root + r.screenshot;
      a.target = "_blank";
      p.append(a);
    }
    for (const d of r.diagnostics || []) {
      const a = create("a"," 匹配诊断图"); a.href = root+d.file; a.target = "_blank"; a.title = d.message; p.append(a);
    }
    box.append(p);
  }
  const list = create("details");
  list.append(create("summary", "成功资源清单（" + j.resources.length + "）"));
  for (const s of j.resources)
    list.append(create("div", s.sources.join(", ") + " · " + s.url));
  box.append(list);
}
function reportBoxes() {
  return [...$("history").querySelectorAll("input:checked")];
}
function updateSelection() {
  const count = reportBoxes().length;
  const total = $("history").querySelectorAll("input").length;
  $("selectAll").checked = count > 0 && count === total;
  $("selectAll").indeterminate = count > 0 && count < total;
  $("deleteReports").disabled = !count;
  $("deleteReports").textContent = "删除所选报告" + (count ? "（" + count + "）" : "");
}
async function removeSelected() {
  const ids = reportBoxes().map(box => box.value);
  if (!ids.length || !confirm("永久删除所选的 " + ids.length + " 份报告及其日志和截图？")) return;
  try {
    await api("/api/history/delete", { ids });
  } finally {
    await history();
  }
}
async function history() {
  const ids = await api("/api/history");
  const checked = new Set(reportBoxes().map(box => box.value));
  if (viewedReport && !ids.includes(viewedReport)) {
    viewedReport = "";
    $("report").replaceChildren();
  }
  $("history").replaceChildren();
  for (const id of ids) {
    const iso = id.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
    const date = new Date(iso);
    const label = Number.isNaN(date.getTime()) ? id : date.toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai", hour12: false,
    }) + " 北京时间";
    const b = create("button", label);
    b.className = "secondary";
    b.onclick = () => report(id).catch(show);
    const row = create("div"), box = create("input");
    row.className = "historyRow";
    box.type = "checkbox";
    box.setAttribute("aria-label", "选择 " + label);
    box.value = id;
    box.checked = checked.has(id);
    row.append(box, b);
    $("history").append(row);
  }
  $("reportTools").hidden = !ids.length;
  updateSelection();
  if (!ids.length) $("history").textContent = "暂无已完成任务";
  return ids;
}
function show(e) {
  if ($("err")) $("err").textContent = e.message;
}
const previewCards = new Map();
async function refreshFrame(card, key) {
  card.busy = true;
  let url;
  try {
    const response = await fetch(key, {signal:card.controller.signal});
    if (response.status !== 200) return;
    url = URL.createObjectURL(await response.blob());
    const img = new Image();
    img.alt = card.caption.textContent;
    img.src = url;
    await img.decode();
    if (card.controller.signal.aborted) return;
    card.time = Number(response.headers.get("X-Frame-Time"));
    card.frame.replaceChildren(img);
    if (card.url) URL.revokeObjectURL(card.url);
    card.url = url;
    url = null;
  } catch {
    // The next poll retries while the environment is active.
  } finally {
    if (url) URL.revokeObjectURL(url);
    card.next = Date.now() + 1000;
    card.busy = false;
  }
}
function updatePreview(job) {
  const running = job?.status === "running";
  $("preview").hidden = !running;
  const live = new Set();
  if (running && $("preview").open && !document.hidden) {
    for (const instance of job.instances || []) {
      const key = "/api/preview?job=" + job.id + "&run=" + instance.run;
      live.add(key);
      let card = previewCards.get(key);
      if (!card) {
        const el = create("figure"), caption = create("figcaption", "#" + instance.run + " · " + instance.title);
        const frame = create("div", "等待窗口画面…");
        el.append(caption,frame);
        $("screens").append(el);
        card = {el,caption,frame,controller:new AbortController(),next:0};
        previewCards.set(key,card);
      }
      if (card.time) card.caption.textContent = "#" + instance.run + " · " + instance.title + " · 画面距今 " + Math.max(0,Math.floor((Date.now()-card.time)/1000)) + " 秒";
      if (!card.busy && Date.now() >= card.next) refreshFrame(card,key);
    }
  }
  for (const [key,card] of previewCards) {
    if (live.has(key)) continue;
    card.controller.abort();
    if (card.url) URL.revokeObjectURL(card.url);
    card.el.remove();
    previewCards.delete(key);
  }
}
let manualToken;
function renderManual(job) {
  const m = job?.manual;
  $("manual").hidden = !m;
  if (!m) { manualToken = null; return; }
  $("manualTitle").textContent = job.paths.groupLabel + " · 手动录入";
  $("manualNote").textContent = m.note || "可先在下方实时预览中观察游戏。点击“录入当前画面”接管当前游戏，也可跳过此游戏。";
  if (manualToken === m.token) return;
  manualToken = m.token;
  const controls = $("manualControls");
  controls.replaceChildren();
  function button(label, action, index) {
    const b = create("button", label);
    b.onclick = async () => {
      if (action === "record" || action === "reopen") {
        const windowRef = window.open("/record.html#" + (m.session || m.token), "GameTrailRecorder", "popup,width=1060,height=760");
        if (!windowRef) { show(Error("请允许本站打开录制窗口")); return; }
        windowRef.focus();
        if (action === "reopen") return;
      }
      for (const el of controls.children) el.disabled = true;
      try { await api("/api/manual", {token:m.token, action, index}); }
      catch (e) { manualToken = null; show(e); }
    };
    controls.append(b);
  }
  if (m.allowed.includes("record")) button("录入当前画面", "record");
  if (m.session) button("打开录制窗口", "reopen");
  if (m.allowed.includes("rerecord")) button("从入口重新录制", "rerecord");
  if (m.allowed.includes("reset")) button("重新预览入口", "reset");
  if (m.allowed.includes("trial")) m.paths.forEach((name,i) => button("从入口试播 · " + name, "trial", i));
  if (m.allowed.includes("finish")) button("结束录制并验证", "finish");
  if (m.allowed.includes("discard")) button("放弃这条路径", "discard");
  if (m.allowed.includes("done")) button(m.paths.length ? "录入完毕，继续" : "跳过此游戏", "done");
}
let replayViewKey = "";
async function editRerun(task) {
  const saved = await api("/api/replays/config?id=" + encodeURIComponent(task.id));
  const dialog = $("rerunDialog"), fields = $("rerunFields");
  fields.replaceChildren();
  $("rerunName").textContent = task.name;
  $("rerunHint").textContent = (saved.primaryVariable
    ? "按 " + saved.primaryVariable + " 复用已录路径。"
    : "按原变量组合和机型复用已录路径。") + "没有对应路径的环境只加载入口。开始后将重置此任务的进度。";
  $("rerunError").textContent = "";
  const keys = new Set([...saved.template.matchAll(/\{([\w-]+)\}/g)].map(match => match[1]));
  for (const key of new Set([...(saved.variableOrder ?? Object.keys(saved.variables)), ...keys])) {
    if (!keys.has(key)) continue;
    const label = create("label", key), input = create("textarea");
    input.name = key;
    input.rows = 3;
    input.required = true;
    input.value = saved.variables[key].join("\n");
    label.append(create("small", "每行一个值"), input);
    fields.append(label);
  }
  $("rerunCancel").onclick = () => dialog.close();
  $("rerunForm").onsubmit = async event => {
    event.preventDefault();
    const variables = {...saved.variables};
    for (const field of fields.querySelectorAll("textarea")) {
      if (field.value !== saved.variables[field.name].join("\n"))
        variables[field.name] = field.value.split("\n").map(value => value.trim()).filter(Boolean);
    }
    $("rerunStart").disabled = true;
    try {
      await api("/api/replays/start", {id:task.id, mode:"all", variables, replayConcurrency:replayConcurrency()});
      replayViewKey = "";
      dialog.close();
    } catch (e) {
      $("rerunError").textContent = e.message;
    } finally {
      $("rerunStart").disabled = false;
    }
  };
  dialog.showModal();
}
const replayBoxes = () => [...$("replays").querySelectorAll("input:enabled")];
function replaySelection() {
  const boxes = replayBoxes(), count = boxes.filter(box => box.checked).length;
  $("allReplays").checked = count > 0 && count === boxes.length;
  $("allReplays").indeterminate = count > 0 && count < boxes.length;
  $("deleteReplays").disabled = !count;
}
async function refreshReplays(job) {
  const tasks = await api("/api/replays");
  const checked = new Set(replayBoxes().filter(box => box.checked).map(box => box.value));
  const list = $("replays");
  list.replaceChildren();
  $("replayTools").hidden = !tasks.length;
  if (!tasks.length) list.textContent = "暂无已保存的重放任务";
  for (const task of tasks) {
    const row = create("div"), box = create("input");
    row.className = "historyRow replayRow";
    box.type = "checkbox";
    box.value = task.id;
    box.setAttribute("aria-label", "选择 " + task.name);
    const running = job?.status === "running";
    box.disabled = running && job.replayId === task.id;
    box.checked = !box.disabled && checked.has(task.id);
    const progress = task.rowIndex === task.total ? "已全部重放" :
      "下次从环境 " + (task.rowIndex+1) + " / " + task.total + " 的路径 " + (task.pathIndex+1) + " 开始";
    row.append(box, create("span", task.name + " · " + progress));
    function button(label, disabled, action) {
      const el = create("button", label);
      el.className = "secondary";
      el.disabled = disabled;
      el.onclick = () => action().catch(show);
      row.append(el);
    }
    for (const [mode,label] of [["continue","继续重放"],["all","全量重跑"]]) {
      button(label, running || (mode === "continue" && task.rowIndex === task.total), async () => {
        if (mode === "all") return editRerun(task);
        await api("/api/replays/start", {id:task.id, mode, replayConcurrency:replayConcurrency()});
        replayViewKey = "";
      });
    }
    button("重命名", false, async () => {
      const name = prompt("重放任务名称", task.name);
      if (name !== null) await api("/api/replays/rename", {id:task.id, name});
    });
    list.append(row);
  }
  replaySelection();
}
async function poll() {
  try {
    const { job: j, cache: c, replayRevision } = await api("/api/state?after=" + seq);
    $("usage").textContent =
      (c.bytes / 1048576).toFixed(1) +
      " MiB / " +
      (c.cap / 1073741824).toFixed(2) +
      " GiB · " +
      c.entries +
      " 个文件";
    if (!$("cap").dataset.ready) {
      $("cap").value = c.cap / 1073741824;
      $("cap").dataset.ready = "1";
    }
    const key = replayRevision + "/" + (j?.status ?? "");
    if (key !== replayViewKey) {
      await refreshReplays(j);
      replayViewKey = key;
    }
    updatePreview(j);
    renderManual(j);
    if (j) {
      if (currentId !== j.id) {
        currentId = j.id;
        seq = 0;
        recent = [];
      }
      if (j.events.length) {
        seq = j.events.at(-1).seq;
        recent.push(...j.events);
        recent = recent.slice(-1500);
        render();
      }
      $("done").textContent = j.done + " / " + j.total;
      $("success").textContent = j.success;
      $("errors").textContent = j.errors;
      $("hits").textContent = j.cacheHits;
      $("active").textContent = j.active || "本次运行已结束";
      $("paths").textContent = j.paths ? j.paths.groupLabel + " · " + j.paths.phaseLabel + " · 已记录 " + j.paths.count + " 条路径" + (j.paths.activity ? " · " + j.paths.activity : "") : "";
      $("status").textContent = {
        running: "运行中",
        complete: "已完成",
        cancelled: "已取消",
        partial: "完成 · 有异常",
      }[j.status];
      $("progress").max = j.total;
      $("progress").value = j.done;
      $("stop").disabled = j.status !== "running";
      $("start").disabled = j.status === "running";
      if (j.status !== lastStatus && j.status !== "running") {
        const ids = await history();
        if (ids.includes(j.id)) await report(j.id);
      }
      lastStatus = j.status;
    }
  } catch (e) {
    show(e);
  } finally {
    if ($("status")) setTimeout(poll, 600);
  }
}
async function init() {
  const data = await api("/api/config");
  $("version").textContent = "v" + data.version;
  $("history").onchange = updateSelection;
  $("selectAll").onchange = () => {
    for (const box of $("history").querySelectorAll("input")) box.checked = $("selectAll").checked;
    updateSelection();
  };
  $("deleteReports").onclick = () => removeSelected().catch(show);
  $("replays").onchange = replaySelection;
  $("allReplays").onchange = () => {
    for (const box of replayBoxes()) box.checked = $("allReplays").checked;
    replaySelection();
  };
  $("deleteReplays").onclick = async () => {
    const ids = replayBoxes().filter(box => box.checked).map(box => box.value);
    if (ids.length && confirm("删除所选的 " + ids.length + " 个重放任务？历史报告会保留。")) {
      try { await api("/api/replays/delete", {ids}); } catch (e) { show(e); }
    }
  };
  presets = data.presets;
  const s = data.settings;
  for (const k of ["template", "waitSeconds", "quietSeconds", "pixelTimeout", "pixelSimilarity", "actions"])
    $(k).value = s[k] ?? (k === "quietSeconds" ? 1 : "");
  $("variables").value = [...new Set([...(s.variableOrder ?? []), ...Object.keys(s.variables)])]
    .filter(k => Object.hasOwn(s.variables,k)).map(k => k + "=" + s.variables[k].join(","))
    .join("\n");
  $("primaryVariable").value = s.primaryVariable ?? (s.template.includes("{gameId}") ? "gameId" : "");
  $("custom").value = JSON.stringify(s.custom, null, 2);
  $("explore").checked = s.explore;
  $("exploreMode").value = s.exploreMode || "manual";
  $("replayConcurrency").value = s.replayConcurrency ?? "";
  devices(s.selected);
  $("custom").onchange = () => {
    try {
      devices(selected());
      estimate();
    } catch (e) {
      show(e);
    }
  };
  $("form").oninput = estimate;
  $("form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      $("err").textContent = "";
      await api("/api/start", config());
      seq = 0;
      recent = [];
      lastStatus = "";
      $("start").disabled = true;
    } catch (e) {
      show(e);
    }
  };
  $("stop").onclick = () => api("/api/stop", {}).catch(show);
  $("save").onclick = () =>
    api("/api/cache", {
      cap: Math.round(Number($("cap").value) * 1073741824),
    }).catch(show);
  $("clear").onclick = () => api("/api/cache", { clear: true }).catch(show);
  $("filter").onchange = render;
  $("quit").onclick = async () => {
    try {
      await api("/api/quit", {});
      document.body.replaceChildren(
        create("main", "GameTrail 已退出，可以关闭此页。"),
      );
    } catch (e) {
      show(e);
    }
  };
  await estimate();
  await history();
  await poll();
}
init().catch(show);
