// 總指揮用的關卡指令（從專案根目錄執行）：
//   node <plugin>/hooks/scripts/gate.mjs lock    依 gate.json 的 lockedTests 計算並寫入 sha256
//   node <plugin>/hooks/scripts/gate.mjs check   比對驗收測試是否被改過（有變更 exit 1）
//   node <plugin>/hooks/scripts/gate.mjs clear   功能完成後清掉 gate.json 與擋停計數
// 專案根目錄預設是 CLAUDE_PROJECT_DIR，沒有就用目前目錄；也可以加 --root <路徑>。
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { gatePath, lockedEntries, readGate, sha256File, stateDir } from './gate-state.mjs';

export function lock(root) {
  const gate = readGate(root);
  if (!gate) return { ok: false, lines: [`找不到或無法解析 ${gatePath(root)}，請先建立 gate.json`] };
  const entries = lockedEntries(gate);
  if (entries.length === 0) return { ok: false, lines: ['gate.json 的 lockedTests 是空的'] };

  const missing = entries.filter((e) => !existsSync(resolve(root, e.path)));
  if (missing.length) return { ok: false, lines: missing.map((e) => `找不到驗收測試檔：${e.path}`) };

  gate.lockedTests = entries.map((e) => ({ path: e.path, sha256: sha256File(resolve(root, e.path)) }));
  writeFileSync(gatePath(root), `${JSON.stringify(gate, null, 2)}\n`, 'utf8');
  return { ok: true, lines: [`已鎖定 ${entries.length} 個驗收測試檔：`, ...gate.lockedTests.map((e) => `  ${e.sha256.slice(0, 12)}  ${e.path}`)] };
}

export function check(root) {
  const gate = readGate(root);
  if (!gate) return { ok: false, lines: [`找不到或無法解析 ${gatePath(root)}`] };
  const entries = lockedEntries(gate);
  const problems = [];
  for (const e of entries) {
    const file = resolve(root, e.path);
    if (!e.sha256) problems.push(`尚未鎖定（先跑 gate.mjs lock）：${e.path}`);
    else if (!existsSync(file)) problems.push(`已被刪除：${e.path}`);
    else if (sha256File(file) !== e.sha256) problems.push(`已被修改：${e.path}`);
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
