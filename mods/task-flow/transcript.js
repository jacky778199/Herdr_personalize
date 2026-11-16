import { exec } from "herdr";

const inflight = new Map();

/**
 * 讀取給定終端的 Cursor Agent 任務歷程。
 * 只接受與 chat 標題完全一致的唯一命中。同專案最新檔不當備援。
 * 讀屏只用於遠端終端，或這個 cwd 底下根本沒有 transcript。
 * @param {string} terminal
 * @param {string} cwd
 * @param {string} title
 * @param {string|null} status
 */
export async function fetchAgentTaskFlow(terminal, cwd, title, status) {
  if (!terminal || !status) return null;
  const key = String(terminal);
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = runFetch(terminal, cwd, title).finally(() => {
    if (inflight.get(key) === job) inflight.delete(key);
  });
  inflight.set(key, job);
  return job;
}

const PY_SCRIPT = `
import json, pathlib, re, sys, subprocess
from datetime import datetime

terminal = sys.argv[1] if len(sys.argv) > 1 else ""
cwd = sys.argv[2] if len(sys.argv) > 2 else ""
title = sys.argv[3] if len(sys.argv) > 3 else ""

if not terminal:
    print(json.dumps(None))
    sys.exit(0)

base_chats = pathlib.Path.home() / ".cursor" / "chats"
base_projects = pathlib.Path.home() / ".cursor" / "projects"
usage_cache_path = pathlib.Path.home() / ".config" / "herdr-app" / "data" / "cursor-usage" / "usage_cache.json"

slug = ""
if cwd:
    clean = re.sub(r"^[a-zA-Z]:[\\\\/]", lambda m: m.group(0)[0].upper() + "-", cwd)
    clean = re.sub(r"[\\\\/]+", "-", clean)
    slug = clean.strip("-")

project_dir = base_projects / slug if slug else None
matched_file = None
found_uuid = None

def norm(s):
    s = re.sub("[\\b\\x08]+", "", s or "")
    s = re.sub(r"\\s+[-–—].*$", "", s).strip()
    return s.casefold()

def parse_ts_ms(text):
    m = re.search(r"<timestamp>([^<]+)</timestamp>", text or "")
    if not m:
        return None, ""
    raw = re.sub(r"\\s*\\([^)]*\\)\\s*$", "", m.group(1).strip()).strip()
    for fmt in ("%A, %b %d, %Y, %I:%M %p", "%a, %b %d, %Y, %I:%M %p", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            dt = datetime.strptime(raw, fmt)
            return int(dt.timestamp() * 1000), dt.strftime("%H:%M")
        except Exception:
            pass
    return None, ""

def fmt_cents(cents):
    val = float(cents or 0) / 100.0
    if val <= 0:
        return "$0.00"
    if val < 0.1:
        return f"\${val:.3f}"
    return f"\${val:.2f}"

def fmt_tok(tok):
    tok = int(tok or 0)
    if tok >= 1_000_000:
        return f"{tok/1_000_000:.1f}M"
    if tok >= 1_000:
        return f"{tok/1_000:.1f}k"
    return str(tok)

nt = norm(title)
generic = (not nt) or ("cursor agent" in nt) or nt in ("pwsh.exe", "powershell.exe") or len(nt) < 3
found = []
if not generic and base_chats.exists():
    for meta in base_chats.glob("*/*/meta.json"):
        try:
            d = json.load(meta.open(encoding="utf-8"))
            if norm(d.get("title") or "") == nt:
                found.append(meta.parent.name)
        except Exception:
            pass

if len(set(found)) == 1:
    found_uuid = found[0]
    if project_dir and (project_dir / "agent-transcripts" / found_uuid).exists():
        cands = list((project_dir / "agent-transcripts" / found_uuid).glob("*.jsonl"))
        if cands:
            matched_file = cands[0]
    if not matched_file:
        cands = list(base_projects.glob("*/agent-transcripts/" + found_uuid + "/*.jsonl"))
        if cands:
            matched_file = cands[0]

if matched_file and matched_file.exists():
    try:
        with open(matched_file, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        tasks = []
        cur = None
        latest_tool = None
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue
            role = ev.get("role")
            contents = ev.get("message", {}).get("content", [])
            if role == "user":
                for c in contents:
                    if c.get("type") == "text":
                        t = c.get("text", "")
                        ts_ms, time_str = parse_ts_ms(t)
                        m = re.search(r"<user_query>(.*?)</user_query>", t, re.DOTALL)
                        q = m.group(1).strip() if m else re.sub(r"<[^>]+>.*?</[^>]+>", "", t, flags=re.DOTALL).strip()
                        q = re.sub("[\\b\\x08]+", "", q).strip()
                        if q:
                            cur = {
                                "prompt": q,
                                "ts_ms": ts_ms,
                                "time": time_str,
                                "steps": [],
                                "result": None,
                                "summary": None,
                            }
                            tasks.append(cur)
            elif role == "assistant" and cur is not None:
                for c in contents:
                    ctype = c.get("type")
                    if ctype == "tool_use":
                        name = c.get("name")
                        inp = c.get("input", {}) or {}
                        desc = inp.get("description") or inp.get("command") or inp.get("path") or inp.get("pattern") or ""
                        desc = str(desc).replace("\\n", " ").replace("\\\\n", " ").strip()
                        if len(desc) > 160:
                            desc = desc[:157] + "..."
                        step = (name + ": " + desc) if desc else name
                        cur["steps"].append(step)
                        latest_tool = step
                    elif ctype == "text":
                        txt = (c.get("text") or "").strip()
                        if txt and not txt.startswith("[REDACTED]"):
                            norm_txt = txt.replace("\\r\\n", "\\n").replace("\\r", "\\n").strip()
                            if len(norm_txt) > 2500:
                                norm_txt = norm_txt[:2497] + "..."
                            cur["result"] = norm_txt
                            fl = norm_txt.split("\\n")[0].strip()
                            if len(fl) > 140:
                                fl = fl[:137] + "..."
                            cur["summary"] = fl

        # Match per-turn & session cost from usage_cache.json
        conv_calls = []
        if found_uuid and usage_cache_path.exists():
            try:
                uc = json.loads(usage_cache_path.read_text(encoding="utf-8"))
                conv_calls = [c for c in (uc.get("today_calls") or []) if c.get("conv_id") == found_uuid]
            except Exception:
                conv_calls = []

        session_cents = sum(float(c.get("charged_cents") or 0) for c in conv_calls)
        session_models = []
        for c in conv_calls:
            m_name = c.get("model")
            if m_name and m_name not in session_models:
                session_models.append(m_name)

        # Assign calls to tasks by turn timestamp window
        for i, tk in enumerate(tasks):
            t_start = tk.get("ts_ms")
            if t_start is None:
                continue
            t_end = None
            for j in range(i + 1, len(tasks)):
                if tasks[j].get("ts_ms") is not None:
                    t_end = tasks[j]["ts_ms"]
                    break
            matched_calls = []
            for c in conv_calls:
                cts = c.get("ts_ms") or 0
                if cts >= (t_start - 5000) and (t_end is None or cts < (t_end - 5000)):
                    matched_calls.append(c)
            if matched_calls:
                cents = sum(float(c.get("charged_cents") or 0) for c in matched_calls)
                toks = sum(int(c.get("input_tokens") or 0) + int(c.get("output_tokens") or 0) + int(c.get("cache_read_tokens") or 0) for c in matched_calls)
                models = []
                for c in matched_calls:
                    mn = c.get("model")
                    if mn and mn not in models:
                        models.append(mn)
                tk["cost_cents"] = round(cents, 3)
                tk["cost_str"] = fmt_cents(cents)
                tk["calls"] = len(matched_calls)
                tk["tokens_str"] = fmt_tok(toks)
                tk["models"] = models

        if tasks:
            out = {
                "source": "transcript",
                "conv_id": found_uuid,
                "file": matched_file.name,
                "latest_tool": latest_tool,
                "session_cost_str": fmt_cents(session_cents) if conv_calls else None,
                "session_calls": len(conv_calls),
                "session_models": session_models,
                "tasks": tasks[-10:],
            }
            print(json.dumps(out, ensure_ascii=False))
            sys.exit(0)
    except Exception:
        pass

remote = "/" in (terminal or "")
has_local = bool(project_dir and (project_dir / "agent-transcripts").exists())
if (not remote) and has_local:
    print(json.dumps(None))
    sys.exit(0)

try:
    r = subprocess.run(["hc", "read", terminal, "--lines", "50"], capture_output=True, text=True, timeout=2)
    screen = r.stdout or ""
    if screen.strip():
        lines = screen.splitlines()
        latest_tool = None
        for l in reversed(lines[-12:]):
            sl = l.strip()
            if any(k in sl for k in ["Running", "Editing", "Waiting for approval", "Run (once)"]):
                latest_tool = sl
                break
            elif sl.startswith("$ "):
                latest_tool = "Shell: " + sl[2:]
                break

        queries = []
        for i, l in enumerate(lines[:-4]):
            if l.startswith("  ") and not l.startswith("    ") and not l.startswith("  $") and not l.startswith("  →") and not l.startswith("  •"):
                if i > 0 and lines[i - 1].strip() == "" and len(l.strip()) > 3:
                    if not any(k in l for k in ["Cursor Agent", "Tip:", "tokens", "task", "files edited", "v202"]):
                        queries.append(l.strip())

        if queries or latest_tool:
            p_text = queries[-1] if queries else (title if title and "Cursor Agent" not in title else "Active Session")
            out = {
                "source": "screen",
                "latest_tool": latest_tool,
                "tasks": [{"prompt": p_text, "steps": [latest_tool] if latest_tool else [], "result": None, "summary": None}]
            }
            print(json.dumps(out, ensure_ascii=False))
            sys.exit(0)
except Exception:
    pass

print(json.dumps(None))
`;

async function runFetch(terminal, cwd, title) {
  try {
    const res = await exec("python", ["-c", PY_SCRIPT, terminal, cwd || "", title || ""], { timeout: 5000 });
    if (res.code === 0 && res.stdout) {
      return JSON.parse(res.stdout.trim());
    }
  } catch (_e) {}

  return null;
}
