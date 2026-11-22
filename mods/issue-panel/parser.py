"""Scan and parse .ai_team/issue_* directories for Herdr Issue Panel."""

import argparse
import json
import os
import pathlib
import re
import sys
from datetime import datetime

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

STANDARD_DOCS = [
    ("00_board.md", "任務看板"),
    ("01_analysis.md", "偵察分析"),
    ("02_plan.md", "實作計畫"),
    ("03_test_report.md", "測試報告"),
    ("04_final_report.md", "交付總結"),
]

STAGE_NAMES = {
    1: "偵察",
    2: "計畫與實作",
    3: "測試",
    4: "審查",
    5: "交付",
}


def fmt_mtime(ts):
    if not ts:
        return None
    try:
        return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


def map_stage(raw_stage):
    """Map raw stage text from 00_board.md to stage number 1..5."""
    s = (raw_stage or "").strip()
    low = s.lower()
    if not s:
        return 0
    if "階段五" in s or "交付" in s or "deliver" in low or "release" in low or re.search(r"\b5\b", low):
        return 5
    if "階段四" in s or "審查" in s or "review" in low or re.search(r"\b4\b", low):
        return 4
    if "階段三" in s or "測試" in s or "test" in low or "qa" in low or re.search(r"\b3\b", low):
        return 3
    if "階段二" in s or "計畫" in s or "實作" in s or "plan" in low or "implement" in low or re.search(r"\b2\b", low):
        return 2
    if "階段一" in s or "偵察" in s or "investigat" in low or re.search(r"\b1\b", low):
        return 1
    return 0


def _extract_field(text, pattern):
    m = re.search(pattern, text, re.MULTILINE)
    if not m:
        return ""
    return m.group(1).strip().strip("`").strip()


def _extract_int(text, pattern):
    m = re.search(pattern, text, re.MULTILINE | re.IGNORECASE)
    if not m:
        return 0
    try:
        return int(m.group(1))
    except ValueError:
        return 0


def parse_board(board_path, fallback_id):
    """Parse 00_board.md safely with sensible defaults on missing or malformed data."""
    result = {
        "title": f"Issue {fallback_id}",
        "issue_id": fallback_id,
        "stage": 0,
        "stage_text": "",
        "stage_label": "未開始",
        "status": "UNKNOWN",
        "retries": {
            "inv": 0,
            "dev_qa": 0,
            "review": 0,
        },
        "retry_max": 0,
        "circuit_breaker": False,
        "logs": [],
        "board_exists": False,
    }

    if not board_path.is_file():
        return result

    try:
        content = board_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return result

    result["board_exists"] = True

    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            result["title"] = stripped[2:].strip() or result["title"]
            break

    parsed_id = _extract_field(content, r"^\s*-\s*\*\*任務編號\*\*\s*[:：]\s*(.+)$")
    if parsed_id:
        result["issue_id"] = parsed_id

    stage_text = _extract_field(content, r"^\s*-\s*\*\*目前階段\*\*\s*[:：]\s*(.+)$")
    if stage_text:
        result["stage_text"] = stage_text
        stage_num = map_stage(stage_text)
        result["stage"] = stage_num
        result["stage_label"] = stage_text if stage_num == 0 else STAGE_NAMES[stage_num]

    status = _extract_field(content, r"^\s*-\s*\*\*狀態\*\*\s*[:：]\s*(.+)$")
    if status:
        result["status"] = status.upper()

    inv_retry = _extract_int(content, r"^\s*-\s*偵察[^:：\n]*[:：]\s*`?(\d+)`?")
    dev_qa_retry = _extract_int(content, r"^\s*-\s*實作/測試[^:：\n]*[:：]\s*`?(\d+)`?")
    review_retry = _extract_int(content, r"^\s*-\s*Code\s*Review[^:：\n]*[:：]\s*`?(\d+)`?")

    retries = {
        "inv": inv_retry,
        "dev_qa": dev_qa_retry,
        "review": review_retry,
    }
    retry_max = max(inv_retry, dev_qa_retry, review_retry)
    result["retries"] = retries
    result["retry_max"] = retry_max
    result["circuit_breaker"] = retry_max >= 3 or result["status"] == "NEED_HUMAN"

    logs = []
    for line in content.splitlines():
        m = re.match(r"^\s*-\s*\*\*\[([^\]]+)\]\*\*\s*(.+)$", line)
        if m:
            logs.append({
                "stage": m.group(1).strip(),
                "text": m.group(2).strip(),
            })
    result["logs"] = logs
    return result


def _doc_preview(path, max_lines=3, max_chars=220):
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return "", 0
    lines = text.splitlines()
    line_count = len(lines)
    snippets = []
    for raw in lines:
        s = raw.strip()
        if not s or s.startswith("---") or s.startswith("```"):
            continue
        s = re.sub(r"^#{1,6}\s+", "", s)
        s = s.replace("**", "").replace("`", "")
        if s:
            snippets.append(s)
        if len(snippets) >= max_lines:
            break
    joined = " | ".join(snippets)
    if len(joined) > max_chars:
        joined = joined[: max_chars - 1].rstrip() + "…"
    return joined, line_count


def scan_docs(issue_dir):
    """Scan standard and extra markdown handoff documents in issue_<ID> directory."""
    known_names = [name for name, _ in STANDARD_DOCS]
    label_map = dict(STANDARD_DOCS)

    extra_names = []
    try:
        for entry in sorted(issue_dir.iterdir(), key=lambda p: p.name.lower()):
            if entry.is_file() and entry.suffix.lower() == ".md" and entry.name not in label_map:
                extra_names.append(entry.name)
    except Exception:
        pass

    docs = []
    latest_ts = 0.0
    for name in known_names + extra_names:
        doc_path = issue_dir / name
        label = label_map.get(name, name)
        if doc_path.is_file():
            try:
                stat = doc_path.stat()
                mtime = stat.st_mtime
                size_bytes = stat.st_size
            except Exception:
                mtime = 0.0
                size_bytes = 0
            if mtime > latest_ts:
                latest_ts = mtime
            preview, line_count = _doc_preview(doc_path)
            docs.append({
                "name": name,
                "label": label,
                "path": str(doc_path),
                "exists": True,
                "updated_at": fmt_mtime(mtime),
                "updated_ts": mtime,
                "size_bytes": size_bytes,
                "line_count": line_count,
                "preview": preview,
            })
        else:
            docs.append({
                "name": name,
                "label": label,
                "path": str(doc_path),
                "exists": False,
                "updated_at": None,
                "updated_ts": 0.0,
                "size_bytes": 0,
                "line_count": 0,
                "preview": "",
            })

    return docs, latest_ts


def _issue_sort_key(item):
    numeric = int(item["id"]) if item["id"].isdigit() else -1
    return (item["updated_ts"], numeric, item["id"])


def scan_workspace(cwd, selected_issue=None):
    """Scan workspace .ai_team/issue_* directories and return structured state."""
    ws_path = pathlib.Path(cwd) if cwd else None
    if not ws_path or not ws_path.exists():
        return {
            "ok": True,
            "cwd": str(cwd or ""),
            "has_ai_team": False,
            "issues": [],
            "selected_issue_id": None,
            "current": None,
        }

    ai_team_dir = ws_path / ".ai_team"
    if not ai_team_dir.is_dir():
        return {
            "ok": True,
            "cwd": str(ws_path),
            "has_ai_team": False,
            "issues": [],
            "selected_issue_id": None,
            "current": None,
        }

    issue_entries = []
    try:
        for entry in ai_team_dir.iterdir():
            if entry.is_dir() and entry.name.startswith("issue_"):
                issue_id = entry.name[len("issue_"):]
                if not issue_id:
                    continue
                board = parse_board(entry / "00_board.md", issue_id)
                docs, latest_ts = scan_docs(entry)
                if latest_ts == 0.0:
                    try:
                        latest_ts = entry.stat().st_mtime
                    except Exception:
                        latest_ts = 0.0
                issue_entries.append({
                    "id": issue_id,
                    "dir_name": entry.name,
                    "dir_path": str(entry),
                    "title": board["title"],
                    "stage": board["stage"],
                    "stage_text": board["stage_text"],
                    "stage_label": board["stage_label"],
                    "status": board["status"],
                    "retries": board["retries"],
                    "retry_max": board["retry_max"],
                    "circuit_breaker": board["circuit_breaker"],
                    "logs": board["logs"],
                    "board_exists": board["board_exists"],
                    "docs": docs,
                    "updated_ts": latest_ts,
                    "updated_at": fmt_mtime(latest_ts),
                })
    except Exception as exc:
        return {
            "ok": False,
            "cwd": str(ws_path),
            "error": str(exc),
        }

    issue_entries.sort(key=_issue_sort_key, reverse=True)

    current = None
    if issue_entries:
        if selected_issue:
            for item in issue_entries:
                if item["id"] == selected_issue or item["dir_name"] == selected_issue:
                    current = item
                    break
        if current is None:
            current = issue_entries[0]

    summaries = [
        {
            "id": item["id"],
            "dir_name": item["dir_name"],
            "title": item["title"],
            "stage": item["stage"],
            "stage_label": item["stage_label"],
            "status": item["status"],
            "retry_max": item["retry_max"],
            "circuit_breaker": item["circuit_breaker"],
            "updated_at": item["updated_at"],
        }
        for item in issue_entries
    ]

    return {
        "ok": True,
        "cwd": str(ws_path),
        "has_ai_team": True,
        "issues": summaries,
        "selected_issue_id": current["id"] if current else None,
        "current": current,
    }


def read_doc(cwd, issue_id, doc_name):
    """Safely read a markdown document inside .ai_team/issue_<ID>/ with path traversal protection."""
    if not cwd or not issue_id or not doc_name:
        return {"ok": False, "error": "Missing required parameters"}

    if (
        "/" in doc_name
        or "\\" in doc_name
        or ".." in doc_name
        or not doc_name.lower().endswith(".md")
    ):
        return {"ok": False, "error": "Invalid document filename"}

    if "/" in issue_id or "\\" in issue_id or ".." in issue_id:
        return {"ok": False, "error": "Invalid issue ID"}

    ws_path = pathlib.Path(cwd)
    dir_name = issue_id if issue_id.startswith("issue_") else f"issue_{issue_id}"
    issue_dir = (ws_path / ".ai_team" / dir_name).resolve()
    ai_team_dir = (ws_path / ".ai_team").resolve()

    if not ai_team_dir.is_dir() or issue_dir.parent != ai_team_dir or not issue_dir.is_dir():
        return {"ok": False, "error": "Issue directory not found"}

    target = (issue_dir / doc_name).resolve()
    if target.parent != issue_dir:
        return {"ok": False, "error": "Path traversal denied"}

    if not target.is_file():
        return {"ok": False, "error": f"Document not found: {doc_name}"}

    try:
        content = target.read_text(encoding="utf-8", errors="replace")
        stat = target.stat()
        return {
            "ok": True,
            "issue_id": dir_name[len("issue_"):],
            "doc": target.name,
            "path": str(target),
            "content": content,
            "line_count": len(content.splitlines()),
            "size_bytes": stat.st_size,
            "updated_at": fmt_mtime(stat.st_mtime),
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def main():
    parser = argparse.ArgumentParser(description="Parse .ai_team issue state for Herdr Issue Panel.")
    parser.add_argument("--cwd", required=True, help="Workspace directory path")
    parser.add_argument("--issue", default=None, help="Issue ID to inspect")
    parser.add_argument("--doc", default=None, help="Markdown document filename to read")
    args = parser.parse_args()

    if args.doc is not None:
        if not args.issue:
            print(json.dumps({"ok": False, "error": "--issue is required with --doc"}, ensure_ascii=False))
            sys.exit(1)
        res = read_doc(args.cwd, args.issue, args.doc)
        print(json.dumps(res, ensure_ascii=False))
        if not res.get("ok"):
            sys.exit(1)
        return

    res = scan_workspace(args.cwd, selected_issue=args.issue)
    print(json.dumps(res, ensure_ascii=False))
    if not res.get("ok"):
        sys.exit(1)


if __name__ == "__main__":
    main()
