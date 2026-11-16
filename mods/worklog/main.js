import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { theme, run, exec, appHome, props, checking, openOverlay, closeOverlay } from "herdr";

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function shiftDate(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return todayStr();
  d.setDate(d.getDate() + deltaDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export default class WorklogPanel extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.isDetail = p.mode === "detail";
    this.date = p.date || todayStr();
    this.selectedConvId = p.convId ?? null;
    this.data = p.initialData ?? null;
    this.loading = false;
    this.error = null;
    this.copied = false;
    this.expandedSteps = new Set();

    if (this.isDetail) {
      this.handle = cx.focus_handle();
      this.handle.focus();
    }

    if (!checking() && !this.data) {
      this.loadDate(this.date, cx);
    }
  }

  loadDate(dateStr, cx) {
    if (this.loading) return;
    this.date = dateStr;
    this.loading = true;
    this.error = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const script = `${appHome()}/mods/worklog/get_worklog.py`;
        const res = await exec("python", [script, "--date", dateStr], { timeout: 15000 });
        if (res.code === 0 && res.stdout.trim()) {
          const parsed = JSON.parse(res.stdout.trim());
          if (parsed?.ok) {
            this.data = parsed;
            this.error = null;
          } else {
            this.error = parsed?.error || "無法讀取工作日誌";
          }
        } else {
          this.error = res.stderr || "執行工作日誌腳本失敗";
        }
      } catch (err) {
        this.error = String(err);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  changeDate(delta, cx) {
    const next = shiftDate(this.date, delta);
    if (next > todayStr()) return;
    this.selectedConvId = null;
    this.loadDate(next, cx);
  }

  openDetailDialog(convId = null) {
    openOverlay({
      mod: "worklog",
      kind: "dialog",
      width: 0.88,
      height: 0.94,
      props: {
        mode: "detail",
        date: this.date,
        convId,
        initialData: this.data,
      },
    });
  }

  copyMarkdown(cx) {
    const md = this.data?.summary?.markdown;
    if (!md) return;
    cx.write_to_clipboard(md);
    this.copied = true;
    cx.notify();
    cx.timer.after(2000, (cx) => {
      this.copied = false;
      cx.notify();
    });
  }

  toggleSteps(key, cx) {
    if (this.expandedSteps.has(key)) this.expandedSteps.delete(key);
    else this.expandedSteps.add(key);
    cx.notify();
  }

  renderDateBar(t, summary, cx) {
    const isToday = this.date >= todayStr();
    return h_flex()
      .px(10)
      .py(7)
      .gap(6)
      .items_center()
      .justify_between()
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome)
      .child(
        h_flex()
          .gap(4)
          .items_center()
          .child(
            div()
              .id("wl-prev-day")
              .px(7)
              .py(2.5)
              .rounded(4)
              .bg(t.surface)
              .border(1)
              .border_color(t.border)
              .text_size(11)
              .text_color(t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .tooltip("前一天")
              .on_click((_e, cx) => this.changeDate(-1, cx))
              .child("◀")
          )
          .child(
            div()
              .px(8)
              .py(2.5)
              .rounded(4)
              .bg(t.surface)
              .border(1)
              .border_color(t.border)
              .text_size(11.5)
              .font_semibold()
              .text_color(t.foreground)
              .child(`${this.date}${summary?.weekday ? ` (${summary.weekday})` : ""}`)
          )
          .child(
            div()
              .id("wl-next-day")
              .px(7)
              .py(2.5)
              .rounded(4)
              .bg(t.surface)
              .border(1)
              .border_color(t.border)
              .text_size(11)
              .text_color(isToday ? t.dim + "66" : t.muted)
              .when(!isToday, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
              .tooltip(isToday ? "已是今天" : "後一天")
              .on_click((_e, cx) => {
                if (!isToday) this.changeDate(1, cx);
              })
              .child("▶")
          )
      )
      .child(
        h_flex()
          .gap(4)
          .items_center()
          .when(!isToday, (btn) =>
            btn.child(
              div()
                .id("wl-today-btn")
                .px(6)
                .py(2.5)
                .rounded(4)
                .bg(t.accent + "22")
                .border(1)
                .border_color(t.accent + "55")
                .text_size(10.5)
                .font_semibold()
                .text_color(t.accent)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => {
                  this.selectedConvId = null;
                  this.loadDate(todayStr(), cx);
                })
                .child("回今天")
            )
          )
          .child(
            div()
              .id("wl-copy-md")
              .px(7)
              .py(2.5)
              .rounded(4)
              .bg(this.copied ? "#10b98122" : t.surface)
              .border(1)
              .border_color(this.copied ? "#10b98155" : t.border)
              .text_size(10.5)
              .font_medium()
              .text_color(this.copied ? "#10b981" : t.foreground)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .tooltip("複製當日 Markdown 工作日誌")
              .on_click((_e, cx) => this.copyMarkdown(cx))
              .child(this.copied ? "已複製 ✓" : "📋 複製日報")
          )
      );
  }

  renderKpiStrip(t, summary) {
    return h_flex()
      .px(10)
      .py(8)
      .gap(6)
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome)
      .children([
        v_flex()
          .flex_1()
          .p(6)
          .rounded(6)
          .bg(t.surface)
          .gap(1)
          .child(div().text_size(10).text_color(t.dim).child("完成任務"))
          .child(div().text_size(13).font_bold().text_color(t.accent).child(`${summary.task_count ?? 0}`)),
        v_flex()
          .flex_1()
          .p(6)
          .rounded(6)
          .bg(t.surface)
          .gap(1)
          .child(div().text_size(10).text_color(t.dim).child("工作階段"))
          .child(div().text_size(13).font_bold().text_color(t.foreground).child(`${summary.session_count ?? 0}`)),
        v_flex()
          .flex_1()
          .p(6)
          .rounded(6)
          .bg(t.surface)
          .gap(1)
          .child(div().text_size(10).text_color(t.dim).child("異動檔案"))
          .child(div().text_size(13).font_bold().text_color("#10b981").child(`${summary.files_count ?? 0}`)),
        v_flex()
          .flex_1()
          .p(6)
          .rounded(6)
          .bg(t.surface)
          .gap(1)
          .child(div().text_size(10).text_color(t.dim).child("當日花費"))
          .child(div().text_size(12.5).font_semibold().text_color(summary.cost_str ? (t.ansi3 ?? "#f59e0b") : t.dim).child(summary.cost_str || "—")),
      ]);
  }

  renderDetail(t, summary, sessions, cx) {
    const p = props() ?? {};
    const shownSessions = this.selectedConvId
      ? sessions.filter((s) => s.conv_id === this.selectedConvId)
      : sessions;

    return v_flex()
      .id("worklog-detail-dialog")
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
              .child(svg("mods/task-notes/book.svg").size(16).flex_none().text_color(t.accent))
              .child(div().font_semibold().text_size(15).child(`工作日誌總覽 · ${this.date}`))
              .when(Boolean(summary?.weekday), (el) =>
                el.child(div().text_size(12).text_color(t.muted).child(`(${summary.weekday})`))
              )
          )
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(
                div()
                  .id("wl-dlg-refresh")
                  .px(7)
                  .py(3)
                  .rounded(4)
                  .bg(t.surface)
                  .border(1)
                  .border_color(t.border)
                  .text_size(11)
                  .text_color(this.loading ? t.accent : t.muted)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => this.loadDate(this.date, cx))
                  .child(this.loading ? "載入中…" : "↻ 重新整理")
              )
              .child(
                div()
                  .id("wl-dlg-close")
                  .px(7)
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
      .child(this.renderDateBar(t, summary, cx))
      .child(this.renderKpiStrip(t, summary))
      // Session Filter Pills
      .when(sessions.length > 1, (bar) =>
        bar.child(
          h_flex()
            .px(12)
            .py(7)
            .gap(6)
            .flex_wrap()
            .border_b(1)
            .border_color(t.border)
            .bg(t.background)
            .child(
              div()
                .id("wl-filter-all")
                .px(8)
                .py(2.5)
                .rounded(5)
                .cursor_pointer()
                .text_size(11)
                .font_medium()
                .bg(!this.selectedConvId ? t.selected : t.surface)
                .border(1)
                .border_color(!this.selectedConvId ? t.accent + "66" : t.border)
                .text_color(!this.selectedConvId ? t.foreground : t.muted)
                .on_click((_e, cx) => {
                  this.selectedConvId = null;
                  cx.notify();
                })
                .child(`全部 (${sessions.length})`)
            )
            .children(
              sessions.map((s, idx) => {
                const active = this.selectedConvId === s.conv_id;
                return div()
                  .id(`wl-filter-${idx}`)
                  .px(8)
                  .py(2.5)
                  .rounded(5)
                  .cursor_pointer()
                  .text_size(11)
                  .bg(active ? t.selected : t.surface)
                  .border(1)
                  .border_color(active ? t.accent + "66" : t.border)
                  .text_color(active ? t.foreground : t.muted)
                  .hover((st) => st.bg(t.hover))
                  .on_click((_e, cx) => {
                    this.selectedConvId = s.conv_id;
                    cx.notify();
                  })
                  .child(`[${s.project}] ${s.title}`);
              })
            )
        )
      )
      // Main Scroll Content
      .child(
        div()
          .flex_1()
          .min_h(200)
          .relative()
          .child(
            v_flex()
              .id("worklog-detail-scroll")
              .absolute()
              .inset_0()
              .overflow_y_scroll()
              .p(14)
              .gap(12)
              .when(shownSessions.length === 0, (emptyEl) =>
                emptyEl.child(
                  div()
                    .p(28)
                    .text_center()
                    .text_color(t.muted)
                    .child(this.loading ? "正在彙整當日活動紀錄…" : `${this.date} 尚無 Cursor Agent 活動紀錄`)
                )
              )
              .children(
                shownSessions.map((sess, sIdx) =>
                  v_flex()
                    .id(`wl-detail-sess-${sIdx}`)
                    .p(12)
                    .gap(10)
                    .rounded(8)
                    .bg(t.surface)
                    .border(1)
                    .border_color(t.border)
                    // Session Header
                    .child(
                      h_flex()
                        .justify_between()
                        .items_center()
                        .gap(8)
                        .flex_wrap()
                        .child(
                          h_flex()
                            .gap(7)
                            .items_center()
                            .child(
                              div()
                                .px(6)
                                .py(1.5)
                                .rounded(4)
                                .bg(t.accent + "22")
                                .text_size(10.5)
                                .font_semibold()
                                .text_color(t.accent)
                                .child(sess.project)
                            )
                            .child(div().font_semibold().text_size(13.5).text_color(t.foreground).child(sess.title))
                            .when(Boolean(sess.time_range), (el) =>
                              el.child(div().text_size(11).text_color(t.dim).child(sess.time_range))
                            )
                        )
                        .child(
                          h_flex()
                            .gap(6)
                            .items_center()
                            .child(div().text_size(11).text_color(t.muted).child(`${sess.turn_count} 項任務 · ${sess.steps_count} 步驟`))
                            .when(Boolean(sess.cost_str), (el) =>
                              el.child(
                                div()
                                  .px(7)
                                  .py(1.5)
                                  .rounded(4)
                                  .bg((t.ansi3 ?? "#f59e0b") + "1f")
                                  .text_size(11)
                                  .font_semibold()
                                  .text_color(t.ansi3 ?? "#f59e0b")
                                  .child(sess.cost_str)
                              )
                            )
                        )
                    )
                    // Modified files chips
                    .when(sess.files_modified?.length > 0, (fWrap) =>
                      fWrap.child(
                        h_flex()
                          .gap(5)
                          .flex_wrap()
                          .items_center()
                          .child(div().text_size(10.5).text_color(t.dim).child("異動檔案:"))
                          .children(
                            sess.files_modified.slice(0, 12).map((fn) =>
                              div()
                                .px(5)
                                .py(1)
                                .rounded(4)
                                .bg(t.chrome)
                                .border(1)
                                .border_color(t.border)
                                .text_size(10)
                                .text_color("#10b981")
                                .child(fn)
                            )
                          )
                      )
                    )
                    // Turns (2-column cards)
                    .children(
                      (sess.turns ?? []).slice().reverse().map((tk, tIdx) => {
                        const key = `${sess.conv_id}-${tIdx}`;
                        const steps = tk.steps ?? [];
                        const expanded = this.expandedSteps.has(key);
                        const shownSteps = expanded ? steps : steps.slice(-4);
                        const resultText = tk.result || tk.result_short || "";

                        return v_flex()
                          .id(`wl-turn-${sIdx}-${tIdx}`)
                          .p(10)
                          .gap(8)
                          .rounded(7)
                          .bg(t.background)
                          .border(1)
                          .border_color(t.border)
                          .child(
                            h_flex()
                              .justify_between()
                              .items_center()
                              .child(
                                h_flex()
                                  .gap(6)
                                  .items_center()
                                  .child(div().text_size(10.5).font_semibold().text_color(t.accent).child(`任務 #${sess.turns.length - tIdx}`))
                                  .when(Boolean(tk.time), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(tk.time)))
                              )
                              .when(Boolean(tk.cost_str), (el) =>
                                el.child(
                                  div()
                                    .text_size(10.5)
                                    .font_semibold()
                                    .text_color(t.accent)
                                    .child(`${tk.cost_str}${tk.tokens_str ? ` · ${tk.tokens_str}` : ""}`)
                                )
                              )
                          )
                          .child(
                            h_flex()
                              .gap(10)
                              .items_stretch()
                              .child(
                                v_flex()
                                  .flex_1()
                                  .min_w(0)
                                  .gap(6)
                                  .child(
                                    v_flex()
                                      .p(8)
                                      .gap(3)
                                      .rounded(5)
                                      .bg(t.chrome)
                                      .child(div().text_size(10).font_semibold().text_color(t.accent).child("做了什麼 (Prompt)"))
                                      .child(div().text_size(12).text_color(t.foreground).child(tk.prompt))
                                  )
                                  .when(steps.length > 0, (stEl) =>
                                    stEl.child(
                                      v_flex()
                                        .p(8)
                                        .gap(4)
                                        .rounded(5)
                                        .bg(t.chrome)
                                        .child(
                                          h_flex()
                                            .justify_between()
                                            .items_center()
                                            .child(div().text_size(10).font_semibold().text_color(t.muted).child(`實作步驟 (${steps.length})`))
                                            .when(steps.length > 4, (b) =>
                                              b.child(
                                                div()
                                                  .id(`wl-step-toggle-${sIdx}-${tIdx}`)
                                                  .text_size(10)
                                                  .text_color(t.accent)
                                                  .cursor_pointer()
                                                  .on_click((_e, cx) => this.toggleSteps(key, cx))
                                                  .child(expanded ? "收合 ▴" : `展開全部 ${steps.length} 步 ▾`)
                                              )
                                            )
                                        )
                                        .children(
                                          shownSteps.map((st, si) =>
                                            div().text_size(11).text_color(t.muted).child(`${(expanded ? 1 : steps.length - shownSteps.length + 1) + si}. ${st}`)
                                          )
                                        )
                                    )
                                  )
                              )
                              .when(Boolean(resultText), (resEl) =>
                                resEl.child(
                                  v_flex()
                                    .flex_1()
                                    .min_w(0)
                                    .p(8)
                                    .gap(4)
                                    .rounded(5)
                                    .bg(t.chrome)
                                    .child(div().text_size(10).font_semibold().text_color("#10b981").child("完成了什麼 (最終結果)"))
                                    .child(div().text_size(11.5).text_color(t.foreground).child(resultText))
                                )
                              )
                          );
                      })
                    )
                )
              )
          )
          .child(Scrollbar.vertical("worklog-detail-scroll").absolute().inset_0())
      );
  }

  render(cx) {
    const t = theme();
    const summary = this.data?.summary ?? {
      date: this.date,
      weekday: "",
      session_count: 0,
      task_count: 0,
      steps_count: 0,
      files_count: 0,
      cost_str: null,
    };
    const sessions = this.data?.sessions ?? [];

    if (this.isDetail) {
      return this.renderDetail(t, summary, sessions, cx);
    }

    // Right Side Panel Mode (Concise Daily Summary + Click to Expand)
    return v_flex()
      .id("worklog-panel")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(12)
      // Panel Header (42px)
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(12)
          .gap(8)
          .items_center()
          .justify_between()
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome)
          .child(
            h_flex()
              .gap(7)
              .items_center()
              .child(svg("mods/task-notes/book.svg").size(15).flex_none().text_color(t.accent))
              .child(div().font_semibold().text_size(13).child("工作日誌"))
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
                  .child(summary.is_today ? "今日" : this.date.slice(5))
              )
          )
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .child(
                div()
                  .id("btn-wl-expand")
                  .px(6)
                  .py(3)
                  .rounded(5)
                  .bg(t.surface)
                  .border(1)
                  .border_color(t.border)
                  .text_size(10.5)
                  .font_medium()
                  .text_color(t.accent)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .tooltip("展開大畫面檢視完整任務細節與匯出日報")
                  .on_click(() => this.openDetailDialog(null))
                  .child("⤢ 展開")
              )
              .child(
                div()
                  .id("btn-wl-refresh")
                  .size(24)
                  .flex_none()
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(5)
                  .text_color(this.loading ? t.accent : t.muted)
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .cursor_pointer()
                  .tooltip("重新掃描當日活動")
                  .on_click((_e, cx) => this.loadDate(this.date, cx))
                  .child(
                    svg("mods/cursor-usage/icons/refresh.svg")
                      .size(13)
                      .when(this.loading, (el) => el.spin(900).text_color(t.accent))
                  )
              )
              .child(
                div()
                  .id("btn-wl-close")
                  .size(24)
                  .flex_none()
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(5)
                  .text_color(t.dim)
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .cursor_pointer()
                  .tooltip("隱藏側欄面板")
                  .on_click(() => run("layout.hide", { id: "panel" }))
                  .child(div().text_size(12).child("✕"))
              )
          )
      )
      .child(this.renderDateBar(t, summary, cx))
      .child(this.renderKpiStrip(t, summary))
      // Scrollable Concise Session Cards
      .child(
        div()
          .flex_1()
          .min_h(180)
          .relative()
          .child(
            v_flex()
              .id("worklog-scroll-list")
              .absolute()
              .inset_0()
              .overflow_y_scroll()
              .p(10)
              .gap(8)
              .when(Boolean(this.error), (el) =>
                el.child(
                  div()
                    .p(12)
                    .rounded(7)
                    .bg(t.surface)
                    .text_color(t.dim)
                    .child(`讀取失敗: ${this.error}`)
                )
              )
              .when(!this.error && sessions.length === 0, (emptyEl) =>
                emptyEl.child(
                  div()
                    .p(20)
                    .text_center()
                    .text_size(11.5)
                    .text_color(t.dim)
                    .child(this.loading ? "正在整理當日活動紀錄…" : `${this.date} 尚無任務紀錄`)
                )
              )
              .children(
                sessions.map((sess, idx) =>
                  v_flex()
                    .id(`wl-card-${idx}`)
                    .p(9)
                    .gap(6)
                    .rounded(7)
                    .bg(t.surface)
                    .border(1)
                    .border_color(t.border)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).border_color(t.accent + "55"))
                    .tooltip("點擊展開大畫面查看完整細節")
                    .on_click(() => this.openDetailDialog(sess.conv_id))
                    // Row 1: Project + Session Title + Cost
                    .child(
                      h_flex()
                        .justify_between()
                        .items_center()
                        .gap(6)
                        .child(
                          h_flex()
                            .gap(5)
                            .items_center()
                            .flex_1()
                            .min_w(0)
                            .child(
                              div()
                                .px(5)
                                .py(1)
                                .rounded(4)
                                .flex_none()
                                .bg(t.accent + "22")
                                .text_size(9.5)
                                .font_semibold()
                                .text_color(t.accent)
                                .child(sess.project)
                            )
                            .child(div().font_semibold().text_size(12).text_color(t.foreground).truncate().child(sess.title))
                        )
                        .when(Boolean(sess.cost_str), (el) =>
                          el.child(
                            div()
                              .flex_none()
                              .text_size(11)
                              .font_semibold()
                              .text_color(t.accent)
                              .child(sess.cost_str)
                          )
                        )
                    )
                    // Row 2: Time + Counts
                    .child(
                      h_flex()
                        .justify_between()
                        .items_center()
                        .text_size(10)
                        .text_color(t.dim)
                        .child(div().child(`${sess.time_range || "今日"} · ${sess.turn_count} 項任務 · ${sess.steps_count} 步驟`))
                        .when(sess.files_modified?.length > 0, (el) =>
                          el.child(div().text_color("#10b981").child(`改 ${sess.files_modified.length} 檔`))
                        )
                    )
                    // Row 3: Concise tasks list (做了什麼 / 完成了什麼)
                    .child(
                      v_flex()
                        .gap(4)
                        .pt(2)
                        .children(
                          (sess.turns ?? []).slice(-3).reverse().map((tk) =>
                            v_flex()
                              .p(6)
                              .gap(2)
                              .rounded(5)
                              .bg(t.chrome)
                              .child(
                                h_flex()
                                  .gap(5)
                                  .items_center()
                                  .when(Boolean(tk.time), (el) => el.child(div().flex_none().text_size(9.5).text_color(t.dim).child(tk.time)))
                                  .child(div().flex_1().min_w(0).truncate().text_size(11).font_medium().text_color(t.foreground).child(`• ${tk.prompt_short}`))
                              )
                              .when(Boolean(tk.result_short), (el) =>
                                el.child(
                                  div()
                                    .text_size(10.5)
                                    .text_color(t.muted)
                                    .truncate()
                                    .child(`✓ ${tk.result_short}`)
                                )
                              )
                          )
                        )
                        .when((sess.turns?.length ?? 0) > 3, (more) =>
                          more.child(
                            div()
                              .text_size(10)
                              .text_color(t.accent)
                              .child(`+ 還有 ${sess.turns.length - 3} 項任務（點擊展開查看全部）`)
                          )
                        )
                    )
                )
              )
          )
          .child(Scrollbar.vertical("worklog-scroll-list").absolute().inset_0())
      )
      // Footer
      .child(
        h_flex()
          .h(26)
          .flex_none()
          .px(12)
          .justify_between()
          .items_center()
          .border_t(1)
          .border_color(t.border)
          .bg(t.chrome)
          .text_size(10.5)
          .text_color(t.dim)
          .child(div().child(`更新於 ${this.data?.generated_at ?? "–"}`))
          .child(div().child("點擊卡片展開大畫面"))
      );
  }
}
