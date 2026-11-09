// 驗收測試鎖定（guard-locked-tests、check-locked-after-bash）、綠燈關卡（require-green-on-stop）與 gate.mjs 的測試。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { comparablePath, isEngineer, roleOf } from '../hooks/scripts/gate-state.mjs';
import { lockedTestDecision } from '../hooks/scripts/guard-locked-tests.mjs';
import { countProblem, parseCounts, reportsStuck, stopDecision, tail } from '../hooks/scripts/require-green-on-stop.mjs';
import { check, clear, lock } from '../hooks/scripts/gate.mjs';
import { postShellDecision, restoreLocked } from '../hooks/scripts/check-locked-after-bash.mjs';

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

test('gate.mjs：lock 建立備份，重新 lock 換掉舊備份，clear 一併清除', () => {
  withProject({}, (root) => {
    assert.ok(lock(root).ok);
    const dir = join(root, '.claude', 'dev-team', 'locked');
    const sha1 = JSON.parse(readFileSync(join(root, '.claude', 'dev-team', 'gate.json'), 'utf8')).lockedTests[0].sha256;
    assert.equal(readFileSync(join(dir, sha1), 'utf8'), readFileSync(join(root, TEST_FILE), 'utf8'));
    assert.equal(readFileSync(join(dir, 'gate.json'), 'utf8'), readFileSync(join(root, '.claude', 'dev-team', 'gate.json'), 'utf8'));

    writeFileSync(join(root, TEST_FILE), 'def test_x():\n    assert 2 == 3\n');
    assert.ok(lock(root).ok, 'test-engineer 經同意改測試後重新 lock');
    assert.ok(!existsSync(join(dir, sha1)), '舊版測試的備份要清掉');

    assert.ok(clear(root).ok);
    assert.ok(!existsSync(dir));
  });
});

test('gate.mjs：lock 後改了 gate.json 卻沒重跑 lock，check 會失敗', () => {
  withProject({}, (root) => {
    assert.ok(lock(root).ok);
    const file = join(root, '.claude', 'dev-team', 'gate.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('docs/specs/x', 'docs/specs/y'));
    const r = check(root);
    assert.equal(r.ok, false);
    assert.match(r.lines.join('\n'), /重跑 gate\.mjs lock/);
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

test('parseCounts 讀得懂 pytest / vitest / jest 的摘要行，跳過檔案數那行', () => {
  assert.deepEqual(parseCounts('....\n3 passed, 1 skipped in 0.12s'), { passed: 3, skipped: 1 });
  assert.deepEqual(parseCounts('===== 2 failed, 5 passed, 1 xfailed, 1 error in 1.0s ====='), { failed: 2, passed: 5, xfailed: 1, error: 1 });
  assert.deepEqual(parseCounts('1 deselected in 0.00s'), { deselected: 1 });
  assert.deepEqual(
    parseCounts(' Test Files  1 passed (1)\n      Tests  2 passed | 1 skipped (3)\n   Start at  10:00:00'),
    { passed: 2, skipped: 1 },
  );
  assert.deepEqual(
    parseCounts('Test Suites: 1 passed, 1 total\nTests:       1 todo, 2 passed, 3 total\nTime: 1 s'),
    { todo: 1, passed: 2 },
  );
  assert.deepEqual(parseCounts('\x1b[32m4 passed\x1b[0m in 0.2s'), { passed: 4 });
  assert.equal(parseCounts('all good'), null);
});

test('countProblem：有 skip 類結果或通過數不足就有問題，解析不到回 unparsed', () => {
  assert.equal(countProblem('3 passed in 0.1s', 3), null);
  assert.equal(countProblem('5 passed in 0.1s', 3), null, '多了邊界測試沒關係');
  assert.equal(countProblem('3 passed in 0.1s', undefined), null, '沒設定數量只檢查 skip');
  assert.equal(countProblem('1 skipped in 0.0s', 1)?.kind, 'not-run');
  assert.equal(countProblem('2 passed, 1 xpassed', 2)?.kind, 'not-run');
  assert.equal(countProblem('2 passed in 0.1s', 3)?.kind, 'count');
  assert.deepEqual(countProblem('', 3), { unparsed: true });
});

test('綠燈關卡：exit 0 但測試被 skip（例如新增 conftest.py）→ 擋下並說明', () => {
  withProject({ ...CMDS, acceptanceCounts: { 'backend-engineer': 1 } }, (root, env) => {
    const skipped = () => ({ ok: true, status: 0, output: 's\n1 skipped in 0.01s' });
    const d = stopDecision(stop('backend-engineer'), env, skipped);
    assert.equal(d?.decision, 'block');
    assert.match(d.reason, /沒有真的執行（1 skipped）/);
    assert.match(d.reason, /conftest\.py/);
    const log = readFileSync(join(root, '.claude', 'dev-team', 'activity.jsonl'), 'utf8');
    assert.match(log, /"result":"fail-blocked".*"kind":"not-run"/);
  });
});

test('綠燈關卡：通過數少於 acceptanceCounts → 擋下；解析不到摘要 → 放行但記 pass-unparsed', () => {
  withProject({ ...CMDS, acceptanceCounts: { 'backend-engineer': 3 } }, (root, env) => {
    const few = () => ({ ok: true, status: 0, output: '2 passed in 0.1s' });
    assert.match(stopDecision(stop('backend-engineer', undefined, 'e-a'), env, few)?.reason ?? '', /只通過 2 個，少於 RED 時的 3 個/);
    const silent = () => ({ ok: true, status: 0, output: '' });
    assert.equal(stopDecision(stop('backend-engineer', undefined, 'e-b'), env, silent), null);
    const log = readFileSync(join(root, '.claude', 'dev-team', 'activity.jsonl'), 'utf8');
    assert.match(log, /"result":"pass-unparsed"/);
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

// --- check-locked-after-bash ---

const shell = (agent_type, agent_id = 'eng-1') =>
  ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', agent_type, agent_id, tool_input: { command: "sed -i 's/2/1/' x" } });
const ORIGINAL = 'def test_x():\n    assert 1 == 2\n';

test('工程師用指令改了鎖定測試 → 還原、回饋 block、記錄 LockCheck', () => {
  withProject({}, (root, env) => {
    assert.ok(lock(root).ok);
    writeFileSync(join(root, TEST_FILE), 'def test_x():\n    assert True\n');
    const d = postShellDecision(shell('dev-team:backend-engineer'), env);
    assert.equal(d?.decision, 'block');
    assert.match(d.reason, /已被修改，已還原/);
    assert.match(d.reason, /不要再嘗試修改/);
    assert.equal(readFileSync(join(root, TEST_FILE), 'utf8'), ORIGINAL);
    assert.ok(check(root).ok, '還原後 check 要通過');
    const log = readFileSync(join(root, '.claude', 'dev-team', 'activity.jsonl'), 'utf8');
    assert.match(log, /"event":"LockCheck".*"result":"restored"/);
  });
});

test('刪掉鎖定測試或 gate.json 也會還原', () => {
  withProject({}, (root, env) => {
    assert.ok(lock(root).ok);
    const gateFile = join(root, '.claude', 'dev-team', 'gate.json');
    const gateText = readFileSync(gateFile, 'utf8');
    rmSync(join(root, TEST_FILE));
    rmSync(gateFile);
    const d = postShellDecision(shell('frontend-engineer'), env);
    assert.equal(d?.decision, 'block');
    assert.match(d.reason, /gate\.json（已被刪除，已還原）/);
    assert.match(d.reason, /已被刪除，已還原/);
    assert.equal(readFileSync(join(root, TEST_FILE), 'utf8'), ORIGINAL);
    assert.equal(readFileSync(gateFile, 'utf8'), gateText);
  });
});

test('沒被動過、不是工程師、還沒 lock → 不做事也不還原', () => {
  withProject({}, (root, env) => {
    assert.equal(postShellDecision(shell('backend-engineer'), env), null, '還沒 lock 沒有基準');
    assert.ok(lock(root).ok);
    assert.equal(postShellDecision(shell('backend-engineer'), env), null, '沒被動過');

    writeFileSync(join(root, TEST_FILE), 'changed by test-engineer');
    for (const t of ['dev-team:test-engineer', undefined]) {
      assert.equal(postShellDecision(shell(t), env), null, String(t));
    }
    assert.equal(readFileSync(join(root, TEST_FILE), 'utf8'), 'changed by test-engineer', 'test-engineer 與主 session 不還原');
  });
});

test('鎖定測試被換成 symlink：先移掉連結再還原，不寫穿到連結指向的產品程式碼', (t) => {
  withProject({}, (root, env) => {
    assert.ok(lock(root).ok);
    const product = join(root, 'backend', 'app.py');
    writeFileSync(product, 'PRODUCT = 1\n');
    rmSync(join(root, TEST_FILE));
    try {
      symlinkSync(product, join(root, TEST_FILE));
    } catch {
      t.skip('這台機器不能建立 symlink（Windows 需要開發人員模式）');
      return;
    }
    assert.match(check(root).lines.join('\n'), /已被換成連結或目錄/);
    const d = postShellDecision(shell('backend-engineer'), env);
    assert.match(d?.reason ?? '', /已被換成連結或目錄，已還原/);
    assert.ok(!lstatSync(join(root, TEST_FILE)).isSymbolicLink());
    assert.equal(readFileSync(join(root, TEST_FILE), 'utf8'), ORIGINAL);
    assert.equal(readFileSync(product, 'utf8'), 'PRODUCT = 1\n', '產品程式碼不能被覆寫');
  });
});

test('restoreLocked 找不到備份時照實回報，不假裝已還原', () => {
  withProject({}, (root) => {
    assert.ok(lock(root).ok);
    const sha = JSON.parse(readFileSync(join(root, '.claude', 'dev-team', 'gate.json'), 'utf8')).lockedTests[0].sha256;
    rmSync(join(root, '.claude', 'dev-team', 'locked', sha));
    writeFileSync(join(root, TEST_FILE), 'changed');
    assert.deepEqual(restoreLocked(root), [`${TEST_FILE}（已被修改，找不到備份，沒有還原）`]);
  });
});

test('hook 實跑：工程師改了測試輸出 block 並還原；壞掉的輸入不做事', () => {
  withProject({}, (root, env) => {
    assert.ok(lock(root).ok);
    writeFileSync(join(root, TEST_FILE), 'changed');
    const r = runHook('check-locked-after-bash.mjs', shell('dev-team:backend-engineer'), env);
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).decision, 'block');
    assert.equal(readFileSync(join(root, TEST_FILE), 'utf8'), ORIGINAL);
    const bad = spawnSync(process.execPath, [join(SCRIPTS, 'check-locked-after-bash.mjs')], { input: 'nope', encoding: 'utf8', env: { ...process.env, ...env } });
    assert.equal(bad.status, 0);
    assert.equal(bad.stdout.trim(), '');
  });
});
