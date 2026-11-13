// Add a machine: the hosts in ~/.ssh/config to pick from (or type one),
// each added with one click (`hc machine add`). Machines that need no
// answers are added quietly. When the machine needs something first
// (herdr-core installed there, a password, a new host key), a small
// terminal opens on top and runs `hc machine add` so the person can
// answer there. Opened as a dialog (`mod.open machine-add`); the
// sidebars' Add machine and the welcome open it. The same mod draws
// that terminal's title bar (`props().bar`).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { hc, exec, home, readTextFile, theme, props, closeOverlay, openOverlay, run, terminals } from "herdr";

const I = (name) => `mods/workspace-chrome/${name}.svg`;
const shellArg = (target) => /^[a-z0-9_@%+=:,./-]+$/i.test(target) ? target : "'" + target.replace(/'/g, "'\\''") + "'";
const NEEDS_ANSWER = ["hc_missing", "incompatible", "login_needed", "auth_failed", "host_key"];

function needsAnswer(why) {
  return NEEDS_ANSWER.includes(why?.kind) || /password|passphrase|host key|permission denied|login/i.test(why?.message ?? "");
}

// An Include's files, as ssh finds them: ~ is home, a relative path is
// under ~/.ssh, and a pattern matches files (through sh; none where there's no sh).
async function includeFiles(value) {
  const paths = (value.match(/"[^"]*"|\S+/g) ?? [])
    .map((p) => p.replace(/^"|"$/g, ""))
    .map((p) => (p.startsWith("~/") ? `${home()}/${p.slice(2)}` : p.startsWith("/") || /^[a-z]:[\\/]/i.test(p) ? p : `${home()}/.ssh/${p}`));
  const files = [];
  for (const p of paths) {
    if (!/[*?[]/.test(p)) {
      files.push(p);
      continue;
    }
    // From a Windows program, Git's sh gets the pattern already expanded, one
    // argument per file, unless a space made it quoted: then sh expands it, and
    // takes a backslash as an escape. So read every argument, never split one
    // at its spaces, and give sh slashes.
    const glob = /^[a-z]:/i.test(p) ? p.replace(/\\/g, "/") : p;
    const r = await exec("sh", ["-c", 'IFS=; for p in "$@"; do for f in $p; do [ -f "$f" ] && printf "%s\\n" "$f"; done; done', "sh", glob]).catch(() => null);
    files.push(...(r?.stdout ?? "").split("\n").filter(Boolean));
  }
  return files;
}

// Host entries people can pick: named ones, not patterns, from the file
// and the files it includes (ssh stops 16 deep).
async function parseConfig(text, hosts = [], depth = 0) {
  let cur = null;
  for (const raw of (text ?? "").split("\n")) {
    const m = raw.trim().match(/^([^\s#=]+)\s*=?\s*(.*)$/);
    if (!m) continue;
    const [key, value] = [m[1].toLowerCase(), m[2].trim()];
    if (key === "host" || key === "match") {
      const names = key === "host" ? value.split(/\s+/).filter((h) => h && !/[*?!]/.test(h) && !hosts.some((x) => x.alias === h || x.aliases.includes(h))) : [];
      cur = names.length ? { alias: names[0], aliases: names.slice(1), hostname: null, user: null } : null;
      if (cur) hosts.push(cur);
    } else if (key === "include" && depth < 16) {
      for (const f of await includeFiles(value)) await parseConfig(await readTextFile(f).catch(() => null), hosts, depth + 1);
    } else if (cur && key === "hostname") cur.hostname = value;
    else if (cur && key === "user") cur.user = value;
  }
  return hosts;
}

export default class MachineAdd extends View {
  init(given, cx) {
    if (given?.bar || props()?.bar) {
      this.bar = true;
      return;
    }
    this.hosts = null;
    this.added = [];
    this.state = {}; // target -> "adding" | error text
    this.pending = new Set();
    this.refreshing = false;
    this.typed = "";
    this.input = InputState.new({ placeholder: "user@host" });
    this.input.on("change", (_e, cx) => { this.typed = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.add(this.typed, cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.macs = {}; // target -> { name, core } for an added Mac
    this.opened = {};
    this.setup = {}; // target -> { terminal } while its answer window is open
    this.setupOverlay = null;
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      this.hosts = await parseConfig(await readTextFile(`${home()}/.ssh/config`).catch(() => null));
      await this.refresh();
      cx.notify();
    });
    cx.timer.every(3000, (cx) => {
      if (!this.pending.size || this.refreshing) return;
      this.refreshing = true;
      cx.spawn(async (cx) => {
        try {
          await this.refresh();
          cx.notify();
        } finally {
          this.refreshing = false;
        }
      });
    });
  }

  async refresh() {
    const r = await hc(["machine", "ls", "--json"]).catch(() => null);
    try {
      this.added = r?.code === 0 ? (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary) : [];
    } catch {
      this.added = [];
    }
    for (const target of this.pending) {
      if (!this.isAdded(target)) continue;
      this.pending.delete(target);
      delete this.state[target];
      delete this.setup[target];
      if (this.typed.trim() === target) {
        this.input.set_value("");
        this.typed = "";
      }
      await this.checkMac(target);
    }
  }

  isAdded(target) {
    return this.added.some((m) => m.target === target || m.name === target || m.host === target);
  }

  add(target, cx) {
    target = target.trim();
    if (!target || this.state[target] === "adding") return;
    if (this.state[target] === "setup" && this.setupLive(target)) {
      run("pane.focus", { terminal: this.setup[target].terminal });
      return;
    }
    this.pending.delete(target);
    this.state[target] = "adding";
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await hc(["machine", "add", target, "--json"]).catch((e) => ({ code: 1, stderr: String(e), stdout: "" }));
      let why = null;
      try {
        why = r.code === 0 ? null : (JSON.parse(r.stdout || r.stderr).error ?? { message: (r.stderr || r.stdout).trim() });
      } catch {
        why = { message: (r.stderr || r.stdout || "it didn't answer").trim() };
      }
      if (!why) {
        delete this.state[target];
        this.input.set_value("");
        this.typed = "";
        await this.refresh();
        await this.checkMac(target);
      } else if (needsAnswer(why)) {
        await this.openSetup(target);
      } else this.state[target] = why.message || "it didn't work";
      await this.refresh();
      cx.notify();
    });
  }

  // macOS asks on its own screen before anything reads Desktop, Documents
  // or Downloads, and the asking program waits: say so once, with the way
  // to allow it for good.
  async checkMac(target) {
    const m = this.added.find((x) => x.target === target || x.name === target);
    if (!m) return;
    const r = await exec("sh", ["-c", 'uname; command -v herdr-core || echo "$HOME/.local/bin/herdr-core"'], { on: m.name }).catch(() => null);
    const [os, core] = (r?.stdout ?? "").trim().split("\n");
    if (os === "Darwin") this.macs[target] = { name: m.name, core: core ?? "~/.local/bin/herdr-core" };
  }

  macCard(t, target) {
    const mac = this.macs[target];
    return v_flex()
      .mx(10)
      .mb(8)
      .p(12)
      .gap(8)
      .rounded(10)
      .bg(t.blocked + "14")
      .border_1()
      .border_color(t.blocked + "40")
      .child(div().text_size(12.8).font_semibold().text_color(t.foreground).child(`${mac.name} is a Mac: allow its folders once`))
      .child(
        div()
          .text_size(12.5)
          .line_height("18px")
          .text_color(t.muted)
          .child("macOS asks on the Mac's own screen before an agent reads Desktop, Documents or Downloads, and waits until someone answers. Give herdr-core Full Disk Access there and it never asks again: in the list, press + and pick this file:"),
      )
      .child(div().px(8).py(4).rounded(6).bg(t.background).border_1().border_color(t.border).text_size(12).text_color(t.foreground).child(mac.core))
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            div()
              .id(`ma-mac-${target}`)
              .h(28)
              .px(12)
              .flex()
              .items_center()
              .rounded(7)
              .bg(t.solid)
              .text_color(t.solid_foreground)
              .text_size(12)
              .font_medium()
              .cursor_pointer()
              .hover((s) => s.opacity(0.88))
              .on_click((_e, cx) => {
                exec("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"], { on: mac.name }).catch(() => null);
                this.opened[target] = true;
                cx.notify();
              })
              .child(`Open the setting on ${mac.name}`),
          )
          .when(Boolean(this.opened[target]), (el) => el.child(div().text_size(12).text_color(t.dim).child("It's open on the Mac's screen."))),
      );
  }

  // A real terminal, on top of this dialog, running `hc machine add`.
  // The quiet add above already refused: it will not copy hc, accept a host
  // key, or type a password unless someone answers in a terminal.
  async openSetup(target) {
    for (const s of Object.values(this.setup)) {
      if (s?.terminal) run("terminal.kill", { terminal: s.terminal });
    }
    if (this.setupOverlay) closeOverlay(this.setupOverlay);
    const name = ("madd" + Math.random().toString(36).slice(2, 10)).slice(0, 32);
    const r = await hc(["run", "--bg", "--json", "--no-parent", "--rm", "--name", name, "--", "hc", "machine", "add", target]).catch((e) => ({ code: 1, stderr: String(e), stdout: "" }));
    let started = null;
    try {
      started = JSON.parse(r.stdout || r.stderr);
    } catch {
      started = null;
    }
    const terminal = started?.address;
    if (r.code !== 0 || !terminal || started?.error) {
      const quoted = shellArg(target);
      this.pending.add(target);
      this.state[target] = started?.error?.message || `Couldn't open a setup terminal for ${target}. Run \`hc machine add ${quoted}\` in a terminal.`;
      return;
    }
    this.setupOverlay = openOverlay({
      kind: "dialog",
      modal: true,
      key: "machine-add-setup",
      width: 720,
      height: 460,
      layout: {
        id: "machine-add-setup",
        type: "column",
        children: [
          {
            id: "machine-add-setup-bar",
            type: "block",
            size: { px: 36 },
            content: { mod: "machine-add", props: { bar: true, target, terminal } },
          },
          {
            id: "machine-add-setup-term",
            type: "block",
            size: { weight: 1 },
            content: { terminal },
          },
        ],
      },
    });
    this.setup[target] = { terminal };
    this.pending.add(target);
    this.state[target] = "setup";
    run("pane.focus", { terminal });
  }

  setupLive(target) {
    const terminal = this.setup[target]?.terminal;
    if (!terminal) return false;
    return terminals().some((x) => x.address === terminal);
  }

  // The setup window closes itself when its terminal ends. Refresh then, so a
  // machine that was just added does not flash as a failed setup.
  watchSetup(cx) {
    if (!cx?.spawn) return;
    for (const [target, s] of Object.entries(this.setup)) {
      if (!s || s.settled || this.setupLive(target)) continue;
      s.settled = true;
      cx.spawn(async (cx) => {
        await this.refresh();
        if (this.setup[target]) this.setup[target].checked = true;
        cx.notify();
      });
    }
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    const mine = props();
    if (mine?.bar) {
      // Cancel and Esc stop a setup that is still asking. A finished
      // terminal already closed this window; killing it again would toast.
      if (mine.terminal && terminals().some((x) => x.address === mine.terminal)) run("terminal.kill", { terminal: mine.terminal });
      closeOverlay(mine.overlay);
      return;
    }
    if (this.setupOverlay) closeOverlay(this.setupOverlay);
    for (const s of Object.values(this.setup ?? {})) {
      if (s?.terminal) run("terminal.kill", { terminal: s.terminal });
    }
    closeOverlay(mine?.overlay);
  }

  key(e, cx) {
    if (e.key === "escape") { this.close(); cx.stop_propagation(); }
  }

  message(t, target) {
    if (this.state[target] === "setup") {
      const live = this.setupLive(target);
      const text = live
        ? `Answer in the window in front. It asks before copying hc, and it also takes a password or a new host key. This list updates when ${target} is added.`
        : this.setup[target]?.checked
          ? `The setup window for ${target} closed before the machine was added. Press Add to try again.`
          : `Finishing setup for ${target}…`;
      return h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(12).line_height("18px").text_color(live ? t.muted : t.blocked).child(text))
        .when(live, (el) => el.child(div()
          .id(`ma-show-${target}`)
          .px(10).py(4).rounded(6).bg(t.raised).text_color(t.foreground).text_size(12).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { cx.stop_propagation(); run("pane.focus", { terminal: this.setup[target].terminal }); })
          .child("Show")));
    }
    const text = String(this.state[target]).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const command = `hc machine add ${shellArg(target)}`;
    return v_flex().gap(5)
      .child(div().text_size(12).text_color(t.blocked).child(TextView.html(`ma-message-${target}`, `<span>${text}</span>`).selectable(true)))
      .when(this.pending.has(target), (el) => el.child(h_flex().child(div()
        .id(`ma-copy-${target}`).px(10).py(4).rounded(6).bg(t.raised).text_color(t.foreground)
        .text_size(12).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => { cx.write_to_clipboard(command); this.copiedCommand = command; cx.notify(); })
        .child(this.copiedCommand === command ? "Copied" : "Copy"))));
  }

  row(t, target, label, sub) {
    const st = this.state[target];
    const done = this.isAdded(target);
    const live = st === "setup" && this.setupLive(target);
    const right = done
      ? h_flex().gap(5).items_center().text_size(12).text_color(t.ansi2).child(svg(I("circle-check")).size(13)).child("Added")
      : st === "adding"
        ? h_flex().gap(6).items_center().text_size(12).text_color(t.muted).child(svg(I("spinner")).size(12).text_color(t.working).spin(900)).child("Connecting")
        : live
          ? div()
              .id(`ma-answer-${target}`)
              .px(10)
              .h(26)
              .flex()
              .items_center()
              .rounded(7)
              .bg(t.solid)
              .text_color(t.solid_foreground)
              .text_size(12)
              .font_medium()
              .cursor_pointer()
              .hover((s) => s.opacity(0.88))
              .on_click((_e, cx) => { cx.stop_propagation(); run("pane.focus", { terminal: this.setup[target].terminal }); })
              .child("Answer")
          : div()
              .id(`ma-add-${target}`)
              .px(10)
              .h(26)
              .flex()
              .items_center()
              .rounded(7)
              .border_1()
              .border_color(t.input)
              .bg(t.raised)
              .text_size(12)
              .font_medium()
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => this.add(target, cx))
              .child("Add");
    const idle = !done && !st;
    return v_flex()
      .flex_none()
      .child(
        h_flex()
          .id(`ma-row-${target}`)
          .h(40)
          .px(10)
          .gap(10)
          .items_center()
          .rounded(8)
          .hover((s) => s.bg(t.hover))
          .when(idle, (el) => el.cursor_pointer().on_click((_e, cx) => this.add(target, cx)))
          .child(svg(I("server")).size(15).text_color(t.muted))
          .child(div().flex_none().text_size(13).text_color(t.foreground).child(label))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(sub ?? ""))
          .child(right),
      )
      .when(typeof st === "string" && st !== "adding", (el) => el.child(div().px(35).pb(6).child(this.message(t, target))))
      .when(Boolean(this.macs[target]), (el) => el.child(this.macCard(t, target)));
  }

  setupBar() {
    const t = theme();
    const target = props()?.target ?? "";
    return h_flex()
      .id("ma-setup-bar")
      .size_full()
      .px(12)
      .gap(8)
      .items_center()
      .bg(t.popover)
      .text_color(t.foreground)
      .child(div().flex_none().text_size(13).font_semibold().child(`Set up ${target}`))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child("Answer here. Esc or Cancel stops it."))
      .child(
        div()
          .id("ma-setup-cancel")
          .px(8)
          .py(2)
          .rounded(5)
          .text_size(12)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down((_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.close(); })
          .child("Cancel"),
      );
  }

  render(cx) {
    if (this.bar) return this.setupBar();
    this.watchSetup(cx);
    const t = theme();
    const hosts = this.hosts ?? [];
    return v_flex()
      .id("machine-add")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .w_full()
      .min_h(0)
      .p(18)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child("Add a machine")).child(div().id("ma-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")))
      .child(
        div()
          .pt(6)
          .text_size(12.8)
          .line_height("19px")
          .text_color(t.muted)
          .child("A VPS, a Mac mini, a box at home: Herdr reaches it over ssh, and agents there keep running while your laptop sleeps."),
      )
      .child(div().pt(16).pb(6).text_size(11.5).font_medium().text_color(t.dim).child(hosts.length ? "From your ssh config" : "Your ssh config lists no hosts"))
      .child(
        v_flex()
          .id("ma-hosts")
          .max_h(280)
          .min_h(0)
          .flex_shrink(1)
          .overflow_y_scroll()
          .children(
            this.hosts === null
              ? [div().px(10).py(8).text_size(12.5).text_color(t.dim).child("Reading ~/.ssh/config…")]
              : hosts.map((h) => this.row(t, h.alias, h.alias, [h.user, h.hostname].filter(Boolean).join("@") || (h.aliases.length ? `also ${h.aliases.join(", ")}` : ""))),
          ),
      )
      .child(div().pt(14).pb(6).text_size(11.5).font_medium().text_color(t.dim).child("Or type how ssh reaches it"))
      .child(
        h_flex()
          .gap(8)
          .child(
            Input.new(this.input)
              .flex_1()
              .h(34)
              .px(10)
              .gap(6)
              .items_center()
              .rounded(8)
              .border_1()
              .border_color(this.inputFocused ? t.accent : t.input)
              .bg(t.background)
              .text_size(13)
              .text_color(t.foreground),
          )
          .child(
            div()
              .id("ma-add-typed")
              .h(34)
              .px(14)
              .flex()
              .items_center()
              .rounded(8)
              .bg(t.solid)
              .text_color(t.solid_foreground)
              .text_size(12.5)
              .font_medium()
              .when(!this.typed.trim(), (el) => el.opacity(0.4))
              .cursor_pointer()
              .on_click((_e, cx) => this.add(this.typed, cx))
              .child("Add"),
          ),
      )
      .when(Boolean(this.typed.trim() && this.state[this.typed.trim()]), (el) => el.child(div().pt(6).child(this.message(t, this.typed.trim()))));
  }
}
