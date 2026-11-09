// SubagentStop hook：工程師結束前，自動跑一次「這個角色的驗收測試」，紅燈就不讓它結束。
// 指令來自 <專案>/.claude/dev-team/gate.json 的 acceptanceCommands[<角色>]（test-engineer RED 時實際跑通的指令）。
// 放行條件：
//   - 不是工程師、沒有 gate.json、沒有這個角色的指令 → 不做事
//   - 回報狀態是 BLOCKED / NEEDS_CONTEXT → 照實回報是合法結束，放行
//   - 同一個 agent_id 已被擋 maxStopBlocks 次（預設 3）→ 放行，記到 activity.jsonl 讓總指揮看到
// 擋下時輸出 {"decision":"block","reason":…}，reason 附測試輸出最後幾十行，工程師會接著修。
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isEngineer, maxStopBlocks, projectRoot, readGate, roleOf, stateDir } from './gate-state.mjs';
import { readJsonStdin } from './read-stdin.mjs';

const TAIL_LINES = 40;
const COMMAND_TIMEOUT_MS = 540_000; // hooks.json 的 timeout 是 600 秒，留餘裕給 hook 本身

export function reportsStuck(message) {
  if (typeof message !== 'string') return false;
  const head = message.split(/\r?\n/).filter((l) => l.trim()).slice(0, 3).join('\n');
  return /\b(BLOCKED|NEEDS_CONTEXT)\b/.test(head);
}

export function tail(text, n = TAIL_LINES) {
  const lines = String(text ?? '').replace(/\s+$/, '').split(/\r?\n/);
  return lines.slice(-n).join('\n');
}

function readCounts(file) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  } catch {
    return {};
  }
}

function log(root, record) {
  try {
    const dir = stateDir(root);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'activity.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, 'utf8');
  } catch {
    // 紀錄失敗不影響判斷
  }
}

export function runCommand(command, cwd) {
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  return {
    ok: r.status === 0 && !timedOut,
    status: r.status,
    output: timedOut ? `（測試超過 ${COMMAND_TIMEOUT_MS / 1000} 秒被中止）\n${r.stdout ?? ''}${r.stderr ?? ''}` : `${r.stdout ?? ''}${r.stderr ?? ''}`,
  };
}

export function stopDecision(input, env = process.env, run = runCommand) {
  if (!isEngineer(input?.agent_type)) return null;
  const role = roleOf(input.agent_type);
  const root = projectRoot(input, env);
  const gate = readGate(root);
  const command = gate?.acceptanceCommands?.[role];
  if (!command) return null;
  if (reportsStuck(input.last_assistant_message)) return null;

  const base = { event: 'StopGate', agent_type: input.agent_type, agent_id: input.agent_id ?? null };
  const result = run(command, root);
  if (result.ok) {
    log(root, { ...base, result: 'pass' });
    return null;
  }

  const countsFile = join(stateDir(root), 'stop-guard.json');
  const counts = readCounts(countsFile);
  const key = input.agent_id ?? role;
  const used = Number(counts[key] ?? 0);
  const max = maxStopBlocks(gate);
  if (used >= max) {
    log(root, { ...base, result: 'fail-released', blocks: used });
    return null;
  }

  counts[key] = used + 1;
  try {
    mkdirSync(stateDir(root), { recursive: true });
    writeFileSync(countsFile, `${JSON.stringify(counts, null, 2)}\n`, 'utf8');
  } catch {
    // 寫不進計數也照擋，最壞情況是多擋幾次
  }
  log(root, { ...base, result: 'fail-blocked', blocks: used + 1 });

  const last = used + 1 >= max;
  return {
    decision: 'block',
    reason:
      `[dev-team gate] 驗收測試沒過，還不能結束（第 ${used + 1} / ${max} 次擋下）。\n` +
      `指令：${command}（exit ${result.status ?? '—'}）\n` +
      '請繼續修正產品程式碼讓它變綠，不可修改驗收測試、不可 skip。' +
      (last ? '這是最後一次擋下：再修不好，就把回報狀態寫成 BLOCKED 並照實說明卡在哪裡。' : '') +
      `\n--- 測試輸出（最後 ${TAIL_LINES} 行）---\n${tail(result.output)}`,
  };
}

async function main() {
  let input;
  try {
    input = await readJsonStdin();
  } catch {
    process.exit(0);
  }
  try {
    const decision = stopDecision(input);
    if (decision) process.stdout.write(JSON.stringify(decision));
  } catch {
    // hook 本身出錯就放行，不卡住 agent
  }
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
