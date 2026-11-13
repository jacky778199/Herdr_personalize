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

async function runFetch(terminal, cwd, title) {
  const pyCode = `
import json, pathlib, re, sys, subprocess

terminal = sys.argv[1] if len(sys.argv) > 1 else ""
cwd = sys.argv[2] if len(sys.argv) > 2 else ""
title = sys.argv[3] if len(sys.argv) > 3 else ""

if not terminal:
    print(json.dumps(None))
    sys.exit(0)

base_chats = pathlib.Path.home() / ".cursor" / "chats"
base_projects = pathlib.Path.home() / ".cursor" / "projects"

slug = ""
if cwd:
    clean = re.sub(r"^[a-zA-Z]:[\\\\/]", lambda m: m.group(0)[0].upper() + "-", cwd)
    clean = re.sub(r"[\\\\/]+", "-", clean)
    slug = clean.strip("-")

project_dir = base_projects / slug if slug else None
matched_file = None

def norm(s):
    s = re.sub("[\\b\\x08]+", "", s or "")
    s = re.sub(r"\\s+[-–—].*$", "", s).strip()
    return s.casefold()

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
                        m = re.search(r"<user_query>(.*?)</user_query>", t, re.DOTALL)
                        q = m.group(1).strip() if m else t.strip()
                        q = re.sub("[\\b\\x08]+", "", q).strip()
                        if q:
                            cur = {"prompt": q, "steps": [], "summary": None}
                            tasks.append(cur)
            elif role == "assistant" and cur is not None:
                for c in contents:
                    ctype = c.get("type")
                    if ctype == "tool_use":
                        name = c.get("name")
                        desc = c.get("input", {}).get("description") or c.get("input", {}).get("command") or c.get("input", {}).get("path") or ""
                        desc = str(desc).replace("\\n", " ").replace("\\\\n", " ").strip()
                        if len(desc) > 85:
                            desc = desc[:82] + "..."
                        step = (name + ": " + desc) if desc else name
                        cur["steps"].append(step)
                        latest_tool = step
                    elif ctype == "text":
                        txt = c.get("text", "").strip()
                        if txt and not txt.startswith("[REDACTED]") and not txt.startswith("**"):
                            fl = txt.replace("\\r\\n", "\\n").replace("\\r", "\\n").split("\\n")[0].strip()
                            if len(fl) > 140:
                                fl = fl[:137] + "..."
                            cur["summary"] = fl
        if tasks:
            out = {
                "source": "transcript",
                "file": matched_file.name,
                "latest_tool": latest_tool,
                "tasks": tasks[-6:]
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
                "tasks": [{"prompt": p_text, "steps": [latest_tool] if latest_tool else [], "summary": None}]
            }
            print(json.dumps(out, ensure_ascii=False))
            sys.exit(0)
except Exception:
    pass

print(json.dumps(None))
`;

  try {
    const res = await exec("python", ["-c", pyCode, terminal, cwd || "", title || ""], { timeout: 4000 });
    if (res.code === 0 && res.stdout) {
      return JSON.parse(res.stdout.trim());
    }
  } catch (_e) {}

  return null;
}
