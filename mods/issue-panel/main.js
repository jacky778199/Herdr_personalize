import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import {
  theme,
  run,
  exec,
  appHome,
  props,
  checking,
  openOverlay,
  closeOverlay,
  agents,
  panes,
  spaces,
  focused,
  watchFolder,
  window,
} from "herdr";

const STAGES = [
  { num: 1, label: "1.偵察" },
  { num: 2, label: "2.計畫/實作" },
  { num: 3, label: "3.測試" },
  { num: 4, label: "4.審查" },
  { num: 5, label: "5.交付" },
];

function normPath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function projectName(cwd) {
  if (!cwd) return "未偵測到工作區";
  const parts = String(cwd).replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

function shortTime(tsStr) {
  if (!tsStr) return "";
  const m = String(tsStr).match(/\d{2}-\d{2}\s+(\d{2}:\d{2})/);
  return m ? m[1] : String(tsStr).slice(11, 16) || tsStr;
}

function statusStyle(status, t) {
  const s = String(status || "UNKNOWN").toUpperCase();
  if (s === "DONE") return { label: "DONE", fg: "#10b981", bg: "#10b98122", border: "#10b98155" };
  if (s === "NEED_HUMAN") return { label: "NEED_HUMAN", fg: "#ef4444", bg: "#ef444422", border: "#ef444466" };
  if (s === "BLOCKED") return { label: "BLOCKED", fg: "#f59e0b", bg: "#f59e0b22", border: "#f59e0b55" };
  if (s === "IN_PROGRESS") return { label: "IN_PROGRESS", fg: t.accent, bg: t.accent + "22", border: t.accent + "55" };
  return { label: s, fg: t.muted, bg: t.surface, border: t.border };
}

function agentDotColor(status, t) {
  if (status === "working") return t.working ?? "#3b82f6";
  if (status === "blocked") return t.blocked ?? "#ef4444";
  if (status === "done") return t.done ?? "#10b981";
  return t.dim;
}

function detectWorkspace() {
  try {
    const space = spaces().find((s) => s.active) ?? null;
    const f = focused?.() ?? null;
    const paneList = panes?.() ?? [];
    const pane = f?.pane ? paneList.find((p) => p.pane === f.pane) : null;
    const cwd = pane?.cwd || f?.cwd || space?.folder || "";
    return { cwd, space };
  } catch {
    return { cwd: "", space: null };
  }
}

function parseMarkdownBlocks(text) {
  const lines = String(text || "").split(/\r?\n/);
  const blocks = [];
  let inCode = false;
  let codeLang = "";
  let codeLines = [];
  let paraLines = [];

  const flushPara = () => {
    if (paraLines.length > 0) {
      blocks.push({ type: "para", text: paraLines.join("\n") });
      paraLines = [];
    }
  };

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("```")) {
      flushPara();
      if (!inCode) {
        inCode = true;
        codeLang = trimmed.slice(3).trim();
        codeLines = [];
      } else {
        blocks.push({ type: "code", lang: codeLang, text: codeLines.join("\n") });
        inCode = false;
        codeLang = "";
        codeLines = [];
      }
      continue;
    }

    if (inCode) {
      codeLines.push(raw);
      continue;
    }

    if (!trimmed) {
      flushPara();
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flushPara();
      blocks.push({ type: "hr" });
      continue;
    }

    const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      flushPara();
      blocks.push({ type: "heading", level: hMatch[1].length, text: hMatch[2] });
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushPara();
      blocks.push({ type: "quote", text: trimmed.replace(/^>\s?/, "") });
      continue;
    }

    const listMatch = raw.match(/^(\s*)([-*]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      flushPara();
      const indent = Math.min(24, Math.floor((listMatch[1]?.length || 0) / 2) * 10);
      blocks.push({
        type: "list",
        bullet: listMatch[2],
        indent,
        text: listMatch[3],
      });
      continue;
    }

    paraLines.push(raw);
  }

  if (inCode && codeLines.length > 0) {
    blocks.push({ type: "code", lang: codeLang, text: codeLines.join("\n") });
  }
  flushPara();
  return blocks;
}

export default class IssuePanel extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.isDetail = p.mode === "detail";
    this.cwd = p.cwd || detectWorkspace().cwd;
    this.selectedIssueId = p.issueId ?? null;
    this.data = null;
    this.loading = false;
    this.error = null;
    this.lastSyncAt = "";

    // Detail dialog state
    this.docName = p.docName || "00_board.md";
    this.docsList = p.docs ?? [];
    this.issueTitle = p.issueTitle || "";
    this.docContent = "";
    this.docPath = "";
    this.docUpdatedAt = "";
    this.docLineCount = 0;
    this.docLoading = false;
    this.docError = null;
    this.copiedKind = null;

    // Watcher state
    this._watchingDir = null;
    this._watchGen = 0;
    this._watcher = null;
    this._debouncePending = false;
    this._agentSig = "";

    if (this.isDetail) {
      this.handle = cx.focus_handle();
      this.handle.focus();
      if (!checking() && this.cwd && this.selectedIssueId && this.docName) {
        this.loadDoc(this.docName, cx);
      }
      return;
    }

    if (!checking()) {
      this.loadWorkspace(cx);
      this.ensureWatcher(cx);
      cx.timer.every(3000, (cx) => this.tick(cx));
    }
  }

  tick(cx) {
    if (!window().active) return;
    const { cwd } = detectWorkspace();
    if (cwd && normPath(cwd) !== normPath(this.cwd)) {
      this.cwd = cwd;
      this.selectedIssueId = null;
      this.ensureWatcher(cx);
      this.loadWorkspace(cx);
      return;
    }
    const sig = this.computeAgentSig();
    if (sig !== this._agentSig) {
      this._agentSig = sig;
      cx.notify();
    }
  }

  computeAgentSig() {
    try {
      const list = agents?.() ?? [];
      return list.map((a) => `${a.address}:${a.status}:${a.pane ?? ""}`).join("|");
    } catch {
      return "";
    }
  }

  stopWatcher() {
    this._watchGen += 1;
    this._watchingDir = null;
    this._debouncePending = false;
    if (this._watcher) {
      try {
        this._watcher.cancel();
      } catch {
        // ignore
      }
      this._watcher = null;
    }
  }

  ensureWatcher(cx) {
    if (!this.cwd || checking()) return;
    const aiTeamDir = `${this.cwd.replace(/\\/g, "/").replace(/\/+$/, "")}/.ai_team`;
    if (this._watchingDir === aiTeamDir) return;
    this.stopWatcher();
    this._watchingDir = aiTeamDir;
    const gen = ++this._watchGen;

    cx.spawn(async (cx) => {
      for (;;) {
        if (this._watchGen !== gen) break;
        try {
          const w = watchFolder(aiTeamDir);
          this._watcher = w;
          const changed = await w;
          if (this._watchGen !== gen) break;
          if (!changed || changed.length === 0) break;
          this.scheduleReload(cx, gen);
        } catch {
          break;
        }
      }
    });
  }

  scheduleReload(cx, gen) {
    if (this._debouncePending || this._watchGen !== gen) return;
    this._debouncePending = true;
    cx.timer.after(300, (cx) => {
      this._debouncePending = false;
      if (this._watchGen !== gen) return;
      this.loadWorkspace(cx);
    });
  }

  loadWorkspace(cx) {
    if (this.loading) return;
    if (!this.cwd) {
      this.cwd = detectWorkspace().cwd;
    }
    if (!this.cwd) {
      this.data = null;
      this.error = null;
      cx.notify();
      return;
    }

    this.loading = true;
    this.error = null;
    cx.notify();

    const targetCwd = this.cwd;
    const targetIssue = this.selectedIssueId;

    cx.spawn(async (cx) => {
      try {
        const script = `${appHome()}/mods/issue-panel/parser.py`;
        const args = [script, "--cwd", targetCwd];
        if (targetIssue) {
          args.push("--issue", targetIssue);
        }
        const res = await exec("python", args, { timeout: 10000 });
        if (res.code === 0 && res.stdout.trim()) {
          const parsed = JSON.parse(res.stdout.trim());
          if (parsed?.ok) {
            this.data = parsed;
            if (parsed.selected_issue_id) {
              this.selectedIssueId = parsed.selected_issue_id;
            }
            const now = new Date();
            this.lastSyncAt = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
            this.error = null;
            this.ensureWatcher(cx);
          } else {
            this.error = parsed?.error || "解析 Issue 狀態失敗";
          }
        } else {
          this.error = res.stderr?.trim() || "執行 parser.py 失敗";
        }
      } catch (err) {
        this.error = String(err);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  loadDoc(docName, cx) {
    if (!this.cwd || !this.selectedIssueId || !docName) return;
    this.docName = docName;
    this.docLoading = true;
    this.docError = null;
    cx.notify();

    const targetCwd = this.cwd;
    const targetIssue = this.selectedIssueId;

    cx.spawn(async (cx) => {
      try {
        const script = `${appHome()}/mods/issue-panel/parser.py`;
        const res = await exec(
          "python",
          [script, "--cwd", targetCwd, "--issue", targetIssue, "--doc", docName],
          { timeout: 10000 }
        );
        if (res.code === 0 && res.stdout.trim()) {
          const parsed = JSON.parse(res.stdout.trim());
          if (parsed?.ok) {
            this.docContent = parsed.content ?? "";
            this.docPath = parsed.path ?? "";
            this.docUpdatedAt = parsed.updated_at ?? "";
            this.docLineCount = parsed.line_count ?? 0;
            this.docError = null;
          } else {
            this.docError = parsed?.error || "無法讀取文件";
          }
        } else {
          let errMsg = res.stderr?.trim() || "讀取文件失敗";
          try {
            const errJson = JSON.parse(res.stdout.trim());
            if (errJson?.error) errMsg = errJson.error;
          } catch {
            // ignore
          }
          this.docError = errMsg;
        }
      } catch (err) {
        this.docError = String(err);
      } finally {
        this.docLoading = false;
        cx.notify();
      }
    });
  }

  openDetailDialog(docName) {
    const cur = this.data?.current;
    if (!cur) return;
    openOverlay({
      mod: "issue-panel",
      kind: "dialog",
      width: 0.88,
      height: 0.94,
      props: {
        mode: "detail",
        cwd: this.cwd,
        issueId: cur.id,
        issueTitle: cur.title,
        docName,
        docs: cur.docs ?? [],
      },
    });
  }

  copyText(kind, text, cx) {
    if (!text) return;
    cx.write_to_clipboard(text);
    this.copiedKind = kind;
    cx.notify();
    cx.timer.after(1800, (cx) => {
      if (this.copiedKind === kind) {
        this.copiedKind = null;
        cx.notify();
      }
    });
  }

  workspaceAgents() {
    try {
      const agentList = agents?.() ?? [];
      const paneList = panes?.() ?? [];
      const paneById = new Map(paneList.map((p) => [p.pane, p]));
      const curNorm = normPath(this.cwd);
      const matched = agentList.filter((a) => {
        const p = a.pane ? paneById.get(a.pane) : null;
        const aCwd = normPath(p?.cwd || a.cwd || "");
        if (!curNorm || !aCwd) return false;
        return aCwd === curNorm || aCwd.startsWith(`${curNorm}/`) || curNorm.startsWith(`${aCwd}/`);
      });
      if (matched.length > 0) return matched;
      const space = spaces().find((s) => s.active);
      if (space) {
        return agentList.filter((a) => a.space === space.id);
      }
      return agentList.slice(0, 6);
    } catch {
      return [];
    }
  }

  renderDetail(t, cx) {
    const p = props() ?? {};
    const docs = this.docsList ?? [];
    const blocks = parseMarkdownBlocks(this.docContent);

    return v_flex()
      .id("issue-detail-dialog")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          cx.stop_propagation();
          closeOverlay(p.overlay);
        }
      })
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.popover)
      .border(1)
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(12)
      // Header
      .child(
        h_flex()
          .h(46)
          .flex_none()
          .px(16)
          .justify_between()
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome)
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .flex_1()
              .min_w(0)
              .child(svg("mods/issue-panel/icons/issue.svg").size(16).flex_none().text_color(t.accent))
              .child(
                div()
                  .font_semibold()
                  .text_size(14)
                  .truncate()
                  .child(`Issue ${this.selectedIssueId || ""} · ${this.docName}`)
              )
              .when(Boolean(this.issueTitle), (el) =>
                el.child(div().text_size(11.5).text_color(t.muted).truncate().child(this.issueTitle))
              )
          )
          .child(
            h_flex()
              .gap(6)
              .flex_none()
              .items_center()
              .child(
                div()
                  .id("issue-dlg-copy-path")
                  .px(8)
                  .py(3)
                  .rounded(4)
                  .bg(this.copiedKind === "path" ? "#10b98122" : t.surface)
                  .border(1)
                  .border_color(this.copiedKind === "path" ? "#10b98155" : t.border)
                  .text_size(11)
                  .text_color(this.copiedKind === "path" ? "#10b981" : t.foreground)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => this.copyText("path", this.docPath, cx))
                  .child(this.copiedKind === "path" ? "已複製路徑 ✓" : "複製路徑")
              )
              .child(
                div()
                  .id("issue-dlg-copy-content")
                  .px(8)
                  .py(3)
                  .rounded(4)
                  .bg(this.copiedKind === "content" ? "#10b98122" : t.surface)
                  .border(1)
                  .border_color(this.copiedKind === "content" ? "#10b98155" : t.border)
                  .text_size(11)
                  .text_color(this.copiedKind === "content" ? "#10b981" : t.foreground)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => this.copyText("content", this.docContent, cx))
                  .child(this.copiedKind === "content" ? "已複製內容 ✓" : "複製內容")
              )
              .child(
                div()
                  .id("issue-dlg-close")
                  .px(8)
                  .py(3)
                  .rounded(4)
                  .text_size(12)
                  .text_color(t.dim)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    closeOverlay(p.overlay);
                  })
                  .child("Esc ✕")
              )
          )
      )
      // Body: Left doc list + Right markdown preview
      .child(
        h_flex()
          .flex_1()
          .min_h(0)
          .child(
            v_flex()
              .w(210)
              .flex_none()
              .h_full()
              .border_r(1)
              .border_color(t.border)
              .bg(t.chrome)
              .p(10)
              .gap(5)
              .child(div().text_size(10.5).font_semibold().text_color(t.dim).px(4).pb(2).child("交接文件"))
              .children(
                docs.map((d) => {
                  const active = d.name === this.docName;
                  return v_flex()
                    .id(`dlg-doc-${d.name}`)
                    .px(8)
                    .py(6)
                    .gap(2)
                    .rounded(6)
                    .bg(active ? t.accent + "22" : t.surface)
                    .border(1)
                    .border_color(active ? t.accent + "66" : t.border)
                    .when(d.exists, (el) =>
                      el
                        .cursor_pointer()
                        .hover((s) => s.bg(t.hover))
                        .on_click((_e, cx) => this.loadDoc(d.name, cx))
                    )
                    .child(
                      h_flex()
                        .justify_between()
                        .items_center()
                        .gap(4)
                        .child(
                          div()
                            .text_size(11.5)
                            .font_medium()
                            .truncate()
                            .text_color(d.exists ? (active ? t.accent : t.foreground) : t.dim)
                            .child(d.name)
                        )
                        .when(!d.exists, (el) =>
                          el.child(div().text_size(9.5).text_color(t.dim).child("待產出"))
                        )
                    )
                    .child(
                      div()
                        .text_size(10)
                        .text_color(d.exists ? t.muted : t.dim)
                        .child(d.exists ? `${d.label} · ${d.line_count} 行` : d.label)
                    );
                })
              )
          )
          .child(
            div()
              .flex_1()
              .min_w(0)
              .h_full()
              .relative()
              .bg(t.background)
              .child(
                v_flex()
                  .id("issue-doc-scroll")
                  .absolute()
                  .inset_0()
                  .overflow_y_scroll()
                  .p(20)
                  .gap(8)
                  .when(this.docLoading, (el) =>
                    el.child(div().text_color(t.dim).text_size(12).child("讀取文件中…"))
                  )
                  .when(!this.docLoading && Boolean(this.docError), (el) =>
                    el.child(
                      div()
                        .p(12)
                        .rounded(6)
                        .bg("#ef444422")
                        .border(1)
                        .border_color("#ef444455")
                        .text_color("#ef4444")
                        .child(`讀取失敗: ${this.docError}`)
                    )
                  )
                  .when(!this.docLoading && !this.docError && blocks.length === 0, (el) =>
                    el.child(div().text_color(t.dim).child("文件內容為空"))
                  )
                  .when(!this.docLoading && !this.docError && blocks.length > 0, (el) =>
                    el.children(
                      blocks.map((b) => {
                        if (b.type === "hr") {
                          return div().h(1).w_full().bg(t.border).my(4);
                        }
                        if (b.type === "heading") {
                          const size = b.level === 1 ? 18 : b.level === 2 ? 15 : b.level === 3 ? 13.5 : 12.5;
                          return div()
                            .text_size(size)
                            .font_bold()
                            .text_color(b.level <= 2 ? t.foreground : t.accent)
                            .pt(b.level === 1 ? 2 : 6)
                            .child(b.text);
                        }
                        if (b.type === "code") {
                          return v_flex()
                            .p(10)
                            .gap(4)
                            .rounded(6)
                            .bg(t.chrome)
                            .border(1)
                            .border_color(t.border)
                            .when(Boolean(b.lang), (c) =>
                              c.child(div().text_size(10).text_color(t.dim).child(b.lang))
                            )
                            .child(div().text_size(11.5).text_color(t.foreground).child(b.text));
                        }
                        if (b.type === "quote") {
                          return div()
                            .pl(10)
                            .py(4)
                            .border_l(2)
                            .border_color(t.accent)
                            .bg(t.surface)
                            .rounded(4)
                            .text_size(12)
                            .text_color(t.muted)
                            .child(b.text);
                        }
                        if (b.type === "list") {
                          return h_flex()
                            .pl(b.indent)
                            .gap(6)
                            .items_start()
                            .child(div().flex_none().text_size(12).text_color(t.accent).child(b.bullet))
                            .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).child(b.text));
                        }
                        return div().text_size(12.5).text_color(t.foreground).child(b.text);
                      })
                    )
                  )
              )
              .child(Scrollbar.vertical("issue-doc-scroll").absolute().inset_0())
          )
      )
      // Footer
      .child(
        h_flex()
          .h(26)
          .flex_none()
          .px(14)
          .justify_between()
          .items_center()
          .border_t(1)
          .border_color(t.border)
          .bg(t.chrome)
          .text_size(10.5)
          .text_color(t.dim)
          .child(div().truncate().child(this.docPath || ""))
          .child(div().flex_none().child(`${this.docLineCount} 行 · 更新於 ${this.docUpdatedAt || "–"}`))
      );
  }

  render() {
    const t = theme();
    if (this.isDetail) {
      return this.renderDetail(t, this._cx);
    }

    const data = this.data;
    const issues = data?.issues ?? [];
    const cur = data?.current ?? null;
    const st = statusStyle(cur?.status, t);
    const activeAgents = this.workspaceAgents();
    const paneList = panes?.() ?? [];
    const paneById = new Map(paneList.map((p) => [p.pane, p]));

    return v_flex()
      .size_full()
      .min_w(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(12)
      // Header Bar
      .child(
        h_flex()
          .h(40)
          .flex_none()
          .px(10)
          .justify_between()
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .flex_1()
              .min_w(0)
              .child(svg("mods/issue-panel/icons/issue.svg").size(15).flex_none().text_color(t.accent))
              .child(div().font_semibold().text_size(13).flex_none().child("Issue"))
              .child(
                div()
                  .px(5)
                  .py(1)
                  .rounded(4)
                  .bg(t.surface)
                  .border(1)
                  .border_color(t.border)
                  .text_size(10)
                  .text_color(t.muted)
                  .truncate()
                  .child(projectName(this.cwd))
              )
          )
          .child(
            h_flex()
              .gap(4)
              .flex_none()
              .items_center()
              .when(Boolean(this.lastSyncAt), (el) =>
                el.child(div().text_size(9.5).text_color(t.dim).child(this.lastSyncAt))
              )
              .child(
                div()
                  .id("btn-issue-refresh")
                  .size(24)
                  .flex_none()
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(5)
                  .text_color(this.loading ? t.accent : t.muted)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .tooltip("重新掃描 .ai_team")
                  .on_click((_e, cx) => this.loadWorkspace(cx))
                  .child(svg("mods/cursor-usage/icons/refresh.svg").size(13))
              )
              .child(
                div()
                  .id("btn-issue-close")
                  .size(24)
                  .flex_none()
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(5)
                  .text_color(t.dim)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .tooltip("隱藏面板")
                  .on_click(() => run("layout.hide", { id: "panel" }))
                  .child(div().text_size(12).child("✕"))
              )
          )
      )
      // Issue Switcher Bar (when multiple issues exist)
      .when(issues.length > 0, (el) =>
        el.child(
          h_flex()
            .px(10)
            .py(6)
            .gap(5)
            .flex_wrap()
            .border_b(1)
            .border_color(t.border)
            .bg(t.chrome)
            .children(
              issues.map((item) => {
                const selected = item.id === cur?.id;
                const warn = item.circuit_breaker;
                return div()
                  .id(`issue-tab-${item.id}`)
                  .px(7)
                  .py(2)
                  .rounded(4)
                  .bg(selected ? t.accent + "22" : t.surface)
                  .border(1)
                  .border_color(warn ? "#ef444488" : selected ? t.accent + "66" : t.border)
                  .text_size(10.5)
                  .font_medium()
                  .text_color(warn ? "#ef4444" : selected ? t.accent : t.muted)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    if (this.selectedIssueId === item.id) return;
                    this.selectedIssueId = item.id;
                    this.loadWorkspace(cx);
                  })
                  .child(`#${item.id}${warn ? " !" : ""}`);
              })
            )
        )
      )
      // Main Scrollable Body
      .child(
        div()
          .flex_1()
          .min_h(120)
          .relative()
          .child(
            v_flex()
              .id("issue-panel-scroll")
              .absolute()
              .inset_0()
              .overflow_y_scroll()
              .p(10)
              .gap(8)
              .when(Boolean(this.error), (el) =>
                el.child(
                  div()
                    .p(10)
                    .rounded(6)
                    .bg("#ef444422")
                    .border(1)
                    .border_color("#ef444455")
                    .text_size(11)
                    .text_color("#ef4444")
                    .child(`讀取失敗: ${this.error}`)
                )
              )
              .when(!this.error && !this.cwd, (el) =>
                el.child(
                  div()
                    .p(16)
                    .text_center()
                    .text_size(11.5)
                    .text_color(t.dim)
                    .child("請先聚焦或開啟一個工作區")
                )
              )
              .when(!this.error && Boolean(this.cwd) && !cur, (el) =>
                el.child(
                  v_flex()
                    .p(14)
                    .gap(4)
                    .rounded(7)
                    .bg(t.surface)
                    .border(1)
                    .border_color(t.border)
                    .child(div().font_medium().text_size(12).child("無進行中的 Issue"))
                    .child(
                      div()
                        .text_size(11)
                        .text_color(t.dim)
                        .child(data?.has_ai_team ? ".ai_team/ 內尚無 issue_* 目錄" : "此工作區尚未建立 .ai_team/ 目錄")
                    )
                )
              )
              // Status Overview Card
              .when(Boolean(cur), (el) =>
                el
                  .child(
                    v_flex()
                      .p(10)
                      .gap(8)
                      .rounded(7)
                      .bg(t.surface)
                      .border(1)
                      .border_color(cur.circuit_breaker ? "#ef444466" : t.border)
                      // Title + Status badge
                      .child(
                        h_flex()
                          .justify_between()
                          .items_start()
                          .gap(6)
                          .child(
                            div()
                              .flex_1()
                              .min_w(0)
                              .font_semibold()
                              .text_size(12.5)
                              .text_color(t.foreground)
                              .child(cur.title)
                          )
                          .child(
                            div()
                              .flex_none()
                              .px(6)
                              .py(2)
                              .rounded(4)
                              .bg(st.bg)
                              .border(1)
                              .border_color(st.border)
                              .text_size(9.5)
                              .font_semibold()
                              .text_color(st.fg)
                              .child(st.label)
                          )
                      )
                      // Circuit Breaker Warning
                      .when(cur.circuit_breaker, (w) =>
                        w.child(
                          div()
                            .px(8)
                            .py(5)
                            .rounded(5)
                            .bg("#ef444422")
                            .border(1)
                            .border_color("#ef444466")
                            .text_size(10.5)
                            .font_medium()
                            .text_color("#ef4444")
                            .child(
                              cur.status === "NEED_HUMAN"
                                ? "⚠ 已觸發人工介入（NEED_HUMAN）"
                                : `⚠ 重試次數已達上限 (${cur.retry_max}/3)，觸發熔斷告警`
                            )
                        )
                      )
                      // 5-Stage Stepper
                      .child(
                        v_flex()
                          .gap(4)
                          .child(
                            div()
                              .text_size(10)
                              .text_color(t.dim)
                              .child(`目前階段：${cur.stage_text || cur.stage_label}`)
                          )
                          .child(
                            h_flex()
                              .gap(3)
                              .children(
                                STAGES.map((s) => {
                                  const done = cur.stage > s.num || (cur.status === "DONE" && cur.stage >= s.num);
                                  const active = cur.stage === s.num && cur.status !== "DONE";
                                  const bg = done
                                    ? "#10b98122"
                                    : active
                                      ? (cur.circuit_breaker ? "#ef444422" : t.accent + "22")
                                      : t.chrome;
                                  const border = done
                                    ? "#10b98155"
                                    : active
                                      ? (cur.circuit_breaker ? "#ef444466" : t.accent + "66")
                                      : t.border;
                                  const fg = done
                                    ? "#10b981"
                                    : active
                                      ? (cur.circuit_breaker ? "#ef4444" : t.accent)
                                      : t.dim;
                                  return div()
                                    .flex_1()
                                    .min_w(0)
                                    .py(3)
                                    .px(2)
                                    .rounded(4)
                                    .bg(bg)
                                    .border(1)
                                    .border_color(border)
                                    .text_center()
                                    .text_size(9.5)
                                    .font_medium()
                                    .text_color(fg)
                                    .truncate()
                                    .child(s.label);
                                })
                              )
                          )
                      )
                      // Retry Counters
                      .child(
                        h_flex()
                          .gap(6)
                          .pt(2)
                          .children([
                            { label: "inv", val: cur.retries?.inv ?? 0 },
                            { label: "dev/qa", val: cur.retries?.dev_qa ?? 0 },
                            { label: "review", val: cur.retries?.review ?? 0 },
                          ].map((r) => {
                            const hot = r.val > 0;
                            const crit = r.val >= 3;
                            return h_flex()
                              .flex_1()
                              .px(6)
                              .py(3)
                              .rounded(4)
                              .justify_between()
                              .items_center()
                              .bg(crit ? "#ef444422" : hot ? "#f59e0b22" : t.chrome)
                              .border(1)
                              .border_color(crit ? "#ef444466" : hot ? "#f59e0b55" : t.border)
                              .child(div().text_size(10).text_color(t.muted).child(r.label))
                              .child(
                                div()
                                  .text_size(10.5)
                                  .font_semibold()
                                  .text_color(crit ? "#ef4444" : hot ? "#f59e0b" : t.foreground)
                                  .child(String(r.val))
                              );
                          }))
                      )
                  )
                  // Team / Agents Live Status Section
                  .child(
                    v_flex()
                      .p(9)
                      .gap(6)
                      .rounded(7)
                      .bg(t.surface)
                      .border(1)
                      .border_color(t.border)
                      .child(
                        h_flex()
                          .justify_between()
                          .items_center()
                          .child(div().font_semibold().text_size(11.5).child("組員即時狀態"))
                          .child(div().text_size(10).text_color(t.dim).child(`${activeAgents.length} 運作中`))
                      )
                      .when(activeAgents.length === 0, (el) =>
                        el.child(div().text_size(10.5).text_color(t.dim).child("目前工作區無活躍 Agent"))
                      )
                      .children(
                        activeAgents.map((a, idx) => {
                          const p = a.pane ? paneById.get(a.pane) : null;
                          const label = a.title || p?.title || a.program?.name || a.address;
                          const stName = a.status || "idle";
                          return h_flex()
                            .id(`issue-agent-${idx}`)
                            .px(7)
                            .py(4)
                            .gap(6)
                            .rounded(5)
                            .bg(t.chrome)
                            .border(1)
                            .border_color(t.border)
                            .items_center()
                            .justify_between()
                            .cursor_pointer()
                            .hover((s) => s.bg(t.hover))
                            .on_click(() => {
                              if (a.pane) run("pane.focus", { pane: a.pane });
                              else if (a.tab) run("tab.select", { id: a.tab });
                              else if (a.address) run("pane.focus", { terminal: a.address });
                            })
                            .child(
                              h_flex()
                                .gap(6)
                                .items_center()
                                .flex_1()
                                .min_w(0)
                                .child(div().size(6).rounded(3).flex_none().bg(agentDotColor(stName, t)))
                                .child(div().text_size(11).truncate().text_color(t.foreground).child(label))
                            )
                            .child(div().flex_none().text_size(10).text_color(t.dim).child(stName));
                        })
                      )
                  )
                  // Handoff Documents List
                  .child(
                    v_flex()
                      .p(9)
                      .gap(5)
                      .rounded(7)
                      .bg(t.surface)
                      .border(1)
                      .border_color(t.border)
                      .child(div().font_semibold().text_size(11.5).child("交接文件"))
                      .children(
                        (cur.docs ?? []).map((d) =>
                          h_flex()
                            .id(`issue-doc-${d.name}`)
                            .px(7)
                            .py(5)
                            .gap(6)
                            .rounded(5)
                            .bg(t.chrome)
                            .border(1)
                            .border_color(t.border)
                            .items_center()
                            .justify_between()
                            .when(d.exists, (btn) =>
                              btn
                                .cursor_pointer()
                                .hover((s) => s.bg(t.hover).border_color(t.accent + "55"))
                                .tooltip("點擊開啟大畫面預覽")
                                .on_click(() => this.openDetailDialog(d.name))
                            )
                            .child(
                              v_flex()
                                .flex_1()
                                .min_w(0)
                                .gap(1)
                                .child(
                                  div()
                                    .text_size(11)
                                    .font_medium()
                                    .truncate()
                                    .text_color(d.exists ? t.foreground : t.dim)
                                    .child(d.name)
                                )
                                .child(
                                  div()
                                    .text_size(9.5)
                                    .truncate()
                                    .text_color(d.exists ? t.muted : t.dim)
                                    .child(d.label)
                                )
                            )
                            .child(
                              d.exists
                                ? v_flex()
                                    .flex_none()
                                    .items_end()
                                    .gap(1)
                                    .child(div().text_size(9.5).text_color(t.accent).child(`${d.line_count} 行`))
                                    .child(div().text_size(9).text_color(t.dim).child(shortTime(d.updated_at)))
                                : div().flex_none().text_size(9.5).text_color(t.dim).child("待產出")
                            )
                        )
                      )
                  )
                  // Stage Logs
                  .when((cur.logs?.length ?? 0) > 0, (el) =>
                    el.child(
                      v_flex()
                        .p(9)
                        .gap(4)
                        .rounded(7)
                        .bg(t.surface)
                        .border(1)
                        .border_color(t.border)
                        .child(div().font_semibold().text_size(11.5).child("階段紀錄"))
                        .children(
                          cur.logs.map((log) =>
                            v_flex()
                              .p(6)
                              .gap(2)
                              .rounded(4)
                              .bg(t.chrome)
                              .child(div().text_size(9.5).font_semibold().text_color(t.accent).child(log.stage))
                              .child(div().text_size(10.5).text_color(t.muted).child(log.text))
                          )
                        )
                    )
                  )
              )
          )
          .child(Scrollbar.vertical("issue-panel-scroll").absolute().inset_0())
      );
  }
}
