#!/usr/bin/env node
// XD Lite push-guard (ZCode PreToolUse hook for the Bash tool).
// When the agent runs `git push`, open the XD Lite review window and block
// until the human sends the review (or XD_LITE_HOOK_TIMEOUT minutes pass).
// Exit 0 — proceed (not a push / review sent / nothing open).
// Exit 2 — block the command; stderr (REVIEW_FILE=…) is shown to the agent.
import { spawnSync } from 'node:child_process';

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let cmd = '';
  try {
    cmd = JSON.parse(input)?.tool_input?.command ?? '';
  } catch {}
  // guard only actual pushes; a deliberate --no-verify bypasses the review
  if (!/\bgit\b[^&|;]*\bpush\b/.test(cmd) || /--no-verify/.test(cmd)) process.exit(0);
  const timeout = process.env.XD_LITE_HOOK_TIMEOUT ?? '15';
  // xd-lite's stdout must NOT reach the hook's stdout (it is parsed as strict
  // JSON) — route the review output to stderr instead.
  const r = spawnSync('xd-lite', ['.', '--wait', '--fail-on-open', '--timeout', timeout], {
    cwd: process.cwd(),
    stdio: ['ignore', 2, 'inherit'],
  });
  if (r.error) {
    console.error('[xd-lite] not on PATH — push not blocked:', String(r.error.message ?? r.error));
    process.exit(0); // fail-open: never break pushes because the tool is missing
  }
  process.exit(r.status ?? 0);
});
