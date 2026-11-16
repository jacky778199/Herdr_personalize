"""Fetch Cursor usage summary, daily/model breakdowns, and per-call today events.

Data strategy:
1. Event-driven / change-only updates (--if-changed):
   - Computes a fast local activity fingerprint from:
     - ~/.cursor/ai-tracking/ai-code-tracking.db (+ -wal)
     - ~/.cursor/chats/**/meta.json (latest updated mtime)
     - %APPDATA%/Cursor/User/globalStorage/state.vscdb
   - If local files did not change (and cache is within fallback TTL), returns
     {"ok": true, "changed": false} in <10ms without network or UI re-render.
2. Live Cursor RPC (using %APPDATA%/cursor/auth.json accessToken):
   - GetMonthlyBillingCycle + GetDailySpendByCategory -> up-to-date monthly/daily/model spend
   - GetFilteredUsageEvents (today 00:00..now) -> every individual AI call today
3. Offline fallback:
   - If network/auth is unavailable, falls back to local state.vscdb snapshot + usage_cache.json.
"""

import glob
import hashlib
import json
import os
import sqlite3
import sys
import time
import urllib.request
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(BASE_DIR)), "data", "cursor-usage")
os.makedirs(DATA_DIR, exist_ok=True)
CACHE_PATH = os.path.join(DATA_DIR, "usage_cache.json")
FALLBACK_SYNC_SEC = 1800  # 30 min safety check even if no local file changed


def fmt_tokens(tok):
    tok = int(tok or 0)
    if tok >= 1e9:
        return f"{tok/1e9:.2f}B"
    if tok >= 1e6:
        return f"{tok/1e6:.1f}M"
    if tok >= 1e3:
        return f"{tok/1e3:.1f}k"
    return str(tok)


def fmt_cents_precise(cents):
    val = float(cents or 0) / 100.0
    if val == 0:
        return "$0.00"
    if val < 0.1:
        return f"${val:.3f}"
    return f"${val:.2f}"


def get_local_activity_signature():
    """Fast stat-only signature across local Cursor activity files."""
    parts = []
    home = os.path.expanduser("~")
    appdata = os.environ.get("APPDATA", "") or os.path.join(home, "AppData", "Roaming")

    candidates = [
        os.path.join(home, ".cursor", "ai-tracking", "ai-code-tracking.db"),
        os.path.join(home, ".cursor", "ai-tracking", "ai-code-tracking.db-wal"),
        os.path.join(appdata, "Cursor", "User", "globalStorage", "state.vscdb"),
        os.path.join(appdata, "cursor", "auth.json"),
    ]
    for p in candidates:
        try:
            st = os.stat(p)
            parts.append(f"{os.path.basename(p)}:{int(st.st_mtime_ns)}:{st.st_size}")
        except OSError:
            pass

    chats_dir = os.path.join(home, ".cursor", "chats")
    max_chat_mtime = 0
    chat_count = 0
    if os.path.isdir(chats_dir):
        for root, _dirs, files in os.walk(chats_dir):
            for fn in files:
                if fn in ("meta.json", "store.db-wal", "store.db"):
                    chat_count += 1
                    try:
                        mt = os.stat(os.path.join(root, fn)).st_mtime_ns
                        if mt > max_chat_mtime:
                            max_chat_mtime = mt
                    except OSError:
                        pass
    parts.append(f"chats:{chat_count}:{max_chat_mtime}")
    parts.append(f"day:{datetime.now().strftime('%Y-%m-%d')}")
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:16]


def load_chat_titles():
    """Map conversationId -> title from ~/.cursor/chats/*/*/meta.json."""
    titles = {}
    chats_dir = os.path.join(os.path.expanduser("~"), ".cursor", "chats")
    if not os.path.isdir(chats_dir):
        return titles
    for root, _dirs, files in os.walk(chats_dir):
        if "meta.json" in files:
            conv_id = os.path.basename(root)
            try:
                with open(os.path.join(root, "meta.json"), "r", encoding="utf-8") as f:
                    meta = json.load(f)
                t = (meta.get("title") or "").strip()
                if t:
                    titles[conv_id] = t
            except Exception:
                pass
    return titles


def read_local_state_metadata():
    """Read account info, teamId/userId, and offline snapshot from Cursor state.vscdb."""
    appdata = os.environ.get("APPDATA", "") or os.path.expanduser(r"~\AppData\Roaming")
    db_path = os.path.join(appdata, "Cursor", "User", "globalStorage", "state.vscdb")

    meta = {
        "email": "Unknown",
        "team": "Personal",
        "membership": "Pro",
        "team_id": None,
        "user_id": None,
        "snapshot": None,
        "db_exists": os.path.exists(db_path),
    }
    if not meta["db_exists"]:
        return meta

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=3.0)
        cur = conn.cursor()

        cur.execute("SELECT value FROM ItemTable WHERE key = 'cursorAuth/cachedEmail'")
        r = cur.fetchone()
        if r and r[0]:
            meta["email"] = r[0]

        cur.execute("SELECT value FROM ItemTable WHERE key = 'cursorAuth/cachedTeam'")
        r = cur.fetchone()
        if r and r[0]:
            tdata = json.loads(r[0])
            meta["team"] = tdata.get("name", "Team")
            meta["team_id"] = tdata.get("teamId")

        cur.execute("SELECT value FROM ItemTable WHERE key = 'cursorAuth/stripeMembershipType'")
        r = cur.fetchone()
        if r and r[0]:
            meta["membership"] = r[0].capitalize()

        cur.execute("SELECT value FROM ItemTable WHERE key = 'aiSettings.enterprisePlanUsageSnapshot'")
        r = cur.fetchone()
        if r and r[0]:
            snap = json.loads(r[0])
            meta["snapshot"] = snap
            if not meta["team_id"]:
                meta["team_id"] = snap.get("teamId")
            if not meta["user_id"]:
                meta["user_id"] = snap.get("userId")
        conn.close()
    except Exception:
        pass
    return meta


def read_cli_access_token():
    appdata = os.environ.get("APPDATA", "") or os.path.expanduser(r"~\AppData\Roaming")
    auth_path = os.path.join(appdata, "cursor", "auth.json")
    if not os.path.exists(auth_path):
        return None
    try:
        with open(auth_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get("accessToken") or None
    except Exception:
        return None


def rpc_call(token, method, body):
    req = urllib.request.Request(
        f"https://api2.cursor.sh/aiserver.v1.DashboardService/{method}",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
            "User-Agent": "Cursor/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def build_models_and_daily(daily_spend):
    total_cents = sum(int(item.get("spendCents", 0) or 0) for item in daily_spend)

    models_map = {}
    for item in daily_spend:
        cat = item.get("category", "Other")
        cents = int(item.get("spendCents", 0) or 0)
        tok = int(item.get("totalTokens", 0) or 0)
        if cat not in models_map:
            models_map[cat] = {"spendCents": 0, "tokens": 0}
        models_map[cat]["spendCents"] += cents
        models_map[cat]["tokens"] += tok

    models_list = []
    for cat, stats in sorted(models_map.items(), key=lambda x: x[1]["spendCents"], reverse=True):
        m_spent = stats["spendCents"] / 100.0
        m_pct = round((stats["spendCents"] / total_cents) * 100.0, 1) if total_cents > 0 else 0.0
        models_list.append({
            "name": cat,
            "spent": m_spent,
            "spent_str": f"${m_spent:.2f}",
            "percent": m_pct,
            "tokens": stats["tokens"],
            "tokens_str": fmt_tokens(stats["tokens"]),
        })

    days_map = {}
    for item in daily_spend:
        d_ms = int(item.get("day", 0) or 0)
        d_str = datetime.fromtimestamp(d_ms / 1000.0).strftime("%Y-%m-%d")
        cents = int(item.get("spendCents", 0) or 0)
        tok = int(item.get("totalTokens", 0) or 0)
        if d_str not in days_map:
            days_map[d_str] = {"spendCents": 0, "tokens": 0, "models": []}
        days_map[d_str]["spendCents"] += cents
        days_map[d_str]["tokens"] += tok
        days_map[d_str]["models"].append({"name": item.get("category", "Other"), "cents": cents})

    daily_list = []
    for d_str, stats in sorted(days_map.items(), key=lambda x: x[0], reverse=True):
        d_cents = stats["spendCents"]
        d_spent = d_cents / 100.0

        named_models = sorted(
            [m for m in stats["models"] if m["name"] != "Other" and m["cents"] > 0],
            key=lambda x: x["cents"],
            reverse=True,
        )
        other_cents = sum(m["cents"] for m in stats["models"] if m["name"] == "Other" and m["cents"] > 0)
        top3 = named_models[:3]
        rest_cents = other_cents + sum(m["cents"] for m in named_models[3:])

        segments = []
        for m in top3:
            pct = round((m["cents"] / d_cents) * 100.0, 1) if d_cents > 0 else 0.0
            segments.append({
                "name": m["name"],
                "spent": round(m["cents"] / 100.0, 2),
                "spent_str": f"${m['cents']/100.0:.2f}",
                "percent": pct,
                "is_others": False,
            })
        if rest_cents > 0:
            pct = round((rest_cents / d_cents) * 100.0, 1) if d_cents > 0 else 0.0
            segments.append({
                "name": "Others",
                "spent": round(rest_cents / 100.0, 2),
                "spent_str": f"${rest_cents/100.0:.2f}",
                "percent": pct,
                "is_others": True,
            })

        daily_list.append({
            "date": d_str,
            "date_short": d_str[5:],
            "spent": d_spent,
            "spent_str": f"${d_spent:.2f}",
            "tokens": stats["tokens"],
            "tokens_str": fmt_tokens(stats["tokens"]),
            "segments": segments,
            "top_models": segments,
        })

    return total_cents, models_list, daily_list


def fetch_today_calls(token, team_id, user_id, chat_titles):
    now_dt = datetime.now()
    today_start = datetime(now_dt.year, now_dt.month, now_dt.day, 0, 0, 0)
    start_ms = int(today_start.timestamp() * 1000)
    end_ms = int(time.time() * 1000)

    all_events = []
    page = 1
    page_size = 200
    total_count = 0

    while page <= 5:
        res = rpc_call(token, "GetFilteredUsageEvents", {
            "teamId": team_id,
            "userId": user_id,
            "startDate": str(start_ms),
            "endDate": str(end_ms),
            "page": page,
            "pageSize": page_size,
        })
        batch = res.get("usageEventsDisplay") or res.get("usageEvents") or []
        total_count = int(res.get("totalUsageEventsCount") or len(batch))
        all_events.extend(batch)
        if len(all_events) >= total_count or len(batch) < page_size:
            break
        page += 1

    calls = []
    total_charged_cents = 0.0
    total_in = 0
    total_out = 0
    total_cr = 0
    total_cw = 0

    for ev in all_events:
        ts_ms = int(ev.get("timestamp") or 0)
        time_str = datetime.fromtimestamp(ts_ms / 1000.0).strftime("%H:%M:%S") if ts_ms else "--:--:--"
        model = ev.get("model") or "unknown"
        tu = ev.get("tokenUsage") or {}
        in_tok = int(tu.get("inputTokens") or 0)
        out_tok = int(tu.get("outputTokens") or 0)
        cr_tok = int(tu.get("cacheReadTokens") or 0)
        cw_tok = int(tu.get("cacheWriteTokens") or 0)

        charged_cents = float(ev.get("chargedCents") or 0.0)
        list_cents = float(tu.get("totalCents") or charged_cents)
        discount_pct = int(tu.get("enterpriseUsageDiscountPercent") or 0)
        token_fee = float(ev.get("cursorTokenFee") or 0.0)
        req_cost = ev.get("requestsCosts")
        is_token_call = bool(ev.get("isTokenBasedCall", True))

        conv_id = str(ev.get("conversationId") or "")
        if conv_id.startswith("sand-subagent-"):
            conv_label = f"Subagent · {conv_id.replace('sand-subagent-', '')[:8]}"
        elif conv_id in chat_titles:
            conv_label = chat_titles[conv_id]
        elif conv_id:
            conv_label = f"Session {conv_id[:8]}"
        else:
            conv_label = "-"

        total_charged_cents += charged_cents
        total_in += in_tok
        total_out += out_tok
        total_cr += cr_tok
        total_cw += cw_tok

        calls.append({
            "id": ev.get("usageEventId") or f"{ts_ms}-{model}",
            "ts_ms": ts_ms,
            "time": time_str,
            "model": model,
            "conv_id": conv_id,
            "conv_title": conv_label,
            "charged_cents": round(charged_cents, 4),
            "cost_str": fmt_cents_precise(charged_cents) if charged_cents > 0 else ("Included" if not is_token_call else "$0.00"),
            "list_cost_str": fmt_cents_precise(list_cents),
            "discount_pct": discount_pct,
            "token_fee": token_fee,
            "req_cost": req_cost,
            "is_token_call": is_token_call,
            "input_tokens": in_tok,
            "output_tokens": out_tok,
            "cache_read_tokens": cr_tok,
            "cache_write_tokens": cw_tok,
            "in_str": fmt_tokens(in_tok),
            "out_str": fmt_tokens(out_tok),
            "cr_str": fmt_tokens(cr_tok),
            "cw_str": fmt_tokens(cw_tok),
        })

    # Ensure newest first
    calls.sort(key=lambda c: c["ts_ms"], reverse=True)

    summary = {
        "date": now_dt.strftime("%Y-%m-%d"),
        "count": total_count or len(calls),
        "charged_cents": round(total_charged_cents, 2),
        "spent_str": f"${total_charged_cents / 100.0:.2f}",
        "in_str": fmt_tokens(total_in),
        "out_str": fmt_tokens(total_out),
        "cr_str": fmt_tokens(total_cr),
        "cw_str": fmt_tokens(total_cw),
        "total_tokens_str": fmt_tokens(total_in + total_out + total_cr + total_cw),
    }
    return summary, calls


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
            json.dump(payload, f, ensure_ascii=False)
    except Exception:
        pass


def compute_data_signature(payload):
    q = payload.get("quota", {})
    ts = payload.get("today_summary", {})
    calls = payload.get("today_calls", [])
    latest_id = calls[0]["id"] if calls else ""
    latest_ts = calls[0]["ts_ms"] if calls else 0
    raw = f"{q.get('spent')}|{q.get('limit')}|{ts.get('count')}|{ts.get('charged_cents')}|{latest_id}|{latest_ts}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def get_cursor_usage_details(if_changed=False, force=False):
    now_ts = time.time()
    local_sig = get_local_activity_signature()
    cached = load_cache()

    if if_changed and not force and cached and cached.get("ok"):
        last_local = cached.get("local_sig")
        age = now_ts - float(cached.get("synced_ts") or 0)
        if last_local == local_sig and age < FALLBACK_SYNC_SEC:
            return {
                "ok": True,
                "changed": False,
                "skip_reason": "no_local_activity",
                "checked_at": datetime.fromtimestamp(now_ts).strftime("%H:%M:%S"),
            }

    meta = read_local_state_metadata()
    token = read_cli_access_token()
    team_id = meta.get("team_id")
    user_id = meta.get("user_id")

    p_start_ms = None
    p_end_ms = None
    limit_cents = 65000
    daily_spend = []
    fetched_at_ms = now_ts * 1000
    today_summary = {
        "date": datetime.now().strftime("%Y-%m-%d"),
        "count": 0,
        "charged_cents": 0.0,
        "spent_str": "$0.00",
        "in_str": "0",
        "out_str": "0",
        "cr_str": "0",
        "cw_str": "0",
        "total_tokens_str": "0",
    }
    today_calls = []
    source_mode = "offline"
    sync_error = None

    # Try Live RPC first if CLI token and team/user ids are available
    if token and team_id and user_id:
        try:
            cycle_res = rpc_call(token, "GetMonthlyBillingCycle", {})
            p_start_ms = int(cycle_res.get("startDateEpochMillis") or 0)
            p_end_ms = int(cycle_res.get("endDateEpochMillis") or 0)

            if not p_start_ms and meta.get("snapshot"):
                p_start_ms = meta["snapshot"].get("periodStartMs")
                p_end_ms = meta["snapshot"].get("periodEndMs")

            if p_start_ms and p_end_ms:
                spend_res = rpc_call(token, "GetDailySpendByCategory", {
                    "teamId": team_id,
                    "userId": user_id,
                    "periodStartMs": str(p_start_ms),
                    "periodEndMs": str(p_end_ms),
                    "groupBy": "MODEL",
                    "spendType": "ALL",
                })
                daily_spend = spend_res.get("dailySpend") or []
                limit_cents = int(spend_res.get("effectiveLimitCents") or 65000)

            chat_titles = load_chat_titles()
            today_summary, today_calls = fetch_today_calls(token, team_id, user_id, chat_titles)
            fetched_at_ms = now_ts * 1000
            source_mode = "live"
        except Exception as e:
            sync_error = str(e)

    # Fallback to local state.vscdb snapshot if live RPC failed or unavailable
    if source_mode != "live":
        snap = meta.get("snapshot")
        if snap and snap.get("charts"):
            charts = snap["charts"]
            now_ms = now_ts * 1000
            chosen_chart = next(
                (c for c in charts if c.get("periodStartMs", 0) <= now_ms <= c.get("periodEndMs", 0)),
                charts[-1],
            )
            p_start_ms = snap.get("periodStartMs") or chosen_chart.get("periodStartMs") or now_ms
            p_end_ms = snap.get("periodEndMs") or chosen_chart.get("periodEndMs") or now_ms
            fetched_at_ms = snap.get("fetchedAt") or chosen_chart.get("fetchedAt") or now_ms
            resp = json.loads(chosen_chart.get("response", "{}"))
            daily_spend = resp.get("dailySpend", [])
            limit_cents = int(resp.get("effectiveLimitCents", 65000) or 65000)
            if cached and cached.get("today_calls"):
                today_summary = cached.get("today_summary", today_summary)
                today_calls = cached.get("today_calls", [])
        elif cached and cached.get("ok"):
            cached["changed"] = True
            cached["source_mode"] = "cache"
            return cached
        else:
            return {"ok": False, "error": sync_error or "找不到本機用量快照或憑證"}

    p_start_s = (p_start_ms or now_ts * 1000) / 1000.0
    p_end_s = (p_end_ms or now_ts * 1000) / 1000.0
    total_sec = max(1.0, p_end_s - p_start_s)
    passed_sec = max(0.0, min(total_sec, now_ts - p_start_s))

    days_passed = round(passed_sec / 86400.0, 1)
    days_total = round(total_sec / 86400.0, 1)
    time_pct = round((passed_sec / total_sec) * 100.0, 1)

    total_cents, models_list, daily_list = build_models_and_daily(daily_spend)
    spent = total_cents / 100.0
    limit = limit_cents / 100.0 if limit_cents > 0 else 650.0
    spent_pct = round((spent / limit) * 100.0, 1) if limit > 0 else 0.0
    remaining = max(0.0, limit - spent)

    pace = "normal"
    if spent_pct > time_pct + 15:
        pace = "danger"
    elif spent_pct > time_pct:
        pace = "warning"

    payload = {
        "ok": True,
        "changed": True,
        "source_mode": source_mode,
        "sync_warning": sync_error,
        "local_sig": local_sig,
        "synced_ts": now_ts,
        "account": {
            "email": meta["email"],
            "team": meta["team"],
            "membership": meta["membership"],
        },
        "cycle": {
            "start": datetime.fromtimestamp(p_start_s).strftime("%Y-%m-%d"),
            "end": datetime.fromtimestamp(p_end_s).strftime("%Y-%m-%d"),
            "days_passed": days_passed,
            "days_total": days_total,
            "time_percent": time_pct,
        },
        "quota": {
            "spent": round(spent, 2),
            "spent_str": f"${spent:.2f}",
            "limit": round(limit, 2),
            "limit_str": f"${limit:.0f}",
            "remaining": round(remaining, 2),
            "remaining_str": f"${remaining:.2f}",
            "percent": spent_pct,
            "daily_avg": round(spent / max(1.0, days_passed), 2),
            "daily_avg_str": f"${round(spent / max(1.0, days_passed), 2):.2f}",
            "pace": pace,
        },
        "models": models_list,
        "daily": daily_list,
        "today_summary": today_summary,
        "today_calls": today_calls,
        "fetched_at": datetime.fromtimestamp(fetched_at_ms / 1000.0).strftime("%Y-%m-%d %H:%M:%S"),
    }

    data_sig = compute_data_signature(payload)
    payload["data_sig"] = data_sig

    if if_changed and not force and cached and cached.get("data_sig") == data_sig:
        # Update local_sig & synced_ts in cache so we don't re-hit RPC next tick
        cached["local_sig"] = local_sig
        cached["synced_ts"] = now_ts
        save_cache(cached)
        return {
            "ok": True,
            "changed": False,
            "skip_reason": "same_data",
            "checked_at": datetime.fromtimestamp(now_ts).strftime("%H:%M:%S"),
        }

    save_cache(payload)
    return payload


if __name__ == "__main__":
    if_changed = "--if-changed" in sys.argv
    force = "--force" in sys.argv
    print(json.dumps(get_cursor_usage_details(if_changed=if_changed, force=force), ensure_ascii=False))
