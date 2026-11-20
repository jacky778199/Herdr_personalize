// Agents-screen no longer reads the terminal to press Enter. That stays in the
// user.auto-enter plugin so the screen read is not on the UI thread.
import { shared } from "herdr";

export function autoInputEnabled() {
  return shared("cursor.auto-input") !== false;
}

function bottomSlice(text, lineCount = 8) {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""))
    .filter((l) => l.trim())
    .slice(-lineCount)
    .join("\n");
}

export function screenFingerprint(text) {
  return bottomSlice(text, 12).slice(0, 600);
}

/** @returns {string|null} key sequence for hc send; null = do not auto-send */
export function pickAutoInput(text) {
  const bottom = bottomSlice(text, 8);
  if (!bottom) return null;

  if (/write to this file\?/i.test(bottom) && /proceed \(y\)/i.test(bottom)) return "y\r";
  if (/run this command\?|waiting for approval/i.test(bottom) && /run \(once\)\s*\(y\)|skip \(esc or n\)/i.test(bottom)) {
    return "y\r";
  }
  if (/(?:→\s*)?run \(once\)\s*\(y\)/i.test(bottom) && /skip.*esc or n/i.test(bottom)) return "y\r";
  if (/^\s*allow .*\(y\)/im.test(bottom)) return "y\r";
  if (/\(y\) \(enter\)/i.test(bottom)) return "y\r";
  if (/reject & propose changes/i.test(bottom) && /\(y\)/i.test(bottom)) return "y\r";

  return null;
}
