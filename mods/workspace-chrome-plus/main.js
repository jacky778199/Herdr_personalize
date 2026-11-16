import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout, exec, appHome, nextCommand } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

export default class WorkspaceChrome extends View {
  init(props, cx) {
    this.quotaFormatted = "$163.97/$650";
    this.quotaPercent = 25.2;
    this.daysPassed = 11.2;
    this.daysTotal = 30.0;
    this.dayNum = 12;
    this.timePercent = 37.3;
    this.refreshing = false;
    if (props?.footer) {
      // Listen for mod commands (e.g. herdr-app do workspace-chrome-plus.refresh)
      cx.spawn(async (cx) => {
        for (;;) {
          const cmd = await nextCommand();
          if (cmd === "refresh" || cmd === "update") {
            this.manualRefresh(cx);
          }
        }
      });
      // Refresh every 1 hour (3600 seconds)
      cx.timer.every(3600 * 1000, (cx) => this.refreshQuota(cx));
      this.refreshQuota(cx);
    }
  }

  manualRefresh(cx) {
    this.refreshQuota(cx);
    try { run("cursor-usage.refresh"); } catch {}
  }

  refreshQuota(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const script = `${appHome()}/mods/workspace-chrome-plus/get_quota.py`;
        const res = await exec("python", [script], { timeout: 10000 });
        if (res.code === 0 && res.stdout.trim()) {
          try {
            const data = JSON.parse(res.stdout.trim());
            this.quotaFormatted = data.formatted ?? "$163.97/$650";
            this.quotaPercent = typeof data.percent === "number" ? data.percent : 25.2;
            this.daysPassed = typeof data.days_passed === "number" ? data.days_passed : 11.2;
            this.daysTotal = typeof data.days_total === "number" ? data.days_total : 30.0;
            this.dayNum = typeof data.day_num === "number" ? data.day_num : 12;
            this.timePercent = typeof data.time_percent === "number" ? data.time_percent : 37.3;
          } catch {
            this.quotaFormatted = res.stdout.trim();
          }
        }
      } catch (e) {
        // ignore
      } finally {
        this.refreshing = false;
        cx.notify();
      }
    });
  }

  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    if (props()?.footer) {
      const live = shared("cursor.liveQuota");
      const qFormatted = live?.formatted ?? this.quotaFormatted;
      const qDayNum = typeof live?.day_num === "number" ? live.day_num : this.dayNum;
      const qDaysTotal = typeof live?.days_total === "number" ? live.days_total : this.daysTotal;
      const pct = Math.max(0, Math.min(100, (typeof live?.percent === "number" ? live.percent : this.quotaPercent) ?? 0));
      const timePct = Math.max(0, Math.min(100, (typeof live?.time_percent === "number" ? live.time_percent : this.timePercent) ?? 0));

      // Bar color for quota
      let barColor = "#38bdf8";
      if (pct >= 80) {
        barColor = "#ef4444";
      } else if (pct >= 50) {
        barColor = "#f59e0b";
      }

      // Pacing evaluation: light status (燈號) based on spend % vs time elapsed %
      let paceColor = "#10b981"; // green (safe)
      let paceLabel = "安全";
      if (pct > timePct + 10) {
        paceColor = "#ef4444"; // red (over budget pacing)
        paceLabel = "超前";
      } else if (pct > timePct) {
        paceColor = "#f59e0b"; // amber (slightly ahead)
        paceLabel = "偏高";
      }

      const tooltipText = `Cursor用量: ${qFormatted} (${pct}%)\n週期進度: 第 ${qDayNum}/${Math.round(qDaysTotal)} 天 (${timePct}%)\n節奏狀態: ${paceLabel} (用量 ${pct}% vs 時間 ${timePct}%)\n點擊開啟右側用量細節面板`;

      const refreshBtn = div().id("quota-refresh-btn")
        .size(16).flex_none().flex().items_center().justify_center().rounded(4)
        .text_color(this.refreshing ? t.accent : t.muted)
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .cursor_pointer()
        .tooltip(this.refreshing ? "更新中…" : "手動更新用量")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.manualRefresh(cx);
        })
        .child(
          svg("mods/workspace-chrome-plus/refresh.svg")
            .size(11)
            .when(this.refreshing, el => el.spin(900).text_color(t.accent))
        );

      const quotaBlock = v_flex().id("quota-block").px(8).py(5).gap(3).rounded(8)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          this.manualRefresh(cx);
          run("layout.select", { stack: "panel-body", child: "usage" });
          run("layout.show", { id: "panel" });
        })
        .tooltip(tooltipText)
        // Row 1: Status light + Quota amount + Percentage + Refresh icon
        .child(
          h_flex().items_center().justify_between().w_full()
            .child(
              h_flex().gap(6).items_center()
                .child(div().size(7).rounded_full().bg(paceColor).flex_none())
                .child(div().text_size(12).font_medium().text_color(t.foreground).child(qFormatted))
            )
            .child(
              h_flex().gap(5).items_center()
                .child(div().text_size(11).font_semibold().text_color(barColor).child(`${pct}%`))
                .child(refreshBtn)
            )
        )
        // Row 2: Token usage bar
        .child(
          h_flex().w_full().h(4).rounded_full().overflow_hidden().bg(t.border)
            .child(div().h_full().rounded_full().bg(barColor).flex_grow(Math.max(0.5, pct)))
            .child(div().h_full().flex_grow(Math.max(0, 100 - pct)))
        )
        // Row 3: Time elapsed bar (並排緊鄰，方便直接視覺比較)
        .child(
          h_flex().w_full().h(3.5).rounded_full().overflow_hidden().bg(t.border)
            .child(div().h_full().rounded_full().bg(t.muted).flex_grow(Math.max(0.5, timePct)))
            .child(div().h_full().flex_grow(Math.max(0, 100 - timePct)))
        )
        // Row 4: Subtle day count text (換到 bar 下面，低調顯示)
        .child(
          h_flex().items_center().justify_between().w_full().pt(1)
            .child(
              div().text_size(10).text_color(t.dim).child(`第 ${qDayNum}/${Math.round(qDaysTotal)} 天`)
            )
            .child(
              div().text_size(10).text_color(t.dim).child(`時間 ${timePct}%`)
            )
        );

      const quotaBlockCollapsed = v_flex().id("quota-block-collapsed").w(32).py(4).gap(3).items_center().justify_center().rounded(8)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => this.manualRefresh(cx))
        .tooltip(this.refreshing ? "更新中…" : tooltipText)
        .child(
          this.refreshing
            ? svg("mods/workspace-chrome-plus/refresh.svg").size(10).text_color(t.accent).spin(900)
            : div().size(6).rounded_full().bg(paceColor)
        )
        .child(
          h_flex().w(22).h(3).rounded_full().overflow_hidden().bg(t.border)
            .child(div().h_full().rounded_full().bg(barColor).flex_grow(Math.max(0.5, pct)))
            .child(div().h_full().flex_grow(Math.max(0, 100 - pct)))
        )
        .child(
          h_flex().w(22).h(2.5).rounded_full().overflow_hidden().bg(t.border)
            .child(div().h_full().rounded_full().bg(t.muted).flex_grow(Math.max(0.5, timePct)))
            .child(div().h_full().flex_grow(Math.max(0, 100 - timePct)))
        );

      const row = (id, icon, label, dim, action) => h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(8)
        .when(collapsed, el => el.relative().w(32).px(0).justify_center().tooltip(label))
        .text_color(dim ? t.dim : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click(action).child(svg(`mods/workspace-chrome-plus/${icon}.svg`).size(14))
        .when(!collapsed, el => el.child(label));

      const ready = div().size(6).rounded_full().bg(t.accent);

      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(8).gap(2).text_size(13)
        .when(collapsed, el => el.px(0).items_center())
        .child(collapsed ? quotaBlockCollapsed : quotaBlock)
        .child(row("settings", "settings", "Settings", false, () => run("app.settings"))
          .when(Boolean(updates().app.ready), el => el.child(collapsed ? ready.absolute().top(5).right(6) : ready)))
        .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" })));
    }

    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 6 : 14).pr(10).gap(4).items_center().text_size(13.5)
      .when(window()?.platform === "macos" && !window()?.fullscreen && !collapsed, el => el.pl(76))
      .when(!collapsed, el => el.child(h_flex().flex_1().gap(8).items_center().child(image("frame/welcome/herdr.png").size(20).rounded(5)).child(div().font_semibold().text_color(t.foreground).child("Herdr"))))
      .when(!collapsed, el => el.child(this.button("search", svg("mods/workspace-chrome-plus/search.svg").size(15), () => run("mod.open", { name: "picker" }))))
      // On the macOS rail the traffic lights fill the row; the agents list's » unfolds it.
      .when(!(collapsed && window()?.platform === "macos"), el => el.child(this.button("sidebar-toggle", svg("mods/workspace-chrome-plus/sidebar.svg").size(15), toggleSidebar)));
  }
}
