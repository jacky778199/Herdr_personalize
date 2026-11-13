import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
defaults = ["請繼續執行下一步", "檢查並測試剛才的修改", "總結目前完成進度與後續計畫"]
best = {}
if root.exists():
    for path in root.glob("store-*.json"):
        try:
            obj = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        mtime = path.stat().st_mtime
        for key, raw in obj.items():
            if not key.startswith("herdr-task-notes:"):
                continue
            terminal = key.split(":", 1)[1]
            if terminal in ("", "global"):
                continue
            try:
                notes = json.loads(raw) if isinstance(raw, str) else raw
            except Exception:
                continue
            if not isinstance(notes, list):
                continue
            texts = [item.get("text") for item in notes if isinstance(item, dict)]
            custom = len(notes) > 0 and texts != defaults
            prev = best.get(terminal)
            if prev is None or (custom and not prev["custom"]) or (custom == prev["custom"] and mtime >= prev["mtime"]):
                best[terminal] = {"custom": custom, "mtime": mtime, "notes": notes}

print(json.dumps({key: value["notes"] for key, value in best.items()}, ensure_ascii=False))
