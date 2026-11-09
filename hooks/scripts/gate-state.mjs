// dev-team 關卡狀態的共用工具。
// 狀態檔：<專案>/.claude/dev-team/gate.json，由總指揮在階段 3 建立、階段 8 清除：
// {
//   "workdir": "docs/specs/20261109-order-filter",
//   "lockedTests": [{ "path": "backend/tests/acceptance/test_x.py", "sha256": "…" }],
//   "acceptanceCommands": { "backend-engineer": "…", "frontend-engineer": "…" },
//   "maxStopBlocks": 3
// }
// 沒有 gate.json 時，所有關卡 hook 都不做事（fail-open），不影響沒在跑 /dev-team:feature 的專案。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export const ENGINEER_ROLES = new Set(['backend-engineer', 'frontend-engineer']);
export const DEFAULT_MAX_STOP_BLOCKS = 3;

export function projectRoot(input = {}, env = process.env) {
  return env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}

export function stateDir(root) {
  return join(root, '.claude', 'dev-team');
}

export function gatePath(root) {
  return join(stateDir(root), 'gate.json');
}

// plugin 安裝時 agent_type 會帶前綴（dev-team:backend-engineer），只取最後一段比對。
export function roleOf(agentType) {
  if (!agentType) return null;
  const s = String(agentType);
  return s.slice(s.lastIndexOf(':') + 1);
}

export function isEngineer(agentType) {
  return ENGINEER_ROLES.has(roleOf(agentType));
}

export function readGate(root) {
  const file = gatePath(root);
  if (!existsSync(file)) return null;
  try {
    const gate = JSON.parse(readFileSync(file, 'utf8'));
    return gate && typeof gate === 'object' ? gate : null;
  } catch {
    return null;
  }
}

export function lockedEntries(gate) {
  const list = Array.isArray(gate?.lockedTests) ? gate.lockedTests : [];
  return list
    .map((e) => (typeof e === 'string' ? { path: e } : e))
    .filter((e) => e && typeof e.path === 'string' && e.path.trim());
}

// 比對用的路徑：轉成絕對路徑、統一斜線、忽略大小寫（Windows 路徑不分大小寫）。
export function comparablePath(root, p) {
  const abs = isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) ? p : resolve(root, p);
  return abs.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
}

export function isLocked(root, gate, filePath) {
  if (!filePath) return false;
  const target = comparablePath(root, String(filePath));
  return lockedEntries(gate).some((e) => comparablePath(root, e.path) === target);
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function maxStopBlocks(gate) {
  const n = Number(gate?.maxStopBlocks);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_STOP_BLOCKS;
}
