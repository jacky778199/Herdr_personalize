// Subset of Herdr TUI agent-detection/remote/cursor.toml for screen reads in the app.

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07\x1b\\]*(?:\x07|\x1b\\)/g, "");
}

function nonEmptyLines(text) {
  return text.split(/\r?\n/).map(stripAnsi).filter((l) => l.trim());
}

const SPINNER_WORKING = /^\s*([\u2800-\u28FF]|⬡|⬢)+\s+\p{Alphabetic}\w*ing\b/iu;

/** @returns {"blocked"|"working"|"idle"} */
export function detectCursor(text) {
  const lines = nonEmptyLines(text);
  const bottom = lines.slice(-8);
  const recent = lines.slice(-30).join("\n");
  const bottomText = bottom.join("\n");

  if (/write to this file\?/i.test(recent) && /proceed \(y\)/i.test(recent)) return "blocked";
  if (/waiting for approval|run this command\?/i.test(bottomText) && /run \(once\)|skip \(esc or n\)|\(y\)/i.test(bottomText)) {
    return "blocked";
  }
  // Run-once menu: only the last lines count (ignore old prompts in scrollback).
  if (/(?:→\s*)?run \(once\)\s*\(y\)/i.test(bottomText) && /skip.*esc or n/i.test(bottomText)) return "blocked";
  if (/^\s*→\s*run\b.*\(y\)/im.test(bottomText)) return "blocked";
  if (/^\s*allow .*\(y\)/im.test(bottomText)) return "blocked";
  if (/reject & propose changes/i.test(recent) && /proceed \(y\)/i.test(bottomText)) return "blocked";

  if (/\b[1-9][0-9]*\s+background\s+tasks?\b/i.test(bottomText)) return "working";
  if (/ctrl\+c to stop/i.test(bottomText)) return "working";
  if (/[\u2800-\u28FF⬡⬢]/.test(bottomText) && /\bEditing\b/i.test(bottomText)) return "working";
  for (const line of bottom) {
    if (SPINNER_WORKING.test(line)) return "working";
  }

  return "idle";
}
