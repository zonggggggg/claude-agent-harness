// PostToolUse hook（Bash / PowerShell）：工程師每跑完一次指令，就比對鎖定的驗收測試與 gate.json 有沒有被改。
// PreToolUse 的 guard-locked-tests 只攔得到 Edit / Write；用 sed、重導向、python -c 改檔都攔不到，
// 比對指令字串也擋不完。這支不看指令怎麼寫，只看結果：跟 gate.mjs lock 時的雜湊不同就從備份還原，
// 並回饋給工程師。指令已經執行過了，所以是事後還原，不是事前阻擋。
// 不做事的情況：不是工程師、還沒 lock（沒有 .claude/dev-team/locked/gate.json）。
// 限制：整個 .claude/dev-team/ 被刪掉時沒有備份可比，這時要靠總指揮的 gate.mjs check（找不到 gate.json 會失敗）。
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { STATE_LABEL, appendActivity, backupDir, gatePath, isEngineer, lockedEntries, lockedFileState, projectRoot, roleOf } from './gate-state.mjs';
import { readJsonStdin } from './read-stdin.mjs';

// 比對並還原，回傳每個有問題的項目（空陣列代表沒被動過）。
export function restoreLocked(root) {
  const dir = backupDir(root);
  const gateBackup = join(dir, 'gate.json');
  if (!existsSync(gateBackup)) return [];

  const changes = [];
  const expected = readFileSync(gateBackup, 'utf8');
  const gateState = gateFileState(gatePath(root), expected);
  if (gateState !== 'ok') {
    replaceWith(gatePath(root), () => writeFileSync(gatePath(root), expected, 'utf8'));
    changes.push(`.claude/dev-team/gate.json（${STATE_LABEL[gateState]}，已還原）`);
  }

  for (const e of lockedEntries(JSON.parse(expected))) {
    if (!e.sha256) continue;
    const file = resolve(root, e.path);
    const state = lockedFileState(file, e.sha256);
    if (state === 'ok') continue;
    const backup = join(dir, e.sha256);
    if (existsSync(backup)) {
      replaceWith(file, () => copyFileSync(backup, file));
      changes.push(`${e.path}（${STATE_LABEL[state]}，已還原）`);
    } else {
      changes.push(`${e.path}（${STATE_LABEL[state]}，找不到備份，沒有還原）`);
    }
  }
  return changes;
}

function gateFileState(file, expected) {
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return 'missing';
  }
  if (!st.isFile()) return 'not-file';
  return readFileSync(file, 'utf8') === expected ? 'ok' : 'changed';
}

// 先移掉原本的東西再寫：被換成 symlink 時直接寫會寫穿到 symlink 指向的檔案（例如產品程式碼）。
function replaceWith(file, write) {
  rmSync(file, { recursive: true, force: true });
  mkdirSync(dirname(file), { recursive: true });
  write();
}

export function postShellDecision(input, env = process.env) {
  if (!isEngineer(input?.agent_type)) return null;
  const root = projectRoot(input, env);
  const changes = restoreLocked(root);
  if (changes.length === 0) return null;

  const role = roleOf(input.agent_type);
  appendActivity(root, { event: 'LockCheck', agent_type: input.agent_type, agent_id: input.agent_id ?? null, result: 'restored', changes });
  return {
    decision: 'block',
    reason:
      `[dev-team guard] ${role} 剛才的指令改動了鎖定的驗收測試或關卡狀態，已自動還原：\n` +
      `${changes.map((c) => `- ${c}`).join('\n')}\n` +
      '驗收測試由 test-engineer 負責，工程師不能用任何方式修改。認為測試寫錯時，停下來在回報裡說明理由' +
      '（狀態用 DONE_WITH_CONCERNS 或 BLOCKED），由總指揮判斷；不要再嘗試修改。' +
      '如果是格式化或 lint 工具（例如 ruff format、prettier --write）順手改到，之後把範圍限定在產品程式碼。' +
      '這次還原已記錄，總指揮會看到。',
  };
}

async function main() {
  let input;
  try {
    input = await readJsonStdin();
  } catch {
    process.exit(0); // 讀不到輸入就不做事
  }
  try {
    const decision = postShellDecision(input);
    if (decision) process.stdout.write(JSON.stringify(decision));
  } catch {
    // hook 本身出錯不擋，總指揮的 gate.mjs check 仍是最後防線
  }
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
