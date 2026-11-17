// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, closeOverlay, props, exec, hc, theme, shared, setShared, watchFolder, window, layout, appHome, readTextFile } from "herdr";

function appFile(...parts) {
  const root = appHome().replace(/[\\/]+$/, "");
  const sep = root.includes("\\") ? "\\" : "/";
  return [root, ...parts].join(sep);
}

async function sampleUsage(code, machine) {
  const bins = machine ? ["python3", "python"] : ["python", "python3"];
  for (const bin of bins) {
    try {
      const options = { timeout: 15000 };
      if (machine) options.on = machine;
      const result = await exec(bin, ["-c", code], options);
      if (result.code !== 0 || !result.stdout) continue;
      const line = result.stdout.trim().split(/\r?\n/).pop();
      const data = JSON.parse(line);
      if (data && typeof data.cpu === "number") return data;
    } catch (_e) {}
  }
  return null;
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

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 40 : 42);
const RAIL_CELL = 32;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
const leaf = (path) => {
  const norm = String(path ?? "").replace(/[\\/]+$/, "");
  const cut = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return (cut >= 0 ? norm.slice(cut + 1) : norm) || "";
};
// Machine view is the shipped grouping. Project view buckets spaces by git repo
// name, else the live folder, and asks Agents to follow.
const VIEWS = [
  { id: "machine", label: "By machine", icon: "monitor", agents: "grouped" },
  { id: "project", label: "By project folder", icon: "folder", agents: "project" },
];
const viewOf = () => VIEWS.find((v) => v.id === shared("spaces.view")) ?? VIEWS[0];
const idPart = (s) => {
  let h = 0;
  for (const c of String(s)) h = Math.imul(h, 31) + c.codePointAt(0) | 0;
  return (h >>> 0).toString(36);
};
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

function spaceAgentInfo(w) {
  const coreBy = shared("core-status.by-tab") ?? {};
  const screenBy = shared("screen-status.by-tab") ?? {};
  let blocked = 0, working = 0, done = 0;
  for (const tab of w.tabs ?? []) {
    const st = tab.status ?? coreBy[tab.id] ?? screenBy[tab.id] ?? null;
    if (st === "blocked") blocked++;
    else if (st === "working") working++;
    else if (st === "done") done++;
  }
  const status = blocked > 0 ? "blocked" : working > 0 ? "working" : done > 0 ? "done" : (w.status ?? "idle");
  return { status, blocked, working, done, tabs: (w.tabs ?? []).length };
}

export default class Spaces extends View {
  init(_props, cx) {
    if (props()?.viewMenu) return;
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.hovered = null;
    this.machines = [];
    this.usage = {};
    this.usageCode = "";
    this.sampling = false;
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.projectFolded = new Set(JSON.parse(localStorage.getItem("spaces.projectFolded") ?? "[]"));
    this.pinned = new Set(JSON.parse(localStorage.getItem("spaces.pinned") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    this.refreshUsage(cx);
    cx.timer.every(30000, cx => this.refreshUsage(cx));
    // Refresh only when the refs could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshUsage(cx) {
    if (this.sampling) return;
    this.sampling = true;
    cx.spawn(async (cx) => {
      try {
        if (!this.usageCode) this.usageCode = (await readTextFile(appFile("mods", "spaces-plus", "usage.py"))) ?? "";
        if (!this.usageCode) return;
        const targets = [null, ...this.machines.filter((machine) => machine.state === "connected").map((machine) => machine.name)];
        await Promise.all(targets.map(async (machine) => {
          const sample = await sampleUsage(this.usageCode, machine);
          if (sample) this.usage[machine ?? ""] = sample;
        }));
      } finally {
        this.sampling = false;
        cx.notify();
      }
    });
  }

  usageBars(machine, t, { barW = 20, barH = 5, iconSize = 10, gap = 4 } = {}) {
    const usage = this.usage[machine ?? ""] ?? null;
    const who = usage?.user || "user";
    const clamp = (value) => Math.max(0, Math.min(100, Number(value) || 0));
    const bar = (icon, total, mine, tip) => {
      const raw = Number(total) || 0;
      const used = clamp(raw);
      const user = Math.min(clamp(mine), used);
      const alert = raw > 100 ? t.blocked : raw > 90 ? t.ansi3 : null;
      return h_flex().flex_none().gap(3).items_center().tooltip(tip)
        .child(svg(`mods/spaces-plus/${icon}.svg`).size(iconSize).flex_none().text_color(alert ?? t.dim))
        .child(h_flex().w(barW).h(barH).rounded(barH / 2).overflow_hidden().bg(t.border)
          .child(div().h_full().flex_grow(user).bg(alert ?? t.accent))
          .child(div().h_full().flex_grow(Math.max(0, used - user)).bg(alert ?? t.muted))
          .child(div().h_full().flex_grow(Math.max(0.01, 100 - used))));
    };
    const cpuTip = usage ? `CPU ${usage.cpu}% · ${who} ${usage.cpu_user}%` : "CPU";
    const memTip = usage ? `記憶體 ${usage.mem}% · ${who} ${usage.mem_user}%` : "記憶體";
    return h_flex().flex_none().gap(gap).items_center()
      .child(bar("cpu", usage?.cpu, usage?.cpu_user, cpuTip))
      .child(bar("mem", usage?.mem, usage?.mem_user, memTip));
  }

  usageInline(machine, t) {
    if (machine) {
      const known = this.machines.find((item) => item.name === machine);
      if (known && known.state !== "connected" && !this.usage[machine]) return null;
    }
    return this.usageBars(machine, t, { barW: 20, barH: 5, iconSize: 10, gap: 5 });
  }

  usageStrip(machinesList, t, collapsed) {
    if (collapsed) return [];
    const active = machinesList.filter((m) => {
      if (!m) return true;
      const known = this.machines.find((item) => item.name === m);
      return !known || known.state === "connected" || Boolean(this.usage[m]);
    });
    if (!active.length) return [];
    return [h_flex().id("project-usage-strip").h(20).flex_none().px(8).gap(10).items_center().overflow_hidden()
      .children(active.map((m) => h_flex().flex_none().gap(4).items_center()
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(10).flex_none().text_color(t.dim))
        .when(Boolean(m), (el) => el.child(div().text_size(10).text_color(t.dim).max_w(48).truncate().child(m)))
        .child(this.usageBars(m, t, { barW: 16, barH: 4.5, iconSize: 9, gap: 4 }))))];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        await Promise.all(keys.map((key) => this.check(key, cx)));
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // Ref-only reads avoid scanning the worktree or waking its index watch.
      // Two reads: a folder name may itself contain a newline.
      const [r, common] = await Promise.all([
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
      ]);
      if (r.code !== 0 || common.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.code !== 0 ? r.stderr : common.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = r.stdout.replace(/\n$/, ""), repo = common.stdout.replace(/\n$/, "");
      const [branch, counts, statusRes] = await Promise.all([
        exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
        exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on }),
        exec("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd, on }),
      ]);
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
      const dirty = statusRes.code === 0
        ? statusRes.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length
        : 0;
      const info = { name, branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : "(detached)", ahead, behind, dirty, repo: JSON.stringify([on, repo]), linked: repo !== `${top}/.git` };
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  // Git repo name when known, otherwise the live folder's own name.
  // Same repo name on two machines shares one project. A folder git has not
  // answered for stays on its own so two unrelated "src" dirs do not merge.
  projectInfo(w, ps) {
    const folder = place(w, ps) || w.folder || "";
    const g = this.git[where(w, ps)];
    if (g?.name) return { key: `repo:${g.name.toLowerCase()}`, label: g.name, folder };
    const label = (!w.named && w.name) ? w.name : (leaf(folder) || w.name || "Other");
    const dir = String(folder).replace(/[\\/]+$/, "").toLowerCase();
    return { key: `dir:${w.machine ?? ""}:${dir || label.toLowerCase()}`, label, folder };
  }

  publishProjects(ps) {
    const map = {};
    for (const s of spaces()) {
      const info = this.projectInfo(s, ps);
      map[s.id] = { key: info.key, label: info.label };
    }
    const next = JSON.stringify(map);
    if (next === this.publishedProjects) return;
    this.publishedProjects = next;
    setShared("spaces.projects", map);
  }

  viewMenu(t) {
    const on = viewOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Group spaces"))
      .children(VIEWS.map((v) => h_flex()
        .id(`space-view-${v.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("spaces.view", v.id);
          setShared("agents.sort", v.agents);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${v.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(v.label))
        .when(v.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  // Login / rebuilt machines stay reachable when spaces are not under machine headers.
  trouble(t, collapsed) {
    if (collapsed) return [];
    const names = [...new Set([...this.machines.map((m) => m.name), ...Object.keys(this.reconnecting)])];
    const out = [];
    for (const m of names) {
      const repair = this.reconnecting[m];
      const machine = this.machines.find((k) => k.name === m) ?? repair?.machine;
      const login = machine?.state === "needs_login";
      const rebuilt = this.rebuilt(machine) || !!repair;
      if (!login && !rebuilt) continue;
      const cmd = `hc machine login ${m}`;
      out.push(h_flex().id(`project-trouble-${m}`).h(28).px(8).gap(7).flex_none().items_center().text_size(11).text_color(t.blocked)
        .child(svg("mods/workspace-chrome/server.svg").size(13).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(login ? `${m} needs a login` : `${m} rebuilt`))
        .when(login, (el) => el.child(div().flex_none().cursor_pointer().text_color(t.foreground)
          .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(cmd); run("app.settings", { section: "machines" }); })
          .child("Login")))
        .when(rebuilt && !login, (el) => el.child(div().flex_none().cursor_pointer().text_color(t.foreground)
          .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
          .child(repair?.busy ? "Connecting…" : "Connect"))));
    }
    return out;
  }

  togglePin(id, cx) {
    this.pinned.has(id) ? this.pinned.delete(id) : this.pinned.add(id);
    localStorage.setItem("spaces.pinned", JSON.stringify([...this.pinned]));
    this.hovered = null;
    cx.notify();
  }

  // Sort rows keeping worktree children attached to their parent checkout.
  sortWithPins(list, { byMachine = false } = {}) {
    const units = [];
    for (const r of list) {
      if (r.tree && units.length) units[units.length - 1].push(r);
      else units.push([r]);
    }
    const unitPin = (u) => (u.some((r) => this.pinned.has(r.w.id)) ? 0 : 1);
    const unitMachine = (u) => u[0].w.machine ?? "";
    return units
      .map((u, idx) => ({ u, idx }))
      .sort((a, b) => {
        const pinDiff = unitPin(a.u) - unitPin(b.u);
        if (pinDiff !== 0) return pinDiff;
        if (byMachine) {
          const ma = unitMachine(a.u), mb = unitMachine(b.u);
          if (Boolean(ma) !== Boolean(mb)) return ma ? 1 : -1;
          if (ma !== mb) return ma.localeCompare(mb);
        }
        return a.idx - b.idx;
      })
      .flatMap((entry) => entry.u);
  }

  // Spaces under a header per project folder. Worktree nesting from ordered() stays.
  byProject(t, collapsed) {
    const ps = panes();
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row({ ...r, reorder: false, showMachine: true, ps }, t));
    const items = this.ordered().map((r) => ({ ...r, project: this.projectInfo(r.w, ps) }));
    const keys = [];
    for (const r of items) if (!keys.includes(r.project.key)) keys.push(r.project.key);
    const hasPinned = (key) => items.some((r) => r.project.key === key && this.pinned.has(r.w.id));
    keys.sort((a, b) => (hasPinned(a) ? 0 : 1) - (hasPinned(b) ? 0 : 1));
    const remote = [...new Set([...items.map((r) => r.w.machine).filter(Boolean), ...this.machines.map((m) => m.name)])];
    const usage = this.usageStrip([null, ...remote], t, collapsed);
    const groups = keys.flatMap((key) => {
      const mine = this.sortWithPins(items.filter((r) => r.project.key === key), { byMachine: true });
      const label = mine[0].project.label || "Other";
      const folded = this.projectFolded.has(key);
      const pinnedGroup = hasPinned(key);
      const head = h_flex().id(`project-${idPart(key)}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .when(collapsed, (el) => el.mt(4).w(RAIL_CELL).justify_center().rounded(6).tooltip(label))
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.projectFolded.delete(key) : this.projectFolded.add(key);
          localStorage.setItem("spaces.projectFolded", JSON.stringify([...this.projectFolded]));
          cx.notify();
        })
        .child(svg("mods/workspace-chrome/folder.svg").size(13).flex_none())
        .when(!collapsed, (el) => el
          .child(div().flex_1().min_w(0).truncate().child(label))
          .when(pinnedGroup, (el) => el.child(svg("mods/workspace-chrome/pin.svg").size(10).flex_none().text_color(t.accent)))
          .child(div().flex_none().child(String(mine.length)))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const cell = collapsed ? railCell : (el) => el;
      return [cell(head), ...(folded ? [] : mine.map(draw))];
    });
    return [...this.trouble(t, collapsed), ...usage, ...groups];
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const ps = panes();
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row({ ...r, ps }, t));
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) {
      const sorted = this.sortWithPins(rows);
      const body = loading(null) && !sorted.length ? [loadingRow(null)] : sorted.map(draw);
      return [...this.usageStrip([null], t, collapsed), ...body];
    }
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = this.sortWithPins(rows.filter((r) => (r.w.machine ?? null) === m));
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const login = machine?.state === "needs_login" ? `hc machine login ${m}` : null;
      const folded = this.folded.has(m);
      const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none();
      const badge = div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.dim);
      const inlineUsage = !collapsed ? this.usageInline(m, t) : null;
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(6).items_center().text_size(11).text_color(t.dim)
        .when(collapsed, el => el.mt(4).w(RAIL_CELL).justify_center().rounded(6).tooltip(login ? `${m} needs a login: run ${login}. Click for Copy.` : m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "This computer"))
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (collapsed && login) { run("app.settings", { section: "machines" }); return; }
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .when(!collapsed, el => el.child(icon))
        .when(collapsed, el => el.child(div().relative().flex_none().child(icon).when(Boolean(m), el => el.child(badge))))
        .when(!collapsed, el => el.child(div().flex_1().min_w(0).truncate().child(m ?? "This computer"))
          .when(Boolean(inlineUsage), (el) => el.child(inlineUsage))
          .when(!connected && !rebuilt && !login, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(6).justify_center().tooltip(`New space on ${m ?? "this computer"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there"));
      if (!collapsed && rebuilt) return [head];
      const cell = collapsed ? railCell : (el) => el;
      const guidance = !collapsed && login ? [v_flex().px(8).pb(6).gap(3).flex_none()
        .child(div().text_size(11).text_color(t.blocked).child("needs a login: run"))
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(login).text_size(11).text_color(t.muted).child(login))
          .child(div().id(`machine-login-copy-${m}`).flex_none().px(5).py(2).rounded(4)
            .text_size(11).text_color(t.foreground).bg(t.raised).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(login); this.copiedLogin = login; cx.notify(); })
            .child(this.copiedLogin === login ? "Copied" : "Copy")))] : [];
      return [cell(head), ...guidance, ...(folded ? [] : mine.length ? mine.map(draw) : [loading(m) ? loadingRow(m) : cell(empty)])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, raw].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .items_center()
      .text_size(11)
      .text_color(t.dim)
      .child(div().flex_1().min_w(0).truncate().child(where || raw))
      .when(g.dirty > 0, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.ansi3 ?? "#f59e0b").tooltip(`${g.dirty} 個未提交變更`).child(`*${g.dirty}`)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  agentBadge(agent, t) {
    if (agent.blocked > 0) {
      return div().flex_none().px(5).h(15).rounded(4).bg((t.blocked ?? "#ef4444") + "26")
        .text_size(10).font_bold().text_color(t.blocked ?? "#ef4444")
        .flex().items_center().justify_center()
        .tooltip(`${agent.blocked} 個 Agent 等待確認`)
        .child(agent.blocked > 1 ? `!${agent.blocked}` : "!");
    }
    if (agent.working > 0) {
      return h_flex().flex_none().gap(3).items_center()
        .tooltip(`${agent.working} 個 Agent 執行中`)
        .child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working ?? t.accent).spin(900))
        .when(agent.working > 1, (el) => el.child(div().text_size(10).text_color(t.working ?? t.accent).child(String(agent.working))));
    }
    if (agent.done > 0) {
      return div().size(6).flex_none().rounded(3).bg(t.done ?? t.ansi2)
        .tooltip(`${agent.done} 個 Agent 已完成`);
    }
    return null;
  }

  machinePill(w, t) {
    if (w.machine) {
      const mInfo = this.machines.find((m) => m.name === w.machine);
      const connected = !mInfo || mInfo.state === "connected";
      const color = connected ? (t.accent ?? "#5b8def") : t.dim;
      return h_flex().flex_none().px(5).h(15).gap(3).rounded(4).items_center()
        .bg(connected ? ((t.accent ?? "#5b8def") + "20") : t.raised)
        .child(svg("mods/workspace-chrome/server.svg").size(9).flex_none().text_color(color))
        .child(div().text_size(10).text_color(color).child(w.machine));
    }
    if (!this.machines.length) return null;
    return h_flex().flex_none().px(5).h(15).gap(3).rounded(4).items_center()
      .bg(t.raised)
      .child(svg("mods/workspace-chrome/monitor.svg").size(9).flex_none().text_color(t.dim))
      .child(div().text_size(10).text_color(t.muted).child("local"));
  }

  row({ w, i, g, tree, reorder = true, showMachine = false, ps }, t) {
    const on = w.active;
    const isPinned = this.pinned.has(w.id);
    const showPin = isPinned || this.hovered === w.id;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    const agent = spaceAgentInfo(w);
    const badge = this.agentBadge(agent, t);
    const mPill = showMachine ? this.machinePill(w, t) : null;
    const cwd = place(w, ps ?? panes()) || w.folder || "";
    const tip = [
      `${w.name}${w.machine ? ` (${w.machine})` : ""}`,
      cwd,
      g ? `${g.name} · ${g.branch ?? "detached"}${g.dirty ? ` (*${g.dirty})` : ""}` : null,
    ].filter(Boolean).join("\n");
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .gap(2)
      .rounded(8)
      .tooltip(tip)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_hover((hovered, cx) => {
        if (hovered) this.hovered = w.id;
        else if (this.hovered === w.id) this.hovered = null;
        cx.notify();
      })
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        if (!reorder) return;
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        if (!reorder) return;
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        if (!reorder) {
          run("space.select", { id: w.id });
          return;
        }
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .when(Boolean(tree), el => el.pl(20).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(w.name))
          .when(showPin, (el) => el.child(
            div().id(`space-pin-${w.id}`).flex_none().p(2).rounded(4).cursor_pointer()
              .text_color(isPinned ? t.accent : t.dim)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .tooltip(isPinned ? "取消置頂" : "置頂 Space")
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => { cx.stop_propagation(); this.togglePin(w.id, cx); })
              .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(11)),
          ))
          .when(Boolean(badge), (el) => el.child(badge)),
      )
      .child(
        h_flex()
          .pl(tree ? 34 : 26)
          .gap(5)
          .items_center()
          .text_size(11)
          .text_color(t.dim)
          .when(Boolean(mPill), (el) => el.child(mPill))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1().min_w(0).truncate().child(leaf(cwd) || "~")),
      );
  }

  compact({ w, i }, t) {
    const agent = spaceAgentInfo(w);
    return railCell(h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_CELL)
      .h(26)
      .rounded(6)
      .justify_center()
      .items_center()
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().absolute().right(5).text_color(tone(t, agent.status)).child(glyph(agent.status))));
  }

  render() {
    const t = theme();
    if (props()?.viewMenu) return this.viewMenu(t);
    const collapsed = narrow();
    const view = viewOf();
    this.publishProjects(panes());
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child("Spaces"))
        .child(h_flex().gap(2).items_center()
          .when(!collapsed, el => el.child(div().id("space-view").size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
            .tooltip(`Group spaces: ${view.label}`)
            .on_click(() => openOverlay({ mod: "spaces-plus", kind: "popup", width: 220, height: 148, props: { viewMenu: true } }))
            .child(svg(`mods/workspace-chrome/${view.icon}.svg`).size(14))))
          .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14)))))
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(view.id === "project" ? this.byProject(t, collapsed) : this.grouped(t, collapsed)));
  }
}
