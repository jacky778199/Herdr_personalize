import json
import os
import sys
import time


def emit(user, cpu, cpu_user, mem, mem_user):
    print(json.dumps({
        "user": user,
        "cpu": round(max(0.0, cpu), 1),
        "cpu_user": round(max(0.0, cpu_user), 1),
        "mem": round(max(0.0, mem), 1),
        "mem_user": round(max(0.0, mem_user), 1),
    }))


def linux():
    user = os.environ.get("USER") or os.environ.get("USERNAME") or ""
    uid = os.getuid()

    def cpu_line():
        parts = open("/proc/stat", encoding="utf-8").readline().split()[1:]
        nums = [int(x) for x in parts]
        idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
        return idle, sum(nums)

    def mine():
        rss = 0
        ticks = 0
        for name in os.listdir("/proc"):
            if not name.isdigit():
                continue
            try:
                status = open(f"/proc/{name}/status", encoding="utf-8", errors="replace").read().splitlines()
                owned = False
                for line in status:
                    if line.startswith("Uid:"):
                        owned = int(line.split()[1]) == uid
                        break
                if not owned:
                    continue
                for line in status:
                    if line.startswith("VmRSS:"):
                        rss += int(line.split()[1])
                        break
                stat = open(f"/proc/{name}/stat", encoding="utf-8", errors="replace").read()
                fields = stat[stat.rfind(")") + 2:].split()
                ticks += int(fields[11]) + int(fields[12])
            except Exception:
                continue
        return rss, ticks

    def meminfo():
        info = {}
        for line in open("/proc/meminfo", encoding="utf-8"):
            key, val = line.split(":", 1)
            info[key] = int(val.strip().split()[0])
        total = info["MemTotal"]
        avail = info.get("MemAvailable", info.get("MemFree", 0))
        return total, 100.0 * (total - avail) / total if total else 0.0

    idle1, total1 = cpu_line()
    rss1, ticks1 = mine()
    time.sleep(0.35)
    idle2, total2 = cpu_line()
    rss2, ticks2 = mine()
    total_k, mem = meminfo()
    dt = max(1, total2 - total1)
    cpu = 100.0 * (1.0 - (idle2 - idle1) / dt)
    cpu_user = 100.0 * max(0, ticks2 - ticks1) / dt
    mem_user = 100.0 * ((rss1 + rss2) / 2) / total_k if total_k else 0.0
    emit(user, cpu, cpu_user, mem, mem_user)


def windows():
    import ctypes
    from ctypes import wintypes

    user = os.environ.get("USERNAME") or os.environ.get("USER") or ""
    k32 = ctypes.windll.kernel32
    adv = ctypes.windll.advapi32
    psapi = ctypes.windll.psapi
    adv.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    adv.OpenProcessToken.restype = wintypes.BOOL
    adv.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_uint32, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    adv.GetTokenInformation.restype = wintypes.BOOL
    adv.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    adv.ConvertSidToStringSidW.restype = wintypes.BOOL
    k32.LocalFree.argtypes = [ctypes.c_void_p]
    k32.LocalFree.restype = ctypes.c_void_p
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    k32.CloseHandle.restype = wintypes.BOOL

    class FILETIME(ctypes.Structure):
        _fields_ = [("lo", wintypes.DWORD), ("hi", wintypes.DWORD)]

    def ticks(ft):
        return (ft.hi << 32) | ft.lo

    def system_times():
        idle, kernel, usr = FILETIME(), FILETIME(), FILETIME()
        k32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(usr))
        return ticks(idle), ticks(kernel), ticks(usr)

    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [
            ("dwLength", wintypes.DWORD),
            ("dwMemoryLoad", wintypes.DWORD),
            ("ullTotalPhys", ctypes.c_uint64),
            ("ullAvailPhys", ctypes.c_uint64),
            ("ullTotalPageFile", ctypes.c_uint64),
            ("ullAvailPageFile", ctypes.c_uint64),
            ("ullTotalVirtual", ctypes.c_uint64),
            ("ullAvailVirtual", ctypes.c_uint64),
            ("ullAvailExtendedVirtual", ctypes.c_uint64),
        ]

    class SID_AND_ATTRIBUTES(ctypes.Structure):
        _fields_ = [("Sid", ctypes.c_void_p), ("Attributes", wintypes.DWORD)]

    class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    class WTS_PROCESS_INFOW(ctypes.Structure):
        _fields_ = [
            ("SessionId", wintypes.DWORD),
            ("ProcessId", wintypes.DWORD),
            ("pProcessName", ctypes.c_wchar_p),
            ("pUserSid", ctypes.c_void_p),
        ]

    k32.GetProcessTimes.argtypes = [wintypes.HANDLE, ctypes.POINTER(FILETIME), ctypes.POINTER(FILETIME), ctypes.POINTER(FILETIME), ctypes.POINTER(FILETIME)]
    k32.GetProcessTimes.restype = wintypes.BOOL
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESS_MEMORY_COUNTERS), wintypes.DWORD]
    psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
    wts = ctypes.windll.wtsapi32
    wts.WTSEnumerateProcessesW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.POINTER(WTS_PROCESS_INFOW)), ctypes.POINTER(wintypes.DWORD)]
    wts.WTSEnumerateProcessesW.restype = wintypes.BOOL
    wts.WTSFreeMemory.argtypes = [ctypes.c_void_p]

    def token_sid(token):
        needed = wintypes.DWORD()
        adv.GetTokenInformation(token, 1, None, 0, ctypes.byref(needed))
        if not needed.value:
            return None
        buf = ctypes.create_string_buffer(needed.value)
        if not adv.GetTokenInformation(token, 1, buf, needed.value, ctypes.byref(needed)):
            return None
        info = ctypes.cast(buf, ctypes.POINTER(SID_AND_ATTRIBUTES)).contents
        text = ctypes.c_void_p()
        if not adv.ConvertSidToStringSidW(info.Sid, ctypes.byref(text)):
            return None
        value = ctypes.wstring_at(text)
        k32.LocalFree(text)
        return value

    def open_token(handle):
        token = wintypes.HANDLE()
        if not adv.OpenProcessToken(handle, 0x0008, ctypes.byref(token)):
            return None
        return token

    current = k32.GetCurrentProcess()
    current_token = open_token(current)
    mine = token_sid(current_token) if current_token else None
    if current_token:
        k32.CloseHandle(current_token)

    def user_pids():
        info = ctypes.POINTER(WTS_PROCESS_INFOW)()
        count = wintypes.DWORD()
        if not mine or not wts.WTSEnumerateProcessesW(None, 0, 1, ctypes.byref(info), ctypes.byref(count)):
            return []
        found = []
        try:
            for index in range(count.value):
                sid = info[index].pUserSid
                if not sid:
                    continue
                text = ctypes.c_void_p()
                if not adv.ConvertSidToStringSidW(sid, ctypes.byref(text)):
                    continue
                if ctypes.wstring_at(text) == mine:
                    found.append(int(info[index].ProcessId))
                k32.LocalFree(text)
        finally:
            wts.WTSFreeMemory(info)
        return found

    QUERY = 0x0410

    def sample(pid_list):
        cpu_ticks = 0
        mem_bytes = 0
        for pid in pid_list:
            handle = k32.OpenProcess(QUERY, False, pid)
            if not handle:
                continue
            created, exited, kernel, usr = FILETIME(), FILETIME(), FILETIME(), FILETIME()
            if k32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(usr)):
                cpu_ticks += ticks(kernel) + ticks(usr)
            counters = PROCESS_MEMORY_COUNTERS()
            counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
            if psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
                mem_bytes += int(counters.WorkingSetSize)
            k32.CloseHandle(handle)
        return cpu_ticks, mem_bytes

    mem = MEMORYSTATUSEX()
    mem.dwLength = ctypes.sizeof(mem)
    k32.GlobalMemoryStatusEx(ctypes.byref(mem))
    owned = user_pids()
    idle1, kernel1, user1 = system_times()
    mine1, mem_bytes = sample(owned)
    time.sleep(0.35)
    idle2, kernel2, user2 = system_times()
    mine2, _mem2 = sample(owned)
    total = max(1, (kernel2 - kernel1) + (user2 - user1))
    busy = max(0, (kernel2 - kernel1) - (idle2 - idle1) + (user2 - user1))
    cpu = 100.0 * busy / total
    cpu_user = 100.0 * max(0, mine2 - mine1) / total
    mem_user = 100.0 * mem_bytes / mem.ullTotalPhys if mem.ullTotalPhys else 0.0
    emit(user, cpu, cpu_user, float(mem.dwMemoryLoad), mem_user)


if sys.platform.startswith("linux"):
    linux()
elif sys.platform == "win32":
    windows()
else:
    emit(os.environ.get("USER") or "", 0, 0, 0, 0)
