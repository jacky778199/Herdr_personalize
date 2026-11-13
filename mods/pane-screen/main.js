// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane-screen" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, shared, setShared, spaces, openOverlay, focused } from "herdr";
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

function paneStatus(p) {
  if (p.status) return p.status;
  if (p.terminal) return (shared("screen-status.by-terminal") ?? {})[p.terminal] ?? null;
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

export default class Pane extends View {
  init(_props, cx) {
    this.hovered = false;
    this.taskFlow = null;
    this.lastFetched = 0;
    this.fetching = false;

    cx.timer.every(160, () => flushPendingPaste());
    // Agent 狀態才抓任務標題。失敗或沒有唯一標題時保留上一筆。
    cx.timer.every(9000, async (cx) => {
      if (this.fetching) return;
      const p = this.me();
      if (!p?.terminal) return;
      const st = paneStatus(p);
      if (!st) {
        if (this.taskFlow !== null) {
          this.taskFlow = null;
          cx.notify();
        }
        return;
      }
      this.fetching = true;
      try {
        const flow = await fetchAgentTaskFlow(p.terminal, p.cwd, p.title, st);
        if (flow && JSON.stringify(flow) !== JSON.stringify(this.taskFlow)) {
          this.taskFlow = flow;
          cx.notify();
        }
      } finally {
        this.fetching = false;
      }
    });
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  openFlowPopup(p, e, cx) {
    cx.stop_propagation();
    const st = paneStatus(p);
    openOverlay({
      mod: "task-flow",
      kind: "popup",
      width: 580,
      height: 440,
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

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = paneStatus(p);
    const pane = p.pane;
    const tabIndex = spaces().flatMap((s) => s.tabs).find((tab) => tab.id === p.tab)?.index;

    // 當前 task 的簡短摘要 (只在判定為 Agent 終端且有專屬 task 時顯示)
    const latestTask = st ? this.taskFlow?.tasks?.[this.taskFlow.tasks.length - 1] : null;
    const rawPrompt = latestTask?.prompt ? latestTask.prompt.replace(/[\b\x08]+/g, "").trim() : "";
    const taskTitle = rawPrompt
      ? (rawPrompt.length > 25 ? rawPrompt.slice(0, 24) + "…" : rawPrompt)
      : null;

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
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
