# Herdr Personalize

Custom Herdr Desktop mods and `main-plus` layout, including:

- **`cursor-usage`**: Right-side panel for Cursor billing cycle quota, per-model breakdown, daily Top-3 + Others stacked bar, official Cursor model fee list, today's per-call details (with Cache Read hit rate), and usage analytics charts.
- **`workspace-chrome-plus`**: Sidebar footer with live Cursor quota integration.
- **`tabs-timer`**: Top tab bar with panel toggles (Files, Changes, Inspector, Git, Usage).
- **`agent-inspector`**, **`git-graph`**, **`agents-screen`**, **`pane-screen`**, **`spaces-plus`**, **`task-flow`**, **`task-notes`**, **`tmux-prefix`**, **`workspace-status-plus`**, etc.

## One-Line Install (Windows PowerShell)

```powershell
irm https://raw.githubusercontent.com/jacky778199/Herdr_personalize/main/install.ps1 | iex
```

This will:
1. Download the latest `layouts/main-plus.json` and all custom `mods/*` into `~/.config/herdr-app` (without overwriting your existing Herdr settings or session state).
2. Switch the active Herdr layout to `main-plus`.

## Requirements

- [Herdr](https://herdr.dev) installed
- Python 3 in `PATH` (used by `cursor-usage` and `agent-inspector` scripts)
- Cursor Desktop / Cursor CLI logged in on the machine (for live usage sync)
