import { hc, panes, setShared, shared, terminals } from "herdr";
import { collectScreenTargets } from "./detect.js";
import { reportedStatus, statusWord } from "./status-word.js";

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const READ_EVENTS = new Set(["status", "turn", "title", "finished", "created", "restarted"]);

export function publishCoreShared(byTerminal, workingSinceByTerminal) {
  const byTab = {};
  const workingSinceByTab = {};
  for (const p of panes()) {
    const st = byTerminal[p.terminal];
    if (!st) continue;
    const prev = byTab[p.tab];
    if (!prev || (RANK[st] ?? 0) > (RANK[prev] ?? 0)) byTab[p.tab] = st;
    if (st === "working") {
      const since = workingSinceByTerminal[p.terminal];
      if (since != null) {
        const prevSince = workingSinceByTab[p.tab];
        if (prevSince == null || since < prevSince) workingSinceByTab[p.tab] = since;
      }
    }
  }
  setShared("core-status.by-terminal", byTerminal);
  setShared("core-status.by-tab", byTab);
  setShared("core-status.working-since", workingSinceByTab);
  setShared("core-status.working-since-by-terminal", workingSinceByTerminal);
}

function workingSinceFor(term, cache) {
  const word = statusWord(term);
  if (word !== "working") return null;
  if (term.status_ms != null) {
    const prev = cache[term.address];
    const turn = term.turn ?? 0;
    if (prev && prev.turn === turn && prev.since != null) return prev.since;
    return term.status_ms;
  }
  return cache[term.address]?.since ?? Date.now();
}

function snapshotFromTerminals(cache) {
  const byTerminal = {};
  const workingSince = {};
  const nextCache = {};
  for (const t of terminals()) {
    if (t.state !== "live") continue;
    const word = statusWord(t);
    if (!word && !reportedStatus(t)) continue;
    const st = word === "error" ? "blocked" : word ?? "idle";
    byTerminal[t.address] = st;
    const since = workingSinceFor(t, cache);
    if (since != null) workingSince[t.address] = since;
    nextCache[t.address] = { turn: t.turn ?? 0, since };
  }
  return { byTerminal, workingSince, cache: nextCache };
}

function applyTerminalFact(term, cache) {
  const byTerminal = { ...(shared("core-status.by-terminal") ?? {}) };
  const workingSince = { ...(shared("core-status.working-since-by-terminal") ?? {}) };
  const word = statusWord(term);
  if (!word) return cache;
  const st = word === "error" ? "blocked" : word;
  byTerminal[term.address] = st;
  const since = workingSinceFor(term, cache);
  if (since != null) workingSince[term.address] = since;
  else delete workingSince[term.address];
  const next = { ...cache, [term.address]: { turn: term.turn ?? 0, since } };
  publishCoreShared(byTerminal, workingSince);
  return next;
}

export function startCoreSync(cx, { onScreenRefresh }) {
  const state = {
    cache: {},
    lastJson: "",
    screenTargets: new Set(),
  };

  const applySnapshot = () => {
    const { byTerminal, workingSince, cache } = snapshotFromTerminals(state.cache);
    state.cache = cache;
    const json = JSON.stringify(byTerminal);
    const changed = json !== state.lastJson;
    state.lastJson = json;
    if (changed) {
      publishCoreShared(byTerminal, workingSince);
      cx.notify();
    }
    return changed;
  };

  const syncScreenTargetSet = () => {
    state.screenTargets = new Set(collectScreenTargets());
  };

  const refreshOne = (addr) => {
    if (addr && onScreenRefresh) onScreenRefresh(addr);
  };

  const handleEventLine = (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.channel != null && Array.isArray(msg.terminals)) {
      state.cache = {};
      applySnapshot();
      return;
    }
    const ev = msg.method === "event" ? msg.params : msg.type ? msg : null;
    if (!ev?.terminal) return;
    const type = ev.type;
    if (type === "status" || type === "turn") {
      const data = ev.data;
      if (data?.state) {
        state.cache = applyTerminalFact({
          address: ev.terminal,
          status: data,
          status_ms: data.status_ms ?? null,
          turn: ev.turn ?? data.turn ?? 0,
          reported: true,
        }, state.cache);
        cx.notify();
      } else {
        hc(["get", ev.terminal, "--json"]).then((r) => {
          if (r.code !== 0) return;
          try {
            state.cache = applyTerminalFact(JSON.parse(r.stdout), state.cache);
            cx.notify();
          } catch {}
        }).catch(() => {});
      }
    } else {
      applySnapshot();
    }
    if (type && READ_EVENTS.has(type)) refreshOne(ev.terminal);
  };

  let watchSig = "";

  const syncFromTerminals = () => {
    syncScreenTargetSet();
    const sig = terminals()
      .filter((t) => t.state === "live")
      .map((t) => `${t.address}\0${t.turn}\0${statusWord(t)}\0${t.status_ms}\0${t.title ?? ""}`)
      .join("\n");
    const sigChanged = sig !== watchSig;
    watchSig = sig;
    applySnapshot();
    if (sigChanged && onScreenRefresh) {
      onScreenRefresh();
    }
  };

  syncFromTerminals();

  cx.timer.after(1500, (cx) => {
    cx.timer.every(2000, syncFromTerminals);
  });

  cx.spawn(async () => {
    try {
      const { spawn } = await import("node:child_process");
      const child = spawn("hc", ["events", "--json"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let buf = "";
      child.stdout.on("data", (chunk) => {
        buf += String(chunk);
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const line of parts) {
          const t = line.trim();
          if (t) handleEventLine(t);
        }
      });
      child.on("error", () => {});
    } catch {
      // 1s terminals() diff still drives screen reads and core-status.
    }
  });
}
