import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { props, closeOverlay, theme, shared, setShared } from "herdr";
import { fetchAgentTaskFlow } from "./transcript.js";

export default class TaskFlowPopup extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();

    const p = props() ?? {};
    this.terminal = p.terminal ?? "";
    this.flow = p.flow ?? (this.terminal ? shared(`task-flow:${this.terminal}`) : null);
    this.expandedSteps = new Set(); // 預設精簡顯示最近 5 步，讓單一任務的 Prompt / 花費 / 過程 / 結果能一次全覽

    // 啟動時立刻非同步校驗最新狀態，保持 0 延遲開窗同時更新
    cx.spawn(async (cx) => {
      if (!this.terminal || !p.status) return;
      const fresh = await fetchAgentTaskFlow(this.terminal, p.cwd, p.title, p.status);
      if (fresh) {
        this.flow = fresh;
        setShared(`task-flow:${this.terminal}`, fresh);
        cx.notify();
      }
    });
  }

  toggleSteps(idx, cx) {
    if (this.expandedSteps.has(idx)) {
      this.expandedSteps.delete(idx);
    } else {
      this.expandedSteps.add(idx);
    }
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const flow = this.flow ?? p.flow ?? { tasks: [] };
    const status = p.status ?? null;
    const toolLive = status === "working";
    const rawTasks = flow.tasks ?? [];
    const tasks = rawTasks.slice().reverse();

    // 若 transcript 沒有帶 session_cost_str，嘗試從 cursor.sessionStats 補齊
    const sessStats = shared("cursor.sessionStats");
    const sessFallback = flow.conv_id && sessStats?.by_id?.[flow.conv_id] ? sessStats.by_id[flow.conv_id] : null;
    const sessionCostStr = flow.session_cost_str ?? sessFallback?.cost_str ?? null;
    const sessionCalls = flow.session_calls || sessFallback?.calls || 0;
    const sessionModels = flow.session_models?.length
      ? flow.session_models
      : sessFallback?.model
        ? [sessFallback.model]
        : [];

    return v_flex()
      .id("task-flow-popup")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          cx.stop_propagation();
          closeOverlay(p.overlay);
        }
      })
      .size_full()
      .min_h(0)
      .p(14)
      .gap(8)
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
          .gap(10)
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .flex_wrap()
              .child(div().font_semibold().text_size(15).text_color(t.foreground).child("📋 Task Flow & Session History"))
              .when(Boolean(this.terminal), (el) =>
                el.child(
                  div()
                    .px(7)
                    .py(2)
                    .rounded(4)
                    .bg(t.raised)
                    .border(1)
                    .border_color(t.border)
                    .text_size(11.5)
                    .font_semibold()
                    .text_color(t.accent)
                    .child(this.terminal)
                )
              )
              .when(Boolean(sessionCostStr), (el) =>
                el.child(
                  div()
                    .px(7)
                    .py(2)
                    .rounded(4)
                    .bg((t.ansi3 ?? "#f59e0b") + "1f")
                    .border(1)
                    .border_color((t.ansi3 ?? "#f59e0b") + "55")
                    .text_size(11.5)
                    .font_semibold()
                    .text_color(t.ansi3 ?? "#f59e0b")
                    .child(`Session 今日花費: ${sessionCostStr} (${sessionCalls} calls)`)
                )
              )
              .when(sessionModels.length > 0, (el) =>
                el.child(
                  div()
                    .px(7)
                    .py(2)
                    .rounded(4)
                    .bg(t.chrome)
                    .border(1)
                    .border_color(t.border)
                    .text_size(11)
                    .text_color(t.muted)
                    .child(sessionModels.join(", "))
                )
              )
          )
          .child(
            div()
              .p(4)
              .rounded(4)
              .text_color(t.dim)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => {
                cx.stop_propagation();
                closeOverlay(p.overlay);
              })
              .child(div().text_size(12).child("Esc ✕"))
          )
      )
      // Active Status / Latest Tool
      .when(Boolean(flow.latest_tool), (el) =>
        el.child(
          h_flex()
            .px(11)
            .py(7)
            .rounded(6)
            .bg(toolLive ? t.working + "18" : t.raised)
            .border(1)
            .border_color(toolLive ? t.working + "44" : t.border)
            .gap(8)
            .items_center()
            .child(div().text_color(toolLive ? t.working : t.dim).font_semibold().text_size(12).child(toolLive ? "⚡ 正在執行:" : "上一動:"))
            .child(div().flex_1().truncate().text_size(12).text_color(t.foreground).child(flow.latest_tool))
        )
      )
      // Scrollable Task History List
      .child(
        div()
          .flex_1()
          .min_h(220)
          .relative()
          .child(
            v_flex()
              .id("task-flow-scroll-list")
              .absolute()
              .inset_0()
              .overflow_y_scroll()
              .gap(12)
              .children(
                tasks.length === 0
                  ? [
                      div()
                        .p(28)
                        .text_center()
                        .text_color(t.muted)
                        .child("尚未記錄到歷史任務，請稍候或開始對話。"),
                    ]
                  : tasks.map((task, idx) => {
                      const isLatest = idx === 0;
                      const steps = task.steps ?? [];
                      const isExpanded = this.expandedSteps.has(idx);
                      const displaySteps = isExpanded ? steps : steps.slice(-5);
                      const hiddenStepsCount = steps.length - displaySteps.length;
                      const resultText = task.result || task.summary || "";

                      return v_flex()
                        .id(`task-card-${idx}`)
                        .p(11)
                        .gap(8)
                        .rounded(8)
                        .bg(isLatest ? t.raised : t.canvas)
                        .border(1)
                        .border_color(isLatest ? t.accent + "66" : t.border)
                        // Card Header: 狀態 + 時間 + 本次花費
                        .child(
                          h_flex()
                            .justify_between()
                            .items_center()
                            .gap(8)
                            .flex_wrap()
                            .child(
                              h_flex()
                                .gap(8)
                                .items_center()
                                .child(
                                  div()
                                    .px(7)
                                    .py(2)
                                    .rounded(4)
                                    .bg(isLatest ? t.working + "22" : t.raised)
                                    .text_size(11)
                                    .font_semibold()
                                    .text_color(isLatest ? t.working : t.dim)
                                    .child(isLatest ? "● 當前階段任務" : `✓ 歷史任務 #${tasks.length - idx}`)
                                )
                                .when(Boolean(task.time), (el) =>
                                  el.child(div().text_size(11).text_color(t.dim).child(task.time))
                                )
                                .when(task.models?.length > 0, (el) =>
                                  el.child(
                                    div()
                                      .px(6)
                                      .py(1.5)
                                      .rounded(4)
                                      .bg(t.chrome)
                                      .text_size(10.5)
                                      .text_color(t.muted)
                                      .child(task.models.join(", "))
                                  )
                                )
                            )
                            // 2. 本次花費
                            .child(
                              h_flex()
                                .gap(6)
                                .items_center()
                                .child(
                                  div()
                                    .px(8)
                                    .py(2)
                                    .rounded(4)
                                    .bg(task.cost_str ? t.accent + "1f" : t.chrome)
                                    .border(1)
                                    .border_color(task.cost_str ? t.accent + "55" : t.border)
                                    .text_size(11)
                                    .font_semibold()
                                    .text_color(task.cost_str ? t.accent : t.dim)
                                    .child(
                                      task.cost_str
                                        ? `💰 本次花費: ${task.cost_str}${task.calls ? ` · ${task.calls} calls` : ""}${task.tokens_str ? ` · ${task.tokens_str} tok` : ""}`
                                        : "💰 本次花費: —"
                                    )
                                )
                            )
                        )
                        // Card Body: 左欄 (Prompt + 實作過程) / 右欄 (最終結果)
                        .child(
                          h_flex()
                            .gap(10)
                            .items_stretch()
                            // 左欄：1. Prompt + 3. 實作過程
                            .child(
                              v_flex()
                                .flex_1()
                                .min_w(0)
                                .gap(8)
                                // 1. Prompt
                                .child(
                                  v_flex()
                                    .p(9)
                                    .gap(4)
                                    .rounded(6)
                                    .bg(t.background)
                                    .border(1)
                                    .border_color(t.border)
                                    .child(div().text_size(10.5).font_semibold().text_color(t.accent).child("1. Prompt"))
                                    .child(div().text_size(12.5).font_medium().text_color(t.foreground).child(task.prompt))
                                )
                                // 3. 實作過程
                                .when(steps.length > 0, (stepsContainer) =>
                                  stepsContainer.child(
                                    v_flex()
                                      .p(9)
                                      .gap(5)
                                      .rounded(6)
                                      .bg(t.background)
                                      .border(1)
                                      .border_color(t.border)
                                      .child(
                                        h_flex()
                                          .justify_between()
                                          .items_center()
                                          .child(
                                            div()
                                              .text_size(10.5)
                                              .font_semibold()
                                              .text_color(t.muted)
                                              .child(`3. 實作過程 (${steps.length} 個步驟)`)
                                          )
                                          .when(steps.length > 5, (btnEl) =>
                                            btnEl.child(
                                              div()
                                                .id(`toggle-steps-${idx}`)
                                                .px(6)
                                                .py(1.5)
                                                .rounded(4)
                                                .bg(t.chrome)
                                                .border(1)
                                                .border_color(t.border)
                                                .text_size(10.5)
                                                .text_color(t.accent)
                                                .cursor_pointer()
                                                .hover((s) => s.bg(t.hover))
                                                .on_click((_e, cx) => {
                                                  cx.stop_propagation();
                                                  this.toggleSteps(idx, cx);
                                                })
                                                .child(isExpanded ? "收合步驟 ▴" : `展開全部 ${steps.length} 步 ▾`)
                                            )
                                          )
                                      )
                                      .when(hiddenStepsCount > 0, (moreEl) =>
                                        moreEl.child(
                                          div()
                                            .text_size(10.5)
                                            .text_color(t.dim)
                                            .child(`... 尚有較早的 ${hiddenStepsCount} 個步驟（點擊右上角展開全部）`)
                                        )
                                      )
                                      .children(
                                        displaySteps.map((step, sIdx) => {
                                          const stepNo = (isExpanded ? 1 : steps.length - displaySteps.length + 1) + sIdx;
                                          return h_flex()
                                            .gap(6)
                                            .items_start()
                                            .text_size(11.5)
                                            .text_color(t.muted)
                                            .child(div().flex_none().text_color(t.dim).child(`${stepNo}.`))
                                            .child(div().flex_1().min_w(0).child(step));
                                        })
                                      )
                                  )
                                )
                            )
                            // 右欄：4. 最終結果
                            .when(Boolean(resultText), (sumEl) =>
                              sumEl.child(
                                v_flex()
                                  .flex_1()
                                  .min_w(0)
                                  .p(9)
                                  .gap(5)
                                  .rounded(6)
                                  .bg(t.chrome)
                                  .border(1)
                                  .border_color(t.border)
                                  .child(div().text_size(10.5).font_semibold().text_color(t.done ?? "#10b981").child("4. 最終結果"))
                                  .child(
                                    div()
                                      .text_size(12)
                                      .text_color(t.foreground)
                                      .child(resultText)
                                  )
                              )
                            )
                        );
                    })
              )
          )
          .child(Scrollbar.vertical("task-flow-scroll-list").absolute().inset_0())
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
              .child(`共 ${tasks.length} 個任務歷程 · 花費對齊今日 Cursor 用量快取`)
          )
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .child(flow.source === "screen" ? "來源: 終端畫面即時解析" : "來源: Cursor Agent Transcript")
          )
      );
  }
}
