// SubagentStop hook：工程師結束前，自動跑一次「這個角色的驗收測試」，紅燈就不讓它結束。
// 指令來自 <專案>/.claude/dev-team/gate.json 的 acceptanceCommands[<角色>]（test-engineer RED 時實際跑通的指令）。
// exit 0 也不一定是真的綠燈：測試被 skip（例如新增 conftest.py 把測試全部標成 skip）時 pytest 一樣 exit 0。
// 所以 exit 0 之後還會解析測試結果的摘要行（pytest / vitest / jest）：
//   - 有 skipped / deselected / xfailed / xpassed / todo → 擋下
//   - gate.json 有 acceptanceCounts[<角色>] 而通過數比它少 → 擋下
//   - 解析不到摘要行 → 放行，但記成 pass-unparsed 讓總指揮知道數量檢查沒生效
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

const NOT_RUN = ['skipped', 'deselected', 'xfailed', 'xpassed', 'todo'];

// 從測試輸出由下往上找摘要行，回傳 { passed, failed, skipped, ... }；找不到回 null。
// 跳過 vitest 的「Test Files」與 jest 的「Test Suites」，那兩行算的是檔案數不是測試數。
export function parseCounts(output) {
  const lines = String(output ?? '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].replace(/\x1b\[[0-9;]*m/g, '');
    if (/Test Files|Test Suites|Suites:/i.test(line)) continue;
    const hits = [...line.matchAll(/(\d+)\s+(passed|failed|skipped|deselected|xfailed|xpassed|todo|errors?)\b/gi)];
    if (hits.length === 0) continue;
    const counts = {};
    for (const [, n, kind] of hits) {
      const key = kind.toLowerCase().startsWith('error') ? 'error' : kind.toLowerCase();
      counts[key] = (counts[key] ?? 0) + Number(n);
    }
    return counts;
  }
  return null;
}

// exit 0 之後的數量檢查。回傳 null（沒問題）、{ unparsed: true }，或 { kind, message }。
export function countProblem(output, expected) {
  const counts = parseCounts(output);
  if (!counts) return { unparsed: true };
  const notRun = NOT_RUN.filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`);
  if (notRun.length) {
    return {
      kind: 'not-run',
      message:
        `驗收測試 exit 0，但有測試沒有真的執行（${notRun.join('、')}）。` +
        '請移除讓驗收測試被略過的設定或標記（conftest.py、pytest.ini / pyproject.toml 的 pytest 設定、vitest / jest 設定、skip / xfail / todo），讓它真的執行並通過。',
    };
  }
  const passed = counts.passed ?? 0;
  if (Number.isInteger(expected) && expected > 0 && passed < expected) {
    return { kind: 'count', message: `驗收測試只通過 ${passed} 個，少於 RED 時的 ${expected} 個；有驗收測試沒有被收集到或沒有執行。` };
  }
  return null;
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
  let problem = null;
  if (result.ok) {
    problem = countProblem(result.output, gate.acceptanceCounts?.[role]);
    if (!problem) {
      log(root, { ...base, result: 'pass' });
      return null;
    }
    if (problem.unparsed) {
      log(root, { ...base, result: 'pass-unparsed' });
      return null;
    }
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
  log(root, { ...base, result: 'fail-blocked', blocks: used + 1, ...(problem ? { kind: problem.kind } : {}) });

  const last = used + 1 >= max;
  return {
    decision: 'block',
    reason:
      `[dev-team gate] 驗收測試沒過，還不能結束（第 ${used + 1} / ${max} 次擋下）。\n` +
      `指令：${command}（exit ${result.status ?? '—'}）\n` +
      (problem ? `${problem.message}\n` : '') +
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
