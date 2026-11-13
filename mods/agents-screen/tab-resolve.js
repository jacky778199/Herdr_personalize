import { spaces } from "herdr";

/** Tab id as spaces() uses it (`build-server/tb…`), including remote label `tb…` only. */
export function canonicalTabId(tabId, terminalAddress) {
  if (!tabId) return tabId;
  for (const sp of spaces()) {
    for (const tab of sp.tabs) {
      if (tab.id === tabId) return tab.id;
    }
  }
  const machine = terminalAddress?.includes("/") ? terminalAddress.split("/")[0] : null;
  if (machine) {
    const qualified = `${machine}/${tabId}`;
    for (const sp of spaces()) {
      if (sp.tabs.some((t) => t.id === qualified)) return qualified;
    }
  }
  return tabId;
}

export function tabIdFromTerminal(term) {
  const raw = term?.labels?.["herdr.tab"];
  if (!raw) return null;
  return canonicalTabId(raw, term.address);
}

export function buildTabIndex() {
  const map = new Map();
  for (const sp of spaces()) {
    for (const tab of sp.tabs) {
      const loc = {
        space: sp.id,
        space_name: sp.name,
        tab_index: tab.index,
        tab_name: tab.name,
        tab_id: tab.id,
      };
      map.set(tab.id, loc);
      const slash = tab.id.indexOf("/");
      if (slash > 0) map.set(tab.id.slice(slash + 1), loc);
    }
  }
  return map;
}
