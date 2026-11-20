import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, closeOverlay, focused, hc, home, nextCommand, notify, props, readTextFile, run, spaces, theme, writeTextFile } from "herdr";

// Edit these two things to make the example yours. Only repeatable actions
// start a timer: the first key after Ctrl+B can take as long as you like.
const REPEAT_MS = 500;
const BINDINGS = [
  ["c", "New tab", "tab.new"],
  ["%", "Split right", "pane.split", { direction: "right" }],
  ['"', "Split down", "pane.split", { direction: "down" }],
  ["x", "Close pane", "pane.close"],
  ["n", "Next tab", "tab.next"],
  ["p", "Previous tab", "tab.prev"],
  ["h", "Focus left", "pane.go", { direction: "left" }, true],
  ["j", "Focus down", "pane.go", { direction: "down" }, true],
  ["k", "Focus up", "pane.go", { direction: "up" }, true],
  ["l", "Focus right", "pane.go", { direction: "right" }, true],
  ["left", "Focus left", "pane.go", { direction: "left" }, true],
  ["down", "Focus down", "pane.go", { direction: "down" }, true],
  ["up", "Focus up", "pane.go", { direction: "up" }, true],
  ["right", "Focus right", "pane.go", { direction: "right" }, true],
  ["J", "Next space", "space.next", {}, true],
  ["K", "Previous space", "space.prev", {}, true],
  ["z", "Zoom pane", "pane.zoom"],
  ["d", "Minimize window", "window.minimize"],
  ...Array.from({ length: 10 }, (_, i) => [String(i), `Tab ${i === 0 ? 10 : i}`, "tab.select", { index: i === 0 ? 10 : i }]),
];

function plainLabel(label) {
  return String(label || "pane").replace(/ ⏎關$/, "").trim() || "pane";
}

async function toggleAutoEnter() {
  const f = focused();
  const pane = f?.pane;
  const tab = f?.tab;
  if (!pane || !tab) return;
  const space = spaces().find((s) => s.tabs?.some((item) => item.id === tab));
  const current = space?.tabs?.find((item) => item.id === tab)?.name || "pane";
  const original = plainLabel(current);
  const statePath = `${home()}/AppData/Local/herdr/plugins/user.auto-enter/disabled.json`;
  const mirrorPath = `${appHome()}/data/auto-enter-off.json`;
  const raw = await readTextFile(statePath);
  let panes = {};
  try { panes = JSON.parse(raw || "{}").panes || {}; } catch { panes = {}; }
  const turningOff = !panes[pane];
  if (turningOff) {
    panes[pane] = { tab_id: tab, tab_label: original };
    run("tab.rename", { id: tab, name: `${original} ⏎關` });
  } else {
    delete panes[pane];
    const still = Object.values(panes).some((item) => item?.tab_id === tab);
    if (!still) run("tab.rename", { id: tab, name: original });
  }
  const text = `${JSON.stringify({ panes }, null, 2)}\n`;
  await writeTextFile(statePath, text, raw);
  const mirrorRaw = await readTextFile(mirrorPath);
  await writeTextFile(mirrorPath, text, mirrorRaw);
  notify({
    title: turningOff ? "⏎ 已關閉" : "⏎ 已開啟",
    body: turningOff ? "分頁和標題列會顯示 ⏎關" : "這個 pane 恢復自動按 Enter",
    timeout: 2500,
  });
}

function forwardKey(e, key) {
  if (["enter", "tab", "backspace", "left", "right", "up", "down", "space"].includes(e.key)) return e.key;
  if (key === " ") return "space";
  if (/^[A-Z]$/.test(key)) return `shift+${key.toLowerCase()}`;
  if (key.length === 1 && "abcdefghijklmnopqrstuvwxyz0123456789`\\[],=-.';/".includes(key)) return key === "\\" ? "backslash" : key;
  return null;
}

export default class TmuxPrefix extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.repeat = false;
    this.generation = 0;
    this.all = false;
    // The mod-specific key binding beats the global opener while we're open.
    cx.spawn(async (cx) => {
      for (;;) {
        await nextCommand();
        this.sendPrefix(cx);
      }
    });
  }

  dismiss() {
    closeOverlay(props().overlay);
  }

  send(key, cx) {
    this.generation++;
    const terminal = focused()?.terminal;
    if (!terminal) return this.dismiss();
    // hc starts its subprocess at the call, before closing cancels this view's tasks.
    const pending = hc(["keys", terminal, key]);
    cx.spawn(async () => {
      const result = await pending;
      if (result.code !== 0) console.log(`tmux-prefix: ${result.stderr}`);
    });
    this.dismiss();
  }

  sendPrefix(cx) {
    this.send("ctrl+b", cx);
  }

  key(e, cx) {
    cx.stop_propagation();
    const m = e.modifiers;
    const plain = !m.control && !m.alt && !m.platform;
    if (e.key === "escape") return this.dismiss();
    if (plain && e.key === "enter") {
      cx.spawn(async () => { await toggleAutoEnter(); });
      return this.dismiss();
    }
    if (m.control && e.key === "b") return this.sendPrefix(cx);
    const key = plain ? (e.key_char ?? (m.shift && e.key.length === 1 ? e.key.toUpperCase() : e.key)) : e.key;
    if (plain && key === "?") {
      this.all = !this.all;
      this.repeat = false;
      this.generation++;
      cx.notify();
      return;
    }
    const binding = plain && BINDINGS.find((b) => b[0] === key);
    if (!binding) {
      const forwarded = this.repeat && plain && forwardKey(e, key);
      if (forwarded) return this.send(forwarded, cx);
      return this.dismiss();
    }
    const [, , command, args = {}, repeatable = false] = binding;
    const pane = focused()?.pane;
    const paneCommand = command === "pane.split" || command === "pane.close" || command === "pane.zoom" || command === "pane.go";
    const withPane = pane && paneCommand ? { ...args, pane } : args;
    if (!repeatable) this.dismiss();
    run(command, withPane);
    if (repeatable) {
      this.repeat = true;
      const generation = ++this.generation;
      cx.timer.after(REPEAT_MS, () => {
        if (this.generation === generation) this.dismiss();
      });
      cx.notify();
    }
  }

  render() {
    const t = theme();
    const rows = this.all ? BINDINGS : BINDINGS.filter(([key]) => !["left", "right", "up", "down"].includes(key) && !/^\d$/.test(key));
    return v_flex().id("tmux-prefix").track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .p(14).gap(8).bg(t.popover).text_color(t.foreground).text_size(12)
      .child(h_flex().justify_between().child(div().font_semibold().child(this.repeat ? `Repeat · ${REPEAT_MS} ms` : "Ctrl+B · waiting for a key"))
        .child(div().text_color(t.muted).child("Esc cancel · ^B send prefix")))
      .child(v_flex().h(280).min_h(0).overflow_y_scrollbar().children(rows.map(([key, label, , , repeatable]) =>
        h_flex().h(20).flex_none().items_center().gap(12).child(div().w(40).text_color(t.accent).child(key))
          .child(div().flex_1().child(label)).child(div().text_color(t.dim).child(repeatable ? "repeat" : "")))))
      .child(div().text_color(t.muted).child("Enter 開關 Auto Enter · 0–9 tabs (0 = 10) · arrows focus · ? all bindings"));
  }
}
