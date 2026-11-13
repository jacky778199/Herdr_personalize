import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { props, closeOverlay, theme, hc, notify, run, home, appHome, readTextFile, writeTextFile, focused, shared, setShared, exec } from "herdr";

const DEFAULT_NOTES = [
  { id: "note-1", text: "請繼續執行下一步" },
  { id: "note-2", text: "檢查並測試剛才的修改" },
  { id: "note-3", text: "總結目前完成進度與後續計畫" },
];

function appPath(...parts) {
  const root = appHome().replace(/[\\/]+$/, "");
  const sep = root.includes("\\") ? "\\" : "/";
  return [root, ...parts].join(sep);
}

let saveChain = Promise.resolve();

function remember(terminals) {
  setShared("task-notes.by-terminal", terminals);
}

async function readStore() {
  const path = appPath("task-notes.json");
  const raw = await readTextFile(path);
  if (!raw) return { path, raw: null, data: { terminals: {} } };
  try {
    const data = JSON.parse(raw);
    if (!data.terminals || typeof data.terminals !== "object") data.terminals = {};
    return { path, raw, data };
  } catch (_e) {
    return { path, raw, data: { terminals: {} } };
  }
}

async function legacyNotes() {
  const res = await exec("python", [appPath("mods", "task-notes", "legacy.py"), appPath("data", "task-notes")], { timeout: 5000 });
  if (res.code !== 0 || !res.stdout) return {};
  try {
    const data = JSON.parse(res.stdout.trim());
    return data && typeof data === "object" ? data : {};
  } catch (_e) {
    return {};
  }
}

function writeTerminal(terminal, notes) {
  const job = saveChain.then(() => commitTerminal(terminal, notes));
  saveChain = job.catch(() => {});
  return job;
}

async function commitTerminal(terminal, notes) {
  const path = appPath("task-notes.json");
  for (let attempt = 0; attempt < 4; attempt++) {
    const expected = await readTextFile(path);
    let data = { terminals: {} };
    if (expected) {
      try {
        data = JSON.parse(expected);
      } catch (_e) {
        data = { terminals: {} };
      }
    }
    if (!data.terminals || typeof data.terminals !== "object") data.terminals = {};
    data.terminals[terminal] = notes;
    try {
      await writeTextFile(path, JSON.stringify(data), expected);
      remember(data.terminals);
      return;
    } catch (_e) {}
  }
}

export default class TaskNotesPopup extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.terminal = props()?.terminal || focused()?.terminal || "";
    this.generation = 0;
    this.loaded = false;
    const cached = shared("task-notes.by-terminal");
    if (this.terminal && cached && Array.isArray(cached[this.terminal])) {
      this.notes = cached[this.terminal];
      this.loaded = true;
    } else {
      this.notes = [];
    }

    cx.spawn(async (cx) => {
      if (!this.terminal || this.loaded) return;
      const { data } = await readStore();
      if (this.generation !== 0) return;
      if (Array.isArray(data.terminals[this.terminal])) {
        this.notes = data.terminals[this.terminal];
      } else {
        const recovered = await legacyNotes();
        if (this.generation !== 0) return;
        const found = recovered[this.terminal];
        this.notes = Array.isArray(found) ? found : DEFAULT_NOTES.map((note) => ({ ...note }));
        await writeTerminal(this.terminal, this.notes);
      }
      const live = { ...(shared("task-notes.by-terminal") ?? {}), [this.terminal]: this.notes };
      remember(live);
      this.loaded = true;
      cx.notify();
    });

    this.injectedId = null;
    this.pastedId = null;
    this.copiedId = null;
    this.editingId = null;
    this.inputFocused = false;

    // 新增筆記輸入框
    this.newInput = InputState.new({ placeholder: "輸入任務備忘或待注入指令 (Enter 新增)..." });
    this.newInput.on("submit", (_e, cx) => this.addNote(cx));
    this.newInput.on("focus", (_e, cx) => {
      this.inputFocused = true;
      cx.notify();
    });
    this.newInput.on("blur", (_e, cx) => {
      this.inputFocused = false;
      cx.notify();
    });

    // 行內編輯專用輸入框
    this.editInput = InputState.new({ placeholder: "編輯筆記內容..." });
    this.editInput.on("submit", (_e, cx) => this.saveEdit(cx));

    this.newInput.focus();
    cx.timer.after(300, () => this.newInput.focus());
  }

  save() {
    if (!this.terminal) return;
    this.generation += 1;
    const notes = this.notes.map((note) => ({ id: note.id, text: note.text }));
    const live = { ...(shared("task-notes.by-terminal") ?? {}), [this.terminal]: notes };
    remember(live);
    writeTerminal(this.terminal, notes);
  }

  addNote(cx) {
    const text = this.newInput.value().trim();
    if (!text) return;
    this.notes.unshift({
      id: String(Date.now()),
      text,
    });
    this.newInput.set_value("");
    this.save();
    cx.notify();
  }

  deleteNote(id, cx) {
    if (this.editingId === id) this.editingId = null;
    this.notes = this.notes.filter((n) => n.id !== id);
    this.save();
    cx.notify();
  }

  addPreset(text, cx) {
    if (!text) return;
    this.notes.unshift({
      id: String(Date.now()),
      text,
    });
    this.save();
    cx.notify();
  }

  startEdit(note, cx) {
    this.editingId = note.id;
    this.editInput.set_value(note.text);
    cx.notify();
    cx.timer.after(100, () => this.editInput.focus());
  }

  saveEdit(cx) {
    if (!this.editingId) return;
    const val = this.editInput.value().trim();
    if (val) {
      const idx = this.notes.findIndex((n) => n.id === this.editingId);
      if (idx !== -1) {
        this.notes[idx].text = val;
        this.save();
      }
    }
    this.editingId = null;
    cx.notify();
  }

  cancelEdit(cx) {
    this.editingId = null;
    cx.notify();
  }

  // 1. 注入並送出 (以 --force 直接送至終端並觸發 Enter 送出)
  async injectAndSubmit(note, cx) {
    const term = this.terminal || focused()?.terminal;
    if (!term || !note?.text) return;
    this.injectedId = note.id;
    cx.notify();

    try {
      // 加上 --force: 避免終端處於 blocked 狀態時被 herdr-core 拒絕，並跳過 quiet wait
      await hc(["send", "--force", term, note.text]);
      notify({
        title: `已注入終端 ${term} 並送出`,
        body: note.text.length > 50 ? note.text.slice(0, 47) + "..." : note.text,
        level: "success",
        timeout: 2000,
      });
    } catch (e) {
      console.log("inject error:", e);
    }

    cx.timer.after(1500, () => {
      this.injectedId = null;
      cx.notify();
    });
  }

  // 2. 僅填入草稿 (複製後關閉彈窗並執行 terminal.paste，不按 Enter，保留游標給使用者繼續打字)
  pasteToDraft(note, cx) {
    const term = this.terminal || focused()?.terminal;
    if (!note?.text || !term) return;
    this.pastedId = note.id;
    cx.notify();

    cx.write_to_clipboard(note.text);
    // 關窗後由還活著的 pane header 等焦點回到這個終端再貼上，不送 Enter。
    setShared("task-notes.pending-paste", { terminal: term, at: Date.now() });
    const p = props();
    if (p?.overlay) closeOverlay(p.overlay);
    run("pane.focus", { terminal: term });

    notify({
      title: `已填入終端 ${term || ""} 草稿框`,
      body: "文字已填入 AI 輸入提示，可接著編輯後按 Enter",
      level: "info",
      timeout: 2200,
    });
  }

  // 3. 原生複製到剪貼簿 (0ms 零延遲、無額外換行、無語法跳脫 bug)
  copyNote(note, cx) {
    if (!note?.text) return;
    this.copiedId = note.id;
    cx.write_to_clipboard(note.text);
    notify({
      title: "已複製至剪貼簿",
      body: note.text.length > 50 ? note.text.slice(0, 47) + "..." : note.text,
      level: "info",
      timeout: 1800,
    });
    cx.notify();

    cx.timer.after(1200, () => {
      this.copiedId = null;
      cx.notify();
    });
  }

  // 全部匯出 (原生寫入桌面 Markdown 並存入剪貼簿)
  async exportAllNotes(cx) {
    if (!this.notes.length) return;
    const content = `# Herdr Task Notes (${new Date().toLocaleString()})\n\n` +
      this.notes.map((n, i) => `${i + 1}. ${n.text}`).join("\n\n");
    cx.write_to_clipboard(content);

    const h = home();
    const target = `${h}/Desktop/task-notes.md`;
    try {
      await writeTextFile(target, content, null);
      notify({
        title: "已匯出全部筆記",
        body: `已存至桌面 task-notes.md 並複製到剪貼簿 (${this.notes.length} 則)`,
        level: "success",
        timeout: 3000,
      });
    } catch (_e) {
      notify({
        title: "已複製全部筆記",
        body: `已複製全部 ${this.notes.length} 則筆記至剪貼簿`,
        level: "success",
        timeout: 2500,
      });
    }
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const presets = ["請繼續執行", "分析目前錯誤並修復", "執行測試並驗證", "總結目前進度與Plan"];

    return v_flex()
      .id("task-notes-popup")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          cx.stop_propagation();
          closeOverlay(p.overlay);
        }
      })
      .size_full()
      .min_h(0)
      .p(16)
      .gap(12)
      .rounded(10)
      .bg(t.popover)
      .border(1)
      .border_color(t.border)
      .text_size(12)
      // Header
      .child(
        h_flex()
          .justify_between()
          .items_center()
          .child(
            h_flex()
              .gap(7)
              .items_center()
              .child(div().font_semibold().text_size(14).text_color(t.foreground).child("📝 Task 小筆記"))
              .when(Boolean(this.terminal), (el) =>
                el.child(
                  div()
                    .px(6)
                    .py(1.5)
                    .rounded(4)
                    .bg(t.raised)
                    .border(1)
                    .border_color(t.border)
                    .text_size(11)
                    .font_semibold()
                    .text_color(t.accent)
                    .child(this.terminal)
                )
              )
          )
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(
                div()
                  .px(7)
                  .py(2)
                  .rounded(4)
                  .bg(t.raised)
                  .border(1)
                  .border_color(t.border)
                  .text_size(11)
                  .text_color(t.foreground)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => this.exportAllNotes(cx))
                  .child("📤 匯出 .md")
              )
              .child(
                div()
                  .p(3)
                  .rounded(4)
                  .text_color(t.dim)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    closeOverlay(p.overlay);
                  })
                  .child(div().text_size(11.5).child("Esc ✕"))
              )
          )
      )
      // Top Input Bar
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            div()
              .flex_1()
              .child(
                Input.new(this.newInput)
                  .h(34)
                  .px(10)
                  .rounded(6)
                  .border_1()
                  .border_color(this.inputFocused ? t.accent : t.input)
                  .bg(t.background)
                  .text_size(12)
                  .text_color(t.foreground)
              )
          )
          .child(
            h_flex()
              .h(34)
              .px(12)
              .items_center()
              .rounded(6)
              .bg(t.solid)
              .text_color(t.solid_foreground)
              .text_size(12)
              .font_medium()
              .cursor_pointer()
              .hover((s) => s.opacity(0.88))
              .on_click((_e, cx) => this.addNote(cx))
              .child("+ 新增筆記")
          )
      )
      // Quick preset tags
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .flex_wrap()
          .child(div().text_size(11).text_color(t.dim).child("範本快捷:"))
          .children(
            presets.map((pre) =>
              div()
                .px(6)
                .py(1.5)
                .rounded(4)
                .bg(t.raised)
                .border(1)
                .border_color(t.border)
                .text_size(10.5)
                .text_color(t.foreground)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).border_color(t.accent))
                .on_click((_e, cx) => this.addPreset(pre, cx))
                .child(`+ ${pre}`)
            )
          )
      )
      // Notes List (Scrollable Area)
      .child(
        div()
          .flex_1()
          .min_h(120)
          .relative()
          .child(
            v_flex()
              .id("notes-scroll-list")
              .absolute()
              .inset_0()
              .overflow_y_scroll()
              .gap(8)
              .children(
                !this.loaded
                  ? [div().p(24).text_color(t.muted).child(this.terminal ? "讀取這個終端的筆記…" : "這個 pane 沒有終端機。")]
                  : this.notes.length === 0
                  ? [div().p(24).text_color(t.muted).child("目前沒有筆記，請在上方輸入框輸入後按 Enter，或點擊快捷標籤加入。")]
                  : this.notes.map((note, index) => {
                      const isInjected = this.injectedId === note.id;
                      const isPasted = this.pastedId === note.id;
                      const isCopied = this.copiedId === note.id;
                      const isEditing = this.editingId === note.id;

                      if (isEditing) {
                        return h_flex()
                          .id(`note-edit-${note.id}`)
                          .p(8)
                          .gap(8)
                          .items_center()
                          .rounded(6)
                          .bg(t.raised)
                          .border(1)
                          .border_color(t.accent)
                          .child(
                            div()
                              .flex_1()
                              .child(
                                Input.new(this.editInput)
                                  .h(30)
                                  .px(8)
                                  .rounded(4)
                                  .border_1()
                                  .border_color(t.accent)
                                  .bg(t.background)
                                  .text_size(12)
                                  .text_color(t.foreground)
                              )
                          )
                          .child(
                            h_flex()
                              .h(28)
                              .px(8)
                              .items_center()
                              .rounded(4)
                              .bg(t.solid)
                              .text_color(t.solid_foreground)
                              .text_size(11)
                              .cursor_pointer()
                              .on_click((_e, cx) => this.saveEdit(cx))
                              .child("儲存")
                          )
                          .child(
                            h_flex()
                              .h(28)
                              .px(8)
                              .items_center()
                              .rounded(4)
                              .bg(t.chrome)
                              .text_color(t.dim)
                              .text_size(11)
                              .cursor_pointer()
                              .on_click((_e, cx) => this.cancelEdit(cx))
                              .child("取消")
                          );
                      }

                      return h_flex()
                        .id(`note-item-${note.id}`)
                        .p(10)
                        .gap(10)
                        .items_center()
                        .rounded(6)
                        .bg(isInjected ? t.working + "18" : t.canvas)
                        .border(1)
                        .border_color(isInjected ? t.working : t.border)
                        // 序號
                        .child(
                          div()
                            .w(22)
                            .text_size(11.5)
                            .font_semibold()
                            .text_color(t.accent)
                            .child(`${index + 1}.`)
                        )
                        // 文字內容 (點擊直接進入編輯)
                        .child(
                          div()
                            .flex_1()
                            .text_size(12.5)
                            .font_medium()
                            .text_color(t.foreground)
                            .cursor_pointer()
                            .hover((s) => s.text_color(t.accent))
                            .on_click((_e, cx) => this.startEdit(note, cx))
                            .child(note.text)
                        )
                        // 操作按鈕群: [⚡ 送出] [📝 填入] [📋 複製] [✏️] [✕]
                        .child(
                          h_flex()
                            .gap(5)
                            .items_center()
                            // 按鈕 1: 注入並送出 (Send & Enter)
                            .child(
                              h_flex()
                                .flex_none()
                                .h(28)
                                .px(8)
                                .gap(3)
                                .items_center()
                                .rounded(5)
                                .bg(isInjected ? t.working : t.solid)
                                .text_color(isInjected ? "#ffffff" : t.solid_foreground)
                                .text_size(11)
                                .font_medium()
                                .cursor_pointer()
                                .hover((s) => s.opacity(0.85))
                                .on_click((_e, cx) => this.injectAndSubmit(note, cx))
                                .child(div().child(isInjected ? "✓" : "⚡"))
                                .child(div().child(isInjected ? "已送出" : "送出"))
                            )
                            // 按鈕 2: 僅填入草稿 (Paste only, without Enter)
                            .child(
                              h_flex()
                                .flex_none()
                                .h(28)
                                .px(8)
                                .gap(3)
                                .items_center()
                                .rounded(5)
                                .bg(isPasted ? t.accent : t.raised)
                                .border(1)
                                .border_color(t.border)
                                .text_color(isPasted ? "#ffffff" : t.foreground)
                                .text_size(11)
                                .font_medium()
                                .cursor_pointer()
                                .hover((s) => s.bg(t.hover))
                                .on_click((_e, cx) => this.pasteToDraft(note, cx))
                                .child(div().child(isPasted ? "✓" : "📝"))
                                .child(div().child(isPasted ? "已填入" : "填入"))
                            )
                            // 按鈕 3: 原生複製到剪貼簿 (Copy)
                            .child(
                              h_flex()
                                .flex_none()
                                .h(28)
                                .px(7)
                                .gap(3)
                                .items_center()
                                .rounded(5)
                                .bg(isCopied ? t.accent : t.raised)
                                .border(1)
                                .border_color(t.border)
                                .text_color(isCopied ? "#ffffff" : t.foreground)
                                .text_size(11)
                                .font_medium()
                                .cursor_pointer()
                                .hover((s) => s.bg(t.hover))
                                .on_click((_e, cx) => this.copyNote(note, cx))
                                .child(div().child(isCopied ? "✓" : "📋"))
                                .child(div().child(isCopied ? "已複製" : "複製"))
                            )
                            // 按鈕 4: 編輯
                            .child(
                              div()
                                .flex_none()
                                .p(4)
                                .rounded(4)
                                .text_size(11.5)
                                .text_color(t.dim)
                                .cursor_pointer()
                                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                                .on_click((_e, cx) => this.startEdit(note, cx))
                                .child("✏️")
                            )
                            // 按鈕 5: 刪除
                            .child(
                              div()
                                .flex_none()
                                .p(4)
                                .rounded(4)
                                .text_size(11.5)
                                .text_color(t.dim)
                                .cursor_pointer()
                                .hover((s) => s.bg(t.hover).text_color(t.blocked))
                                .on_click((_e, cx) => this.deleteNote(note.id, cx))
                                .child("✕")
                            )
                        );
                    })
              )
          )
          .child(Scrollbar.vertical("notes-scroll-list").absolute().inset_0())
      )
      // Footer
      .child(
        h_flex()
          .justify_between()
          .items_center()
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .child(`共 ${this.notes.length} 則筆記 · [送出] 直接執行 · [填入] 貼入草稿 · [複製] 存入剪貼簿`)
          )
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .child("點文字或 ✏️ 編輯 · Esc 關閉")
          )
      );
  }
}
