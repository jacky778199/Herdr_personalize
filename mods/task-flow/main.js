import { View, div, svg } from "gpui-kit";
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

    // 啟動時立刻非同步快速校驗最新狀態 (約 30ms-50ms)，保持 0 延遲開窗同時更新
    cx.spawn(async (cx) => {
      if (!this.terminal) return;
      if (!p.status) return;
      const fresh = await fetchAgentTaskFlow(this.terminal, p.cwd, p.title, p.status);
      if (fresh) {
        this.flow = fresh;
        setShared(`task-flow:${this.terminal}`, fresh);
        cx.notify();
      }
    });
  }

  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const flow = this.flow ?? p.flow ?? { tasks: [] };
    const status = p.status ?? null;
    const toolLive = status === "working";
    const rawTasks = flow.tasks ?? [];
    // 最新的任務排在最上方
    const tasks = rawTasks.slice().reverse();

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
              .child(div().font_semibold().text_size(14).text_color(t.foreground).child("📋 Task Flow & Session History"))
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
      // Active Status / Latest Tool
      .when(Boolean(flow.latest_tool), (el) =>
        el.child(
          h_flex()
            .px(10)
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
      // Scrollable Task History List (使用 GPUI 標準 Scrollbar 容器，徹底避免折疊消失)
      .child(
        div()
          .flex_1()
          .min_h(180)
          .relative()
          .child(
            v_flex()
              .id("task-flow-scroll-list")
              .absolute()
              .inset_0()
              .overflow_y_scroll()
              .gap(10)
              .children(
                tasks.length === 0
                  ? [
                      div()
                        .p(24)
                        .text_center()
                        .text_color(t.muted)
                        .child("尚未記錄到歷史任務，請稍候或開始對話。"),
                    ]
                  : tasks.map((task, idx) => {
                      const isLatest = idx === 0;
                      const steps = task.steps ?? [];
                      const displaySteps = steps.slice(-6);
                      const hiddenStepsCount = steps.length - displaySteps.length;

                      return v_flex()
                        .id(`task-card-${idx}`)
                        .p(12)
                        .gap(8)
                        .rounded(8)
                        .bg(isLatest ? t.raised : t.canvas)
                        .border(1)
                        .border_color(isLatest ? t.accent + "66" : t.border)
                        // Task Header
                        .child(
                          h_flex()
                            .justify_between()
                            .items_center()
                            .child(
                              h_flex()
                                .gap(6)
                                .items_center()
                                .child(
                                  div()
                                    .px(6)
                                    .py(1.5)
                                    .rounded(4)
                                    .bg(isLatest ? t.working + "22" : t.raised)
                                    .text_size(10.5)
                                    .font_semibold()
                                    .text_color(isLatest ? t.working : t.dim)
                                    .child(isLatest ? "● 當前階段任務" : `✓ 歷史任務 ${tasks.length - idx}`)
                                )
                                .when(steps.length > 0, (el) =>
                                  el.child(
                                    div()
                                      .text_size(10.5)
                                      .text_color(t.dim)
                                      .child(`(${steps.length} 個步驟)`)
                                  )
                                )
                            )
                        )
                        // Prompt / Query Text
                        .child(
                          div()
                            .text_size(12.8)
                            .font_semibold()
                            .text_color(t.foreground)
                            .child(task.prompt)
                        )
                        // Steps List
                        .when(steps.length > 0, (stepsContainer) =>
                          stepsContainer.child(
                            v_flex()
                              .p(8)
                              .gap(4)
                              .rounded(6)
                              .bg(t.background)
                              .border(1)
                              .border_color(t.border)
                              .when(hiddenStepsCount > 0, (moreEl) =>
                                moreEl.child(
                                  div()
                                    .text_size(10.5)
                                    .text_color(t.dim)
                                    .child(`... 隱藏更早的 ${hiddenStepsCount} 個步驟`)
                                )
                              )
                              .children(
                                displaySteps.map((step) =>
                                  h_flex()
                                    .gap(6)
                                    .text_size(11.5)
                                    .text_color(t.muted)
                                    .child(div().text_color(t.accent).child("➔"))
                                    .child(div().flex_1().truncate().child(step))
                                )
                              )
                          )
                        )
                        // Summary / Conclusion
                        .when(Boolean(task.summary), (sumEl) =>
                          sumEl.child(
                            h_flex()
                              .p(8)
                              .gap(6)
                              .rounded(6)
                              .bg(t.raised)
                              .border(1)
                              .border_color(t.border)
                              .child(div().text_size(11.5).child("🏁"))
                              .child(
                                div()
                                  .flex_1()
                                  .text_size(11.5)
                                  .text_color(t.foreground)
                                  .child(task.summary)
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
              .child(`共 ${tasks.length} 個任務歷程 · 來源: Cursor Agent Transcript / 畫面解析`)
          )
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .child("按 Esc 關閉")
          )
      );
  }
}
