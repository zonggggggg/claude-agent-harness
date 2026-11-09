// Hook 情境測試：照 hooks.json 的設定實際執行 hook（matcher、${CLAUDE_PLUGIN_ROOT} 展開、用 bash 執行指令），
// 模擬 Claude Code 呼叫 hook 的方式，並用真的 shell 指令嘗試繞過驗收測試鎖定。
// 執行：npm run test:e2e（需要 bash；Windows 請在 Git Bash 執行。有 python + pytest 時會多跑 pytest 情境）
// 這支不在 npm test 裡，因為它依賴 bash、sed 等外部指令。
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
const GATE = join(PLUGIN, 'hooks', 'scripts', 'gate.mjs');
const hooks = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks;
const results = [];
const record = (name, pass, detail = '') => results.push({ name, pass: pass === null ? null : !!pass, detail });

const sh = (cmd, cwd) => spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
if (sh('true').status !== 0) {
  console.log('SKIP  找不到 bash，略過 hook 情境測試（Windows 請在 Git Bash 執行）');
  process.exit(0);
}
const PYTHON = ['python3', 'python'].find((p) => sh(`${p} -c "import sys; sys.exit(0)"`).status === 0) ?? null;
const HAS_PYTEST = PYTHON !== null && sh(`${PYTHON} -m pytest --version`).status === 0;

// 依 hooks.json 觸發某個事件，回傳每個 hook 的結果
function fire(root, event, input) {
  const target = event.startsWith('Subagent') ? input.agent_type : input.tool_name;
  const outs = [];
  for (const group of hooks[event] ?? []) {
    if (group.matcher && !new RegExp(`^(?:${group.matcher})$`).test(target ?? '')) continue;
    for (const h of group.hooks) {
      const t0 = Date.now();
      const r = spawnSync('bash', ['-c', h.command], {
        input: JSON.stringify({ hook_event_name: event, session_id: 'e2e', cwd: root, ...input }),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PROJECT_DIR: root },
        timeout: h.timeout * 1000,
      });
      outs.push({ status: r.status, ms: Date.now() - t0, out: r.stdout.trim() ? JSON.parse(r.stdout) : null });
    }
  }
  return outs;
}

const TEST = 'backend/tests/acceptance/test_filter.py';
const ORIG = 'from app.filter import filter_orders\n\n\ndef test_paid():\n    assert filter_orders("paid") == [1, 3]\n';
const PRODUCT = 'backend/app/filter.py';

function project(gateExtra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dev-team-e2e-'));
  mkdirSync(join(root, 'backend', 'tests', 'acceptance'), { recursive: true });
  mkdirSync(join(root, 'backend', 'app'), { recursive: true });
  writeFileSync(join(root, 'backend', 'app', '__init__.py'), '');
  writeFileSync(join(root, TEST), ORIG);
  writeFileSync(join(root, PRODUCT), 'def filter_orders(status):\n    return []\n');
  mkdirSync(join(root, '.claude', 'dev-team'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'dev-team', 'gate.json'),
    JSON.stringify({ workdir: 'docs/specs/e2e', lockedTests: [TEST], maxStopBlocks: 2, ...gateExtra }, null, 2),
  );
  const r = spawnSync(process.execPath, [GATE, 'lock', '--root', root], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gate.mjs lock 失敗：${r.stdout}${r.stderr}`);
  return root;
}
const read = (root, p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null);
const gateCheckOk = (root) => spawnSync(process.execPath, [GATE, 'check', '--root', root], { encoding: 'utf8' }).status === 0;
const blocked = (outs) => outs.some((o) => o.out?.decision === 'block');
const engineerBash = (root, command, agent_type = 'dev-team:backend-engineer') =>
  fire(root, 'PostToolUse', { tool_name: 'Bash', agent_type, agent_id: 'e1', tool_input: { command }, tool_response: {} });

// 1. 工程師用 Edit 改鎖定測試 → 事前 deny
{
  const root = project();
  const outs = fire(root, 'PreToolUse', { tool_name: 'Edit', agent_type: 'dev-team:backend-engineer', tool_input: { file_path: join(root, TEST) } });
  record('Edit 鎖定測試被 deny', outs.some((o) => o.out?.hookSpecificOutput?.permissionDecision === 'deny'));
  rmSync(root, { recursive: true, force: true });
}

// 2. 用各種指令改檔 → 事後還原，產品程式碼不受影響
const attacks = {
  'sed -i': `sed -i 's/\\[1, 3\\]/[]/' ${TEST}`,
  'echo 覆寫': `echo 'def test_paid(): pass' > ${TEST}`,
  'echo 附加 skip': `echo 'import pytest; pytestmark = pytest.mark.skip' >> ${TEST}`,
  'node 寫入': `node -e "require('fs').writeFileSync('${TEST}','x')"`,
  ...(PYTHON ? { 'python 寫入': `${PYTHON} -c "open('${TEST}','w').write('x')"` } : {}),
  'rm 刪除': `rm ${TEST}`,
  'mv 搬走': `mv ${TEST} ../moved_test.py`,
  '整個目錄改名': 'mv backend/tests/acceptance backend/tests/acceptance_old',
  '清空檔案': `: > ${TEST}`,
  'cp 蓋掉': `cp ${PRODUCT} ${TEST}`,
  '換成 symlink': `rm ${TEST} && ln -s ../../app/filter.py ${TEST}`,
  'sed 拿掉 gate.json 的鎖': `sed -i 's#${TEST}#nothing.py#' .claude/dev-team/gate.json`,
  '刪掉 gate.json': 'rm .claude/dev-team/gate.json',
};
for (const [name, cmd] of Object.entries(attacks)) {
  const root = project();
  const gateBefore = read(root, '.claude/dev-team/gate.json');
  const productBefore = read(root, PRODUCT);
  sh(cmd, root);
  const outs = engineerBash(root, cmd);
  const isLink = existsSync(join(root, TEST)) && lstatSync(join(root, TEST)).isSymbolicLink();
  const restored = read(root, TEST) === ORIG && !isLink && read(root, '.claude/dev-team/gate.json') === gateBefore;
  const productOk = read(root, PRODUCT) === productBefore;
  const checkOk = gateCheckOk(root);
  record(`指令改檔還原：${name}`, blocked(outs) && restored && productOk && checkOk,
    `block=${blocked(outs)} 還原=${restored} 產品程式碼未受影響=${productOk} gate.check=${checkOk}`);
  rmSync(root, { recursive: true, force: true });
}

// 3. 不該還原或不該觸發的情況
{
  const root = project();
  writeFileSync(join(root, TEST), 'changed by test-engineer');
  const a = engineerBash(root, 'true', 'dev-team:test-engineer');
  const b = fire(root, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'true' } });
  record('test-engineer 與主 session 改測試不還原', !a.some((o) => o.out) && !b.some((o) => o.out) && read(root, TEST) === 'changed by test-engineer');
  const c = fire(root, 'PostToolUse', { tool_name: 'PowerShell', agent_type: 'frontend-engineer', tool_input: {} });
  record('PowerShell 也會觸發還原', blocked(c) && read(root, TEST) === ORIG);
  record('Read 等非 shell 工具不觸發', fire(root, 'PostToolUse', { tool_name: 'Read', agent_type: 'frontend-engineer', tool_input: {} }).length === 0);
  rmSync(root, { recursive: true, force: true });
}

// 4. 綠燈關卡完整一輪（不依賴 pytest）
{
  const node = JSON.stringify(process.execPath);
  const cmd = `${node} -e "const s=require('fs').readFileSync('${PRODUCT}','utf8');console.log(s.includes('[1, 3]')?'1 passed':'1 failed');process.exit(s.includes('[1, 3]')?0:1)"`;
  const root = project({ acceptanceCommands: { 'backend-engineer': cmd }, acceptanceCounts: { 'backend-engineer': 1 } });
  const stop = () => fire(root, 'SubagentStop', { agent_type: 'dev-team:backend-engineer', agent_id: 'e1', last_assistant_message: '1. 狀態：`DONE`' });
  record('綠燈關卡：紅燈時擋下', blocked(stop()));
  writeFileSync(join(root, PRODUCT), 'def filter_orders(status):\n    return [1, 3]\n');
  record('綠燈關卡：修好後放行', !blocked(stop()));
  const log = read(root, '.claude/dev-team/activity.jsonl') ?? '';
  record('activity.jsonl 有 SubagentStop 與 StopGate 紀錄', /"event":"SubagentStop"/.test(log) && /"result":"pass"/.test(log));
  spawnSync(process.execPath, [GATE, 'clear', '--root', root]);
  record('clear 後沒有 gate.json 與備份', !existsSync(join(root, '.claude/dev-team/gate.json')) && !existsSync(join(root, '.claude/dev-team/locked')));
  record('clear 後 hook 不做事', !engineerBash(root, 'true').some((o) => o.out));
  rmSync(root, { recursive: true, force: true });
}

// 5. 真的 pytest：用 conftest.py / pytest.ini 讓驗收測試被略過
if (HAS_PYTEST) {
  const cmd = `cd backend && ${PYTHON} -m pytest -q tests/acceptance/test_filter.py -p no:cacheprovider`;
  const gate = { acceptanceCommands: { 'backend-engineer': cmd }, acceptanceCounts: { 'backend-engineer': 1 } };
  const stop = (root, id) => fire(root, 'SubagentStop', { agent_type: 'dev-team:backend-engineer', agent_id: id, last_assistant_message: '1. 狀態：`DONE`' });
  const cases = {
    '新增 conftest.py 把測試全部 skip': (root) => writeFileSync(join(root, 'backend/tests/conftest.py'),
      'import pytest\n\n\ndef pytest_collection_modifyitems(items):\n    for item in items:\n        item.add_marker(pytest.mark.skip(reason="flaky"))\n'),
    '新增 conftest.py 標成 xfail': (root) => writeFileSync(join(root, 'backend/tests/conftest.py'),
      'import pytest\n\n\ndef pytest_collection_modifyitems(items):\n    for item in items:\n        item.add_marker(pytest.mark.xfail(reason="wip"))\n'),
    'pytest.ini 把測試濾掉': (root) => writeFileSync(join(root, 'backend/pytest.ini'), '[pytest]\naddopts = -k "not paid"\n'),
  };
  for (const [name, cheat] of Object.entries(cases)) {
    const root = project(gate);
    cheat(root);
    record(`pytest 繞過：${name} → 擋下`, blocked(stop(root, name)));
    rmSync(root, { recursive: true, force: true });
  }
  const root = project(gate);
  writeFileSync(join(root, PRODUCT), 'def filter_orders(status):\n    return [1, 3]\n');
  record('pytest 真的綠燈 → 放行', !blocked(stop(root, 'ok')));
  rmSync(root, { recursive: true, force: true });
} else {
  record('pytest 情境', null, '沒有 python 或 pytest，略過');
}

// 6. 延遲
{
  const root = project();
  const median = (input) => {
    const ms = Array.from({ length: 9 }, () => fire(root, 'PostToolUse', input)[0].ms).sort((a, b) => a - b);
    return ms[4];
  };
  const main = median({ tool_name: 'Bash', tool_input: {} });
  const eng = median({ tool_name: 'Bash', agent_type: 'backend-engineer', tool_input: {} });
  record('每次 Bash 增加的延遲 < 500ms', main < 500 && eng < 500, `主 session ${main}ms、工程師 ${eng}ms`);
  rmSync(root, { recursive: true, force: true });
}

for (const r of results) console.log(`${r.pass === null ? 'SKIP' : r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
const failed = results.filter((r) => r.pass === false).length;
console.log(`\n${results.filter((r) => r.pass).length} passed, ${failed} failed, ${results.filter((r) => r.pass === null).length} skipped`);
process.exit(failed ? 1 : 0);
