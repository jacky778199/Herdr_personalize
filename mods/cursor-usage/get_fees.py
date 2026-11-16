"""Fetch and cache official Cursor model pricing from cursor.com/docs/models-and-pricing.md."""

import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime

SOURCE_MD_URL = "https://cursor.com/docs/models-and-pricing.md"
SOURCE_WEB_URL = "https://cursor.com/docs/models-and-pricing"
CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "model_fees_cache.json")
CACHE_TTL_SEC = 86400  # 24 hours


def clean_md(s):
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s or "")
    s = s.replace("`", "").replace("\\~", "~").strip()
    return s


def parse_price(s):
    if not s or s == "-":
        return None
    m = re.search(r"([0-9]+(?:\.[0-9]+)?)", s)
    return float(m.group(1)) if m else None


def parse_markdown_pricing(md):
    models = []
    section = "Cursor"
    known_providers = {"Cursor", "Anthropic", "Google", "OpenAI", "DeepSeek", "Z.ai", "Moonshot", "Meta"}

    for line in md.splitlines():
        if line.startswith("### Cursor models"):
            section = "Cursor"
        elif line.startswith("### Model pricing"):
            section = "3rd-Party"
        elif line.startswith("|") and not line.startswith("| Model ") and not line.startswith("| ---"):
            parts = [clean_md(p) for p in line.strip("|").split("|")]
            if len(parts) >= 7 and parts[1] in known_providers:
                name = parts[0]
                provider = parts[1]
                inp = parts[2]
                cw = parts[3]
                cr = parts[4]
                out = parts[5]
                us_res = parts[6]
                notes = parts[7] if len(parts) > 7 else ""

                inp_num = parse_price(inp) or 0.0
                cr_num = parse_price(cr)
                out_num = parse_price(out) or 0.0
                hidden = "hidden by default" in notes.lower()

                # Cursor Token Rate ($0.25/M on Teams/Enterprise) does NOT apply to:
                # 1. Cursor models (Grok / Composer)
                # 2. Third-party models whose cache-read price is strictly below $0.10/M
                exempt = (section == "Cursor") or (cr_num is not None and cr_num < 0.10)

                models.append({
                    "model": name,
                    "provider": provider,
                    "pool": section,
                    "input": inp,
                    "cache_write": cw,
                    "cache_read": cr,
                    "output": out,
                    "input_num": inp_num,
                    "cache_read_num": cr_num,
                    "output_num": out_num,
                    "us_residency": us_res == "Yes",
                    "hidden": hidden,
                    "token_rate_exempt": exempt,
                    "notes": notes,
                })
    return models


def load_cache():
    if not os.path.exists(CACHE_PATH):
        return None
    try:
        with open(CACHE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def save_cache(payload):
    try:
        with open(CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def get_fees(force_refresh=False):
    cached = load_cache()
    now_ts = time.time()

    if not force_refresh and cached and cached.get("models"):
        age = now_ts - cached.get("updated_ts", 0)
        if age < CACHE_TTL_SEC:
            cached["from_cache"] = True
            return cached

    try:
        req = urllib.request.Request(
            SOURCE_MD_URL,
            headers={"User-Agent": "Herdr-CursorUsage/1.0"}
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            md = resp.read().decode("utf-8")

        models = parse_markdown_pricing(md)
        if models:
            payload = {
                "ok": True,
                "source": "cursor.com/docs/models-and-pricing.md",
                "source_url": SOURCE_WEB_URL,
                "updated_ts": now_ts,
                "updated_at": datetime.fromtimestamp(now_ts).strftime("%Y-%m-%d %H:%M:%S"),
                "from_cache": False,
                "total_count": len(models),
                "active_count": sum(1 for m in models if not m["hidden"]),
                "models": models,
            }
            save_cache(payload)
            return payload
    except Exception as e:
        if cached and cached.get("models"):
            cached["from_cache"] = True
            cached["sync_warning"] = str(e)
            return cached
        return {"ok": False, "error": f"無法取得官方價目表: {e}"}

    if cached and cached.get("models"):
        cached["from_cache"] = True
        return cached
    return {"ok": False, "error": "價目表解析結果為空"}


if __name__ == "__main__":
    force = "--refresh" in sys.argv
    print(json.dumps(get_fees(force_refresh=force), ensure_ascii=False))
