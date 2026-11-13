import { hc, panes, terminals, agents, setShared, spaces } from "herdr";
import { detectCursor } from "./rules-cursor.js";
import { isAgentTerminal } from "./agent-terminal.js";
import { canonicalTabId, tabIdFromTerminal } from "./tab-resolve.js";

const CURSOR_SCREEN = /Add a follow-up|→\s*Plan, search|→\s*Run \(once\)|run \(once\)\s*\(y\)|skip.*esc or n|background tasks|ctrl\+c to stop|Gemini .*·|Claude Opus.*·|Cursor Agent\s*\n\s*v20\d|Composer \d|file edited/i;

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

function bumpTab(byTab, workingSinceByTab, tabId, st, since) {
  if (!tabId || !st) return;
  const prev = byTab[tabId];
  if (!prev || (RANK[st] ?? 0) > (RANK[prev] ?? 0)) byTab[tabId] = st;
  if (st === "working" && since != null) {
    const prevSince = workingSinceByTab[tabId];
    if (prevSince == null || since < prevSince) workingSinceByTab[tabId] = since;
  }
}

export function publishScreenShared(byTerminal, workingSinceByTerminal) {
  const byTab = {};
  const workingSinceByTab = {};

  for (const p of panes()) {
    const st = byTerminal[p.terminal];
    if (!st) continue;
    const tabId = canonicalTabId(p.tab, p.terminal);
    bumpTab(byTab, workingSinceByTab, tabId, st, workingSinceByTerminal[p.terminal]);
  }

  for (const t of terminals()) {
    if (t.state !== "live") continue;
    const st = byTerminal[t.address];
    if (!st) continue;
    const tabId = tabIdFromTerminal(t);
    if (!tabId) continue;
    bumpTab(byTab, workingSinceByTab, tabId, st, workingSinceByTerminal[t.address]);
  }

  setShared("screen-status.by-terminal", byTerminal);
  setShared("screen-status.by-tab", byTab);
  setShared("screen-status.working-since", workingSinceByTab);
}

/** True when terminal output matches Cursor agent UI (not tab name / argv). */
export function confirmCursorAgentScreen(text) {
  if (!text?.trim()) return false;
  if (screenLooksLikeCursor(text)) return true;
  const st = detectCursor(text);
  return st === "working" || st === "blocked";
}

export function paneMayNeedDiscovery(pane, knownScreen) {
  if (!pane.terminal) return false;
  if (pane.status != null) return false;
  if (agents().some((a) => a.address === pane.terminal)) return false;
  if (knownScreen?.has(pane.terminal)) return false;
  const term = terminals().find((t) => t.address === pane.terminal);
  return term?.state === "live";
}

export function terminalIsScreenTarget(term) {
  if (!term || term.state !== "live") return false;
  if (agents().some((a) => a.address === term.address)) return false;
  return isAgentTerminal(term);
}

export function screenLooksLikeCursor(text) {
  return Boolean(text && CURSOR_SCREEN.test(text));
}

/** Terminals already confirmed by screen content (or restored from shared). */
export function collectScreenTargets(knownScreen) {
  const known = knownScreen ?? new Set();
  const live = new Set(terminals().filter((t) => t.state === "live").map((t) => t.address));
  return [...known].filter((addr) => live.has(addr));
}

/** Non-OSC pane terminals to probe with hc read until content matches. */
export function collectDiscoveryCandidates(knownScreen) {
  const known = knownScreen ?? new Set();
  const out = [];
  for (const p of panes()) {
    if (!paneMayNeedDiscovery(p, known)) continue;
    out.push(p.terminal);
  }
  const paneTerminals = new Set(panes().map((p) => p.terminal).filter(Boolean));
  for (const t of terminals()) {
    if (t.state !== "live" || known.has(t.address)) continue;
    if (!t.address.includes("/")) continue;
    if (paneTerminals.has(t.address)) continue;
    if (agents().some((a) => a.address === t.address)) continue;
    if (isAgentTerminal(t)) out.push(t.address);
  }
  return [...new Set(out)];
}

/** Remote agents not on a visible pane — polled on a slower cadence. */
export function collectBackgroundScreenTargets() {
  const paneTerminals = new Set(panes().map((p) => p.terminal).filter(Boolean));
  const out = [];
  for (const t of terminals()) {
    if (t.state !== "live") continue;
    if (!t.address.includes("/")) continue;
    if (paneTerminals.has(t.address)) continue;
    if (!terminalIsScreenTarget(t)) continue;
    out.push(t.address);
  }
  return out;
}

export async function readScreen(address, lines = 40) {
  const r = await hc(["read", address, "--lines", String(lines)]);
  const text = (r.stdout ?? "").trim();
  return { text, status: text ? detectCursor(text) : "idle" };
}

export async function readScreenStatus(address) {
  return (await readScreen(address)).status;
}
