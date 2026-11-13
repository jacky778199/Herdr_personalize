import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, home, readTextFile, exec } from "herdr";

function getCountdown(inDateStr, expOutStr) {
  if (!expOutStr) return "";
  const now = new Date();

  let target = null;
  if (inDateStr) {
    target = new Date(`${inDateStr} ${expOutStr}`);
  }
  if (!target || isNaN(target.getTime())) {
    const m = expOutStr.match(/(\d+):(\d+)(?::(\d+))?\s*(AM|PM)?/i);
    if (m) {
      let hour = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const sec = m[3] ? parseInt(m[3], 10) : 0;
      const ampm = (m[4] || "").toUpperCase();
      if (ampm === "PM" && hour < 12) hour += 12;
      if (ampm === "AM" && hour === 12) hour = 0;
      target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, min, sec);
    }
  }

  if (!target || isNaN(target.getTime())) return "";

  const diffMs = target.getTime() - now.getTime();
  if (diffMs > 0) {
    const totalSec = Math.floor(diffMs / 1000);
    const totalMin = Math.floor(totalSec / 60);
    const hours = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    return `⏳ ${hours}hr:${mins}min`;
  } else {
    return `⏳ 0hr:0min (已下班)`;
  }
}

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.workHoursText = "";
    this.countdownText = "";
    this.inDate = "";
    this.expOut = "";
    this.fetching = false;

    // Load initial cache
    this.loadCache(cx);

    // Update countdown every 10 seconds
    cx.timer.every(10 * 1000, (cx) => {
      this.updateCountdown();
      cx.notify();
    });

    // Check daily update every 60 seconds
    cx.timer.every(60 * 1000, (cx) => {
      this.checkDailyUpdate(cx);
    });
  }

  updateCountdown() {
    if (this.expOut) {
      this.countdownText = getCountdown(this.inDate, this.expOut);
    }
  }

  cachePath() {
    const userHome = home().replace(/\\/g, "/");
    return `${userHome}/.cursor/work_hours_cache.json`;
  }

  scriptPath() {
    const userHome = home().replace(/\\/g, "/");
    return `${userHome}/.cursor/fetch_work_hours.ps1`;
  }

  loadCache(cx) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(this.cachePath());
        if (text) {
          const raw = text.replace(/^\uFEFF/, "").trim();
          if (raw) {
            const data = JSON.parse(raw);
            this.workHoursText = data.workHours || (data.expIn && data.expOut ? `${data.expIn} - ${data.expOut}` : "");
            this.inDate = data.inDate || data.date || "";
            this.expOut = data.expOut || "";
            this.updateCountdown();
            cx.notify();
          }
        }
      } catch (e) {
        // ignore
      }

      // Check if fresh fetch needed
      this.checkDailyUpdate(cx);
    });
  }

  checkDailyUpdate(cx) {
    if (this.fetching) return;

    cx.spawn(async (cx) => {
      try {
        const now = new Date();
        const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        const isAfterNoon = now.getHours() >= 12;

        let needFetch = false;
        const text = await readTextFile(this.cachePath());
        if (!text) {
          needFetch = true;
        } else {
          try {
            const raw = text.replace(/^\uFEFF/, "").trim();
            const data = JSON.parse(raw);
            if (data.date !== todayStr) {
              needFetch = true;
            } else if (isAfterNoon && !data.fetchedAfterNoon) {
              needFetch = true;
            } else {
              this.workHoursText = data.workHours || (data.expIn && data.expOut ? `${data.expIn} - ${data.expOut}` : "");
              this.inDate = data.inDate || data.date || "";
              this.expOut = data.expOut || "";
              this.updateCountdown();
              cx.notify();
            }
          } catch {
            needFetch = true;
          }
        }

        if (needFetch) {
          this.fetching = true;
          try {
            await exec("powershell", [
              "-WindowStyle", "Hidden",
              "-ExecutionPolicy", "Bypass",
              "-File", this.scriptPath()
            ], { timeout: 20000 });

            const updatedText = await readTextFile(this.cachePath());
            if (updatedText) {
              const raw = updatedText.replace(/^\uFEFF/, "").trim();
              const data = JSON.parse(raw);
              this.workHoursText = data.workHours || (data.expIn && data.expOut ? `${data.expIn} - ${data.expOut}` : "");
              this.inDate = data.inDate || data.date || "";
              this.expOut = data.expOut || "";
              this.updateCountdown();
              cx.notify();
            }
          } finally {
            this.fetching = false;
          }
        }
      } catch (err) {
        this.fetching = false;
      }
    });
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);

    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .when(Boolean(this.workHoursText), el =>
        el.child(
          h_flex().gap(6).items_center()
            .child(div().size(6).rounded(3).bg(t.dim))
            .child(`本日正常工時: ${this.workHoursText}`)
        )
      )
      .when(Boolean(this.countdownText), el =>
        el.child(
          h_flex().gap(6).items_center()
            .child(div().size(6).rounded(3).bg(t.dim))
            .child(div().text_color(t.accent ?? t.foreground).child(this.countdownText))
        )
      )
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
