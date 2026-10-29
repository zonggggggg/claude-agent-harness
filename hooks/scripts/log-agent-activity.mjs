// SubagentStart / SubagentStop hook：把每個角色的啟動與結束記到
// <專案>/.claude/dev-team/activity.jsonl，事後可以追「誰在什麼時候做了什麼」。
// 純紀錄用途：任何錯誤都吞掉並 exit 0，絕不影響 agent 執行。
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readJsonStdin } from './read-stdin.mjs';

const SUMMARY_MAX = 300;

export function buildRecord(input, now = new Date()) {
  const record = {
    ts: now.toISOString(),
    event: input.hook_event_name ?? null,
    agent_type: input.agent_type ?? null,
    agent_id: input.agent_id ?? null,
    session_id: input.session_id ?? null,
  };
  if (typeof input.last_assistant_message === 'string') {
    const text = input.last_assistant_message.replace(/\s+/g, ' ').trim();
    record.summary = text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text;
  }
  return record;
}

export function logFilePath(input, env = process.env) {
  const root = env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  return join(root, '.claude', 'dev-team', 'activity.jsonl');
}

async function main() {
  try {
    const input = await readJsonStdin();
    const file = logFilePath(input);
    mkdirSync(join(file, '..'), { recursive: true });
    appendFileSync(file, `${JSON.stringify(buildRecord(input))}\n`, 'utf8');
  } catch {
    // 紀錄失敗不影響流程
  }
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
