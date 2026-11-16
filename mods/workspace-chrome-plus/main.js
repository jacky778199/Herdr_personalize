import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout, exec, appHome, nextCommand, hc, checking } from "herdr";

// How often the title light asks herdr-core whether it is still answering.
const HEALTH_EVERY = 4000;

function healthMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// A healthy in-app status check here is about 1–2s. Only a clearly worse result changes the light.
function healthLevel(prev, coreMs, lagMs, ok) {
  const core = coreMs ?? Infinity;
  const lag = lagMs ?? 0;
  const bad = !ok || core >= 6000 || lag >= 2500;
  const slow = core >= 3500 || lag >= 1200;
  if (bad) return "bad";
  if (prev === "bad") return ok && core < 4000 && lag < 1500 ? (slow ? "slow" : "ok") : "bad";
  if (slow || (prev === "slow" && (core >= 2800 || lag >= 800))) return "slow";
  return "ok";
}

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
    } else if (!checking()) {
      this.healthLevel = "unknown";
      this.healthCoreMs = null;
      this.healthLagMs = 0;
      this.healthOk = true;
      this.healthBusy = false;
      this.healthDue = Date.now() + HEALTH_EVERY;
      cx.timer.every(HEALTH_EVERY, (cx) => this.probeHealth(cx));
      this.probeHealth(cx);
    }
  }

  probeHealth(cx) {
    const now = Date.now();
    const lagMs = Math.max(0, now - (this.healthDue || now));
    this.healthDue = now + HEALTH_EVERY;
    if (this.healthBusy) {
      this.applyHealth(cx, now - this.healthStarted, lagMs, false);
      return;
    }
    this.healthBusy = true;
    this.healthStarted = now;
    cx.spawn(async (cx) => {
      let coreMs = null;
      let ok = false;
      try {
        const res = await hc(["server", "status", "--json"]);
        coreMs = Date.now() - this.healthStarted;
        ok = res.code === 0;
      } catch {
        coreMs = Date.now() - this.healthStarted;
      } finally {
        this.healthBusy = false;
      }
      this.applyHealth(cx, coreMs, lagMs, ok);
    });
  }

  applyHealth(cx, coreMs, lagMs, ok) {
    const level = healthLevel(this.healthLevel, coreMs, lagMs, ok);
    const coreChanged = this.healthCoreMs == null || Math.abs((coreMs ?? 0) - this.healthCoreMs) > 200;
    const lagChanged = Math.abs((lagMs ?? 0) - (this.healthLagMs ?? 0)) > 200;
    const changed = level !== this.healthLevel || ok !== this.healthOk || coreChanged || lagChanged;
    this.healthLevel = level;
    this.healthCoreMs = coreMs;
    this.healthLagMs = lagMs;
    this.healthOk = ok;
    if (changed) cx.notify();
  }

  healthLight(compact) {
    const t = theme();
    const level = this.healthLevel ?? "unknown";
    const color = level === "ok" ? "#10b981" : level === "slow" ? "#f59e0b" : level === "bad" ? "#ef4444" : (t.dim ?? t.muted);
    const label = level === "ok" ? "正常" : level === "slow" ? "偏慢" : level === "bad" ? "緩慢" : "偵測中";
    const coreText = this.healthOk ? healthMs(this.healthCoreMs) : (this.healthBusy ? `已等待 ${healthMs(this.healthCoreMs)}` : "無回應");
    const tip = `Herdr ${label}\n核心回應 ${coreText}\n介面延遲 ${healthMs(this.healthLagMs)}`;
    const dot = div().size(10).flex_none().rounded_full().bg(color)
      .when(level === "slow" || level === "bad", (el) => el.loop("opacity", { from: 0.35, to: 1, period: level === "bad" ? 700 : 1200 }));
    return h_flex().id("herdr-health").gap(5).items_center().flex_none().tooltip(tip)
      .child(dot)
      .when(!compact, (el) => el.child(div().text_size(12).font_medium().text_color(color).child(label)));
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
      .when(!collapsed, el => el.child(h_flex().flex_1().gap(8).items_center().child(image("frame/welcome/herdr.png").size(20).rounded(5)).child(h_flex().gap(6).items_center().child(div().font_semibold().text_color(t.foreground).child("Herdr")).child(this.healthLight(false)))))
      .when(collapsed && window()?.platform !== "macos", el => el.child(this.healthLight(true)))
      .when(!collapsed, el => el.child(this.button("search", svg("mods/workspace-chrome-plus/search.svg").size(15), () => run("mod.open", { name: "picker" }))))
      // On the macOS rail the traffic lights fill the row; the agents list's » unfolds it.
      .when(!(collapsed && window()?.platform === "macos"), el => el.child(this.button("sidebar-toggle", svg("mods/workspace-chrome-plus/sidebar.svg").size(15), toggleSidebar)));
  }
}
