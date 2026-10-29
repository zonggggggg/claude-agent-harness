import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sensitiveReason, targetPath } from '../hooks/scripts/guard-sensitive-files.mjs';
import { buildRecord, logFilePath } from '../hooks/scripts/log-agent-activity.mjs';

const SCRIPTS = fileURLToPath(new URL('../hooks/scripts/', import.meta.url));

function runHook(script, input, env = {}) {
  const { DEV_TEAM_ALLOW_SENSITIVE, ...baseEnv } = process.env;
  return spawnSync(process.execPath, [join(SCRIPTS, script)], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...baseEnv, ...env },
  });
}

// --- guard-sensitive-files ---

test('擋下 .env 與其變體', () => {
  for (const p of ['.env', 'backend/.env', 'D:\\proj\\.env.local', '.env.production']) {
    assert.ok(sensitiveReason(p), p);
  }
});

test('放行 .env 範例檔', () => {
  for (const p of ['.env.example', 'app/.env.sample', '.env.template', '.env.dist']) {
    assert.equal(sensitiveReason(p), null, p);
  }
});

test('擋下金鑰與憑證檔', () => {
  for (const p of ['certs/server.pem', 'tls.key', 'C:\\Users\\me\\.ssh\\id_rsa', 'credentials.json', 'secrets.yaml']) {
    assert.ok(sensitiveReason(p), p);
  }
});

test('擋下 .git 內部檔案，但放行 .github / .gitignore', () => {
  assert.ok(sensitiveReason('repo/.git/config'));
  assert.equal(sensitiveReason('.github/workflows/ci.yml'), null);
  assert.equal(sensitiveReason('.gitignore'), null);
});

test('一般程式檔放行', () => {
  for (const p of ['src/env.ts', 'app/config/environment.py', 'README.md', 'keyboard.tsx', null]) {
    assert.equal(sensitiveReason(p), null, String(p));
  }
});

test('targetPath 支援 Edit/Write 與 NotebookEdit 的欄位', () => {
  assert.equal(targetPath({ tool_input: { file_path: 'a.ts' } }), 'a.ts');
  assert.equal(targetPath({ tool_input: { notebook_path: 'n.ipynb' } }), 'n.ipynb');
  assert.equal(targetPath({}), null);
});

function decisionOf(r) {
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

test('hook 實跑：寫 .env 輸出 deny 決策並說明原因', () => {
  const r = runHook('guard-sensitive-files.mjs', { tool_name: 'Write', tool_input: { file_path: 'backend/.env' } });
  assert.equal(r.status, 0);
  const d = decisionOf(r);
  assert.equal(d.hookEventName, 'PreToolUse');
  assert.equal(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /已阻擋/);
});

test('hook 實跑：一般檔案放行（無輸出）', () => {
  const r = runHook('guard-sensitive-files.mjs', { tool_name: 'Edit', tool_input: { file_path: 'src/app.ts' } });
  assert.equal(r.status, 0);
  assert.equal(decisionOf(r), null);
});

test('hook 實跑：DEV_TEAM_ALLOW_SENSITIVE=1 時放行', () => {
  const r = runHook(
    'guard-sensitive-files.mjs',
    { tool_name: 'Write', tool_input: { file_path: '.env' } },
    { DEV_TEAM_ALLOW_SENSITIVE: '1' },
  );
  assert.equal(r.status, 0);
  assert.equal(decisionOf(r), null);
});

test('hook 實跑：stdin 延遲寫入時仍等到完整輸入才判斷', async () => {
  const { DEV_TEAM_ALLOW_SENSITIVE, ...env } = process.env;
  const child = spawn(process.execPath, [join(SCRIPTS, 'guard-sensitive-files.mjs')], { env });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const exited = new Promise((resolve) => child.on('close', resolve));
  await new Promise((r) => setTimeout(r, 300));
  child.stdin.end(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '.env' } }));
  assert.equal(await exited, 0);
  assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('hook 實跑：輸入壞掉時不擋（fail-open）', () => {
  const r = runHook('guard-sensitive-files.mjs', 'not json');
  assert.equal(r.status, 0);
  assert.equal(decisionOf(r), null);
});

// --- log-agent-activity ---

test('buildRecord 擷取欄位並截斷過長摘要', () => {
  const rec = buildRecord(
    {
      hook_event_name: 'SubagentStop',
      agent_type: 'architect',
      agent_id: 'a1',
      session_id: 's1',
      last_assistant_message: 'x'.repeat(500),
    },
    new Date('2026-01-01T00:00:00Z'),
  );
  assert.equal(rec.ts, '2026-01-01T00:00:00.000Z');
  assert.equal(rec.agent_type, 'architect');
  assert.equal(rec.summary.length, 301);
});

test('logFilePath 優先使用 CLAUDE_PROJECT_DIR', () => {
  const p = logFilePath({ cwd: '/other' }, { CLAUDE_PROJECT_DIR: '/proj' });
  assert.equal(p.replace(/\\/g, '/'), '/proj/.claude/dev-team/activity.jsonl');
});

test('hook 實跑：附加一行 JSONL 到專案目錄', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-team-'));
  try {
    const input = { hook_event_name: 'SubagentStart', agent_type: 'verifier', agent_id: 'v1', session_id: 's' };
    assert.equal(runHook('log-agent-activity.mjs', input, { CLAUDE_PROJECT_DIR: dir }).status, 0);
    assert.equal(runHook('log-agent-activity.mjs', input, { CLAUDE_PROJECT_DIR: dir }).status, 0);
    const lines = readFileSync(join(dir, '.claude', 'dev-team', 'activity.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).agent_type, 'verifier');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hook 實跑：輸入壞掉也 exit 0', () => {
  assert.equal(runHook('log-agent-activity.mjs', '{bad').status, 0);
});
