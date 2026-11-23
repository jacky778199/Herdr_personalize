import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import {
  theme,
  run,
  home,
  appHome,
  checking,
  focused,
  panes,
  spaces,
  props,
  openOverlay,
  closeOverlay,
  notify,
  readTextFile,
  writeTextFile,
  setShared,
  layout,
  window,
} from "herdr";

function findLayoutNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const hit = findLayoutNode(child, id);
    if (hit) return hit;
  }
  return null;
}

function appPath(...parts) {
  const root = appHome().replace(/[\\/]+$/, "");
  const sep = root.includes("\\") ? "\\" : "/";
  return [root, ...parts].join(sep);
}

function normalizePath(raw) {
  let s = String(raw ?? "").trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function resolveNotePath(raw) {
  const s = normalizePath(raw);
  if (!s) return "";
  if (/^[a-zA-Z]:[\\/]|^[\\/]{2}|^\//.test(s)) return s;
  const h = home().replace(/[\\/]+$/, "");
  const sep = h.includes("\\") ? "\\" : "/";
  return `${h}${sep}${s.replace(/^[\\/]+/, "")}`;
}

function fileNameOf(path) {
  if (!path) return "";
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

let saveChain = Promise.resolve();

async function loadBindingsStore() {
  const path = appPath("note-bindings.json");
  const raw = await readTextFile(path);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_e) {
    return {};
  }
}

function saveBinding(terminal, filePath) {
  const job = saveChain.then(async () => {
    const storePath = appPath("note-bindings.json");
    for (let attempt = 0; attempt < 4; attempt++) {
      const expected = await readTextFile(storePath);
      let data = {};
      if (expected) {
        try {
          const parsed = JSON.parse(expected);
          if (parsed && typeof parsed === "object") data = parsed;
        } catch (_e) {
          data = {};
        }
      }
      if (filePath) data[terminal] = filePath;
      else delete data[terminal];
      try {
        await writeTextFile(storePath, JSON.stringify(data, null, 2), expected);
        setShared("note.bindings", data);
        setShared("note.active", { terminal, path: filePath || null, updatedAt: Date.now() });
        return data;
      } catch (_e) {}
    }
    return null;
  });
  saveChain = job.catch(() => {});
  return job;
}

export default class NotePanel extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.isDetail = p.mode === "detail";
    this.bindings = p.bindings && typeof p.bindings === "object" ? { ...p.bindings } : {};
    this.bindingsLoaded = Boolean(p.bindings);
    this.currentTerminal = p.terminal ?? this.resolveTargetTerminal() ?? "";
    this.content = p.content ?? null;
    this.loading = false;
    this.error = null;
    this.loadSeq = 0;
    this.editingPath = false;
    this.inputFocused = false;
    this.copied = false;
    this.pasted = false;

    this.pathInput = InputState.new({
      placeholder: "輸入或貼上 .md 檔案路徑 (Enter 確認)...",
    });
    this.pathInput.on("submit", (_e, cx) => this.applyPathInput(cx));
    this.pathInput.on("focus", (_e, cx) => {
      this.inputFocused = true;
      cx.notify();
    });
    this.pathInput.on("blur", (_e, cx) => {
      this.inputFocused = false;
      cx.notify();
    });

    if (this.isDetail) {
      this.handle = cx.focus_handle();
      this.handle.focus();
    } else if (!checking()) {
      this.initLoad(cx);
      cx.timer.every(1000, (cx) => this.syncTerminal(cx));
    }
  }

  resolveTargetTerminal() {
    const f = focused();
    if (f?.terminal) return f.terminal;
    const allPanes = panes();
    if (this.currentTerminal && allPanes.some((p) => p.terminal === this.currentTerminal)) {
      return this.currentTerminal;
    }
    const activeTab = f?.tab || spaces().flatMap((s) => s.tabs ?? []).find((t) => t.active)?.id;
    const hit = allPanes.find((p) => p.terminal && p.tab === activeTab) || allPanes.find((p) => p.terminal);
    return hit?.terminal ?? "";
  }

  initLoad(cx) {
    cx.spawn(async (cx) => {
      const store = await loadBindingsStore();
      this.bindings = store;
      this.bindingsLoaded = true;
      setShared("note.bindings", store);

      const term = this.resolveTargetTerminal();
      this.currentTerminal = term;
      const boundPath = term ? store[term] ?? "" : "";
      if (boundPath) {
        setShared("note.active", { terminal: term, path: boundPath, updatedAt: Date.now() });
        await this.fetchFile(boundPath, cx);
      } else {
        cx.notify();
      }
    });
  }

  async fetchFile(filePath, cx) {
    const seq = ++this.loadSeq;
    const resolved = resolveNotePath(filePath);
    const hadContent = this.content !== null;
    this.loading = true;
    this.error = null;
    if (!hadContent) cx.notify();

    let nextContent = this.content;
    let nextError = null;
    try {
      const text = await readTextFile(resolved);
      if (seq !== this.loadSeq) return;
      if (text == null) {
        nextContent = null;
        nextError = `找不到檔案或無法讀取：\n${resolved}`;
      } else {
        nextContent = text;
        nextError = null;
      }
    } catch (err) {
      if (seq !== this.loadSeq) return;
      nextContent = null;
      nextError = String(err);
    } finally {
      if (seq === this.loadSeq) {
        const changed = nextContent !== this.content || nextError !== this.error || !hadContent;
        this.content = nextContent;
        this.error = nextError;
        this.loading = false;
        if (changed) cx.notify();
      }
    }
  }

  syncTerminal(cx) {
    if (!this.bindingsLoaded || !window().active) return;
    const root = layout();
    const panel = findLayoutNode(root, "panel");
    const body = findLayoutNode(root, "panel-body");
    if (panel?.hidden || (body?.active && body.active !== "note")) return;
    const term = this.resolveTargetTerminal();
    if (term === this.currentTerminal) return;
    this.currentTerminal = term;
    this.editingPath = false;
    this.copied = false;
    this.pasted = false;

    const boundPath = term ? this.bindings[term] ?? "" : "";
    this.pathInput.set_value(boundPath);
    if (boundPath) {
      setShared("note.active", { terminal: term, path: boundPath, updatedAt: Date.now() });
      cx.spawn(async (cx) => {
        await this.fetchFile(boundPath, cx);
      });
    } else {
      this.loadSeq += 1;
      this.loading = false;
      this.content = null;
      this.error = null;
      setShared("note.active", { terminal: term, path: null, updatedAt: Date.now() });
      cx.notify();
    }
  }

  openDetailDialog() {
    openOverlay({
      mod: "note",
      kind: "dialog",
      width: 0.86,
      height: 0.90,
      props: {
        mode: "detail",
        terminal: this.currentTerminal,
        content: this.content,
        bindings: this.bindings,
      },
    });
  }

  applyPathInput(cx) {
    const term = this.currentTerminal || focused()?.terminal || "";
    if (!term) {
      notify({
        title: "請先選擇一個終端",
        body: "點擊任一終端窗格後再設定對應的 Markdown 路徑",
        level: "warning",
        timeout: 2500,
      });
      return;
    }

    const nextPath = normalizePath(this.pathInput.content().text);
    this.pathInput.set_value(nextPath);

    if (!nextPath) {
      this.clearBinding(cx);
      return;
    }

    this.bindings = { ...this.bindings, [term]: nextPath };
    this.editingPath = false;
    cx.spawn(async (cx) => {
      await saveBinding(term, nextPath);
      await this.fetchFile(nextPath, cx);
    });
  }

  clearBinding(cx) {
    const term = this.currentTerminal || focused()?.terminal || "";
    if (!term) return;
    const next = { ...this.bindings };
    delete next[term];
    this.bindings = next;
    this.editingPath = false;
    this.loadSeq += 1;
    this.loading = false;
    this.content = null;
    this.error = null;
    this.pathInput.set_value("");
    cx.notify();

    cx.spawn(async () => {
      await saveBinding(term, null);
    });
  }

  copyAll(cx) {
    if (this.content == null) return;
    cx.write_to_clipboard(this.content);
    this.copied = true;
    cx.notify();
    notify({
      title: "已複製筆記全文",
      body: fileNameOf(this.bindings[this.currentTerminal]),
      level: "info",
      timeout: 1800,
    });
    cx.timer.after(2000, (cx) => {
      this.copied = false;
      cx.notify();
    });
  }

  pasteToTerminal(cx) {
    const term = this.currentTerminal || focused()?.terminal || "";
    if (!term || this.content == null) return;
    cx.write_to_clipboard(this.content);
    setShared("task-notes.pending-paste", { terminal: term, at: Date.now() });
    run("pane.focus", { terminal: term });
    this.pasted = true;
    cx.notify();
    notify({
      title: `已貼入終端 ${term}`,
      body: "檔案全部內容已貼入終端（未按 Enter）",
      level: "success",
      timeout: 2200,
    });
    cx.timer.after(2000, (cx) => {
      this.pasted = false;
      cx.notify();
    });
  }

  renderHeader(t, term, boundPath, cx) {
    return h_flex()
      .h(42)
      .px(12)
      .justify_between()
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome)
      .child(
        h_flex()
          .gap(7)
          .items_center()
          .min_w(0)
          .child(svg("mods/note/note.svg").size(15).flex_none().text_color(t.accent))
          .child(div().font_semibold().text_size(13).text_color(t.foreground).child("Note"))
          .when(Boolean(term), (el) =>
            el.child(
              div()
                .px(6)
                .py(1.5)
                .rounded(4)
                .bg(t.surface)
                .border(1)
                .border_color(t.border)
                .text_size(11)
                .font_semibold()
                .text_color(t.accent)
                .child(term)
            )
          )
      )
      .child(
        h_flex()
          .gap(4)
          .items_center()
          .when(Boolean(boundPath), (el) =>
            el
              .child(
                div()
                  .id("note-reload")
                  .px(6)
                  .py(3)
                  .rounded(4)
                  .text_size(12)
                  .text_color(this.loading ? t.accent : t.muted)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => {
                    cx.spawn(async (cx) => {
                      await this.fetchFile(boundPath, cx);
                    });
                  })
                  .child("↻")
              )
              .child(
                div()
                  .id("note-edit-path")
                  .px(7)
                  .py(3)
                  .rounded(4)
                  .text_size(11)
                  .bg(this.editingPath ? t.selected : t.surface)
                  .border(1)
                  .border_color(this.editingPath ? t.accent + "66" : t.border)
                  .text_color(this.editingPath ? t.foreground : t.muted)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => {
                    this.editingPath = !this.editingPath;
                    if (this.editingPath) {
                      this.pathInput.set_value(boundPath);
                      this.pathInput.focus();
                    }
                    cx.notify();
                  })
                  .child("路徑")
              )
          )
          .when(!this.isDetail && Boolean(boundPath), (el) =>
            el.child(
              div()
                .id("note-expand-dialog")
                .px(6)
                .py(3)
                .rounded(4)
                .bg(t.surface)
                .border(1)
                .border_color(t.border)
                .text_size(11)
                .text_color(t.accent)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .tooltip("展開大畫面檢視筆記")
                .on_click(() => this.openDetailDialog())
                .child("⤢ 展開")
            )
          )
          .child(
            div()
              .id("note-close-panel")
              .px(6)
              .py(3)
              .rounded(4)
              .text_size(12)
              .text_color(t.dim)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => {
                if (this.isDetail) {
                  cx.stop_propagation();
                  closeOverlay((props() ?? {}).overlay);
                } else {
                  run("layout.hide", { id: "panel" });
                }
              })
              .child(this.isDetail ? "Esc ✕" : "✕")
          )
      );
  }

  renderEmptyPage(t, term, cx) {
    return v_flex()
      .flex_1()
      .min_h(0)
      .p(16)
      .gap(12)
      .child(
        v_flex()
          .p(14)
          .gap(10)
          .rounded(8)
          .bg(t.surface)
          .border(1)
          .border_color(t.border)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(svg("mods/note/note.svg").size(15).flex_none().text_color(t.muted))
              .child(
                div()
                  .font_semibold()
                  .text_size(13)
                  .text_color(t.foreground)
                  .child(term ? `尚未設定 ${term} 的 Markdown 筆記` : "尚未選擇終端")
              )
          )
          .child(
            div()
              .text_size(11.5)
              .text_color(t.muted)
              .child(
                term
                  ? "每個終端可獨立綁定一份 .md 檔案（例如 Obsidian 筆記）。設定後可在此瀏覽、複製或直接貼入終端。"
                  : "請先點擊左側任一終端窗格，再設定對應的 Markdown 檔案路徑。"
              )
          )
          .when(Boolean(term), (el) =>
            el
              .child(
                Input.new(this.pathInput)
                  .h(32)
                  .px(9)
                  .rounded(6)
                  .border_1()
                  .border_color(this.inputFocused ? t.accent : t.input)
                  .bg(t.background)
                  .text_size(11.5)
                  .text_color(t.foreground)
              )
              .child(
                h_flex()
                  .justify_between()
                  .items_center()
                  .gap(8)
                  .child(
                    div()
                      .text_size(10.5)
                      .text_color(t.dim)
                      .flex_1()
                      .min_w(0)
                      .truncate()
                      .child("支援直接貼上 Windows「複製路徑」(\"...\")")
                  )
                  .child(
                    h_flex()
                      .id("note-bind-btn")
                      .h(28)
                      .px(12)
                      .items_center()
                      .rounded(6)
                      .bg(t.solid)
                      .text_color(t.solid_foreground)
                      .text_size(11.5)
                      .font_medium()
                      .cursor_pointer()
                      .hover((s) => s.opacity(0.88))
                      .on_click((_e, cx) => this.applyPathInput(cx))
                      .child("連結檔案")
                  )
              )
          )
      );
  }

  renderPathEditor(t, cx) {
    return v_flex()
      .px(12)
      .py(9)
      .gap(7)
      .border_b(1)
      .border_color(t.border)
      .bg(t.surface)
      .child(
        Input.new(this.pathInput)
          .h(30)
          .px(8)
          .rounded(5)
          .border_1()
          .border_color(this.inputFocused ? t.accent : t.input)
          .bg(t.background)
          .text_size(11.5)
          .text_color(t.foreground)
      )
      .child(
        h_flex()
          .justify_between()
          .items_center()
          .gap(6)
          .child(
            div()
              .id("note-unlink-btn")
              .px(8)
              .py(3)
              .rounded(4)
              .text_size(11)
              .text_color(t.blocked)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => this.clearBinding(cx))
              .child("解除連結")
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(
                div()
                  .id("note-cancel-edit")
                  .px(8)
                  .py(3)
                  .rounded(4)
                  .text_size(11)
                  .text_color(t.muted)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => {
                    this.editingPath = false;
                    cx.notify();
                  })
                  .child("取消")
              )
              .child(
                div()
                  .id("note-save-path")
                  .px(10)
                  .py(3)
                  .rounded(4)
                  .bg(t.solid)
                  .text_color(t.solid_foreground)
                  .text_size(11)
                  .font_medium()
                  .cursor_pointer()
                  .hover((s) => s.opacity(0.88))
                  .on_click((_e, cx) => this.applyPathInput(cx))
                  .child("套用")
              )
          )
      );
  }

  renderActionBar(t, boundPath, cx) {
    const hasContent = this.content != null && !this.error;
    return h_flex()
      .px(12)
      .py(7)
      .gap(8)
      .justify_between()
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome)
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(1)
          .child(
            div()
              .text_size(11.5)
              .font_medium()
              .text_color(t.foreground)
              .truncate()
              .child(fileNameOf(boundPath))
          )
          .child(
            div()
              .text_size(10)
              .text_color(t.dim)
              .truncate()
              .child(boundPath)
          )
      )
      .when(hasContent, (el) =>
        el.child(
          h_flex()
            .gap(5)
            .flex_none()
            .items_center()
            .child(
              div()
                .id("note-copy-all")
                .px(8)
                .py(4)
                .rounded(5)
                .bg(this.copied ? t.selected : t.surface)
                .border(1)
                .border_color(this.copied ? t.accent : t.border)
                .text_size(11)
                .text_color(this.copied ? t.accent : t.foreground)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => this.copyAll(cx))
                .child(this.copied ? "✓ 已複製" : "📋 複製")
            )
            .child(
              div()
                .id("note-paste-term")
                .px(8)
                .py(4)
                .rounded(5)
                .bg(this.pasted ? t.selected : t.solid)
                .text_size(11)
                .font_medium()
                .text_color(this.pasted ? t.accent : t.solid_foreground)
                .cursor_pointer()
                .hover((s) => s.opacity(0.88))
                .on_click((_e, cx) => this.pasteToTerminal(cx))
                .child(this.pasted ? "✓ 已貼入" : "📝 貼到終端")
            )
        )
      );
  }

  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const term = this.currentTerminal;
    const boundPath = term ? this.bindings[term] ?? "" : "";

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(this.isDetail ? t.popover : t.background)
      .when(this.isDetail, (el) =>
        el
          .id("note-detail-dialog")
          .track_focus(this.handle)
          .rounded(10)
          .overflow_hidden()
          .border(1)
          .border_color(t.border)
          .on_key_down((e, cx) => {
            if (e.key === "escape") {
              cx.stop_propagation();
              closeOverlay(p.overlay);
            }
          })
      )
      .child(this.renderHeader(t, term, boundPath, cx))
      .when(!boundPath, (el) => el.child(this.renderEmptyPage(t, term, cx)))
      .when(Boolean(boundPath), (el) =>
        el
          .when(this.editingPath, (e2) => e2.child(this.renderPathEditor(t, cx)))
          .child(this.renderActionBar(t, boundPath, cx))
          .child(
            v_flex()
              .flex_1()
              .min_h(0)
              .p(12)
              .when(this.loading && this.content == null, (e2) =>
                e2.child(div().text_size(12).text_color(t.muted).child("讀取檔案中…"))
              )
              .when(Boolean(this.error), (e2) =>
                e2.child(
                  v_flex()
                    .p(12)
                    .gap(8)
                    .rounded(6)
                    .bg(t.surface)
                    .border(1)
                    .border_color(t.blocked + "66")
                    .child(div().text_size(12).font_semibold().text_color(t.blocked).child("無法讀取檔案"))
                    .child(div().text_size(11).text_color(t.muted).child(this.error))
                    .child(
                      h_flex().child(
                        div()
                          .id("note-fix-path")
                          .px(8)
                          .py(4)
                          .rounded(4)
                          .bg(t.raised)
                          .border(1)
                          .border_color(t.border)
                          .text_size(11)
                          .text_color(t.foreground)
                          .cursor_pointer()
                          .hover((s) => s.bg(t.hover))
                          .on_click((_e, cx) => {
                            this.editingPath = true;
                            this.pathInput.set_value(boundPath);
                            this.pathInput.focus();
                            cx.notify();
                          })
                          .child("修改路徑")
                      )
                    )
                )
              )
              .when(this.content != null && !this.error, (e2) =>
                e2.child(
                  TextView.markdown(`note-md-${term}-${this.loadSeq}`, this.content || "*(空白檔案)*")
                    .scrollable(true)
                    .selectable(true)
                    .size_full()
                )
              )
          )
      );
  }
}
