"""Aggregate daily Cursor Agent activity from local transcripts for Worklog."""

import json
import os
import pathlib
import re
import sys
from datetime import datetime

HOME = pathlib.Path.home()
CHATS_DIR = HOME / ".cursor" / "chats"
PROJECTS_DIR = HOME / ".cursor" / "projects"
ANTIGRAVITY_BRAIN_DIR = HOME / ".gemini" / "antigravity-cli" / "brain"
PI_SESSIONS_DIR = HOME / ".pi" / "agent" / "sessions"
USAGE_CACHE = pathlib.Path(__file__).resolve().parents[2] / "data" / "cursor-usage" / "usage_cache.json"

WEEKDAYS_ZH = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"]


def clean_text(s):
    return re.sub(r"[\b\x08]+", "", s or "").strip()


def shorten(s, limit=110):
    s = re.sub(r"\s+", " ", (s or "")).strip()
    if len(s) <= limit:
        return s
    return s[: limit - 1].rstrip() + "…"


def clean_result_summary(txt, limit=150):
    if not txt:
        return ""
    lines = []
    for raw in txt.splitlines():
        line = raw.strip()
        if not line or line.startswith("```") or line.startswith("---"):
            continue
        # Strip markdown headings/bullets/bold markers for compact card display
        line = re.sub(r"^#{1,6}\s+", "", line)
        line = re.sub(r"^[-*•]\s+", "", line)
        line = re.sub(r"^\d+\.\s+", "", line)
        line = line.replace("**", "").replace("`", "")
        if line:
            lines.append(line)
        if len(" ".join(lines)) >= limit:
            break
    return shorten(" ".join(lines), limit)


def decode_project_name(slug):
    if not slug:
        return "Workspace"
    # e.g. C-Users-honjayt -> ~, C-SPB-Data-ted -> ted, C-Users-honjayt-proj -> proj
    home_slug = re.sub(r"^[a-zA-Z]:[\\/]", lambda m: m.group(0)[0].upper() + "-", str(HOME))
    home_slug = re.sub(r"[\\/]+", "-", home_slug).strip("-")
    if slug == home_slug:
        return "~"
    if slug.startswith(home_slug + "-"):
        return slug[len(home_slug) + 1 :]
    parts = [p for p in slug.split("-") if p]
    return parts[-1] if parts else slug


def parse_timestamp(text):
    m = re.search(r"<timestamp>([^<]+)</timestamp>", text or "")
    if not m:
        return None, None, ""
    raw = re.sub(r"\s*\([^)]*\)\s*$", "", m.group(1).strip()).strip()
    for fmt in (
        "%A, %b %d, %Y, %I:%M %p",
        "%a, %b %d, %Y, %I:%M %p",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
    ):
        try:
            dt = datetime.strptime(raw, fmt)
            return dt.strftime("%Y-%m-%d"), int(dt.timestamp() * 1000), dt.strftime("%H:%M")
        except Exception:
            pass
    return None, None, ""


def fmt_cents(cents):
    val = float(cents or 0) / 100.0
    if val <= 0:
        return "$0.00"
    if val < 0.1:
        return f"${val:.3f}"
    return f"${val:.2f}"


def fmt_tok(tok):
    tok = int(tok or 0)
    if tok >= 1_000_000:
        return f"{tok/1_000_000:.1f}M"
    if tok >= 1_000:
        return f"{tok/1_000:.1f}k"
    return str(tok)


def load_chat_meta():
    meta_map = {}
    if not CHATS_DIR.exists():
        return meta_map
    for meta in CHATS_DIR.glob("*/*/meta.json"):
        cid = meta.parent.name
        try:
            d = json.load(meta.open(encoding="utf-8"))
            meta_map[cid] = {
                "title": (d.get("title") or "").strip(),
                "model": d.get("lastUsedModel") or "",
            }
        except Exception:
            pass
    return meta_map


def load_today_usage_calls(target_date):
    by_conv = {}
    if not USAGE_CACHE.exists():
        return by_conv
    try:
        uc = json.loads(USAGE_CACHE.read_text(encoding="utf-8"))
        cache_date = (uc.get("today_summary") or {}).get("date")
        if cache_date != target_date:
            return by_conv
        for c in uc.get("today_calls") or []:
            cid = c.get("conv_id")
            if not cid:
                continue
            by_conv.setdefault(cid, []).append(c)
    except Exception:
        pass
    return by_conv


def build_markdown(date_str, weekday, sessions, summary):
    lines = [
        f"# 工作日誌 {date_str} ({weekday})",
        "",
        f"- 完成任務：{summary['task_count']} 項（共 {summary['session_count']} 個工作階段）",
        f"- 修改檔案：{summary['files_count']} 個 · 工具操作：{summary['steps_count']} 次"
        + (f" · 花費：{summary['cost_str']}" if summary.get("cost_str") else ""),
        "",
    ]
    for s in sessions:
        head = f"## [{s['project']}] {s['title']}"
        if s.get("time_range"):
            head += f" ({s['time_range']})"
        if s.get("cost_str"):
            head += f" — {s['cost_str']}"
        lines.append(head)
        for tk in s["turns"]:
            t_prefix = f"`{tk['time']}` " if tk.get("time") else ""
            lines.append(f"- **任務**：{t_prefix}{tk['prompt_short']}")
            if tk.get("result_short"):
                lines.append(f"  - **完成**：{tk['result_short']}")
            if tk.get("files_modified"):
                lines.append(f"  - **異動檔案**：{', '.join(tk['files_modified'][:8])}")
        lines.append("")
    return "\n".join(lines).strip()


def parse_iso_timestamp(ts_str):
    if not ts_str:
        return None, None, ""
    try:
        s = str(ts_str).strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is not None:
            dt = dt.astimezone()
        return dt.strftime("%Y-%m-%d"), int(dt.timestamp() * 1000), dt.strftime("%H:%M")
    except Exception:
        return None, None, ""


def _unquote(val):
    if val is None:
        return ""
    s = str(val).strip()
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        try:
            return str(json.loads(s))
        except Exception:
            return s[1:-1]
    return s


def collect_antigravity_sessions(target_date, day_start_ts):
    sessions = []
    all_files = set()
    total_tasks = 0
    total_steps = 0

    if not ANTIGRAVITY_BRAIN_DIR.exists():
        return sessions, all_files, total_tasks, total_steps

    for jf in ANTIGRAVITY_BRAIN_DIR.glob("*/.system_generated/logs/transcript.jsonl"):
        try:
            st = jf.stat()
        except OSError:
            continue
        if st.st_mtime < day_start_ts:
            continue

        conv_id = jf.parent.parent.parent.name
        file_date = datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d")
        file_time = datetime.fromtimestamp(st.st_mtime).strftime("%H:%M")

        try:
            raw_lines = jf.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception:
            continue

        turns = []
        cur = None
        for line in raw_lines:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue

            ev_type = ev.get("type")
            if ev_type == "USER_INPUT":
                content = ev.get("content") or ""
                t_date, t_ms, t_hm = parse_iso_timestamp(ev.get("created_at"))
                m = re.search(r"<USER_REQUEST>(.*?)</USER_REQUEST>", content, re.DOTALL)
                q = m.group(1).strip() if m else re.sub(r"<[^>]+>.*?</[^>]+>", "", content, flags=re.DOTALL).strip()
                q = clean_text(q)
                if not q:
                    continue
                cur = {
                    "date": t_date,
                    "ts_ms": t_ms,
                    "time": t_hm,
                    "prompt": q,
                    "prompt_short": shorten(q, 90),
                    "steps": [],
                    "files_modified": [],
                    "result": None,
                    "result_short": "",
                }
                turns.append(cur)
            elif ev_type == "PLANNER_RESPONSE" and cur is not None:
                for tc in ev.get("tool_calls") or []:
                    name = tc.get("name") or "Tool"
                    args = tc.get("args") or {}
                    if not isinstance(args, dict):
                        args = {}
                    desc = (
                        _unquote(args.get("toolSummary"))
                        or _unquote(args.get("CommandLine"))
                        or _unquote(args.get("Path"))
                        or _unquote(args.get("query"))
                        or ""
                    )
                    desc = desc.replace("\n", " ").strip()
                    if len(desc) > 150:
                        desc = desc[:147] + "..."
                    cur["steps"].append(f"{name}: {desc}" if desc else name)

                    if name in ("write_file", "edit_file"):
                        fp = _unquote(args.get("Path"))
                        if fp:
                            bn = os.path.basename(fp.replace("\\", "/"))
                            if bn and bn not in cur["files_modified"]:
                                cur["files_modified"].append(bn)

                txt = (ev.get("content") or "").strip()
                if txt:
                    norm_txt = txt.replace("\r\n", "\n").replace("\r", "\n").strip()
                    if len(norm_txt) > 2200:
                        norm_txt = norm_txt[:2197] + "..."
                    cur["result"] = norm_txt
                    cur["result_short"] = clean_result_summary(norm_txt, 150)

        day_turns = []
        for tk in turns:
            if tk["date"] == target_date:
                day_turns.append(tk)
            elif tk["date"] is None and file_date == target_date:
                tk["time"] = file_time
                tk["ts_ms"] = int(st.st_mtime * 1000)
                day_turns.append(tk)

        if not day_turns:
            continue

        sess_files = []
        sess_steps = 0
        for tk in day_turns:
            sess_steps += len(tk["steps"])
            for f in tk["files_modified"]:
                all_files.add(f)
                if f not in sess_files:
                    sess_files.append(f)

        total_tasks += len(day_turns)
        total_steps += sess_steps

        times = [tk["time"] for tk in day_turns if tk.get("time")]
        time_range = f"{times[0]}–{times[-1]}" if len(times) > 1 and times[0] != times[-1] else (times[0] if times else "")
        last_ts = max((tk.get("ts_ms") or 0) for tk in day_turns)

        title = day_turns[0]["prompt_short"]
        last_turn = day_turns[-1]

        sessions.append({
            "conv_id": conv_id,
            "source": "antigravity",
            "title": title,
            "project": "Antigravity",
            "time_range": time_range,
            "last_ts": last_ts,
            "turn_count": len(day_turns),
            "steps_count": sess_steps,
            "files_modified": sess_files,
            "cost_cents": None,
            "cost_str": None,
            "models": [],
            "what_done": last_turn.get("result_short") or last_turn.get("prompt_short"),
            "turns": day_turns,
        })

    return sessions, all_files, total_tasks, total_steps


def collect_pi_sessions(target_date, day_start_ts):
    sessions = []
    all_files = set()
    total_tasks = 0
    total_steps = 0
    total_cents = 0.0
    has_any_cost = False

    if not PI_SESSIONS_DIR.exists():
        return sessions, all_files, total_tasks, total_steps, total_cents, has_any_cost

    for jf in PI_SESSIONS_DIR.glob("*/*.jsonl"):
        try:
            st = jf.stat()
        except OSError:
            continue
        if st.st_mtime < day_start_ts:
            continue

        conv_id = jf.stem
        project_name = "Pi"
        file_date = datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d")
        file_time = datetime.fromtimestamp(st.st_mtime).strftime("%H:%M")

        try:
            raw_lines = jf.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception:
            continue

        turns = []
        cur = None
        for line in raw_lines:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue

            ev_type = ev.get("type")
            if ev_type == "session":
                if ev.get("id"):
                    conv_id = ev["id"]
                cwd = (ev.get("cwd") or "").strip()
                if cwd:
                    norm_cwd = os.path.normpath(cwd)
                    norm_home = os.path.normpath(str(HOME))
                    project_name = "~" if norm_cwd == norm_home else (os.path.basename(norm_cwd) or "Pi")
            elif ev_type == "message":
                msg = ev.get("message") or {}
                role = msg.get("role")
                contents = msg.get("content")
                if role == "user":
                    t_date, t_ms, t_hm = parse_iso_timestamp(ev.get("timestamp"))
                    if isinstance(contents, str):
                        q = contents
                    elif isinstance(contents, list):
                        q = "\n".join(
                            c.get("text", "") for c in contents
                            if isinstance(c, dict) and c.get("type") == "text"
                        )
                    else:
                        q = ""
                    q = clean_text(q)
                    if not q:
                        continue
                    cur = {
                        "date": t_date,
                        "ts_ms": t_ms,
                        "time": t_hm,
                        "prompt": q,
                        "prompt_short": shorten(q, 90),
                        "steps": [],
                        "files_modified": [],
                        "result": None,
                        "result_short": "",
                        "_cents": 0.0,
                        "_toks": 0,
                        "_calls": 0,
                        "_models": [],
                    }
                    turns.append(cur)
                elif role == "assistant" and cur is not None:
                    if isinstance(contents, list):
                        for c in contents:
                            if not isinstance(c, dict):
                                continue
                            ctype = c.get("type")
                            if ctype == "toolCall":
                                name = c.get("name") or "Tool"
                                args = c.get("arguments") or {}
                                if not isinstance(args, dict):
                                    args = {}
                                desc = str(args.get("command") or args.get("path") or "").replace("\n", " ").strip()
                                if len(desc) > 150:
                                    desc = desc[:147] + "..."
                                cur["steps"].append(f"{name}: {desc}" if desc else name)
                                if name in ("write", "edit"):
                                    fp = args.get("path") or ""
                                    if fp:
                                        bn = os.path.basename(str(fp).replace("\\", "/"))
                                        if bn and bn not in cur["files_modified"]:
                                            cur["files_modified"].append(bn)
                            elif ctype == "text":
                                txt = (c.get("text") or "").strip()
                                if txt:
                                    norm_txt = txt.replace("\r\n", "\n").replace("\r", "\n").strip()
                                    if len(norm_txt) > 2200:
                                        norm_txt = norm_txt[:2197] + "..."
                                    cur["result"] = norm_txt
                                    cur["result_short"] = clean_result_summary(norm_txt, 150)

                    usage = msg.get("usage") or {}
                    cost_total = float((usage.get("cost") or {}).get("total") or 0) * 100.0
                    toks = int(usage.get("totalTokens") or 0)
                    if cost_total > 0 or toks > 0:
                        cur["_cents"] += cost_total
                        cur["_toks"] += toks
                        cur["_calls"] += 1
                    mn = msg.get("model")
                    if mn and mn not in cur["_models"]:
                        cur["_models"].append(mn)

        day_turns = []
        for tk in turns:
            if tk["date"] == target_date:
                day_turns.append(tk)
            elif tk["date"] is None and file_date == target_date:
                tk["time"] = file_time
                tk["ts_ms"] = int(st.st_mtime * 1000)
                day_turns.append(tk)

        if not day_turns:
            continue

        session_cents = 0.0
        session_models = []
        session_has_cost = False
        sess_files = []
        sess_steps = 0

        for tk in day_turns:
            c_cents = tk.pop("_cents", 0.0)
            c_toks = tk.pop("_toks", 0)
            c_calls = tk.pop("_calls", 0)
            c_models = tk.pop("_models", [])
            for mn in c_models:
                if mn not in session_models:
                    session_models.append(mn)
            if c_cents > 0 or c_calls > 0:
                session_has_cost = True
                has_any_cost = True
                session_cents += c_cents
                tk["cost_cents"] = round(c_cents, 3)
                tk["cost_str"] = fmt_cents(c_cents)
                tk["calls"] = c_calls
                tk["tokens_str"] = fmt_tok(c_toks)
            sess_steps += len(tk["steps"])
            for f in tk["files_modified"]:
                all_files.add(f)
                if f not in sess_files:
                    sess_files.append(f)

        total_tasks += len(day_turns)
        total_steps += sess_steps
        total_cents += session_cents

        times = [tk["time"] for tk in day_turns if tk.get("time")]
        time_range = f"{times[0]}–{times[-1]}" if len(times) > 1 and times[0] != times[-1] else (times[0] if times else "")
        last_ts = max((tk.get("ts_ms") or 0) for tk in day_turns)

        title = day_turns[0]["prompt_short"]
        last_turn = day_turns[-1]

        sessions.append({
            "conv_id": conv_id,
            "source": "pi",
            "title": title,
            "project": f"Pi · {project_name}",
            "time_range": time_range,
            "last_ts": last_ts,
            "turn_count": len(day_turns),
            "steps_count": sess_steps,
            "files_modified": sess_files,
            "cost_cents": round(session_cents, 2) if session_has_cost else None,
            "cost_str": fmt_cents(session_cents) if session_has_cost else None,
            "models": session_models,
            "what_done": last_turn.get("result_short") or last_turn.get("prompt_short"),
            "turns": day_turns,
        })

    return sessions, all_files, total_tasks, total_steps, total_cents, has_any_cost


def get_worklog(target_date, source="all"):
    try:
        dt_obj = datetime.strptime(target_date, "%Y-%m-%d")
    except Exception:
        dt_obj = datetime.now()
        target_date = dt_obj.strftime("%Y-%m-%d")

    source = (source or "all").strip().lower()
    if source not in ("all", "auto", "cursor", "antigravity", "pi"):
        source = "all"

    weekday = WEEKDAYS_ZH[dt_obj.weekday()]
    day_start_ts = datetime(dt_obj.year, dt_obj.month, dt_obj.day, 0, 0, 0).timestamp()
    today_str = datetime.now().strftime("%Y-%m-%d")

    sessions = []
    all_files = set()
    total_tasks = 0
    total_steps = 0
    total_cents = 0.0
    has_any_cost = False

    chat_meta = {}
    calls_by_conv = {}
    jsonl_files = []
    if source in ("all", "auto", "cursor"):
        chat_meta = load_chat_meta()
        calls_by_conv = load_today_usage_calls(target_date)

        if PROJECTS_DIR.exists():
            jsonl_files = list(PROJECTS_DIR.glob("*/agent-transcripts/*/*.jsonl"))

    for jf in jsonl_files:
        try:
            st = jf.stat()
        except OSError:
            continue
        # File last modified before target day started -> cannot have turns on target_date
        if st.st_mtime < day_start_ts:
            continue

        conv_id = jf.parent.name
        project_slug = jf.parent.parent.parent.name
        project_name = decode_project_name(project_slug)
        file_date = datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d")
        file_time = datetime.fromtimestamp(st.st_mtime).strftime("%H:%M")

        try:
            raw_lines = jf.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception:
            continue

        turns = []
        cur = None
        for line in raw_lines:
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
                    if c.get("type") != "text":
                        continue
                    t = c.get("text", "")
                    t_date, t_ms, t_hm = parse_timestamp(t)
                    m = re.search(r"<user_query>(.*?)</user_query>", t, re.DOTALL)
                    q = m.group(1).strip() if m else re.sub(r"<[^>]+>.*?</[^>]+>", "", t, flags=re.DOTALL).strip()
                    q = clean_text(q)
                    if not q:
                        continue
                    cur = {
                        "date": t_date,
                        "ts_ms": t_ms,
                        "time": t_hm,
                        "prompt": q,
                        "prompt_short": shorten(q, 90),
                        "steps": [],
                        "files_modified": [],
                        "result": None,
                        "result_short": "",
                    }
                    turns.append(cur)
            elif role == "assistant" and cur is not None:
                for c in contents:
                    ctype = c.get("type")
                    if ctype == "tool_use":
                        name = c.get("name") or "Tool"
                        inp = c.get("input", {}) or {}
                        desc = inp.get("description") or inp.get("command") or inp.get("path") or inp.get("pattern") or ""
                        desc = str(desc).replace("\n", " ").strip()
                        if len(desc) > 150:
                            desc = desc[:147] + "..."
                        cur["steps"].append(f"{name}: {desc}" if desc else name)

                        if name in ("Write", "StrReplace", "Edit", "Delete", "EditNotebook"):
                            fp = inp.get("path") or inp.get("target_file") or inp.get("file_path") or ""
                            if fp:
                                bn = os.path.basename(str(fp).replace("\\", "/"))
                                if bn and bn not in cur["files_modified"]:
                                    cur["files_modified"].append(bn)
                    elif ctype == "text":
                        txt = (c.get("text") or "").strip()
                        if txt and not txt.startswith("[REDACTED]"):
                            norm_txt = txt.replace("\r\n", "\n").replace("\r", "\n").strip()
                            if len(norm_txt) > 2200:
                                norm_txt = norm_txt[:2197] + "..."
                            cur["result"] = norm_txt
                            cur["result_short"] = clean_result_summary(norm_txt, 150)

        # Keep only turns belonging to target_date
        day_turns = []
        for tk in turns:
            if tk["date"] == target_date:
                day_turns.append(tk)
            elif tk["date"] is None and file_date == target_date:
                tk["time"] = file_time
                tk["ts_ms"] = int(st.st_mtime * 1000)
                day_turns.append(tk)

        if not day_turns:
            continue

        # Match costs for this session on target_date (from usage_cache.json if today)
        conv_calls = calls_by_conv.get(conv_id, [])
        session_cents = 0.0
        session_models = []
        if conv_calls:
            has_any_cost = True
            for c in conv_calls:
                mn = c.get("model")
                if mn and mn not in session_models:
                    session_models.append(mn)
            for idx, tk in enumerate(day_turns):
                t_start = tk.get("ts_ms")
                if t_start is None:
                    continue
                t_end = None
                for j in range(idx + 1, len(day_turns)):
                    if day_turns[j].get("ts_ms") is not None:
                        t_end = day_turns[j]["ts_ms"]
                        break
                matched = [
                    c for c in conv_calls
                    if (c.get("ts_ms") or 0) >= (t_start - 5000)
                    and (t_end is None or (c.get("ts_ms") or 0) < (t_end - 5000))
                ]
                if matched:
                    cents = sum(float(c.get("charged_cents") or 0) for c in matched)
                    toks = sum(int(c.get("input_tokens") or 0) + int(c.get("output_tokens") or 0) + int(c.get("cache_read_tokens") or 0) for c in matched)
                    tk["cost_cents"] = round(cents, 3)
                    tk["cost_str"] = fmt_cents(cents)
                    tk["calls"] = len(matched)
                    tk["tokens_str"] = fmt_tok(toks)
            session_cents = sum(float(c.get("charged_cents") or 0) for c in conv_calls)
            total_cents += session_cents

        sess_files = []
        sess_steps = 0
        for tk in day_turns:
            sess_steps += len(tk["steps"])
            for f in tk["files_modified"]:
                all_files.add(f)
                if f not in sess_files:
                    sess_files.append(f)

        total_tasks += len(day_turns)
        total_steps += sess_steps

        times = [tk["time"] for tk in day_turns if tk.get("time")]
        time_range = f"{times[0]}–{times[-1]}" if len(times) > 1 and times[0] != times[-1] else (times[0] if times else "")
        last_ts = max((tk.get("ts_ms") or 0) for tk in day_turns)

        meta = chat_meta.get(conv_id, {})
        title = meta.get("title") or day_turns[0]["prompt_short"]
        last_turn = day_turns[-1]

        sessions.append({
            "conv_id": conv_id,
            "title": title,
            "project": project_name,
            "time_range": time_range,
            "last_ts": last_ts,
            "turn_count": len(day_turns),
            "steps_count": sess_steps,
            "files_modified": sess_files,
            "cost_cents": round(session_cents, 2) if conv_calls else None,
            "cost_str": fmt_cents(session_cents) if conv_calls else None,
            "models": session_models,
            "what_done": last_turn.get("result_short") or last_turn.get("prompt_short"),
            "turns": day_turns,
        })

    if source in ("all", "auto", "antigravity"):
        ag_sessions, ag_files, ag_tasks, ag_steps = collect_antigravity_sessions(target_date, day_start_ts)
        sessions.extend(ag_sessions)
        all_files.update(ag_files)
        total_tasks += ag_tasks
        total_steps += ag_steps

    if source in ("all", "auto", "pi"):
        pi_sessions, pi_files, pi_tasks, pi_steps, pi_cents, pi_has_cost = collect_pi_sessions(target_date, day_start_ts)
        sessions.extend(pi_sessions)
        all_files.update(pi_files)
        total_tasks += pi_tasks
        total_steps += pi_steps
        total_cents += pi_cents
        has_any_cost = has_any_cost or pi_has_cost

    sessions.sort(key=lambda s: s["last_ts"], reverse=True)

    summary = {
        "date": target_date,
        "weekday": weekday,
        "source": source,
        "is_today": target_date == today_str,
        "session_count": len(sessions),
        "task_count": total_tasks,
        "steps_count": total_steps,
        "files_count": len(all_files),
        "all_files": sorted(all_files),
        "cost_str": fmt_cents(total_cents) if has_any_cost else None,
    }
    summary["markdown"] = build_markdown(target_date, weekday, sessions, summary)

    return {
        "ok": True,
        "summary": summary,
        "sessions": sessions,
        "generated_at": datetime.now().strftime("%H:%M:%S"),
    }


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    date_arg = datetime.now().strftime("%Y-%m-%d")
    source_arg = "all"
    for i, a in enumerate(sys.argv[1:]):
        if a == "--date" and i + 2 < len(sys.argv):
            date_arg = sys.argv[i + 2]
        elif a == "--source" and i + 2 < len(sys.argv):
            source_arg = sys.argv[i + 2]
        elif re.match(r"^\d{4}-\d{2}-\d{2}$", a):
            date_arg = a
    print(json.dumps(get_worklog(date_arg, source_arg), ensure_ascii=False))
