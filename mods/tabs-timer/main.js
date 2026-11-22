import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, layout, settings, appHome, readTextFile } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function formatWorkingSince(since) {
  const totalMin = Math.max(0, Math.floor((Date.now() - since) / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

const SNAP_MS = 2000;
const OFF_SUFFIX = " ⏎關";
let offTabIds = new Set();
let offLoadedAt = 0;

function scheduleOffTabs(cx) {
  const now = Date.now();
  if (now - offLoadedAt < SNAP_MS) return;
  offLoadedAt = now;
  cx.spawn(async (cx) => {
    let raw = null;
    try { raw = await readTextFile(`${appHome()}/data/auto-enter-off.json`); } catch { raw = null; }
    const next = new Set();
    try {
      const data = JSON.parse(raw || "{}");
      for (const info of Object.values(data.panes || {})) {
        if (info?.tab_id) next.add(info.tab_id);
      }
    } catch { /* keep the previous set */ return; }
    let same = next.size === offTabIds.size;
    if (same) for (const id of next) if (!offTabIds.has(id)) same = false;
    offTabIds = next;
    if (!same) cx.notify();
  });
}

function tabTitle(name) {
  return name.endsWith(OFF_SUFFIX) ? name.slice(0, -OFF_SUFFIX.length) : name;
}
let tabSnap = null;
let tabSnapAt = 0;

// One copy every 2s for the tab strip. render() reads the result.
function tabWorld() {
  const now = Date.now();
  if (tabSnap && now - tabSnapAt < SNAP_MS) return tabSnap;
  tabSnapAt = now;
  const programByTab = new Map();
  for (const p of panes()) {
    if (!p.tab) continue;
    const prev = programByTab.get(p.tab);
    if (!prev || p.program?.agent) programByTab.set(p.tab, p.program ?? null);
  }
  const root = layout();
  tabSnap = {
    space: spaces().find((s) => s.active) ?? null,
    programByTab,
    coreBy: shared("core-status.by-tab") ?? {},
    coreSince: shared("core-status.working-since") ?? {},
    byTab: shared("screen-status.by-tab") ?? {},
    sinceMap: shared("screen-status.working-since") ?? {},
    panels: shared("workspace.panels"),
    root,
    sidebar: find(root, "sidebar"),
    panel: find(root, "panel"),
    body: find(root, "panel-body"),
    window: window(),
    zoom: settings().zoom,
  };
  return tabSnap;
}

function statusOfTab(tab, w) {
  if (tab.status) return tab.status;
  return w.coreBy[tab.id] || w.byTab[tab.id] || null;
}

function sinceOfTab(tab, w) {
  if (tab.working_since != null) return tab.working_since;
  if (w.coreSince[tab.id] != null) return w.coreSince[tab.id];
  return w.sinceMap[tab.id] ?? null;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    this.shown = [];
    this.tabIds = [];
    this.enabled = ["files", "changes", "git", "usage", "worklog", "note", "issue"];
    this.panelHidden = null;
    this.bodyActive = null;
    this.maximized = null;
    this.lightsPadding = 10;
    this.win = null;
    this.sig = "";
    cx.timer.every(SNAP_MS, (cx) => { this.capture(cx); scheduleOffTabs(cx); });
    this.capture(cx, true);
    scheduleOffTabs(cx);
  }

  capture(cx, force) {
    if (!force && !window().active) return;
    const w = tabWorld();
    const enabled = [...new Set([...(w.panels ?? ["files", "changes"]), "git", "usage", "worklog", "note", "issue"])];
    this.syncPanel(w.space, w.panel, w.body, enabled);
    const shown = (w.space?.tabs ?? []).map((c) => {
      const program = w.programByTab.get(c.id) ?? null;
      const st = statusOfTab(c, w);
      const since = sinceOfTab(c, w);
      return {
        id: c.id,
        name: c.name,
        index: c.index,
        active: !!c.active,
        zoomed: !!c.zoomed,
        spaceId: w.space?.id ?? null,
        program,
        st,
        label: st === "working" && since != null ? formatWorkingSince(since) : "",
      };
    });
    const sidebar = w.sidebar;
    const win = w.window;
    const lightsPadding = win?.platform === "macos" && win.titlebar === "none" && !win.fullscreen && w.root?.traffic_lights
      ? Math.max(10, (w.root.traffic_lights[0] + 64) / w.zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const hostHidden = !!w.panel?.hidden;
    const hostActive = w.body?.active ?? null;
    const hostMax = !!win?.maximized;
    const holdLocal = this.actedAt && Date.now() - this.actedAt < 2000;
    const panelHidden = holdLocal ? this.panelHidden : hostHidden;
    const bodyActive = holdLocal ? this.bodyActive : hostActive;
    const maximized = holdLocal ? this.maximized : hostMax;
    const sig = JSON.stringify(shown.map((c) => [c.id, c.name, c.index, c.active, c.zoomed, c.st, c.label, c.program?.icon ?? "", c.program?.name ?? "", c.program?.tint ? 1 : 0]))
      + `|${panelHidden ? 1 : 0}|${bodyActive ?? ""}|${maximized ? 1 : 0}|${lightsPadding}|${enabled.join(",")}|${win?.buttons ? 1 : 0}|${win?.platform ?? ""}`;
    this.panelHidden = panelHidden;
    this.bodyActive = bodyActive;
    this.maximized = maximized;
    if (sig === this.sig) return;
    this.sig = sig;
    this.shown = shown;
    this.tabIds = shown.map((c) => c.id);
    this.enabled = enabled;
    this.lightsPadding = lightsPadding;
    this.win = win;
    cx?.notify();
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) {
            if (body?.active !== want) run("layout.select", { stack: "panel-body", child: want });
            if (panel.hidden) run("layout.show", { id: "panel" });
          } else {
            run("layout.hide", { id: "panel" });
          }
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const shown = this.shown ?? [];
    const enabled = this.enabled ?? [];
    const w = this.win;
    const lightsPadding = this.lightsPadding ?? 10;
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = c.program;
      const rawName = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      const name = tabTitle(rawName);
      const autoEnterOff = rawName.endsWith(OFF_SUFFIX) || offTabIds.has(c.id);
      const st = c.st;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          const ids = this.tabIds ?? [];
          if (from !== null && from !== i && ids[from]) run("tab.move", { id: ids[from], index: ids.indexOf(c.id) + 1 });
          else if (!c.active) run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: c.spaceId } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().flex_none().w(12).text_size(9.5).text_right().text_color(c.active ? t.dim : t.dim + "99").child(String(c.index)))
        .child(div().max_w(158).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(autoEnterOff, el => el.child(div().flex_none().px(4).rounded(3).text_size(10.5).font_medium().text_color(t.blocked + "b3").child("⏎關")))
        .when(st === "working" && c.label, el => el
          .child(div().flex_none().text_size(11).text_color(t.working).child(c.label)))
        .when(st === "working" || st === "blocked" || st === "done", el => el.child(div().size(6).rounded(3).bg(t[st])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const panelButton = (id, label, icon) => {
      const on = this.panelHidden === false && this.bodyActive === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click((_e, cx) => {
          if (on) {
            this.actedAt = Date.now();
            this.panelHidden = true;
            cx.notify();
            run("layout.hide", { id: "panel" });
          } else {
            const wasHidden = this.panelHidden !== false;
            const wasActive = this.bodyActive;
            this.actedAt = Date.now();
            this.panelHidden = false;
            this.bodyActive = id;
            cx.notify();
            if (wasActive !== id) run("layout.select", { stack: "panel-body", child: id });
            if (wasHidden) run("layout.show", { id: "panel" });
          }
        }).child(svg(icon).size(14)).child(label);
    };
    const maximized = !!this.maximized;
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(enabled.includes("git"), el => el.child(panelButton("git", "Git", "mods/git-graph/icons/graph.svg")))
      .when(enabled.includes("usage"), el => el.child(panelButton("usage", "Usage", "mods/cursor-usage/icons/coins.svg")))
      .when(enabled.includes("worklog"), el => el.child(panelButton("worklog", "Worklog", "mods/task-notes/book.svg")))
      .when(enabled.includes("note"), el => el.child(panelButton("note", "Note", "mods/note/note.svg")))
      .when(enabled.includes("issue"), el => el.child(panelButton("issue", "Issue", "mods/issue-panel/icons/issue.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs-timer/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs-timer/${maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", (_e, cx) => { this.actedAt = Date.now(); this.maximized = !maximized; cx.notify(); run("window.maximize"); }))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs-timer/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
