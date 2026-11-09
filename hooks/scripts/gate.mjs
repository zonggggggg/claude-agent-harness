// 總指揮用的關卡指令（從專案根目錄執行）：
//   node <plugin>/hooks/scripts/gate.mjs lock    依 gate.json 的 lockedTests 計算並寫入 sha256，備份到 .claude/dev-team/locked/
//   node <plugin>/hooks/scripts/gate.mjs check   比對驗收測試與 gate.json 是否被改過（有變更 exit 1）
//   node <plugin>/hooks/scripts/gate.mjs clear   功能完成後清掉 gate.json、擋停計數與備份
// 專案根目錄預設是 CLAUDE_PROJECT_DIR，沒有就用目前目錄；也可以加 --root <路徑>。
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { STATE_LABEL, backupDir, gatePath, isRegularFile, lockedEntries, lockedFileState, readGate, sha256File, stateDir } from './gate-state.mjs';

export function lock(root) {
  const gate = readGate(root);
  if (!gate) return { ok: false, lines: [`找不到或無法解析 ${gatePath(root)}，請先建立 gate.json`] };
  const entries = lockedEntries(gate);
  if (entries.length === 0) return { ok: false, lines: ['gate.json 的 lockedTests 是空的'] };

  const missing = entries.filter((e) => !isRegularFile(resolve(root, e.path)));
  if (missing.length) return { ok: false, lines: missing.map((e) => `找不到驗收測試檔（或不是一般檔案）：${e.path}`) };

  gate.lockedTests = entries.map((e) => ({ path: e.path, sha256: sha256File(resolve(root, e.path)) }));
  writeFileSync(gatePath(root), `${JSON.stringify(gate, null, 2)}\n`, 'utf8');

  // 重新 lock 時換掉舊備份，避免還原成上一版的測試
  const dir = backupDir(root);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const e of gate.lockedTests) copyFileSync(resolve(root, e.path), join(dir, e.sha256));
  copyFileSync(gatePath(root), join(dir, 'gate.json'));

  return {
    ok: true,
    lines: [
      `已鎖定 ${entries.length} 個驗收測試檔（備份在 .claude/dev-team/locked/）：`,
      ...gate.lockedTests.map((e) => `  ${e.sha256.slice(0, 12)}  ${e.path}`),
    ],
  };
}

export function check(root) {
  const gate = readGate(root);
  if (!gate) return { ok: false, lines: [`找不到或無法解析 ${gatePath(root)}`] };
  const entries = lockedEntries(gate);
  const problems = [];
  const gateBackup = join(backupDir(root), 'gate.json');
  if (existsSync(gateBackup) && readFileSync(gateBackup, 'utf8') !== readFileSync(gatePath(root), 'utf8')) {
    problems.push('gate.json 和 lock 時不同（改過 gate.json 要重跑 gate.mjs lock）');
  }
  for (const e of entries) {
    const file = resolve(root, e.path);
    if (!e.sha256) {
      problems.push(`尚未鎖定（先跑 gate.mjs lock）：${e.path}`);
      continue;
    }
    const state = lockedFileState(file, e.sha256);
    if (state !== 'ok') problems.push(`${STATE_LABEL[state]}：${e.path}`);
  }
  if (problems.length) return { ok: false, lines: ['驗收測試有變更：', ...problems.map((p) => `  ${p}`)] };
  return { ok: true, lines: [`OK：${entries.length} 個驗收測試檔未變更`] };
}

export function clear(root) {
  const removed = [];
  for (const name of ['gate.json', 'stop-guard.json']) {
    const file = join(stateDir(root), name);
    if (existsSync(file)) {
      rmSync(file);
      removed.push(name);
    }
  }
  if (existsSync(backupDir(root))) {
    rmSync(backupDir(root), { recursive: true, force: true });
    removed.push('locked/');
  }
  return { ok: true, lines: [removed.length ? `已清除：${removed.join('、')}` : '沒有需要清除的關卡狀態'] };
}

function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const rootIdx = rest.indexOf('--root');
  const root = rootIdx >= 0 ? resolve(rest[rootIdx + 1]) : process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const actions = { lock, check, clear };
  if (!actions[cmd]) {
    process.stderr.write('用法：node gate.mjs <lock|check|clear> [--root <專案根目錄>]\n');
    process.exit(2);
  }
  const result = actions[cmd](root);
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
