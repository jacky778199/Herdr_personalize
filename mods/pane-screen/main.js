// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane-screen" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, terminals, props, run, theme, home, shared, setShared, spaces, openOverlay, focused, window, appHome, readTextFile, writeTextFile, nextCommand, notify, hc } from "herdr";
import { fetchAgentTaskFlow } from "./transcript.js";

let pasteSeen = 0;

function flushPendingPaste() {
  const job = shared("task-notes.pending-paste");
  if (!job?.terminal || !job.at) return;
  if (Date.now() - job.at > 2000) {
    setShared("task-notes.pending-paste", null);
    return;
  }
  if (pasteSeen === job.at) return;
  if (focused()?.terminal !== job.terminal) {
    run("pane.focus", { terminal: job.terminal });
    return;
  }
  pasteSeen = job.at;
  setShared("task-notes.pending-paste", null);
  run("terminal.paste");
}

let pasteChain = 0;

// Runs only while a paste is queued. setShared re-renders this header, which arms it.
function kickPaste(cx) {
  const job = shared("task-notes.pending-paste");
  if (!job?.terminal || !job.at || pasteChain === job.at) return;
  pasteChain = job.at;
  const step = (cx) => {
    const current = shared("task-notes.pending-paste");
    if (!current?.at || current.at !== job.at) {
      if (pasteChain === job.at) pasteChain = 0;
      return;
    }
    if (window().active) flushPendingPaste();
    if (shared("task-notes.pending-paste")?.at === job.at) cx.timer.after(500, step, { owner: null });
    else if (pasteChain === job.at) pasteChain = 0;
  };
  cx.timer.after(0, step, { owner: null });
}

const SNAP_MS = 2000;
const OFF_MIRROR = () => `${appHome()}/data/auto-enter-off.json`;
const OFF_STORE = () => `${home()}/AppData/Local/herdr/plugins/user.auto-enter/disabled.json`;
let offPaneIds = new Set();
let offLoadedAt = 0;
let offWriting = 0;
let commandLoop = false;

function plainLabel(label) {
  return String(label || "pane").replace(/ ⏎關$/, "").trim() || "pane";
}

function tabName(tabId) {
  for (const space of spaces()) {
    const tab = space.tabs?.find((item) => item.id === tabId);
    if (tab) return plainLabel(tab.name);
  }
  return "pane";
}

async function readPanes(path) {
  const raw = await readTextFile(path);
  let panes = {};
  try { panes = JSON.parse(raw || "{}").panes || {}; } catch { panes = {}; }
  return { raw, panes };
}

async function toggleAutoEnter(cx, paneId, tabId) {
  if (!paneId) return;
  const { raw, panes: stored } = await readPanes(OFF_STORE());
  const turningOff = !stored[paneId];
  if (turningOff) {
    const tab = tabId || focused()?.tab;
    stored[paneId] = { tab_id: tab || "", tab_label: tab ? tabName(tab) : "pane" };
    if (tab) run("tab.rename", { id: tab, name: `${stored[paneId].tab_label} ⏎關` });
    offPaneIds.add(paneId);
  } else {
    const tab = stored[paneId]?.tab_id || tabId;
    const original = stored[paneId]?.tab_label || (tab ? tabName(tab) : "pane");
    delete stored[paneId];
    const still = Object.values(stored).some((item) => item?.tab_id === tab);
    if (tab && !still) run("tab.rename", { id: tab, name: original });
    offPaneIds.delete(paneId);
  }
  cx.notify();
  const text = `${JSON.stringify({ panes: stored }, null, 2)}\n`;
  offWriting++;
  try {
    await writeTextFile(OFF_STORE(), text, raw);
    const mirror = await readPanes(OFF_MIRROR());
    await writeTextFile(OFF_MIRROR(), text, mirror.raw);
    notify({
      title: turningOff ? "⏎ 已關閉" : "⏎ 已開啟",
      body: turningOff ? "這個 pane 不再自動按 Enter" : "這個 pane 恢復自動按 Enter",
      timeout: 2500,
    });
  } catch (e) {
    if (turningOff) offPaneIds.delete(paneId);
    else offPaneIds.add(paneId);
    cx.notify();
    notify({ title: "⏎ 切換失敗", body: String(e?.message || e), timeout: 3000 });
  } finally {
    offWriting--;
  }
}

function ensureCommandLoop(cx) {
  if (commandLoop) return;
  commandLoop = true;
  cx.spawn(async (cx) => {
    for (;;) {
      const cmd = await nextCommand();
      if (cmd !== "toggle-auto-enter") continue;
      const f = focused();
      await toggleAutoEnter(cx, f?.pane, f?.tab);
    }
  });
}

const AUTO_ENTER_MS = 4000;
const AUTO_ENTER_COOLDOWN_MS = 3000;
let autoEnterLoop = false;
let autoEnterBusy = false;
const autoEnterState = new Map();

function promptKey(text) {
  const lines = String(text || "")
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const bottom = lines.slice(-8).join("\n");
  if (!bottom) return null;
  const joined = bottom.replace(/[\r\n]/g, "");
  const rules = [
    [/allow search\s*\(y\)/i, "Allow search (y)"],
    [/process\s*\(y\)/i, "process (y)"],
    [/run\s*\(once\)\s*\(y\)/i, "Run (once) (y)"],
    [/proceed\s*\(y\)/i, "Proceed (y)"],
    [/\(y\)\s*\(enter\)/i, "(y) (enter)"],
  ];
  for (const [re, label] of rules) {
    if (re.test(bottom) || re.test(joined)) return { label, seen: joined.slice(-220) };
  }
  return null;
}

const AGENT_PANE = /Cursor Agent|🔐|❓|Waiting for confirmation|Waiting for approval|Waiting for you|⏳|\bWorking\b/i;

function autoEnterTarget(p) {
  if (!p?.terminal || !p.pane || offPaneIds.has(p.pane)) return false;
  if (p.program?.agent) return true;
  return AGENT_PANE.test(p.title || "");
}

async function pollAutoEnter() {
  const targets = [];
  for (const p of panes()) {
    if (autoEnterTarget(p)) targets.push(p);
  }
  const now = Date.now();
  for (const p of targets) {
    let read;
    try { read = await hc(["read", p.terminal, "--lines", "30"]); } catch { continue; }
    if (read?.code && read.code !== 0) continue;
    const hit = promptKey(read?.stdout || "");
    const prev = autoEnterState.get(p.pane) || { seen: "", retries: 0, lastSent: 0 };
    if (!hit) {
      autoEnterState.set(p.pane, { seen: "", retries: 0, lastSent: prev.lastSent });
      continue;
    }
    const retry = prev.seen === hit.seen && prev.seen !== "";
    if (retry && prev.retries >= 1) continue;
    if (now - prev.lastSent < AUTO_ENTER_COOLDOWN_MS) continue;
    try {
      const sent = await hc(["send", p.terminal, "y\r"]);
      if (sent?.code && sent.code !== 0) continue;
    } catch { continue; }
    autoEnterState.set(p.pane, { seen: hit.seen, retries: retry ? 1 : 0, lastSent: Date.now() });
    notify({ title: "⏎ 已按下", body: hit.label, timeout: 1600 });
  }
}

function ensureAutoEnterLoop(cx) {
  if (autoEnterLoop) return;
  autoEnterLoop = true;
  cx.timer.every(AUTO_ENTER_MS, (cx) => {
    if (autoEnterBusy) return;
    autoEnterBusy = true;
    cx.spawn(async () => {
      try { await pollAutoEnter(); } finally { autoEnterBusy = false; }
    });
  }, { owner: null });
}

function scheduleOffPanes(cx) {
  const now = Date.now();
  if (now - offLoadedAt < SNAP_MS || offWriting) return;
  offLoadedAt = now;
  cx.spawn(async (cx) => {
    if (offWriting) return;
    let raw = null;
    try { raw = await readTextFile(OFF_MIRROR()); } catch { raw = null; }
    const next = new Set();
    try {
      const data = JSON.parse(raw || "{}");
      for (const paneId of Object.keys(data.panes || {})) next.add(paneId);
    } catch { return; }
    let same = next.size === offPaneIds.size;
    if (same) for (const id of next) if (!offPaneIds.has(id)) same = false;
    offPaneIds = next;
    if (!same) cx.notify();
  });
}
const TERM_MS = 8000;
let snap = null;
let snapAt = 0;
let termCache = { at: 0, termByAddr: new Map(), sessionStats: null };

// Titles refresh every 2s. The heavier terminal list and session stats refresh every 8s.
// render() reads the result and does not call panes(), terminals(), spaces(), or shared().
function world() {
  const now = Date.now();
  if (snap && now - snapAt < SNAP_MS) return snap;
  snapAt = now;
  if (!termCache.at || now - termCache.at >= TERM_MS) {
    const termByAddr = new Map();
    for (const t of terminals()) termByAddr.set(t.address, t);
    termCache = { at: now, termByAddr, sessionStats: shared("cursor.sessionStats") };
  }
  const paneById = new Map();
  for (const p of panes()) paneById.set(p.pane, p);
  const tabById = new Map();
  let activeSpace = null;
  for (const s of spaces()) {
    if (s.active) activeSpace = s;
    for (const tb of s.tabs ?? []) tabById.set(tb.id, tb);
  }
  snap = {
    paneById,
    tabById,
    termByAddr: termCache.termByAddr,
    activeSpace,
    sessionStats: termCache.sessionStats,
    screenByTerminal: shared("screen-status.by-terminal") ?? {},
  };
  return snap;
}

function statusOf(p, screenByTerminal) {
  if (!p) return null;
  if (p.status) return p.status;
  if (p.terminal) return screenByTerminal[p.terminal] ?? null;
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

function cleanTitleForMatch(s) {
  return String(s ?? "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/\s*[-–—]\s*(?:[⏳⌨️🧭📝📂📤🔄📋🔐❓✅]|Working|Ready|Waiting|Running|Planning|Reviewing).*$/i, "")
    .trim()
    .toLowerCase();
}

function matchPaneSession(p, tab, cleanPrompt, w) {
  const sessionStats = w.sessionStats;
  if (!sessionStats || !p?.terminal) return null;

  const tm = w.termByAddr.get(p.terminal);
  const argv = [...(tm?.argv ?? []), ...(tm?.foreground?.argv ?? [])].join(" ");
  const idHit = argv.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  let s = idHit ? sessionStats.by_id?.[idHit[0]] : null;

  if (!s && sessionStats.by_title) {
    const candidates = [
      cleanTitleForMatch(p.title),
      cleanTitleForMatch(tab?.name),
      cleanTitleForMatch(cleanPrompt),
    ].filter((x) => x.length >= 2);

    for (const key of candidates) {
      if (sessionStats.by_title[key]) { s = sessionStats.by_title[key]; break; }
    }
    if (!s) {
      for (const key of candidates) {
        if (key.length < 4) continue;
        const entry = Object.entries(sessionStats.by_title).find(([tk]) => tk.includes(key) || key.includes(tk));
        if (entry) { s = entry[1]; break; }
      }
    }
  }

  if (!s) return null;
  const modelLabel = s.short_model || s.model;
  return {
    text: modelLabel ? `${modelLabel} · ${s.cost_str}` : s.cost_str,
    cents: s.cents || 0,
    tip: `模型: ${s.model || "unknown"}\n今日花費: ${s.cost_str} (${s.calls} calls)\n對話: ${s.title}\n點擊開啟 Cursor 用量面板`,
  };
}

function deriveHeader(p, taskFlow, w) {
  if (!p) return null;
  const tab = w.tabById.get(p.tab) ?? null;
  const st = statusOf(p, w.screenByTerminal);
  const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
  const latestTask = st ? taskFlow?.tasks?.[taskFlow.tasks.length - 1] : null;
  const rawPrompt = latestTask?.prompt ? latestTask.prompt.replace(/[\b\x08]+/g, "").trim() : "";
  let cleanPrompt = rawPrompt;
  if (!cleanPrompt && p.title && st) {
    const clean = p.title.replace(/\s*[-–—]\s*(?:[⏳⌨️🧭📝📂📤🔄📋🔐❓✅]|Working|Ready|Waiting|Running|Planning|Reviewing).*$/i, "").trim();
    if (clean && !/^(?:pwsh|powershell|bash|sh|cmd)(?:\.exe)?$/i.test(clean) && !clean.includes("Cursor Agent")) {
      cleanPrompt = clean;
    }
  }
  const taskTitle = cleanPrompt
    ? (cleanPrompt.length > 25 ? cleanPrompt.slice(0, 24) + "…" : cleanPrompt)
    : null;
  const sess = matchPaneSession(p, tab, cleanPrompt, w);
  const data = {
    pane: p.pane,
    terminal: p.terminal || null,
    title: p.title || "",
    cwd: p.cwd,
    folder: folder(p.cwd),
    zoomed: !!p.zoomed,
    tab: p.tab,
    name,
    icon: p.program?.icon ?? null,
    tint: !!p.program?.tint,
    tabIndex: tab?.index ?? null,
    status: st,
    taskTitle,
  };
  const sig = [
    data.pane, data.terminal, data.title, data.cwd, data.zoomed, data.name,
    data.icon, data.tint, data.tabIndex, data.status, data.taskTitle,
    sess?.text ?? "", sess?.cents ?? 0,
  ].join("\u0001");
  return { data, sess, sig };
}

export default class Pane extends View {
  init(_props, cx) {
    this.hovered = false;
    this.taskFlow = null;
    this.lastFetched = 0;
    this.fetching = false;

    this.paneData = null;
    this.sess = null;
    this.sig = "";
    ensureCommandLoop(cx);
    ensureAutoEnterLoop(cx);
    cx.timer.after(500, (cx) => {
      cx.timer.every(SNAP_MS, (cx) => { this.refreshHeader(cx); scheduleOffPanes(cx); });
    });
    this.refreshHeader(cx, true);
    scheduleOffPanes(cx);
    let lastFetchedTitle = "";
    // Agent 狀態才抓任務歷程。避免高頻開進程，標題變更或每 60 秒才抓一次。
    cx.timer.every(30000, async (cx) => {
      if (this.fetching || !window().active) return;
      const w = world();
      const p = w.paneById.get(props()?.pane);
      if (!p?.terminal) return;
      const isVisibleTab = w.activeSpace?.tabs?.some((t) => t.active && t.id === p.tab);
      if (!isVisibleTab) return;
      const st = statusOf(p, w.screenByTerminal);
      if (!st) {
        if (this.taskFlow !== null) {
          this.taskFlow = null;
          this.refreshHeader(cx);
        }
        return;
      }
      const curTitle = p.title || "";
      const now = Date.now();
      if (curTitle === lastFetchedTitle && (now - this.lastFetched) < 60000) {
        return;
      }
      this.fetching = true;
      try {
        const flow = await fetchAgentTaskFlow(p.terminal, p.cwd, p.title, st);
        lastFetchedTitle = curTitle;
        this.lastFetched = now;
        if (flow && JSON.stringify(flow) !== JSON.stringify(this.taskFlow)) {
          this.taskFlow = flow;
          this.refreshHeader(cx);
        }
      } finally {
        this.fetching = false;
      }
    });
  }

  refreshHeader(cx, force) {
    if (!force && !window().active) return;
    const w = world();
    const next = deriveHeader(w.paneById.get(props()?.pane), this.taskFlow, w);
    const sig = next?.sig ?? "";
    if (sig === this.sig) return;
    this.sig = sig;
    this.paneData = next?.data ?? null;
    this.sess = next?.sess ?? null;
    cx?.notify();
  }

  openFlowPopup(p, e, cx) {
    cx.stop_propagation();
    const st = p.status;
    openOverlay({
      mod: "task-flow",
      kind: "dialog",
      width: 0.88,
      height: 0.94,
      props: {
        terminal: p.terminal,
        cwd: p.cwd,
        title: p.title,
        status: st,
        flow: this.taskFlow,
      },
    });
  }

  openNotesPopup(p, e, cx) {
    cx.stop_propagation();
    openOverlay({
      mod: "task-notes",
      kind: "popup",
      key: `task-notes:${p.terminal || "none"}`,
      width: 640,
      height: 520,
      props: {
        terminal: p.terminal,
        cwd: p.cwd,
      },
    });
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane-screen/${icon}.svg`).size(14));
  }

  autoEnterButton(t, p) {
    const off = offPaneIds.has(p.pane);
    const tone = off ? t.blocked : t.done;
    return h_flex()
      .id(`ph-ae-${p.pane}`)
      .flex_none()
      .px(6)
      .py(1.5)
      .rounded(4)
      .gap(4)
      .items_center()
      .bg(tone + "14")
      .border(1)
      .border_color(tone + "33")
      .cursor_pointer()
      .hover((s) => s.bg(tone + "24"))
      .tooltip(off ? "Auto Enter 已關閉，點一下開啟（Ctrl+Shift+Enter）" : "Auto Enter 開啟中，點一下關閉（Ctrl+Shift+Enter）")
      .on_click((e, cx) => {
        e.stop_propagation?.();
        cx.stop_propagation();
        cx.spawn(async (cx) => { await toggleAutoEnter(cx, p.pane, p.tab); });
      })
      .child(div().text_size(11).font_medium().text_color(tone + "b3").child(off ? "⏎關" : "⏎開"));
  }

  render(cx) {
    kickPaste(cx);
    const t = theme();
    const p = this.paneData;
    if (!p) return div();
    const name = p.name;
    const pic = p.icon ? icon({ icon: p.icon, tint: p.tint }, 14, t.dim) : null;
    const st = p.status;
    const pane = p.pane;
    const tabIndex = p.tabIndex;
    const taskTitle = p.taskTitle;
    const sess = this.sess;

    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(200).font_medium().text_color(t.foreground).child(name))
      .child(this.autoEnterButton(t, p))
      .when(tabIndex != null, (el) => el.child(
        div()
          .flex_none()
          .px(4)
          .py(1)
          .rounded(3)
          .bg(t.chrome)
          .text_size(10.5)
          .text_color(t.dim)
          .child(`#${tabIndex}`)
      ))
      .when(Boolean(p.terminal), (el) => el.child(
        div()
          .flex_none()
          .px(6)
          .py(1.5)
          .rounded(4)
          .bg(t.raised)
          .border(1)
          .border_color(t.border)
          .text_size(12.5)
          .font_semibold()
          .text_color(t.foreground)
          .child(p.terminal)
      ))
      .when(Boolean(taskTitle), (el) => el.child(
        h_flex()
          .flex_none()
          .px(7)
          .py(1.5)
          .rounded(4)
          .gap(4)
          .items_center()
          .bg(t.raised)
          .border(1)
          .border_color(t.border)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((e, cx) => this.openFlowPopup(p, e, cx))
          .child(
            div()
              .text_size(11)
              .font_medium()
              .text_color(st === "working" ? t.working : t.dim)
              .child(st === "working" ? "⚡" : "📋")
          )
          .child(
            div()
              .max_w(160)
              .truncate()
              .text_size(11)
              .font_medium()
              .text_color(t.foreground)
              .child(taskTitle)
          )
          .child(
            div()
              .text_size(9)
              .text_color(t.dim)
              .child("▾")
          )
      ))
      // Task 小筆記按鈕
      .when(Boolean(p.terminal), (el) => el.child(
        h_flex()
          .flex_none()
          .px(6)
          .py(1.5)
          .rounded(4)
          .gap(4)
          .items_center()
          .bg(t.raised)
          .border(1)
          .border_color(t.border)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((e, cx) => this.openNotesPopup(p, e, cx))
          .child(div().text_size(11).child("📝"))
          .child(div().text_size(11).font_medium().text_color(t.foreground).child("小筆記"))
      ))
      .when(Boolean(sess), (el) => el.child(
        div()
          .id(`pane-sess-${pane}`)
          .flex_none()
          .px(6)
          .py(1.5)
          .rounded(4)
          .bg(t.chrome)
          .border(1)
          .border_color(t.border)
          .text_size(10.5)
          .font_medium()
          .text_color(sess.cents >= 100 ? (t.ansi3 ?? "#f59e0b") : t.muted)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(sess.tip)
          .on_click((_e, cx) => {
            cx.stop_propagation();
            run("layout.show", { id: "panel" });
            run("layout.select", { id: "panel-body", child: "usage" });
          })
          .child(sess.text)
      ))
      .child(div().flex_1().truncate().text_color(t.dim).child(p.folder))
      .when(st === "working", el => el.child(div().size(7).flex_none().rounded(4).bg(t.working)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
