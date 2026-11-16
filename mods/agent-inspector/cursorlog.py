"""Cursor Agent transcripts for the inspector. Local files only.

Matches a Herdr terminal to one chat by title, the same rule as pane-screen:
the title must hit exactly one ~/.cursor/chats meta.json. The newest file in
the folder is not a fallback.
"""
import json
import os
import re
import time

HOME = os.path.expanduser("~")
CHATS = os.path.join(HOME, ".cursor", "chats")
PROJECTS = os.path.join(HOME, ".cursor", "projects")
QUERY = re.compile(r"<user_query>(.*?)</user_query>", re.S)
SECRET = re.compile(
    r"(xox[abpr]-[\w-]+|gh[pousr]_\w{20,}|github_pat_\w+|sk-[\w-]{16,}|AKIA[0-9A-Z]{16}"
    r"|(?i:bearer)\s+[\w.~+/=-]{12,}|(?i:(?:token|secret|password|api[_-]?key)=)\S+)"
)


def red(text, limit=160):
    cleaned = SECRET.sub("[redacted]", " ".join(str(text or "").split()))
    return cleaned.replace(HOME, "~")[:limit]


def is_cursor(fg, raw):
    blob = " ".join([
        " ".join(str(a) for a in (fg.get("argv") or [])),
        str(fg.get("name") or ""),
        str((raw or {}).get("title") or ""),
        str((raw or {}).get("program") or ""),
    ])
    return bool(re.search(r"cursor-agent|cursor agent|cursor-agent\.exe", blob, re.I))


def norm_title(value):
    text = re.sub(r"[\b\x08]+", "", value or "")
    text = re.sub(r"\s+[-–—].*$", "", text).strip()
    return text.casefold()


def project_slug(cwd):
    if not cwd:
        return ""
    clean = re.sub(r"^([a-zA-Z]):[\\/]", lambda m: m.group(1).upper() + "-", cwd)
    clean = re.sub(r"[\\/]+", "-", clean)
    return clean.strip("-")


def find_transcript(cwd, title):
    nt = norm_title(title)
    generic = (not nt) or ("cursor agent" in nt) or nt in ("pwsh.exe", "powershell.exe") or len(nt) < 3
    if generic or not os.path.isdir(CHATS):
        return None
    found = []
    for root, dirs, files in os.walk(CHATS):
        if "meta.json" not in files:
            continue
        path = os.path.join(root, "meta.json")
        try:
            with open(path, encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, json.JSONDecodeError):
            continue
        if norm_title(data.get("title") or "") == nt:
            found.append(os.path.basename(root))
    ids = list(dict.fromkeys(found))
    if len(ids) != 1:
        return None
    chat_id = ids[0]
    slug = project_slug(cwd)
    candidates = []
    if slug:
        folder = os.path.join(PROJECTS, slug, "agent-transcripts", chat_id)
        if os.path.isdir(folder):
            candidates = [os.path.join(folder, name) for name in os.listdir(folder) if name.endswith(".jsonl")]
    if not candidates and os.path.isdir(PROJECTS):
        for project in os.listdir(PROJECTS):
            folder = os.path.join(PROJECTS, project, "agent-transcripts", chat_id)
            if os.path.isdir(folder):
                candidates.extend(os.path.join(folder, name) for name in os.listdir(folder) if name.endswith(".jsonl"))
    return candidates[0] if candidates else None


def _query(text):
    match = QUERY.search(text or "")
    body = match.group(1) if match else (text or "")
    body = re.sub(r"[\b\x08]+", "", body).strip()
    if body.startswith("<") and "skill" in body[:80].lower():
        return ""
    return red(body, 180)


def parse(path):
    turns = []
    current = None
    tools = {}
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            role = event.get("role")
            contents = ((event.get("message") or {}).get("content")) or []
            if not isinstance(contents, list):
                continue
            if role == "user":
                for block in contents:
                    if not isinstance(block, dict) or block.get("type") != "text":
                        continue
                    query = _query(block.get("text") or "")
                    if not query:
                        continue
                    current = {"at": time.time(), "prompt": query, "steps": [], "sum": {"tools": 0, "errors": 0}}
                    turns.append(current)
            elif role == "assistant" and current is not None:
                for block in contents:
                    if not isinstance(block, dict):
                        continue
                    kind = block.get("type")
                    if kind == "tool_use":
                        name = str(block.get("name") or "tool")
                        payload = block.get("input") or {}
                        label = ""
                        if isinstance(payload, dict):
                            label = payload.get("description") or payload.get("command") or payload.get("path") or ""
                        label = red(str(label).replace("\n", " "), 120)
                        current["steps"].append({"k": "tool", "name": name, "label": label, "error": False})
                        current["sum"]["tools"] += 1
                        tools[name] = tools.get(name, 0) + 1
                    elif kind == "text":
                        text = (block.get("text") or "").strip()
                        if text and not text.startswith("[REDACTED]"):
                            current["summary"] = red(text.splitlines()[0], 140)
    doing = {"state": "idle"}
    last_turn = turns[-1] if turns else None
    if last_turn and last_turn["steps"]:
        last = last_turn["steps"][-1]
        age = time.time() - os.path.getmtime(path)
        active = age < 20 and not last_turn.get("summary")
        doing = {
            "state": "tool" if active else "idle",
            "name": last["name"],
            "label": last.get("label") or "",
            "since": os.path.getmtime(path),
        }
    recent = list(reversed((last_turn or {}).get("steps") or []))[:8]
    files = []
    seen = set()
    for turn in reversed(turns):
        for step in reversed(turn["steps"]):
            if step["name"] not in ("Write", "StrReplace", "Edit", "Delete"):
                continue
            path_label = step.get("label") or ""
            if not path_label or path_label in seen:
                continue
            seen.add(path_label)
            files.append(path_label)
            if len(files) == 8:
                break
        if len(files) == 8:
            break
    shown = turns[-40:]
    return {
        "agent": "cursor",
        "model": "Cursor",
        "model_name": "Cursor",
        "prompt_count": len(turns),
        "tool_count": sum(tools.values()),
        "turns": shown,
        "doing": doing,
        "recent": [{"name": step["name"], "label": step.get("label") or ""} for step in recent],
        "files": files,
        "last_reply": (last_turn or {}).get("summary") or "",
        "last_prompt": (last_turn or {}).get("prompt") or "",
        "tools": [{"name": name, "n": count} for name, count in sorted(tools.items(), key=lambda item: -item[1])],
        "transcript": path.replace(HOME, "~"),
        "config": {},
        "issues": [],
        "subagents": [],
    }
