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
function config() {
  const variables = {};
  for (const line of $("variables")
    .value.split("\n")
    .filter((x) => x.trim())) {
    const eq = line.indexOf("=");
    if (eq < 1) throw Error("变量格式示例：lang=zh-CN,en-US");
    variables[line.slice(0, eq).trim()] = line
      .slice(eq + 1)
      .split(/[,，]/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return {
    template: $("template").value.trim(),
    variables,
    selected: selected(),
    custom: JSON.parse($("custom").value || "[]"),
    explore: $("explore").checked,
    labels: $("labels")
      .value.split(/[,，]/)
      .map((v) => v.trim())
      .filter(Boolean),
    ...Object.fromEntries(
      ["waitSeconds", "actions", "extraGets"].map((k) => [
        k,
        Number($(k).value),
      ]),
    ),
  };
}
async function estimate() {
  const n = ++estimateId;
  try {
    const { total } = await api("/api/plan", config());
    if (n === estimateId)
      $("estimate").textContent = "预计运行 " + total + " 个环境";
  } catch (e) {
    if (n === estimateId) $("estimate").textContent = e.message;
  }
}
function color(e) {
  if (e.kind === "failed" || e.status >= 400) return "bad";
  if (e.kind === "warning" || e.status >= 300) return "warn";
  return e.status === 200 ? "good" : "info";
}
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
          }[e.kind] ||
          e.kind,
      );
    s.className = color(e);
    tr.append(
      create("td", e.time.slice(11, 19) + "Z"),
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
    fragment.append(tr);
  }
  $("events").replaceChildren(fragment);
}
async function report(id) {
  const root = "/reports/" + id + "/",
    j = await api(root + "report.json"),
    box = $("report");
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
  for (const r of j.runs) {
    const p = create(
      "p",
      "#" +
        r.run +
        " " +
        r.label +
        " · " +
        r.status +
        " · " +
        (r.error || "探索点击 " + r.clicks + " / 子页面导航 " + r.frames),
    );
    if (r.screenshot) {
      const a = create("a", " 截图");
      a.href = root + r.screenshot;
      a.target = "_blank";
      p.append(a);
    }
    box.append(p);
  }
  const list = create("details");
  list.append(create("summary", "成功资源清单（" + j.resources.length + "）"));
  for (const s of j.resources)
    list.append(create("div", s.sources.join(", ") + " · " + s.url));
  box.append(list);
}
async function history() {
  const ids = await api("/api/history");
  $("history").replaceChildren();
  for (const id of ids) {
    const b = create("button", id.slice(0, 19).replace("T", " ") + " UTC");
    b.className = "secondary";
    b.onclick = () => report(id).catch(show);
    $("history").append(b);
  }
  if (!ids.length) $("history").textContent = "暂无已完成任务";
}
function show(e) {
  if ($("err")) $("err").textContent = e.message;
}
async function poll() {
  try {
    const { job: j, cache: c } = await api("/api/state?after=" + seq);
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
        await history();
        await report(j.id);
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
  presets = data.presets;
  const s = data.settings;
  for (const k of ["template", "waitSeconds", "actions", "extraGets"])
    $(k).value = s[k];
  $("variables").value = Object.entries(s.variables)
    .map(([k, v]) => k + "=" + v.join(","))
    .join("\n");
  $("labels").value = (s.labels || []).join(", ");
  $("custom").value = JSON.stringify(s.custom, null, 2);
  $("explore").checked = s.explore;
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
