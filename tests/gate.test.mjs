// 驗收測試鎖定（guard-locked-tests）、綠燈關卡（require-green-on-stop）與 gate.mjs 的測試。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { comparablePath, isEngineer, roleOf } from '../hooks/scripts/gate-state.mjs';
import { lockedTestDecision } from '../hooks/scripts/guard-locked-tests.mjs';
import { reportsStuck, stopDecision, tail } from '../hooks/scripts/require-green-on-stop.mjs';
import { check, clear, lock } from '../hooks/scripts/gate.mjs';

const SCRIPTS = fileURLToPath(new URL('../hooks/scripts/', import.meta.url));
const TEST_FILE = 'backend/tests/acceptance/test_filter.py';

function makeProject(gate = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dev-team-gate-'));
  mkdirSync(join(root, 'backend', 'tests', 'acceptance'), { recursive: true });
  writeFileSync(join(root, TEST_FILE), 'def test_x():\n    assert 1 == 2\n');
  mkdirSync(join(root, '.claude', 'dev-team'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'dev-team', 'gate.json'),
    JSON.stringify({ workdir: 'docs/specs/x', lockedTests: [TEST_FILE], ...gate }),
  );
  return root;
}

function withProject(gate, fn) {
  const root = makeProject(gate);
  try {
    return fn(root, { CLAUDE_PROJECT_DIR: root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runHook(script, input, env) {
  return spawnSync(process.execPath, [join(SCRIPTS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const edit = (agent_type, file_path) => ({ hook_event_name: 'PreToolUse', tool_name: 'Edit', agent_type, tool_input: { file_path } });

// --- gate-state ---

test('roleOf 去掉 plugin 前綴；只有前後端工程師算 engineer', () => {
  assert.equal(roleOf('dev-team:backend-engineer'), 'backend-engineer');
  assert.equal(roleOf('frontend-engineer'), 'frontend-engineer');
  assert.ok(isEngineer('dev-team:backend-engineer'));
  assert.ok(isEngineer('frontend-engineer'));
  for (const t of ['dev-team:test-engineer', 'verifier', undefined, null]) assert.ok(!isEngineer(t), String(t));
});

test('comparablePath 統一斜線與大小寫，相對路徑以專案根目錄展開', () => {
  assert.equal(comparablePath('D:\\proj', 'D:\\Proj\\Backend\\a.py'), 'd:/proj/backend/a.py');
  assert.equal(comparablePath('/proj', 'backend/a.py'), '/proj/backend/a.py');
  assert.equal(comparablePath('/proj', '/proj/backend/a.py'), comparablePath('/proj', 'backend/a.py'));
});

// --- guard-locked-tests ---

test('工程師改鎖定的驗收測試 → deny（相對與絕對路徑、含 plugin 前綴）', () => {
  withProject({}, (root, env) => {
    for (const p of [TEST_FILE, join(root, TEST_FILE)]) {
      const d = lockedTestDecision(edit('dev-team:backend-engineer', p), env);
      assert.equal(d?.hookSpecificOutput.permissionDecision, 'deny', p);
      assert.match(d.hookSpecificOutput.permissionDecisionReason, /不要改用 Bash/);
    }
    assert.ok(lockedTestDecision(edit('frontend-engineer', TEST_FILE), env));
  });
});

test('test-engineer、主 session、沒鎖的檔案都放行', () => {
  withProject({}, (_root, env) => {
    assert.equal(lockedTestDecision(edit('dev-team:test-engineer', TEST_FILE), env), null);
    assert.equal(lockedTestDecision(edit(undefined, TEST_FILE), env), null);
    assert.equal(lockedTestDecision(edit('backend-engineer', 'backend/app/filter.py'), env), null);
  });
});

test('沒有 gate.json 時不擋測試檔，但工程師仍不能寫 .claude/dev-team/', () => {
  const root = mkdtempSync(join(tmpdir(), 'dev-team-gate-'));
  try {
    const env = { CLAUDE_PROJECT_DIR: root };
    assert.equal(lockedTestDecision(edit('backend-engineer', TEST_FILE), env), null);
    const d = lockedTestDecision(edit('backend-engineer', '.claude/dev-team/gate.json'), env);
    assert.equal(d?.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(lockedTestDecision(edit('test-engineer', '.claude/dev-team/gate.json'), env), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hook 實跑：工程師寫鎖定測試輸出 deny；壞掉的輸入不擋', () => {
  withProject({}, (_root, env) => {
    const r = runHook('guard-locked-tests.mjs', { ...edit('dev-team:backend-engineer', TEST_FILE), tool_name: 'Write' }, env);
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
    const bad = spawnSync(process.execPath, [join(SCRIPTS, 'guard-locked-tests.mjs')], { input: 'nope', encoding: 'utf8', env: { ...process.env, ...env } });
    assert.equal(bad.status, 0);
    assert.equal(bad.stdout.trim(), '');
  });
});

// --- gate.mjs ---

test('gate.mjs：lock 寫入 sha256，check 抓得到修改與刪除，clear 清掉狀態', () => {
  withProject({}, (root) => {
    assert.equal(check(root).ok, false, '還沒 lock 應該失敗');
    const locked = lock(root);
    assert.ok(locked.ok, locked.lines.join('\n'));
    const gate = JSON.parse(readFileSync(join(root, '.claude', 'dev-team', 'gate.json'), 'utf8'));
    assert.match(gate.lockedTests[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(gate.workdir, 'docs/specs/x', 'lock 不能弄丟其他欄位');

    assert.ok(check(root).ok);
    writeFileSync(join(root, TEST_FILE), 'def test_x():\n    assert True\n');
    const changed = check(root);
    assert.equal(changed.ok, false);
    assert.match(changed.lines.join('\n'), /已被修改/);
    rmSync(join(root, TEST_FILE));
    assert.match(check(root).lines.join('\n'), /已被刪除/);

    writeFileSync(join(root, '.claude', 'dev-team', 'stop-guard.json'), '{}');
    assert.ok(clear(root).ok);
    assert.ok(!existsSync(join(root, '.claude', 'dev-team', 'gate.json')));
    assert.ok(!existsSync(join(root, '.claude', 'dev-team', 'stop-guard.json')));
  });
});

test('gate.mjs：lock 遇到不存在的測試檔就失敗，不寫入', () => {
  withProject({ lockedTests: ['nope/test_missing.py'] }, (root) => {
    const r = lock(root);
    assert.equal(r.ok, false);
    assert.match(r.lines.join('\n'), /找不到驗收測試檔/);
  });
});

test('gate.mjs 實跑：check 有變更時 exit 1，未知指令 exit 2', () => {
  withProject({}, (root) => {
    const run = (...args) => spawnSync(process.execPath, [join(SCRIPTS, 'gate.mjs'), ...args, '--root', root], { encoding: 'utf8' });
    assert.equal(run('lock').status, 0);
    assert.equal(run('check').status, 0);
    writeFileSync(join(root, TEST_FILE), 'changed');
    assert.equal(run('check').status, 1);
    assert.equal(run('oops').status, 2);
  });
});

// --- require-green-on-stop ---

const stop = (agent_type, message = '1. 狀態：`DONE`', agent_id = 'eng-1') =>
  ({ hook_event_name: 'SubagentStop', agent_type, agent_id, last_assistant_message: message });
const CMDS = { acceptanceCommands: { 'backend-engineer': 'pytest -q backend/tests/acceptance' } };
const green = () => ({ ok: true, status: 0, output: '1 passed' });
const red = () => ({ ok: false, status: 1, output: 'FAILED test_x - assert 1 == 2' });

test('reportsStuck 只看回報開頭的 BLOCKED / NEEDS_CONTEXT', () => {
  assert.ok(reportsStuck('1. 狀態：`BLOCKED`\n2. ...'));
  assert.ok(reportsStuck('\n狀態：NEEDS_CONTEXT'));
  assert.ok(!reportsStuck('1. 狀態：`DONE_WITH_CONCERNS`'));
  assert.ok(!reportsStuck('1. DONE\n2. a\n3. b\n4. 之前曾經 BLOCKED'));
  assert.ok(!reportsStuck(undefined));
});

test('tail 只留最後幾行', () => {
  assert.equal(tail('a\nb\nc\n', 2), 'b\nc');
});

test('綠燈放行並記錄 StopGate pass', () => {
  withProject(CMDS, (root, env) => {
    assert.equal(stopDecision(stop('dev-team:backend-engineer'), env, green), null);
    const log = readFileSync(join(root, '.claude', 'dev-team', 'activity.jsonl'), 'utf8');
    assert.match(log, /"event":"StopGate".*"result":"pass"/);
  });
});

test('紅燈擋下並附測試輸出；擋滿 3 次後放行並記錄 fail-released', () => {
  withProject(CMDS, (root, env) => {
    for (let i = 1; i <= 3; i += 1) {
      const d = stopDecision(stop('backend-engineer'), env, red);
      assert.equal(d?.decision, 'block', `第 ${i} 次應擋下`);
      assert.match(d.reason, new RegExp(`第 ${i} / 3 次`));
      assert.match(d.reason, /assert 1 == 2/);
      if (i === 3) assert.match(d.reason, /最後一次擋下/);
    }
    assert.equal(stopDecision(stop('backend-engineer'), env, red), null, '第 4 次要放行');
    const log = readFileSync(join(root, '.claude', 'dev-team', 'activity.jsonl'), 'utf8');
    assert.match(log, /"result":"fail-released"/);

    assert.equal(stopDecision(stop('backend-engineer', undefined, 'eng-2'), env, red)?.decision, 'block', '新派的工程師重新計數');
  });
});

test('maxStopBlocks 可以在 gate.json 調整', () => {
  withProject({ ...CMDS, maxStopBlocks: 1 }, (_root, env) => {
    assert.equal(stopDecision(stop('backend-engineer'), env, red)?.decision, 'block');
    assert.equal(stopDecision(stop('backend-engineer'), env, red), null);
  });
});

test('不跑測試的情況：回報 BLOCKED、不是工程師、沒有該角色指令、沒有 gate.json', () => {
  const boom = () => { throw new Error('不應該執行測試'); };
  withProject(CMDS, (_root, env) => {
    assert.equal(stopDecision(stop('backend-engineer', '1. 狀態：`BLOCKED`'), env, boom), null);
    assert.equal(stopDecision(stop('dev-team:test-engineer'), env, boom), null);
    assert.equal(stopDecision(stop('frontend-engineer'), env, boom), null);
  });
  const empty = mkdtempSync(join(tmpdir(), 'dev-team-gate-'));
  try {
    assert.equal(stopDecision(stop('backend-engineer'), { CLAUDE_PROJECT_DIR: empty }, boom), null);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('hook 實跑：指令失敗輸出 block，指令成功沒有輸出', () => {
  const node = JSON.stringify(process.execPath);
  withProject({ acceptanceCommands: { 'backend-engineer': `${node} -e "console.log('boom');process.exit(1)"` } }, (_root, env) => {
    const r = runHook('require-green-on-stop.mjs', stop('dev-team:backend-engineer'), env);
    assert.equal(r.status, 0);
    const d = JSON.parse(r.stdout);
    assert.equal(d.decision, 'block');
    assert.match(d.reason, /boom/);
  });
  withProject({ acceptanceCommands: { 'backend-engineer': `${node} -e "process.exit(0)"` } }, (_root, env) => {
    const r = runHook('require-green-on-stop.mjs', stop('backend-engineer'), env);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });
});
