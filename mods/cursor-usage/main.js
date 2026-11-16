import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import {
  theme,
  run,
  exec,
  appHome,
  home,
  checking,
  watchFolder,
  readTextFile,
  layout,
  shared,
  setShared,
  nextCommand,
} from "herdr";

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

function modelColor(name) {
  const n = String(name || "").toLowerCase();
  if (n === "other" || n === "others") return "#64748b"; // slate gray for Others
  if (n.includes("claude") && n.includes("opus")) return "#c084fc"; // purple
  if (n.includes("claude")) return "#e879f9"; // pink-purple
  if (n.includes("auto") && n.includes("grok")) return "#22d3ee"; // cyan
  if (n.includes("grok-bot")) return "#0ea5e9"; // light blue
  if (n.includes("grok-4.7-high") || n.includes("grok 4.7")) return "#0284c7"; // deep sky blue
  if (n.includes("grok")) return "#38bdf8"; // sky blue
  if (n.includes("gemini-3.8-flash-high")) return "#10b981"; // emerald
  if (n.includes("gemini") && n.includes("flash")) return "#34d399"; // mint green
  if (n.includes("gemini") && n.includes("4")) return "#a3e635"; // lime green
  if (n.includes("gemini")) return "#4ade80"; // green
  if (n.includes("gpt")) return "#fbbf24"; // amber
  if (n.includes("composer")) return "#818cf8"; // indigo
  if (n.includes("deepseek") || n.includes("glm") || n.includes("kimi") || n.includes("muse")) return "#fb7185"; // rose
  return "#94a3b8";
}

function modelIcon(name) {
  const n = String(name || "").toLowerCase();
  if (!n || n === "other" || n === "others") return null;
  if (n.includes("claude")) return "icons/claude.svg";
  if (n.includes("grok")) return "icons/grok.svg";
  if (n.includes("gemini")) return "icons/gemini.svg";
  if (n.includes("gpt")) return "mods/cursor-usage/icons/openai.svg";
  if (n.includes("composer")) return "icons/composer.svg";
  if (n.includes("kimi")) return "icons/kimi.svg";
  if (n.includes("muse")) return "icons/muse.svg";
  return null;
}

function normModelKey(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function modelVendor(name) {
  const n = String(name || "").toLowerCase();
  if (!n || n === "other" || n === "others") return { id: "Other", label: "Other", color: "#64748b", icon: null };
  if (n.includes("claude")) return { id: "Anthropic", label: "Claude", color: "#e879f9", icon: "icons/claude.svg" };
  if (n.includes("grok")) return { id: "xAI", label: "Grok", color: "#38bdf8", icon: "icons/grok.svg" };
  if (n.includes("gemini")) return { id: "Google", label: "Gemini", color: "#4ade80", icon: "icons/gemini.svg" };
  if (n.includes("gpt")) return { id: "OpenAI", label: "GPT", color: "#fbbf24", icon: "mods/cursor-usage/icons/openai.svg" };
  if (n.includes("composer")) return { id: "Cursor", label: "Composer", color: "#818cf8", icon: "icons/composer.svg" };
  if (n.includes("kimi")) return { id: "Moonshot", label: "Kimi", color: "#fb7185", icon: "icons/kimi.svg" };
  if (n.includes("muse")) return { id: "Muse", label: "Muse", color: "#fb7185", icon: "icons/muse.svg" };
  return { id: "Other", label: "Other", color: "#94a3b8", icon: null };
}

function fmtCompactTokens(tok) {
  const n = Number(tok || 0);
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function shortModelName(name) {
  const s = String(name || "").toLowerCase();
  if (!s) return "";
  return s
    .replace(/^claude-/, "")
    .replace(/^auto-/, "")
    .replace(/-(medium|high|low|default|thinking)$/, "")
    .replace(/-hydrogen/, "-h")
    .replace(/-carbon/, "-c")
    .slice(0, 14);
}

function fillDailySeries(daily, cycleStart) {
  if (!daily?.length) return [];
  const byDate = new Map();
  for (const item of daily) {
    byDate.set(item.date, item);
  }
  const dates = daily.map((d) => d.date).sort();
  const startStr = cycleStart && cycleStart < dates[0] ? cycleStart : dates[0];
  const endStr = dates[dates.length - 1];

  const out = [];
  const cur = new Date(`${startStr}T00:00:00`);
  const end = new Date(`${endStr}T00:00:00`);
  let guard = 0;
  while (cur <= end && guard < 45) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, "0");
    const dd = String(cur.getDate()).padStart(2, "0");
    const key = `${y}-${m}-${dd}`;
    const hit = byDate.get(key);
    out.push(
      hit
        ? { ...hit, date_short: `${m}/${dd}`, has_data: true }
        : { date: key, date_short: `${m}/${dd}`, spent: 0, spent_str: "$0.00", tokens: 0, tokens_str: "0", segments: [], has_data: false }
    );
    cur.setDate(cur.getDate() + 1);
    guard += 1;
  }
  return out;
}

function isModelUsed(feeModelName, usedModels) {
  const fk = normModelKey(feeModelName);
  if (!fk || !usedModels?.length) return false;
  return usedModels.some((u) => {
    const uk = normModelKey(u.name);
    return uk && (uk.includes(fk) || fk.includes(uk));
  });
}

export default class CursorUsagePanel extends View {
  init(_props, cx) {
    this.data = null;
    this.loading = false;
    this.tab = "models"; // 預設不進入「今日」，避免背景持續監聽造成畫面閃爍
    this.error = null;
    this.lastCheckedAt = null;
    this.onlyPaidToday = false;

    this.feesData = null;
    this.feesLoading = false;
    this.feesError = null;
    this.feeProvider = "ALL";
    this.showHiddenFees = false;

    this._lastSyncMs = 0;
    this._debouncePending = false;
    this._watching = false;
    this._watchGen = 0;
    this._watchers = [];

    // 先讀取本地快取確保 0ms 呈現，再視需要同步
    this.bootstrap(cx);

    if (!checking()) {
      // 監聽外部指令 (如 herdr-app do cursor-usage.refresh)
      cx.spawn(async (cx) => {
        for (;;) {
          const cmd = await nextCommand();
          if (cmd === "refresh" || cmd === "update") {
            this.refresh(cx, { force: true });
          }
        }
      });

      // 一般狀態改為每 30 分鐘自動檢查更新一次（有變化才更新 UI）
      cx.timer.every(30 * 60 * 1000, (cx) => this.refresh(cx, { ifChanged: true, quiet: true }));
    }
  }

  async close() {
    this.stopWatchers();
  }

  isPanelVisible() {
    try {
      const root = layout();
      const panel = findNode(root, "panel");
      const body = findNode(root, "panel-body");
      return Boolean(panel && !panel.hidden && body?.active === "usage");
    } catch {
      return true;
    }
  }

  bootstrap(cx) {
    cx.spawn(async (cx) => {
      try {
        const raw = await readTextFile(`${appHome()}/data/cursor-usage/usage_cache.json`);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed?.ok) {
            this.data = parsed;
            this.publishLiveQuota(parsed);
            this.publishSessionStats(parsed);
            cx.notify();
          }
        }
      } catch {
        // ignore
      }
      if (!checking()) {
        this.refresh(cx, { ifChanged: true, quiet: Boolean(this.data) });
        this.loadFees(cx, false);
      }
    });
  }

  stopWatchers() {
    this._watching = false;
    this._watchGen += 1;
    this._debouncePending = false;
    for (const w of this._watchers) {
      try {
        w.cancel();
      } catch {
        // ignore
      }
    }
    this._watchers = [];
  }

  startWatchers(cx) {
    if (this._watching || checking()) return;
    this._watching = true;
    const gen = ++this._watchGen;
    const dirs = [
      `${home()}/.cursor/ai-tracking`,
      `${home()}/.cursor/chats`,
    ];
    for (const dir of dirs) {
      cx.spawn(async (cx) => {
        for (;;) {
          if (!this._watching || this._watchGen !== gen) break;
          try {
            const w = watchFolder(dir);
            this._watchers.push(w);
            const changed = await w;
            if (!this._watching || this._watchGen !== gen) break;
            if (!changed || changed.length === 0) break;
            this.scheduleActivitySync(cx, gen);
          } catch {
            break;
          }
        }
      });
    }
  }

  scheduleActivitySync(cx, gen) {
    if (this._debouncePending || !this._watching || this._watchGen !== gen) return;
    this._debouncePending = true;
    cx.timer.after(4000, (cx) => {
      this._debouncePending = false;
      if (!this._watching || this._watchGen !== gen) return;
      if (this.tab !== "today" || !this.isPanelVisible()) {
        this.stopWatchers();
        return;
      }
      const now = Date.now();
      if (now - this._lastSyncMs < 15000) return;
      this.refresh(cx, { ifChanged: true, quiet: true });
    });
  }

  switchTab(nextTab, cx) {
    this.tab = nextTab;
    if (nextTab === "today") {
      this.startWatchers(cx);
      this.refresh(cx, { ifChanged: true, quiet: true });
    } else {
      this.stopWatchers();
      if (nextTab === "fees" && !this.feesData && !this.feesLoading) {
        this.loadFees(cx, false);
      }
    }
    cx.notify();
  }

  publishLiveQuota(d) {
    if (!d?.quota || !d?.cycle) return;
    const q = d.quota;
    const c = d.cycle;
    const next = {
      spent: q.spent,
      limit: q.limit,
      percent: q.percent,
      formatted: `${q.spent_str}/${q.limit_str}`,
      days_passed: c.days_passed,
      days_total: c.days_total,
      day_num: Math.min(Math.round(c.days_total || 30), Math.floor(c.days_passed || 0) + 1),
      time_percent: c.time_percent,
      fetched_at: d.fetched_at,
      source_mode: d.source_mode,
    };
    const prev = shared("cursor.liveQuota");
    if (
      prev &&
      prev.formatted === next.formatted &&
      prev.percent === next.percent &&
      prev.day_num === next.day_num &&
      prev.time_percent === next.time_percent
    ) {
      return;
    }
    setShared("cursor.liveQuota", next);
  }

  publishSessionStats(d) {
    const calls = d?.today_calls ?? [];
    const byId = {};
    for (const c of calls) {
      const id = c.conv_id;
      if (!id) continue;
      if (!byId[id]) {
        byId[id] = {
          conv_id: id,
          title: c.conv_title || "",
          model: c.model || "",
          short_model: shortModelName(c.model),
          cents: 0,
          calls: 0,
          last_ts: c.ts_ms || 0,
        };
      }
      const cur = byId[id];
      cur.cents += Number(c.charged_cents || 0);
      cur.calls += 1;
      if ((c.ts_ms || 0) >= cur.last_ts) {
        cur.last_ts = c.ts_ms || 0;
        cur.model = c.model || cur.model;
        cur.short_model = shortModelName(cur.model);
      }
    }
    const byTitle = {};
    let totalCents = 0;
    let totalCalls = 0;
    for (const item of Object.values(byId)) {
      const dollars = item.cents / 100;
      item.cost_str = dollars === 0 ? "$0.00" : dollars < 0.1 ? `$${dollars.toFixed(3)}` : `$${dollars.toFixed(2)}`;
      totalCents += item.cents;
      totalCalls += item.calls;
      const key = String(item.title || "").trim().toLowerCase();
      if (key && key !== "-" && (!byTitle[key] || item.last_ts >= byTitle[key].last_ts)) {
        byTitle[key] = item;
      }
    }
    const sig = `${totalCalls}|${Math.round(totalCents * 100)}|${Object.keys(byId).length}`;
    const prev = shared("cursor.sessionStats");
    if (prev?.sig === sig) return;
    setShared("cursor.sessionStats", { sig, by_id: byId, by_title: byTitle });
  }

  refresh(cx, { ifChanged = false, force = false, quiet = false } = {}) {
    if (this.loading) return;
    this.loading = true;
    this.error = null;
    if (!quiet) cx.notify();

    cx.spawn(async (cx) => {
      let shouldNotify = !quiet;
      try {
        const script = `${appHome()}/mods/cursor-usage/get_usage.py`;
        const args = [script];
        if (force) args.push("--force");
        else if (ifChanged) args.push("--if-changed");

        const res = await exec("python", args, { timeout: 15000 });
        this._lastSyncMs = Date.now();
        if (res.code === 0 && res.stdout.trim()) {
          const parsed = JSON.parse(res.stdout.trim());
          if (parsed.ok) {
            if (parsed.changed === false) {
              this.lastCheckedAt = parsed.checked_at ?? this.lastCheckedAt;
              // 資料完全沒變：靜默結束，不重新渲染列表
            } else {
              this.data = parsed;
              this.error = null;
              this.lastCheckedAt = parsed.fetched_at;
              this.publishLiveQuota(parsed);
              this.publishSessionStats(parsed);
              shouldNotify = true;
            }
          } else {
            this.error = parsed.error || "無法讀取 Cursor 用量";
            shouldNotify = true;
          }
        } else {
          this.error = res.stderr || "執行用量解析腳本失敗";
          shouldNotify = true;
        }
      } catch (err) {
        this.error = String(err);
        shouldNotify = true;
      } finally {
        this.loading = false;
        if (shouldNotify) cx.notify();
      }
    });
  }

  loadFees(cx, force = false) {
    if (this.feesLoading) return;
    this.feesLoading = true;
    this.feesError = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const script = `${appHome()}/mods/cursor-usage/get_fees.py`;
        const args = force ? [script, "--refresh"] : [script];
        const res = await exec("python", args, { timeout: 15000 });
        if (res.code === 0 && res.stdout.trim()) {
          const parsed = JSON.parse(res.stdout.trim());
          if (parsed.ok) {
            this.feesData = parsed;
            this.feesError = null;
          } else {
            this.feesError = parsed.error || "無法讀取模型費率表";
          }
        } else {
          this.feesError = res.stderr || "執行費率腳本失敗";
        }
      } catch (err) {
        this.feesError = String(err);
      } finally {
        this.feesLoading = false;
        cx.notify();
      }
    });
  }

  openWebDashboard() {
    try {
      exec("cmd", ["/c", "start", "https://cursor.com/dashboard/usage"]);
    } catch {
      // ignore
    }
  }

  openPricingDocs() {
    try {
      exec("cmd", ["/c", "start", "https://cursor.com/docs/models-and-pricing"]);
    } catch {
      // ignore
    }
  }

  renderAnalytics(t, d) {
    const quota = d?.quota ?? { spent: 0, limit: 650, remaining: 650, daily_avg: 0, percent: 0 };
    const cycle = d?.cycle ?? { start: "", days_passed: 1, days_total: 30, time_percent: 0 };
    const models = d?.models ?? [];
    const daily = d?.daily ?? [];
    const todayCalls = d?.today_calls ?? [];

    // 1. Cycle projection & averages
    const daysPassed = Math.max(0.1, Number(cycle.days_passed || 1));
    const daysTotal = Math.max(1, Number(cycle.days_total || 30));
    const daysRemain = Math.max(0.1, daysTotal - daysPassed);
    const activeDays = daily.filter((x) => (x.spent || 0) > 0);
    const activeAvg = activeDays.length
      ? activeDays.reduce((acc, x) => acc + (x.spent || 0), 0) / activeDays.length
      : 0;
    const calAvg = Number(quota.daily_avg || 0);
    const projectedSpend = calAvg * daysTotal;
    const projectedPct = quota.limit > 0 ? Math.round((projectedSpend / quota.limit) * 100) : 0;
    const safeDailyBudget = Math.max(0, (quota.remaining || 0) / daysRemain);
    const peakDay = activeDays.reduce(
      (best, x) => ((x.spent || 0) > (best?.spent || 0) ? x : best),
      null
    );

    // 2. Daily chronological bar series (with $0 calendar gaps)
    const series = fillDailySeries(daily, cycle.start);
    const maxDaily = Math.max(1, ...series.map((s) => Number(s.spent || 0)), calAvg);
    const chartH = 84;
    const avgLineBottom = Math.max(1, Math.min(chartH - 2, Math.round((calAvg / maxDaily) * chartH)));
    const todayStr = series.length ? series[series.length - 1].date : "";

    // 3. Vendor distribution (from models)
    const totalModelSpent = Math.max(0.01, models.reduce((s, m) => s + (m.spent || 0), 0));
    const totalModelTokens = Math.max(1, models.reduce((s, m) => s + (m.tokens || 0), 0));
    const vendorMap = new Map();
    for (const m of models) {
      const v = modelVendor(m.name);
      const cur = vendorMap.get(v.id) ?? { ...v, spent: 0, tokens: 0 };
      cur.spent += m.spent || 0;
      cur.tokens += m.tokens || 0;
      vendorMap.set(v.id, cur);
    }
    const vendors = Array.from(vendorMap.values())
      .sort((a, b) => b.spent - a.spent)
      .map((v) => ({
        ...v,
        pct: Math.round((v.spent / totalModelSpent) * 1000) / 10,
        tokPct: Math.round((v.tokens / totalModelTokens) * 1000) / 10,
      }));

    // 4. Top named models: Cost % vs Token %
    const namedModels = models.filter((m) => m.name !== "Other").slice(0, 6);

    // 5. Today hourly distribution & token composition
    const hourBuckets = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      label: `${String(h).padStart(2, "0")}`,
      count: 0,
      cents: 0,
    }));
    let totIn = 0;
    let totOut = 0;
    let totCr = 0;
    let totCw = 0;
    for (const c of todayCalls) {
      const h = parseInt(String(c.time || "").slice(0, 2), 10);
      if (!Number.isNaN(h) && h >= 0 && h < 24) {
        hourBuckets[h].count += 1;
        hourBuckets[h].cents += Number(c.charged_cents || 0);
      }
      totIn += Number(c.input_tokens || 0);
      totOut += Number(c.output_tokens || 0);
      totCr += Number(c.cache_read_tokens || 0);
      totCw += Number(c.cache_write_tokens || 0);
    }
    const activeHours = hourBuckets.filter((b) => b.count > 0);
    const firstH = activeHours.length ? Math.max(0, activeHours[0].hour) : 8;
    const lastH = activeHours.length ? Math.min(23, activeHours[activeHours.length - 1].hour) : 18;
    const shownHours = hourBuckets.slice(firstH, Math.max(firstH + 1, lastH + 1));
    const maxHourCents = Math.max(1, ...shownHours.map((b) => b.cents));
    const maxHourCount = Math.max(1, ...shownHours.map((b) => b.count));

    const totAllTok = Math.max(1, totIn + totOut + totCr + totCw);
    const cacheHitPct = totIn + totCr > 0 ? Math.round((totCr / (totIn + totCr)) * 1000) / 10 : 0;
    const tokenParts = [
      { label: "Cache Read", val: totCr, pct: Math.round((totCr / totAllTok) * 1000) / 10, color: "#10b981" },
      { label: "Input", val: totIn, pct: Math.round((totIn / totAllTok) * 1000) / 10, color: "#38bdf8" },
      { label: "Output", val: totOut, pct: Math.round((totOut / totAllTok) * 1000) / 10, color: "#c084fc" },
      { label: "Cache Write", val: totCw, pct: Math.round((totCw / totAllTok) * 1000) / 10, color: "#fbbf24" },
    ].filter((p) => p.val > 0);

    const projColor = projectedSpend > quota.limit ? "#ef4444" : projectedSpend > quota.limit * 0.85 ? "#f59e0b" : "#10b981";

    return v_flex()
      .gap(8)
      // Card 1: Projection & Daily Average KPIs
      .child(
        v_flex()
          .p(9)
          .gap(7)
          .rounded(7)
          .bg(t.surface)
          .border(1)
          .border_color(t.border)
          .child(
            h_flex()
              .justify_between()
              .items_center()
              .child(div().font_semibold().text_size(11.5).text_color(t.foreground).child("📈 週期預測與日均分析"))
              .child(
                div()
                  .px(5)
                  .py(1)
                  .rounded(4)
                  .bg(projColor + "20")
                  .text_size(10)
                  .font_semibold()
                  .text_color(projColor)
                  .child(`月底預估 ${projectedPct}%`)
              )
          )
          .child(
            h_flex()
              .gap(5)
              .children([
                v_flex()
                  .flex_1()
                  .p(6)
                  .rounded(5)
                  .bg(t.chrome)
                  .gap(1)
                  .child(div().text_size(9.5).text_color(t.dim).child("預估月底總額"))
                  .child(div().text_size(12).font_semibold().text_color(projColor).child(`$${projectedSpend.toFixed(0)}`)),
                v_flex()
                  .flex_1()
                  .p(6)
                  .rounded(5)
                  .bg(t.chrome)
                  .gap(1)
                  .child(div().text_size(9.5).text_color(t.dim).child("活躍日均"))
                  .child(div().text_size(12).font_semibold().text_color(t.foreground).child(`$${activeAvg.toFixed(2)}`)),
                v_flex()
                  .flex_1()
                  .p(6)
                  .rounded(5)
                  .bg(t.chrome)
                  .gap(1)
                  .child(div().text_size(9.5).text_color(t.dim).child("剩餘可日均"))
                  .child(div().text_size(12).font_semibold().text_color("#38bdf8").child(`$${safeDailyBudget.toFixed(2)}`)),
              ])
          )
          .when(Boolean(peakDay), (pk) =>
            pk.child(
              h_flex()
                .justify_between()
                .text_size(10)
                .text_color(t.dim)
                .child(div().child(`週期日均 $${calAvg.toFixed(2)} · 活躍 ${activeDays.length} 天`))
                .child(div().child(`最高峰 ${peakDay.date_short} (${peakDay.spent_str})`))
            )
          )
      )
      // Card 2: Daily Spend Column Chart with Avg Reference Line
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
              .child(div().font_semibold().text_size(11.5).text_color(t.foreground).child("📅 每日花費趨勢圖"))
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .text_size(10)
                  .child(
                    h_flex()
                      .gap(3)
                      .items_center()
                      .child(div().w(8).h(2).bg("#f59e0b"))
                      .child(div().text_color(t.dim).child(`日均 $${calAvg.toFixed(2)}`))
                  )
              )
          )
          .when(series.length > 0, (chartEl) =>
            chartEl
              .child(
                div()
                  .relative()
                  .w_full()
                  .h(chartH + 4)
                  .pt(4)
                  .border_b(1)
                  .border_color(t.border)
                  .child(
                    h_flex()
                      .size_full()
                      .items_end()
                      .gap(2)
                      .children(
                        series.map((day, i) => {
                          const sp = Number(day.spent || 0);
                          const barH = sp > 0 ? Math.max(4, Math.round((sp / maxDaily) * chartH)) : 2;
                          const isPeak = peakDay && day.date === peakDay.date;
                          const isToday = day.date === todayStr;
                          const barColor = sp <= 0
                            ? t.chrome
                            : isPeak
                              ? "#fb7185"
                              : sp > calAvg
                                ? "#f59e0b"
                                : isToday
                                  ? "#22d3ee"
                                  : "#38bdf8";
                          return v_flex()
                            .id(`an-day-bar-${i}`)
                            .flex_1()
                            .h_full()
                            .justify_end()
                            .items_center()
                            .tooltip(`${day.date}\n花費: ${day.spent_str}\nTokens: ${day.tokens_str}`)
                            .child(
                              div()
                                .w_full()
                                .h(barH)
                                .rounded_t(2)
                                .bg(barColor)
                            );
                        })
                      )
                  )
                  // Average reference horizontal line
                  .child(
                    div()
                      .absolute()
                      .left(0)
                      .right(0)
                      .bottom(avgLineBottom)
                      .h(1)
                      .bg("#f59e0b88")
                  )
              )
              .child(
                h_flex()
                  .justify_between()
                  .text_size(9.5)
                  .text_color(t.dim)
                  .child(div().child(series[0]?.date_short ?? ""))
                  .child(div().child(series[Math.floor(series.length / 2)]?.date_short ?? ""))
                  .child(div().child(series[series.length - 1]?.date_short ?? ""))
              )
          )
      )
      // Card 3: Vendor / Brand Share (Model Selection by Provider)
      .child(
        v_flex()
          .p(9)
          .gap(7)
          .rounded(7)
          .bg(t.surface)
          .border(1)
          .border_color(t.border)
          .child(
            h_flex()
              .justify_between()
              .items_center()
              .child(div().font_semibold().text_size(11.5).text_color(t.foreground).child("🏢 模型品牌選擇分佈"))
              .child(div().text_size(10).text_color(t.dim).child("依費用佔比"))
          )
          .when(vendors.length > 0, (vEl) =>
            vEl
              .child(
                h_flex()
                  .w_full()
                  .h(9)
                  .gap(1)
                  .rounded(4)
                  .overflow_hidden()
                  .bg(t.chrome)
                  .children(
                    vendors.map((v, i) =>
                      div()
                        .id(`an-vendor-bar-${i}`)
                        .h_full()
                        .flex_grow(Math.max(1, v.pct))
                        .bg(v.color)
                        .tooltip(`${v.label}: $${v.spent.toFixed(2)} (${v.pct}%)`)
                    )
                  )
              )
              .child(
                v_flex()
                  .gap(4)
                  .children(
                    vendors.map((v, idx) =>
                      h_flex()
                        .id(`an-vendor-row-${idx}`)
                        .justify_between()
                        .items_center()
                        .text_size(10.5)
                        .child(
                          h_flex()
                            .gap(5)
                            .items_center()
                            .when(Boolean(v.icon), (ic) => ic.child(svg(v.icon).size(12).flex_none().text_color(v.color)))
                            .when(!v.icon, (dt) => dt.child(div().size(6).rounded_full().bg(v.color).flex_none()))
                            .child(div().font_medium().text_color(t.foreground).child(v.label))
                        )
                        .child(
                          h_flex()
                            .gap(6)
                            .items_center()
                            .child(div().text_color(t.dim).child(fmtCompactTokens(v.tokens)))
                            .child(div().font_semibold().text_color(t.accent).child(`$${v.spent.toFixed(2)}`))
                            .child(div().w(36).text_right().text_color(t.muted).child(`${v.pct}%`))
                        )
                    )
                  )
              )
          )
      )
      // Card 4: Model Selection Efficiency (Cost % vs Token %)
      .child(
        v_flex()
          .p(9)
          .gap(7)
          .rounded(7)
          .bg(t.surface)
          .border(1)
          .border_color(t.border)
          .child(
            h_flex()
              .justify_between()
              .items_center()
              .child(div().font_semibold().text_size(11.5).text_color(t.foreground).child("⚖️ 模型性價比：費用 vs Token 佔比"))
              .child(
                h_flex()
                  .gap(6)
                  .text_size(9.5)
                  .text_color(t.dim)
                  .child(
                    h_flex().gap(3).items_center()
                      .child(div().size(6).rounded(1).bg("#38bdf8"))
                      .child(div().child("費用%"))
                  )
                  .child(
                    h_flex().gap(3).items_center()
                      .child(div().size(6).rounded(1).bg("#10b981"))
                      .child(div().child("Token%"))
                  )
              )
          )
          .children(
            namedModels.map((m, idx) => {
              const c = modelColor(m.name);
              const iconPath = modelIcon(m.name);
              const tokPct = Math.round(((m.tokens || 0) / totalModelTokens) * 1000) / 10;
              const costPct = Number(m.percent || 0);
              return v_flex()
                .id(`an-eff-row-${idx}`)
                .gap(3)
                .child(
                  h_flex()
                    .justify_between()
                    .items_center()
                    .text_size(10.5)
                    .child(
                      h_flex()
                        .gap(5)
                        .items_center()
                        .flex_1()
                        .min_w(0)
                        .when(Boolean(iconPath), (ic) => ic.child(svg(iconPath).size(11).flex_none().text_color(c)))
                        .when(!iconPath, (dt) => dt.child(div().size(6).rounded_full().bg(c).flex_none()))
                        .child(div().truncate().font_medium().text_color(t.foreground).child(m.name))
                    )
                    .child(div().flex_none().text_size(10).text_color(t.dim).child(`${m.spent_str} (${costPct}%) · ${tokPct}% tok`))
                )
                .child(
                  v_flex()
                    .gap(2)
                    .child(
                      div().w_full().h(3.5).rounded(2).bg(t.chrome).overflow_hidden()
                        .child(div().h_full().w(`${Math.min(100, costPct)}%`).bg("#38bdf8").rounded(2))
                    )
                    .child(
                      div().w_full().h(3.5).rounded(2).bg(t.chrome).overflow_hidden()
                        .child(div().h_full().w(`${Math.min(100, tokPct)}%`).bg("#10b981").rounded(2))
                    )
                );
            })
          )
      )
      // Card 5: Today Hourly Activity & Token Composition
      .child(
        v_flex()
          .p(9)
          .gap(7)
          .rounded(7)
          .bg(t.surface)
          .border(1)
          .border_color(t.border)
          .child(
            h_flex()
              .justify_between()
              .items_center()
              .child(div().font_semibold().text_size(11.5).text_color(t.foreground).child("⏱️ 今日時段分佈與 Token 結構"))
              .child(
                div()
                  .px(5)
                  .py(1)
                  .rounded(4)
                  .bg("#10b98120")
                  .text_size(10)
                  .font_semibold()
                  .text_color("#10b981")
                  .child(`Cache 命中 ${cacheHitPct}%`)
              )
          )
          .when(shownHours.length > 0 && todayCalls.length > 0, (hrEl) =>
            hrEl
              .child(
                h_flex()
                  .w_full()
                  .h(52)
                  .items_end()
                  .gap(2)
                  .pt(4)
                  .border_b(1)
                  .border_color(t.border)
                  .children(
                    shownHours.map((b, i) => {
                      const ratio = b.cents > 0 ? b.cents / maxHourCents : b.count / maxHourCount;
                      const bh = b.count > 0 ? Math.max(4, Math.round(ratio * 44)) : 2;
                      return div()
                        .id(`an-hr-${i}`)
                        .flex_1()
                        .h_full()
                        .flex()
                        .items_end()
                        .tooltip(`${b.label}:00–${b.label}:59\n呼叫: ${b.count} 次\n花費: $${(b.cents / 100).toFixed(2)}`)
                        .child(
                          div()
                            .w_full()
                            .h(bh)
                            .rounded_t(2)
                            .bg(b.count > 0 ? "#818cf8" : t.chrome)
                        );
                    })
                  )
              )
              .child(
                h_flex()
                  .justify_between()
                  .text_size(9.5)
                  .text_color(t.dim)
                  .child(div().child(`${shownHours[0]?.label ?? "00"}h`))
                  .child(div().child(`${shownHours[Math.floor(shownHours.length / 2)]?.label ?? "12"}h`))
                  .child(div().child(`${shownHours[shownHours.length - 1]?.label ?? "23"}h`))
              )
          )
          .when(tokenParts.length > 0, (tokWrap) =>
            tokWrap
              .child(
                h_flex()
                  .w_full()
                  .h(7)
                  .gap(1)
                  .rounded(3.5)
                  .overflow_hidden()
                  .bg(t.chrome)
                  .children(
                    tokenParts.map((p, i) =>
                      div()
                        .id(`an-tok-${i}`)
                        .h_full()
                        .flex_grow(Math.max(1, p.pct))
                        .bg(p.color)
                        .tooltip(`${p.label}: ${fmtCompactTokens(p.val)} (${p.pct}%)`)
                    )
                  )
              )
              .child(
                h_flex()
                  .gap(6)
                  .flex_wrap()
                  .children(
                    tokenParts.map((p) =>
                      h_flex()
                        .gap(3)
                        .items_center()
                        .text_size(10)
                        .child(div().size(6).rounded_full().bg(p.color))
                        .child(div().text_color(t.muted).child(`${p.label} ${p.pct}%`))
                    )
                  )
              )
          )
      );
  }

  render(cx) {
    if (this._watching && (this.tab !== "today" || !this.isPanelVisible())) {
      this.stopWatchers();
    }
    const t = theme();
    const d = this.data;
    const quota = d?.quota ?? { spent: 0, spent_str: "$0.00", limit: 650, limit_str: "$650", percent: 0, remaining_str: "$650.00", daily_avg_str: "$0.00" };
    const cycle = d?.cycle ?? { start: "", end: "", days_passed: 0, days_total: 30, time_percent: 0 };
    const account = d?.account ?? { email: "", team: "Supermicro", membership: "Enterprise" };
    const models = d?.models ?? [];
    const daily = d?.daily ?? [];
    const todaySummary = d?.today_summary ?? { date: "", count: 0, spent_str: "$0.00", in_str: "0", out_str: "0", cr_str: "0", total_tokens_str: "0" };
    const allTodayCalls = d?.today_calls ?? [];
    const shownTodayCalls = this.onlyPaidToday
      ? allTodayCalls.filter((c) => (c.charged_cents ?? 0) > 0)
      : allTodayCalls;

    let todayInTok = 0;
    let todayOutTok = 0;
    let todayCrTok = 0;
    let todayCwTok = 0;
    for (const c of allTodayCalls) {
      todayInTok += Number(c.input_tokens || 0);
      todayOutTok += Number(c.output_tokens || 0);
      todayCrTok += Number(c.cache_read_tokens || 0);
      todayCwTok += Number(c.cache_write_tokens || 0);
    }
    const todayHitPct = todayInTok + todayCrTok > 0
      ? Math.round((todayCrTok / (todayInTok + todayCrTok)) * 1000) / 10
      : 0;
    const todayHitColor = todayHitPct >= 80 ? "#10b981" : todayHitPct >= 50 ? "#f59e0b" : "#94a3b8";
    const todayTotTok = Math.max(1, todayInTok + todayOutTok + todayCrTok + todayCwTok);
    const todayTokBar = [
      { label: "Cache Read", val: todayCrTok, pct: Math.round((todayCrTok / todayTotTok) * 1000) / 10, color: "#10b981" },
      { label: "Input", val: todayInTok, pct: Math.round((todayInTok / todayTotTok) * 1000) / 10, color: "#38bdf8" },
      { label: "Output", val: todayOutTok, pct: Math.round((todayOutTok / todayTotTok) * 1000) / 10, color: "#c084fc" },
      { label: "Cache Write", val: todayCwTok, pct: Math.round((todayCwTok / todayTotTok) * 1000) / 10, color: "#fbbf24" },
    ].filter((p) => p.val > 0);

    const spentPct = Math.max(0, Math.min(100, quota.percent ?? 0));
    const timePct = Math.max(0, Math.min(100, cycle.time_percent ?? 0));

    let statusColor = "#10b981";
    let statusText = "節奏健康";
    if (spentPct > timePct + 15) {
      statusColor = "#ef4444";
      statusText = "額度預警";
    } else if (spentPct > timePct) {
      statusColor = "#f59e0b";
      statusText = "消耗偏高";
    }

    const allFees = this.feesData?.models ?? [];
    const filteredFees = allFees.filter((f) => {
      if (!this.showHiddenFees && f.hidden) return false;
      if (this.feeProvider === "ALL") return true;
      if (this.feeProvider === "OTHER") return !["Cursor", "Anthropic", "Google", "OpenAI"].includes(f.provider);
      return f.provider === this.feeProvider;
    });
    const feeCountLabel = this.feesData ? `${this.showHiddenFees ? this.feesData.total_count : this.feesData.active_count}` : "…";

    return v_flex()
      .id("cursor-usage")
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
          .px(14)
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
              .child(svg("mods/cursor-usage/icons/coins.svg").size(15).flex_none().text_color(t.accent))
              .child(div().font_semibold().text_size(13).child("Cursor 用量細節"))
              .child(
                div()
                  .px(6)
                  .py(1)
                  .rounded(4)
                  .bg(t.surface)
                  .border(1)
                  .border_color(t.border)
                  .text_size(10)
                  .text_color(t.muted)
                  .child(account.team ? `${account.team} · ${account.membership}` : "Enterprise")
              )
          )
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .child(
                div()
                  .id("btn-usage-refresh")
                  .size(24)
                  .flex_none()
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(5)
                  .text_color(this.loading ? t.accent : t.muted)
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .cursor_pointer()
                  .tooltip(this.loading ? "同步中…" : "手動立即更新 (強制同步最新 Call 與月用量)")
                  .on_click((_e, cx) => {
                    this.refresh(cx, { force: true });
                  })
                  .child(
                    svg("mods/cursor-usage/icons/refresh.svg")
                      .size(13)
                      .when(this.loading, (el) => el.spin(900).text_color(t.accent))
                  )
              )
              .child(
                div()
                  .id("btn-usage-web")
                  .size(24)
                  .flex_none()
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(5)
                  .text_color(t.muted)
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .cursor_pointer()
                  .tooltip("在瀏覽器開啟 cursor.com/dashboard/usage")
                  .on_click(() => {
                    this.openWebDashboard();
                  })
                  .child(svg("mods/cursor-usage/icons/external-link.svg").size(13))
              )
              .child(
                div()
                  .id("btn-usage-close")
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
                  .on_click(() => {
                    this.stopWatchers();
                    run("layout.hide", { id: "panel" });
                  })
                  .child(div().text_size(12).child("✕"))
              )
          )
      )
      // Overview Card Section
      .child(
        v_flex()
          .p(12)
          .gap(10)
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome)
          .child(
            h_flex()
              .justify_between()
              .items_baseline()
              .child(
                h_flex()
                  .gap(6)
                  .items_baseline()
                  .child(div().font_bold().text_size(20).text_color(t.accent).child(quota.spent_str))
                  .child(div().text_size(12).text_color(t.muted).child(`/ ${quota.limit_str}`))
                  .child(div().text_size(11).font_semibold().text_color(t.dim).child(`(${spentPct}%)`))
              )
              .child(
                h_flex()
                  .gap(5)
                  .items_center()
                  .px(6)
                  .py(2)
                  .rounded(4)
                  .bg(statusColor + "20")
                  .border(1)
                  .border_color(statusColor + "55")
                  .child(div().size(6).rounded_full().bg(statusColor))
                  .child(div().text_size(10.5).font_semibold().text_color(statusColor).child(statusText))
              )
          )
          .child(
            v_flex()
              .gap(6)
              .child(
                v_flex()
                  .gap(2)
                  .child(
                    h_flex()
                      .justify_between()
                      .text_size(10.5)
                      .text_color(t.dim)
                      .child(div().child("額度消耗"))
                      .child(div().child(`${quota.spent_str} / ${quota.limit_str}`))
                  )
                  .child(
                    div()
                      .h(6)
                      .w_full()
                      .rounded(3)
                      .bg(t.surface)
                      .overflow_hidden()
                      .child(div().h_full().w(`${spentPct}%`).bg(statusColor === "#ef4444" ? "#ef4444" : "#38bdf8").rounded(3))
                  )
              )
              .child(
                v_flex()
                  .gap(2)
                  .child(
                    h_flex()
                      .justify_between()
                      .text_size(10.5)
                      .text_color(t.dim)
                      .child(div().child("週期天數"))
                      .child(div().child(`第 ${cycle.days_passed} / ${cycle.days_total} 天 (${timePct}%)`))
                  )
                  .child(
                    div()
                      .h(4)
                      .w_full()
                      .rounded(2)
                      .bg(t.surface)
                      .overflow_hidden()
                      .child(div().h_full().w(`${timePct}%`).bg("#818cf8").rounded(2))
                  )
              )
          )
          .child(
            h_flex()
              .gap(6)
              .children([
                v_flex()
                  .flex_1()
                  .p(6)
                  .rounded(6)
                  .bg(t.surface)
                  .gap(1)
                  .child(div().text_size(10).text_color(t.dim).child("剩餘額度"))
                  .child(div().text_size(12).font_semibold().text_color(t.foreground).child(quota.remaining_str)),
                v_flex()
                  .flex_1()
                  .p(6)
                  .rounded(6)
                  .bg(t.surface)
                  .gap(1)
                  .child(div().text_size(10).text_color(t.dim).child("日均花費"))
                  .child(div().text_size(12).font_semibold().text_color(t.foreground).child(quota.daily_avg_str)),
                v_flex()
                  .flex_1()
                  .p(6)
                  .rounded(6)
                  .bg(t.surface)
                  .gap(1)
                  .child(div().text_size(10).text_color(t.dim).child("帳單週期"))
                  .child(div().text_size(11).font_medium().text_color(t.muted).child(`${cycle.start ? cycle.start.slice(5) : "–"}~${cycle.end ? cycle.end.slice(5) : "–"}`)),
              ])
          )
      )
      // View Sub-tab Switcher (今日用量 / 模型用量 / 每日使用量 / 費率表 / 使用分析)
      .child(
        h_flex()
          .px(8)
          .pt(6)
          .pb(6)
          .gap(4)
          .flex_wrap()
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome)
          .child(
            div()
              .id("tab-today")
              .px(7)
              .py(3.5)
              .rounded(6)
              .cursor_pointer()
              .text_size(10.5)
              .font_medium()
              .bg(this.tab === "today" ? t.selected : t.surface)
              .text_color(this.tab === "today" ? t.foreground : t.muted)
              .hover((s) => s.bg(t.hover))
              .tooltip(`今日每次呼叫明細 (${allTodayCalls.length}) · 點擊開啟即時異動監聽`)
              .on_click((_e, cx) => {
                this.switchTab("today", cx);
              })
              .child("今日用量")
          )
          .child(
            div()
              .id("tab-models")
              .px(7)
              .py(3.5)
              .rounded(6)
              .cursor_pointer()
              .text_size(10.5)
              .font_medium()
              .bg(this.tab === "models" ? t.selected : t.surface)
              .text_color(this.tab === "models" ? t.foreground : t.muted)
              .hover((s) => s.bg(t.hover))
              .tooltip(`依模型統計用量 (${models.length})`)
              .on_click((_e, cx) => {
                this.switchTab("models", cx);
              })
              .child("模型用量")
          )
          .child(
            div()
              .id("tab-daily")
              .px(7)
              .py(3.5)
              .rounded(6)
              .cursor_pointer()
              .text_size(10.5)
              .font_medium()
              .bg(this.tab === "daily" ? t.selected : t.surface)
              .text_color(this.tab === "daily" ? t.foreground : t.muted)
              .hover((s) => s.bg(t.hover))
              .tooltip(`每日使用量與 Top3 模型佔比 (${daily.length})`)
              .on_click((_e, cx) => {
                this.switchTab("daily", cx);
              })
              .child("每日使用量")
          )
          .child(
            div()
              .id("tab-fees")
              .px(7)
              .py(3.5)
              .rounded(6)
              .cursor_pointer()
              .text_size(10.5)
              .font_medium()
              .bg(this.tab === "fees" ? t.selected : t.surface)
              .text_color(this.tab === "fees" ? t.foreground : t.muted)
              .hover((s) => s.bg(t.hover))
              .tooltip(`Cursor 官方模型費率表 (${feeCountLabel})`)
              .on_click((_e, cx) => {
                this.switchTab("fees", cx);
              })
              .child("費率表")
          )
          .child(
            div()
              .id("tab-analytics")
              .px(7)
              .py(3.5)
              .rounded(6)
              .cursor_pointer()
              .text_size(10.5)
              .font_medium()
              .bg(this.tab === "analytics" ? t.selected : t.surface)
              .text_color(this.tab === "analytics" ? t.foreground : t.muted)
              .hover((s) => s.bg(t.hover))
              .tooltip("使用情況圖表分析：日均趨勢、模型品牌、性價比與今日時段")
              .on_click((_e, cx) => {
                this.switchTab("analytics", cx);
              })
              .child("使用分析")
          )
      )
      // Main Scrollable Content Area
      .child(
        div()
          .flex_1()
          .min_h(180)
          .relative()
          .child(
            v_flex()
              .id("usage-scroll-list")
              .absolute()
              .inset_0()
              .overflow_y_scroll()
              .p(10)
              .gap(8)
              .when(Boolean(this.error), (el) =>
                el.child(
                  div()
                    .p(16)
                    .rounded(8)
                    .bg(t.surface)
                    .text_color(t.dim)
                    .child(`無法讀取用量資料: ${this.error}`)
                )
              )
              // Tab 0: Today's Per-Call Details
              .when(this.tab === "today", (el) =>
                el
                  .child(
                    v_flex()
                      .p(9)
                      .gap(6)
                      .rounded(7)
                      .bg(t.chrome)
                      .border(1)
                      .border_color(t.border)
                      .child(
                        h_flex()
                          .justify_between()
                          .items_center()
                          .child(
                            h_flex()
                              .gap(6)
                              .items_baseline()
                              .child(div().text_size(11).text_color(t.dim).child(`今日 (${todaySummary.date || "今天"})`))
                              .child(div().font_bold().text_size(14).text_color(t.accent).child(todaySummary.spent_str))
                              .child(div().text_size(10.5).text_color(t.muted).child(`· ${todaySummary.count} calls`))
                          )
                          .child(
                            div()
                              .id("btn-today-paid-filter")
                              .px(6)
                              .py(2)
                              .rounded(4)
                              .bg(this.onlyPaidToday ? t.selected : t.surface)
                              .border(1)
                              .border_color(this.onlyPaidToday ? t.accent + "66" : t.border)
                              .text_size(10)
                              .text_color(this.onlyPaidToday ? t.foreground : t.muted)
                              .cursor_pointer()
                              .hover((s) => s.bg(t.hover))
                              .on_click((_e, cx) => {
                                this.onlyPaidToday = !this.onlyPaidToday;
                                cx.notify();
                              })
                              .child(this.onlyPaidToday ? "僅看計費 ✓" : "顯示全部")
                          )
                      )
                      .child(
                        h_flex()
                          .justify_between()
                          .items_center()
                          .gap(6)
                          .child(
                            h_flex()
                              .gap(8)
                              .flex_wrap()
                              .text_size(10.5)
                              .text_color(t.dim)
                              .child(div().child(`In ${todaySummary.in_str}`))
                              .child(div().child(`Out ${todaySummary.out_str}`))
                              .child(div().font_medium().text_color("#10b981").child(`CacheR ${todaySummary.cr_str}`))
                              .when(todayCwTok > 0, (cwEl) => cwEl.child(div().child(`CW ${todaySummary.cw_str}`)))
                              .child(div().child(`總計 ${todaySummary.total_tokens_str}`))
                          )
                          .child(
                            div()
                              .px(5)
                              .py(1)
                              .rounded(4)
                              .flex_none()
                              .bg(todayHitColor + "20")
                              .border(1)
                              .border_color(todayHitColor + "44")
                              .text_size(10)
                              .font_semibold()
                              .text_color(todayHitColor)
                              .tooltip("今日 Cache 命中率 = Cache Read ÷ (Input + Cache Read)")
                              .child(`Cache 命中 ${todayHitPct}%`)
                          )
                      )
                      .when(todayTokBar.length > 0, (barEl) =>
                        barEl.child(
                          h_flex()
                            .w_full()
                            .h(4)
                            .gap(1)
                            .rounded(2)
                            .overflow_hidden()
                            .bg(t.surface)
                            .children(
                              todayTokBar.map((p, bi) =>
                                div()
                                  .id(`today-tok-bar-${bi}`)
                                  .h_full()
                                  .flex_grow(Math.max(1, p.pct))
                                  .bg(p.color)
                                  .tooltip(`${p.label}: ${fmtCompactTokens(p.val)} (${p.pct}%)`)
                              )
                            )
                        )
                      )
                  )
                  .when(shownTodayCalls.length === 0, (emptyEl) =>
                    emptyEl.child(
                      div()
                        .p(18)
                        .text_center()
                        .text_size(11.5)
                        .text_color(t.dim)
                        .child(this.loading ? "正在載入今日每次呼叫明細…" : "今日尚無符合條件的呼叫紀錄")
                    )
                  )
                  .children(
                    shownTodayCalls.map((call, idx) => {
                      const c = modelColor(call.model);
                      const iconPath = modelIcon(call.model);
                      const isFree = (call.charged_cents ?? 0) <= 0;
                      const callIn = Number(call.input_tokens || 0);
                      const callCr = Number(call.cache_read_tokens || 0);
                      const callHitPct = callIn + callCr > 0 ? Math.round((callCr / (callIn + callCr)) * 100) : 0;
                      const callHitColor = callHitPct >= 75 ? "#10b981" : callHitPct >= 40 ? "#f59e0b" : t.dim;
                      const tip = [
                        `時間: ${call.time}`,
                        `模型: ${call.model}`,
                        `對話: ${call.conv_title}`,
                        `實付: ${call.cost_str}${call.discount_pct ? ` (原價 ${call.list_cost_str}，Enterprise -${call.discount_pct}%)` : ""}`,
                        call.token_fee ? `Cursor Token Rate: $${(call.token_fee / 100).toFixed(3)}` : null,
                        `Cache 命中率: ${callHitPct}%`,
                        `Tokens: In ${call.input_tokens.toLocaleString()} / Out ${call.output_tokens.toLocaleString()} / CacheR ${call.cache_read_tokens.toLocaleString()}${call.cache_write_tokens ? ` / CacheW ${call.cache_write_tokens.toLocaleString()}` : ""}`,
                      ].filter(Boolean).join("\n");

                      return v_flex()
                        .id(`today-call-${idx}`)
                        .p(8)
                        .gap(4)
                        .rounded(7)
                        .bg(t.surface)
                        .border(1)
                        .border_color(t.border)
                        .tooltip(tip)
                        // Row 1: Time + Model + Cost
                        .child(
                          h_flex()
                            .justify_between()
                            .items_center()
                            .gap(6)
                            .child(
                              h_flex()
                                .gap(6)
                                .items_center()
                                .flex_1()
                                .min_w(0)
                                .child(div().text_size(10.5).text_color(t.dim).flex_none().child(call.time))
                                .when(Boolean(iconPath), (icEl) =>
                                  icEl.child(svg(iconPath).size(13).flex_none().text_color(c))
                                )
                                .when(!iconPath, (dotEl) =>
                                  dotEl.child(div().size(6).rounded_full().bg(c).flex_none())
                                )
                                .child(div().font_semibold().text_size(11.5).text_color(t.foreground).truncate().child(call.model))
                            )
                            .child(
                              div()
                                .text_size(11.5)
                                .font_semibold()
                                .flex_none()
                                .text_color(isFree ? t.dim : t.accent)
                                .child(call.cost_str)
                            )
                        )
                        // Row 2: Conversation Title + Token breakdown
                        .child(
                          h_flex()
                            .justify_between()
                            .items_center()
                            .gap(8)
                            .text_size(10.5)
                            .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(call.conv_title))
                            .child(
                              h_flex()
                                .gap(5)
                                .flex_none()
                                .text_color(t.dim)
                                .when(call.is_token_call, (tokEl) =>
                                  tokEl
                                    .child(div().child(`In ${call.in_str}`))
                                    .child(div().child(`Out ${call.out_str}`))
                                    .child(div().font_medium().text_color(callHitColor).child(`CR ${call.cr_str} (${callHitPct}%)`))
                                )
                                .when(!call.is_token_call, (nonTok) =>
                                  nonTok.child(div().child("Automation / Included"))
                                )
                            )
                        );
                    })
                  )
              )
              // Tab 1: By Model List
              .when(this.tab === "models", (el) =>
                el.children(
                  models.map((m, idx) => {
                    const c = modelColor(m.name);
                    const iconPath = modelIcon(m.name);
                    return v_flex()
                      .id(`model-row-${idx}`)
                      .p(8)
                      .gap(6)
                      .rounded(7)
                      .bg(t.surface)
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
                              .when(Boolean(iconPath), (icEl) =>
                                icEl.child(svg(iconPath).size(14).flex_none().text_color(c))
                              )
                              .when(!iconPath, (dotEl) =>
                                dotEl.child(div().size(7).rounded_full().bg(c).flex_none())
                              )
                              .child(div().font_semibold().text_size(12).text_color(t.foreground).child(m.name))
                          )
                          .child(
                            h_flex()
                              .gap(6)
                              .items_center()
                              .child(div().text_size(11).text_color(t.dim).child(`${m.tokens_str} tokens`))
                              .child(div().text_size(12).font_semibold().text_color(t.accent).child(m.spent_str))
                          )
                      )
                      .child(
                        h_flex()
                          .gap(8)
                          .items_center()
                          .child(
                            div()
                              .flex_1()
                              .h(4)
                              .rounded(2)
                              .bg(t.chrome)
                              .overflow_hidden()
                              .child(div().h_full().w(`${m.percent}%`).bg(c).rounded(2))
                          )
                          .child(div().w(38).text_right().text_size(10.5).text_color(t.muted).child(`${m.percent}%`))
                      );
                  })
                )
              )
              // Tab 2: Daily History List with Top 3 + Others Color Bar
              .when(this.tab === "daily", (el) =>
                el.children(
                  daily.map((day, idx) => {
                    const isToday = idx === 0;
                    const segs = day.segments ?? day.top_models ?? [];
                    return v_flex()
                      .id(`daily-row-${idx}`)
                      .p(9)
                      .gap(7)
                      .rounded(7)
                      .bg(t.surface)
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
                              .child(div().font_semibold().text_size(12).text_color(t.foreground).child(day.date))
                              .when(isToday, (tag) =>
                                tag.child(
                                  div()
                                    .px(4)
                                    .py(0.5)
                                    .rounded(3)
                                    .bg(t.accent + "22")
                                    .text_size(9.5)
                                    .font_semibold()
                                    .text_color(t.accent)
                                    .child("最新")
                                )
                              )
                          )
                          .child(
                            h_flex()
                              .gap(6)
                              .items_center()
                              .child(div().text_size(11).text_color(t.dim).child(`${day.tokens_str} tokens`))
                              .child(div().text_size(12).font_semibold().text_color(t.accent).child(day.spent_str))
                          )
                      )
                      .when(Boolean(segs.length), (barWrap) =>
                        barWrap.child(
                          h_flex()
                            .w_full()
                            .h(7)
                            .gap(1)
                            .rounded(3.5)
                            .overflow_hidden()
                            .bg(t.chrome)
                            .children(
                              segs.map((seg, sIdx) => {
                                const c = modelColor(seg.name);
                                const pct = Math.max(1, Number(seg.percent) || 0);
                                return div()
                                  .id(`daily-bar-${idx}-${sIdx}`)
                                  .h_full()
                                  .flex_grow(pct)
                                  .bg(c)
                                  .tooltip(`${seg.name}: ${seg.spent_str} (${seg.percent}%)`);
                              })
                            )
                        )
                      )
                      .when(Boolean(segs.length), (sub) =>
                        sub.child(
                          h_flex()
                            .gap(4)
                            .flex_wrap()
                            .children(
                              segs.map((seg) => {
                                const c = modelColor(seg.name);
                                const iconPath = seg.is_others ? null : modelIcon(seg.name);
                                return h_flex()
                                  .px(5)
                                  .py(1.5)
                                  .gap(4)
                                  .items_center()
                                  .rounded(4)
                                  .bg(t.chrome)
                                  .border(1)
                                  .border_color(t.border)
                                  .text_size(10.5)
                                  .when(Boolean(iconPath), (icEl) =>
                                    icEl.child(svg(iconPath).size(11).flex_none().text_color(c))
                                  )
                                  .when(!iconPath, (dotEl) =>
                                    dotEl.child(div().size(6).rounded_full().bg(c).flex_none())
                                  )
                                  .child(div().text_color(seg.is_others ? t.dim : t.foreground).child(seg.name))
                                  .child(div().text_color(t.muted).child(`${seg.spent_str} · ${seg.percent}%`));
                              })
                            )
                        )
                      );
                  })
                )
              )
              // Tab 3: Official Model Fee List
              .when(this.tab === "fees", (el) => {
                const providers = [
                  { id: "ALL", label: "全部" },
                  { id: "Cursor", label: "Cursor" },
                  { id: "Anthropic", label: "Claude" },
                  { id: "Google", label: "Gemini" },
                  { id: "OpenAI", label: "GPT" },
                  { id: "OTHER", label: "其他" },
                ];
                return el
                  .child(
                    v_flex()
                      .p(8)
                      .gap(5)
                      .rounded(7)
                      .bg(t.chrome)
                      .border(1)
                      .border_color(t.border)
                      .child(
                        h_flex()
                          .justify_between()
                          .items_center()
                          .child(div().text_size(10.5).text_color(t.muted).child("單位: $/1M tokens · 來源: cursor.com 官方文件"))
                          .child(
                            h_flex()
                              .gap(4)
                              .items_center()
                              .child(
                                div()
                                  .id("btn-fees-toggle-hidden")
                                  .px(5)
                                  .py(1.5)
                                  .rounded(4)
                                  .bg(this.showHiddenFees ? t.selected : t.surface)
                                  .border(1)
                                  .border_color(t.border)
                                  .text_size(10)
                                  .text_color(this.showHiddenFees ? t.foreground : t.muted)
                                  .cursor_pointer()
                                  .hover((s) => s.bg(t.hover))
                                  .on_click((_e, cx) => {
                                    this.showHiddenFees = !this.showHiddenFees;
                                    cx.notify();
                                  })
                                  .child(this.showHiddenFees ? "含隱藏" : "僅常用")
                              )
                              .child(
                                div()
                                  .id("btn-fees-sync")
                                  .px(5)
                                  .py(1.5)
                                  .rounded(4)
                                  .bg(t.surface)
                                  .border(1)
                                  .border_color(t.border)
                                  .text_size(10)
                                  .text_color(this.feesLoading ? t.accent : t.muted)
                                  .cursor_pointer()
                                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                                  .tooltip("向 cursor.com/docs/models-and-pricing.md 重新同步最新費率")
                                  .on_click((_e, cx) => {
                                    this.loadFees(cx, true);
                                  })
                                  .child(this.feesLoading ? "同步中…" : "↻ 同步")
                              )
                              .child(
                                div()
                                  .id("btn-fees-docs")
                                  .px(5)
                                  .py(1.5)
                                  .rounded(4)
                                  .bg(t.surface)
                                  .border(1)
                                  .border_color(t.border)
                                  .text_size(10)
                                  .text_color(t.muted)
                                  .cursor_pointer()
                                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                                  .tooltip("在瀏覽器開啟官方費率表")
                                  .on_click(() => this.openPricingDocs())
                                  .child("↗")
                              )
                          )
                      )
                      .child(
                        div()
                          .text_size(10)
                          .text_color(t.dim)
                          .child("Enterprise: 第三方且 Cache Read ≥ $0.10 另加 +$0.25/M Token 費率")
                      )
                  )
                  .child(
                    h_flex()
                      .gap(4)
                      .flex_wrap()
                      .children(
                        providers.map((p) => {
                          const on = this.feeProvider === p.id;
                          return div()
                            .id(`fee-prov-${p.id}`)
                            .px(7)
                            .py(2.5)
                            .rounded(5)
                            .cursor_pointer()
                            .text_size(10.5)
                            .font_medium()
                            .bg(on ? t.selected : t.surface)
                            .border(1)
                            .border_color(on ? t.accent + "66" : t.border)
                            .text_color(on ? t.foreground : t.muted)
                            .hover((s) => s.bg(t.hover))
                            .on_click((_e, cx) => {
                              this.feeProvider = p.id;
                              cx.notify();
                            })
                            .child(p.label);
                        })
                      )
                  )
                  .when(Boolean(this.feesError), (errEl) =>
                    errEl.child(
                      div()
                        .p(10)
                        .rounded(6)
                        .bg(t.surface)
                        .text_size(11)
                        .text_color(t.dim)
                        .child(`費率讀取錯誤: ${this.feesError}`)
                    )
                  )
                  .children(
                    filteredFees.map((f, idx) => {
                      const c = modelColor(f.model);
                      const iconPath = modelIcon(f.model);
                      const used = isModelUsed(f.model, models);
                      const tip = f.notes ? `${f.model} (${f.provider})\n${f.notes}` : `${f.model} (${f.provider})`;
                      return v_flex()
                        .id(`fee-row-${idx}`)
                        .p(8)
                        .gap(5)
                        .rounded(7)
                        .bg(t.surface)
                        .border(1)
                        .border_color(used ? t.accent + "55" : t.border)
                        .tooltip(tip)
                        .child(
                          h_flex()
                            .justify_between()
                            .items_center()
                            .gap(6)
                            .child(
                              h_flex()
                                .gap(6)
                                .items_center()
                                .flex_1()
                                .min_w(0)
                                .when(Boolean(iconPath), (icEl) =>
                                  icEl.child(svg(iconPath).size(13).flex_none().text_color(c))
                                )
                                .when(!iconPath, (dotEl) =>
                                  dotEl.child(div().size(7).rounded_full().bg(c).flex_none())
                                )
                                .child(div().font_semibold().text_size(11.5).text_color(t.foreground).truncate().child(f.model))
                                .when(used, (uEl) =>
                                  uEl.child(
                                    div()
                                      .px(4)
                                      .py(0.5)
                                      .rounded(3)
                                      .bg(t.accent + "22")
                                      .text_size(9.5)
                                      .font_semibold()
                                      .text_color(t.accent)
                                      .flex_none()
                                      .child("已用")
                                  )
                                )
                            )
                            .child(
                              h_flex()
                                .gap(4)
                                .items_center()
                                .flex_none()
                                .child(
                                  div()
                                    .px(4)
                                    .py(0.5)
                                    .rounded(3)
                                    .bg(t.chrome)
                                    .text_size(9.5)
                                    .text_color(t.muted)
                                    .child(f.provider)
                                )
                                .child(
                                  div()
                                    .px(4)
                                    .py(0.5)
                                    .rounded(3)
                                    .bg(f.pool === "Cursor" ? "#38bdf822" : f.token_rate_exempt ? "#10b98122" : "#f59e0b22")
                                    .text_size(9.5)
                                    .text_color(f.pool === "Cursor" ? "#38bdf8" : f.token_rate_exempt ? "#10b981" : "#f59e0b")
                                    .child(f.pool === "Cursor" ? "Pool" : f.token_rate_exempt ? "免Token費" : "+$0.25/M")
                                )
                            )
                        )
                        .child(
                          h_flex()
                            .gap(6)
                            .items_center()
                            .text_size(10.5)
                            .children([
                              h_flex()
                                .flex_1()
                                .gap(3)
                                .child(div().text_color(t.dim).child("In"))
                                .child(div().font_medium().text_color(t.foreground).child(f.input)),
                              h_flex()
                                .flex_1()
                                .gap(3)
                                .child(div().text_color(t.dim).child("Out"))
                                .child(div().font_semibold().text_color(t.accent).child(f.output)),
                              h_flex()
                                .flex_1()
                                .gap(3)
                                .child(div().text_color(t.dim).child("Read"))
                                .child(div().text_color(t.muted).child(f.cache_read)),
                              h_flex()
                                .flex_1()
                                .gap(3)
                                .child(div().text_color(t.dim).child("Write"))
                                .child(div().text_color(t.muted).child(f.cache_write)),
                            ])
                        );
                    })
                  );
              })
              // Tab 4: Usage Analytics Charts
              .when(this.tab === "analytics", (el) =>
                el.child(this.renderAnalytics(t, d))
              )
          )
          .child(Scrollbar.vertical("usage-scroll-list").absolute().inset_0())
      )
      // Panel Footer (26px)
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
          .child(
            div().child(
              this.tab === "fees"
                ? `費率同步: ${this.feesData?.updated_at ?? "–"}`
                : `同步時間: ${d?.fetched_at ?? "–"}`
            )
          )
          .child(
            div().child(
              this.tab === "fees"
                ? (this.feesData?.from_cache ? "本地快取 · $/1M" : "官網同步 · $/1M")
                : this.tab === "today" && this._watching
                  ? "即時監聽中 (今日)"
                  : (d?.source_mode === "live" ? "每30分檢查 · 手動↻" : "離線快照 · state.vscdb")
            )
          )
      );
  }
}
