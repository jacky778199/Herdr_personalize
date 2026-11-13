import json
import os
import sqlite3
import time
import calendar
from datetime import datetime


def main():
    appdata = os.environ.get("APPDATA", "")
    if not appdata:
        appdata = os.path.expanduser(r"~\AppData\Roaming")
    db_path = os.path.join(appdata, "Cursor", "User", "globalStorage", "state.vscdb")

    now_ts = time.time()
    now_ms = now_ts * 1000

    # Default fallback dates based on calendar month
    now_dt = datetime.now()
    days_in_month = calendar.monthrange(now_dt.year, now_dt.month)[1]
    fallback_days_passed = round(now_dt.day - 1 + (now_dt.hour * 3600 + now_dt.minute * 60 + now_dt.second) / 86400.0, 1)
    fallback_time_pct = round((fallback_days_passed / days_in_month) * 100.0, 1)

    if not os.path.exists(db_path):
        print(json.dumps({
            "spent": 0.0,
            "limit": 650.0,
            "percent": 0.0,
            "formatted": "$0.00/$650",
            "days_passed": fallback_days_passed,
            "days_total": float(days_in_month),
            "day_num": now_dt.day,
            "time_percent": fallback_time_pct
        }))
        return

    uri = f"file:{db_path}?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=3.0)
        cur = conn.cursor()
        cur.execute("SELECT value FROM ItemTable WHERE key = 'aiSettings.enterprisePlanUsageSnapshot'")
        row = cur.fetchone()
        conn.close()

        if not row or not row[0]:
            print(json.dumps({
                "spent": 0.0,
                "limit": 650.0,
                "percent": 0.0,
                "formatted": "$0.00/$650",
                "days_passed": fallback_days_passed,
                "days_total": float(days_in_month),
                "day_num": now_dt.day,
                "time_percent": fallback_time_pct
            }))
            return

        data = json.loads(row[0])
        charts = data.get("charts", [])
        if not charts:
            print(json.dumps({
                "spent": 0.0,
                "limit": 650.0,
                "percent": 0.0,
                "formatted": "$0.00/$650",
                "days_passed": fallback_days_passed,
                "days_total": float(days_in_month),
                "day_num": now_dt.day,
                "time_percent": fallback_time_pct
            }))
            return

        chosen_chart = None
        for c in charts:
            p_start = c.get("periodStartMs", 0)
            p_end = c.get("periodEndMs", 0)
            if p_start <= now_ms <= p_end:
                chosen_chart = c
                break
        if not chosen_chart:
            chosen_chart = charts[-1]

        # Billing period calculation
        p_start_ms = data.get("periodStartMs") or chosen_chart.get("periodStartMs") or (now_ms - 86400000 * 12)
        p_end_ms = data.get("periodEndMs") or chosen_chart.get("periodEndMs") or (now_ms + 86400000 * 18)

        p_start_s = p_start_ms / 1000.0
        p_end_s = p_end_ms / 1000.0
        total_sec = max(1.0, p_end_s - p_start_s)
        passed_sec = max(0.0, min(total_sec, now_ts - p_start_s))

        days_passed = round(passed_sec / 86400.0, 1)
        days_total = round(total_sec / 86400.0, 1)
        time_pct = round((passed_sec / total_sec) * 100.0, 1)
        day_num = min(int(days_total), int(days_passed) + 1)

        resp = json.loads(chosen_chart.get("response", "{}"))
        daily = resp.get("dailySpend", [])
        total_cents = sum(item.get("spendCents", 0) for item in daily)
        limit_cents = resp.get("effectiveLimitCents", 65000)

        spent = total_cents / 100.0
        limit = limit_cents / 100.0 if limit_cents > 0 else 650.0
        spent_pct = round((spent / limit) * 100.0, 1) if limit > 0 else 0.0

        print(json.dumps({
            "spent": round(spent, 2),
            "limit": round(limit, 2),
            "percent": spent_pct,
            "formatted": f"${spent:.2f}/${limit:.0f}",
            "days_passed": days_passed,
            "days_total": days_total,
            "day_num": day_num,
            "time_percent": time_pct
        }))
    except Exception:
        print(json.dumps({
            "spent": 0.0,
            "limit": 650.0,
            "percent": 0.0,
            "formatted": "$--/$650",
            "days_passed": fallback_days_passed,
            "days_total": float(days_in_month),
            "day_num": now_dt.day,
            "time_percent": fallback_time_pct
        }))


if __name__ == "__main__":
    main()
