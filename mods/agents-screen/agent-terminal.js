import { isCursorAgentTitle } from "./rules-cursor.js";

const AGENT_ARGV = /\bcursor-agent\b|\bagent(?:\.exe)?\b(?:\s|$)|\bagent\s+--|\-\-api-key\b|\.local\/bin\/agent\b|\.local\/share\/cursor-agent\b|claude(?:-code)?\b|codex\b|\bgemini\b|aider\b|\bpi\b|agent-sdk/i;

export function agentArgv(term) {
  return [...(term?.argv ?? []), ...(term?.foreground?.argv ?? [])].join(" ");
}

export function isAgentTerminal(term) {
  if (!term) return false;
  if (AGENT_ARGV.test(agentArgv(term))) return true;
  return isCursorAgentTitle(term.title);
}
