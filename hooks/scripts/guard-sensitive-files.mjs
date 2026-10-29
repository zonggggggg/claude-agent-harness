// PreToolUse hook：阻擋任何角色（含主 session）直接寫入敏感檔案。
// 阻擋時在 stdout 輸出 permissionDecision: "deny" 的 JSON（原因會回饋給 Claude）。
// 不用 exit 2：Windows 上實測 Claude Code 只把它記成 hook 錯誤，檔案照樣被寫入。
// 確實需要改時，啟動 Claude 前設定 DEV_TEAM_ALLOW_SENSITIVE=1。
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readJsonStdin } from './read-stdin.mjs';

const ENV_TEMPLATE_SUFFIX = /\.(example|sample|template|dist|defaults)$/i;

const SENSITIVE_NAME_PATTERNS = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^credentials(\..+)?\.json$/i,
  /^secrets?\.(json|ya?ml|toml)$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
];

export function sensitiveReason(filePath) {
  if (!filePath) return null;
  const normalized = String(filePath).replace(/\\/g, '/');
  if (/(^|\/)\.git\//.test(normalized)) return 'git 內部檔案';

  const name = basename(normalized);
  if (ENV_TEMPLATE_SUFFIX.test(name)) return null;
  const hit = SENSITIVE_NAME_PATTERNS.find((re) => re.test(name));
  return hit ? `敏感檔案（${name}）` : null;
}

export function targetPath(input) {
  const ti = input?.tool_input ?? {};
  return ti.file_path ?? ti.notebook_path ?? ti.path ?? null;
}

async function main() {
  if (process.env.DEV_TEAM_ALLOW_SENSITIVE === '1') process.exit(0);

  let input;
  try {
    input = await readJsonStdin();
  } catch {
    process.exit(0); // 讀不到輸入就不擋，避免 hook 本身壞掉卡住所有編輯
  }

  const filePath = targetPath(input);
  const reason = sensitiveReason(filePath);
  if (!reason) process.exit(0);

  process.stdout.write(JSON.stringify(denyDecision(filePath, reason)));
  process.exit(0);
}

export function denyDecision(filePath, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `[dev-team guard] 已阻擋寫入 ${filePath}：${reason}。` +
        '請改用範例檔（如 .env.example），或請使用者手動修改；' +
        '若使用者確認要改，需以 DEV_TEAM_ALLOW_SENSITIVE=1 重新啟動 Claude。',
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
