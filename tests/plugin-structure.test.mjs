// 檢查 plugin 結構：agent / skill frontmatter 合法、名稱唯一、
// skill 提到的角色都存在、hooks.json 指到的腳本都存在。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const KNOWN_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Bash', 'PowerShell',
  'WebFetch', 'WebSearch', 'NotebookEdit', 'Agent', 'Skill', 'TodoWrite',
]);
const KNOWN_MODELS = new Set(['inherit', 'opus', 'sonnet', 'haiku', 'fable']);

function frontmatter(file) {
  const text = readFileSync(file, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  assert.ok(m, `${file} 缺少 frontmatter`);
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
  }
  return { fields, body: m[2] };
}

const agentFiles = readdirSync(join(ROOT, 'agents')).filter((f) => f.endsWith('.md'));
const agents = agentFiles.map((f) => ({ file: f, ...frontmatter(join(ROOT, 'agents', f)) }));
const agentNames = new Set(agents.map((a) => a.fields.name));

test('至少有核心角色', () => {
  for (const role of ['requirements-analyst', 'architect', 'backend-engineer', 'frontend-engineer',
    'test-engineer', 'code-reviewer', 'security-reviewer', 'verifier']) {
    assert.ok(agentNames.has(role), `缺少 ${role}`);
  }
});

test('每個 agent 都有 name / description，且 name 與檔名一致', () => {
  for (const a of agents) {
    assert.ok(a.fields.name, `${a.file} 缺 name`);
    assert.ok(a.fields.description?.length > 20, `${a.file} description 太短`);
    assert.equal(`${a.fields.name}.md`, a.file);
    assert.ok(a.body.trim().length > 200, `${a.file} system prompt 太短`);
  }
  assert.equal(agentNames.size, agents.length, 'agent name 重複');
});

test('tools / model 只用已知值', () => {
  for (const a of agents) {
    for (const key of ['tools', 'disallowedTools']) {
      if (!a.fields[key]) continue;
      for (const t of a.fields[key].split(',').map((s) => s.trim())) {
        assert.ok(KNOWN_TOOLS.has(t), `${a.file} ${key} 有未知工具 ${t}`);
      }
    }
    if (a.fields.model) assert.ok(KNOWN_MODELS.has(a.fields.model), `${a.file} model 未知`);
  }
});

test('每個角色都明確指定模型，不用 inherit', () => {
  const expected = {
    'requirements-analyst': 'opus',
    architect: 'opus',
    'backend-engineer': 'opus',
    'frontend-engineer': 'opus',
    'code-reviewer': 'opus',
    'security-reviewer': 'opus',
    verifier: 'opus',
    'test-engineer': 'opus',
    'staged-change-reviewer': 'sonnet',
  };
  for (const a of agents) {
    assert.ok(a.fields.model && a.fields.model !== 'inherit', `${a.file} 沒有明確指定 model`);
    if (expected[a.fields.name]) assert.equal(a.fields.model, expected[a.fields.name], `${a.file} model 不符`);
  }
});

test('reviewer 與 verifier 是唯讀（沒有 Write / Edit）', () => {
  for (const a of agents.filter((x) => /reviewer|verifier/.test(x.fields.name))) {
    const tools = (a.fields.tools ?? '').split(',').map((s) => s.trim());
    assert.ok(a.fields.tools, `${a.file} 必須明確列出 tools`);
    assert.ok(!tools.includes('Write') && !tools.includes('Edit'), `${a.file} 不應有寫入權限`);
  }
});

test('skills 有合法 frontmatter，且提到的角色都存在', () => {
  for (const dir of readdirSync(join(ROOT, 'skills'))) {
    const { fields, body } = frontmatter(join(ROOT, 'skills', dir, 'SKILL.md'));
    assert.equal(fields.name, dir);
    assert.ok(fields.description);
    for (const [, name] of body.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)) {
      if (/(engineer|reviewer|analyst)$/.test(name)) assert.ok(agentNames.has(name), `${dir} 引用了不存在的 ${name}`);
    }
  }
  assert.ok(existsSync(join(ROOT, 'skills', 'feature', 'templates', 'spec.md')));
  assert.ok(existsSync(join(ROOT, 'skills', 'feature', 'templates', 'design.md')));
});

test('feature 流程是測試先行：紅燈測試階段排在實作階段之前', () => {
  const { body } = frontmatter(join(ROOT, 'skills', 'feature', 'SKILL.md'));
  const stages = [...body.matchAll(/^### 階段 (\d+)：(.+)$/gm)].map(([, n, title]) => ({ n: Number(n), title }));
  const red = stages.find((s) => s.title.includes('紅燈'));
  const impl = stages.find((s) => s.title.startsWith('實作'));
  assert.ok(red, '缺少紅燈測試階段');
  assert.ok(impl, '缺少實作階段');
  assert.ok(red.n < impl.n, `紅燈測試（階段 ${red.n}）必須在實作（階段 ${impl.n}）之前`);
  assert.deepEqual(stages.map((s) => s.n), stages.map((_, i) => i), '階段編號要從 0 連續');
  assert.match(body, /## Bug 修復模式/);
});

test('test-engineer 有 RED 與 VERIFY 兩種模式', () => {
  const { fields, body } = agents.find((a) => a.fields.name === 'test-engineer');
  assert.match(fields.description, /RED/);
  assert.match(body, /## RED 模式/);
  assert.match(body, /## VERIFY 模式/);
});

test('工程師角色要求 TDD、回報紅燈 / 綠燈證據、不可改驗收測試', () => {
  for (const name of ['backend-engineer', 'frontend-engineer']) {
    const { body } = agents.find((a) => a.fields.name === name);
    assert.match(body, /## 測試先行（TDD）/, `${name} 缺少 TDD 段落`);
    assert.match(body, /\*\*RED 證據\*\*/, `${name} 回報缺 RED 證據`);
    assert.match(body, /\*\*GREEN 證據\*\*/, `${name} 回報缺 GREEN 證據`);
    assert.match(body, /不修改 test-engineer 寫的驗收測試/, `${name} 缺少驗收測試鎖定紅線`);
  }
});

test('design 範本的第一個任務是 TEST，實作任務依賴它', () => {
  const text = readFileSync(join(ROOT, 'skills', 'feature', 'templates', 'design.md'), 'utf8');
  const rows = [...text.matchAll(/^\| \[ \] \| (T\d+)[^|]*\| (\w+) \|[^|]*\| ([^|]*) \|$/gm)]
    .map(([, id, role, deps]) => ({ id, role, deps }));
  assert.ok(rows.length >= 2, '任務清單解析不到');
  assert.equal(rows[0].role, 'TEST');
  for (const r of rows.filter((x) => x.role === 'BE' || x.role === 'FE')) {
    assert.ok(r.deps.includes(rows[0].id), `${r.id} 沒有依賴 ${rows[0].id}`);
  }
});

test('feature 流程用 progress.md 記錄進度，且輪數上限與範本一致', () => {
  const { body } = frontmatter(join(ROOT, 'skills', 'feature', 'SKILL.md'));
  const template = readFileSync(join(ROOT, 'skills', 'feature', 'templates', 'progress.md'), 'utf8');
  assert.match(body, /\*\*進度檔 `progress\.md`\*\*/);
  assert.match(body, /\*\*接續既有工作\*\*/);
  assert.match(body, /\*\*先讀 `progress\.md`\*\*/);

  const section = (n) => body.split(/^### /m).find((s) => s.startsWith(`階段 ${n}：`)) ?? '';
  const cap = (text) => Number(text.match(/最多(?:來回)? (\d+) (?:輪|次)/)?.[1]);
  const templateCap = (label) => Number(template.match(new RegExp(`\\| ${label}[^|]*\\| 0 / (\\d+) \\|`))?.[1]);
  assert.equal(templateCap('需求釐清'), cap(section(1)));
  assert.equal(templateCap('測試驗證退回'), cap(section(5)));
  assert.equal(templateCap('Review 退回'), cap(section(6)));
});

test('hooks.json 指到的腳本都存在', () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const commands = Object.values(hooks).flat().flatMap((g) => g.hooks).map((h) => h.command);
  assert.ok(commands.length > 0);
  for (const cmd of commands) {
    const m = cmd.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/);
    assert.ok(m, `無法解析 ${cmd}`);
    assert.ok(existsSync(join(ROOT, m[1])), `找不到 ${m[1]}`);
  }
});

test('plugin.json 與 marketplace.json 名稱一致', () => {
  const plugin = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const market = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.ok(market.plugins.some((p) => p.name === plugin.name));
});
