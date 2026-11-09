// PreToolUse hook：工程師（backend-engineer / frontend-engineer）不能改被鎖定的驗收測試。
// 鎖定清單來自 <專案>/.claude/dev-team/gate.json 的 lockedTests（總指揮在階段 3 建立）。
// test-engineer 與主 session 不擋：test-engineer 依規則可在有理由時修改，總指揮要負責重新 lock。
// 阻擋方式和 guard-sensitive-files 一樣輸出 permissionDecision: "deny" 的 JSON（Windows 上 exit 2 擋不住）。
// 限制：只攔 Edit / Write / MultiEdit / NotebookEdit，用 Bash 改檔攔不到，所以總指揮仍要跑 gate.mjs check。
import { pathToFileURL } from 'node:url';

import { comparablePath, isEngineer, isLocked, projectRoot, readGate, roleOf, stateDir } from './gate-state.mjs';
import { readJsonStdin } from './read-stdin.mjs';
import { targetPath } from './guard-sensitive-files.mjs';

function deny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

export function lockedTestDecision(input, env = process.env) {
  if (!isEngineer(input?.agent_type)) return null;
  const root = projectRoot(input, env);
  const filePath = targetPath(input);
  if (!filePath) return null;

  // 關卡狀態檔（gate.json、擋停計數）本身也不能讓工程師改，否則可以把鎖拿掉
  const dir = `${comparablePath(root, stateDir(root))}/`;
  if (comparablePath(root, String(filePath)).startsWith(dir)) {
    return deny(`[dev-team guard] ${roleOf(input.agent_type)} 不能修改 dev-team 的關卡狀態檔 ${filePath}。`);
  }

  const gate = readGate(root);
  if (!gate || !isLocked(root, gate, filePath)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `[dev-team guard] ${roleOf(input.agent_type)} 不能修改已鎖定的驗收測試 ${filePath}。` +
        '認為測試寫錯時，停下來在回報裡說明理由（狀態用 DONE_WITH_CONCERNS 或 BLOCKED），由總指揮交給 test-engineer 判斷；' +
        '不要改用 Bash 或其他方式繞過。',
    },
  };
}

async function main() {
  let input;
  try {
    input = await readJsonStdin();
  } catch {
    process.exit(0); // 讀不到輸入就不擋
  }
  try {
    const decision = lockedTestDecision(input);
    if (decision) process.stdout.write(JSON.stringify(decision));
  } catch {
    // hook 本身出錯不擋，避免卡住所有編輯
  }
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
