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
    'test-engineer', 'code-reviewer', 'security-reviewer', 'verifier', 'ui-designer']) {
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
    'backend-engineer': 'sonnet',
    'frontend-engineer': 'sonnet',
    'code-reviewer': 'opus',
    'security-reviewer': 'opus',
    verifier: 'opus',
    'test-engineer': 'sonnet',
    'staged-change-reviewer': 'sonnet',
    'ui-designer': 'opus',
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
      if (/(engineer|reviewer|analyst|designer)$/.test(name)) assert.ok(agentNames.has(name), `${dir} 引用了不存在的 ${name}`);
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

test('輸入與錯誤處理在 spec / design 先定：範本有欄位，分析師與架構師要填', () => {
  const spec = readFileSync(join(ROOT, 'skills', 'feature', 'templates', 'spec.md'), 'utf8');
  const input = spec.split(/^## /m).find((s) => s.startsWith('輸入與錯誤處理')) ?? '';
  for (const item of ['前後空白、換行', '控制字元', '長度上限', '多個錯誤同時發生', '錯誤訊息原文']) {
    assert.ok(input.includes(item), `spec 範本「輸入與錯誤處理」缺少「${item}」`);
  }
  const design = readFileSync(join(ROOT, 'skills', 'feature', 'templates', 'design.md'), 'utf8');
  const order = design.split(/^## /m).find((s) => s.startsWith('輸入處理與驗證順序')) ?? '';
  for (const item of ['正規化步驟', '驗證順序', '錯誤碼與 spec 訊息的對應']) {
    assert.ok(order.includes(item), `design 範本「輸入處理與驗證順序」缺少「${item}」`);
  }
  const role = (name) => agents.find((a) => a.fields.name === name).body;
  assert.match(role('requirements-analyst'), /\*\*輸入與錯誤處理\*\*/);
  assert.match(role('architect'), /\*\*輸入處理與驗證順序\*\*/);
});

test('流程中途的待決策：登記、退給負責角色寫備忘、一次問完不限題數', () => {
  const { body } = frontmatter(join(ROOT, 'skills', 'feature', 'SKILL.md'));
  assert.match(body, /\*\*流程中途的待決策\*\*/);
  assert.match(body, /\*\*退給負責的角色研究，不要自己查\*\*/);
  assert.match(body, /`\[行為\]`.*→ `requirements-analyst`.*`\[技術\]`.*→ `architect`/);
  assert.match(body, /\*\*一次問完\*\*/);
  assert.match(body, /\*\*不限題數\*\*/);
  // 三種分類：有依據照做、只影響內部先裁決、影響使用者 / 契約 / 資料 / 鎖定測試一定問
  assert.match(body, /\*\*① 有依據\*\*/);
  assert.match(body, /\*\*② 沒依據，但明顯、只影響內部\*\*/);
  assert.match(body, /\*\*就算很明顯也要問使用者\*\*/);
  assert.match(body, /分不清是 ② 還是 ③ 就當 ③/);
  assert.match(body, /\*\*決定權永遠在使用者\*\*/);
  assert.match(body, /\*\*負責角色查完仍無法建議\*\*.*不限選擇題/);
  const stage = (n) => body.split(/^### /m).find((s) => s.startsWith(`階段 ${n}：`)) ?? '';
  assert.match(stage(4), /照「流程中途的待決策」處理/, '階段 4 遇到待決策要照規則處理');
  assert.match(stage(8), /② 類裁決/, '階段 8 要把先裁決的 ② 類列給使用者確認');

  const progress = readFileSync(join(ROOT, 'skills', 'feature', 'templates', 'progress.md'), 'utf8');
  assert.match(progress, /^## 待決策$/m, 'progress 範本缺少「待決策」');

  for (const name of ['requirements-analyst', 'architect']) {
    const memo = agents.find((a) => a.fields.name === name).body.split(/^## /m).find((s) => s.startsWith('決策備忘')) ?? '';
    assert.match(memo, /decisions\/<編號>-<slug>\.md/, `${name} 缺少決策備忘的檔案位置`);
    assert.match(memo, /選項 2–3 個/, `${name} 決策備忘缺少選項`);
    assert.match(memo, /`NEEDS_DECISION`/, `${name} 決策備忘缺少回報狀態`);
    assert.match(memo, /\*\*查完仍無法判斷就寫「無建議」\*\*/, `${name} 決策備忘沒有允許「無建議」`);
  }
  for (const name of ['backend-engineer', 'frontend-engineer', 'test-engineer', 'code-reviewer']) {
    assert.match(agents.find((a) => a.fields.name === name).body, /\*\*待決策\*\*.*`\[行為\]`.*`\[技術\]`/s, `${name} 沒有標註待決策類型`);
  }
  // 只影響內部的技術細節，工程師可以先做並標出來，避免多一輪派工；行為類不行
  for (const name of ['backend-engineer', 'frontend-engineer']) {
    assert.match(agents.find((a) => a.fields.name === name).body, /「\*\*已先採用：<做法>\*\*」.*`\[行為\]`，或會影響上述任何一項的，不要先做/s, `${name} 缺少「已先採用」的界線`);
  }
  assert.match(body, /標「已先採用」的項目就是它的提議/, '總指揮要處理工程師「已先採用」的項目');
});

test('design 範本寫明測試前置條件，任務細節有參照的既有實作', () => {
  const text = readFileSync(join(ROOT, 'skills', 'feature', 'templates', 'design.md'), 'utf8');
  const testing = text.split(/^## /m).find((s) => s.startsWith('測試策略')) ?? '';
  for (const item of ['只跑單一測試', '前置條件', '執行環境', '環境變數', '需要的服務']) {
    assert.ok(testing.includes(item), `測試策略缺少「${item}」`);
  }
  const detail = text.split(/^## /m).find((s) => s.startsWith('任務細節')) ?? '';
  assert.match(detail, /^- 參照：/m, '任務細節缺少「參照」欄位');
});

test('專案 CLAUDE.md 的「測試方式」只摸索一次：先讀、跑通後提草稿、使用者同意才寫入', () => {
  const { body } = frontmatter(join(ROOT, 'skills', 'feature', 'SKILL.md'));
  assert.match(body, /\*\*專案測試方式\*\*/);
  const stage3 = body.split(/^### /m).find((s) => s.startsWith('階段 3：')) ?? '';
  assert.match(stage3, /\*\*使用者同意才寫入\*\*/, '階段 3 必須先問使用者才寫入 CLAUDE.md');

  for (const name of ['architect', 'test-engineer']) {
    const { body: agentBody } = agents.find((a) => a.fields.name === name);
    assert.match(agentBody, /`CLAUDE\.md` 的「測試方式」段落/, `${name} 沒有先讀 CLAUDE.md 的測試方式`);
  }
  const { body: tester } = agents.find((a) => a.fields.name === 'test-engineer');
  assert.match(tester, /建議加入 CLAUDE\.md 的測試方式/, 'test-engineer 缺少草稿產出');
  assert.match(tester, /你不改 `CLAUDE\.md`/, 'test-engineer 不應自行改 CLAUDE.md');
});

test('總指揮精簡：派工不貼歷史、回報短細節進檔案、有工作界線與裁決紀錄', () => {
  const { body } = frontmatter(join(ROOT, 'skills', 'feature', 'SKILL.md'));
  assert.match(body, /\*\*派工 prompt 只放這個角色需要的東西\*\*/);
  assert.match(body, /\*\*不貼對話歷史、前面角色的完整回報或檔案內容\*\*/);
  assert.match(body, /\*\*回報短、細節進檔案\*\*/);
  assert.match(body, /\*\*總指揮的工作界線\*\*/);
  assert.match(body, /總指揮裁決/);
  const section = (n) => body.split(/^### /m).find((s) => s.startsWith(`階段 ${n}：`)) ?? '';
  assert.match(section(4), /回報檔路徑/, '階段 4 派工要給工程師回報檔路徑');
  assert.match(section(6), /只確認這些是否解決/, '階段 6 再 review 要限縮範圍');
  assert.match(section(8), /\*\*建議使用者開新 session\*\*/, '階段 8 要提醒開新 session');

  const template = readFileSync(join(ROOT, 'skills', 'feature', 'templates', 'progress.md'), 'utf8');
  assert.match(template, /^## 總指揮裁決$/m, 'progress 範本缺少「總指揮裁決」');
});

test('寫入型角色回報 15 行內，工程師把完整內容寫進回報檔並回狀態值', () => {
  for (const name of ['requirements-analyst', 'architect', 'test-engineer', 'backend-engineer', 'frontend-engineer']) {
    const { body } = agents.find((a) => a.fields.name === name);
    const report = body.split(/^## /m).find((s) => s.startsWith('回報給呼叫者')) ?? '';
    assert.match(report, /\*\*15 行內\*\*/, `${name} 回報沒有長度限制`);
  }
  for (const name of ['backend-engineer', 'frontend-engineer']) {
    const { body } = agents.find((a) => a.fields.name === name);
    assert.match(body, /^## 回報檔：.*`<工作資料夾>\/reports\//m, `${name} 缺少回報檔`);
    assert.match(body, /`DONE` \/ `DONE_WITH_CONCERNS` \/ `BLOCKED` \/ `NEEDS_CONTEXT`/, `${name} 缺少狀態值`);
  }
});

test('預期值可追溯：design 列關鍵斷言與來源，RED 照抄並標來源，總指揮與 verifier 檢查', () => {
  const template = readFileSync(join(ROOT, 'skills', 'feature', 'templates', 'design.md'), 'utf8');
  const testing = template.split(/^## /m).find((s) => s.startsWith('測試策略')) ?? '';
  assert.match(testing, /\| AC \| 關鍵斷言（具體預期值） \| 預期值來源 \|/, 'design 範本缺少關鍵斷言表');

  const role = (name) => agents.find((a) => a.fields.name === name).body;
  assert.match(role('architect'), /\*\*關鍵斷言\*\*/, 'architect 沒有要求寫關鍵斷言');
  assert.match(role('test-engineer'), /\*\*預期值不憑記憶填\*\*/, 'test-engineer 沒有禁止憑記憶填預期值');
  assert.match(role('test-engineer'), /\| 預期值來源`/, 'RED 對照表缺少預期值來源');
  assert.match(role('verifier'), /測試太弱/, 'verifier 沒有把弱測試判為 FAIL');

  const { body } = frontmatter(join(ROOT, 'skills', 'feature', 'SKILL.md'));
  const stage3 = body.split(/^### /m).find((s) => s.startsWith('階段 3：')) ?? '';
  assert.match(stage3, /\*\*有預期值說不出來源\*\*/, '階段 3 要退回說不出來源的預期值');
  assert.match(stage3, /關鍵斷言」列的斷言沒寫進測試/, '階段 3 要對照關鍵斷言');
});

test('sonnet 角色卡住時升級 opus，並記進裁決', () => {
  const { body } = frontmatter(join(ROOT, 'skills', 'feature', 'SKILL.md'));
  assert.match(body, /\*\*卡住時升級模型\*\*/);
  assert.match(body, /\*\*明確傳 `model: opus`\*\*/);
  for (const name of agents.filter((a) => a.fields.model === 'sonnet').map((a) => a.fields.name)) {
    if (name === 'staged-change-reviewer') continue;
    assert.ok(body.includes(`\`${name}\``) || (name.endsWith('-engineer') && body.includes('工程師')), `升級規則沒涵蓋 ${name}`);
  }
});

test('進度檔一律從範本建立，退回時表格與階段紀錄同時更新，裁決寫在獨立段落', () => {
  const { body } = frontmatter(join(ROOT, 'skills', 'feature', 'SKILL.md'));
  assert.match(body, /\*\*一律從範本建立，不要複製其他 task 的進度檔\*\*/);
  assert.match(body, /\*\*表格和階段紀錄要同時更新\*\*/);
  assert.match(body, /寫進「總指揮裁決」段落（不是混在階段紀錄裡）/);
});

test('修正後只補驗受影響處：工程師跑相關測試 + 一次完整測試，比對雜湊，不整套重派 VERIFY', () => {
  const { body } = frontmatter(join(ROOT, 'skills', 'feature', 'SKILL.md'));
  assert.match(body, /\*\*修正後的驗證\*\*/);
  assert.match(body, /\*\*不再重新派 `test-engineer` 做 VERIFY\*\*/);
  assert.match(body, /\*\*限定範圍的 VERIFY\*\*/);
  const section = (n) => body.split(/^### /m).find((s) => s.startsWith(`階段 ${n}：`)) ?? '';
  assert.match(section(3), /gate\.mjs lock/, '階段 3 要鎖定驗收測試並記下雜湊值');
  assert.match(body, /跑 `gate\.mjs check`/, '修正後要用 gate.mjs check 比對驗收測試');
  assert.match(section(5), /修正後的驗證/, '階段 5 退回要照修正後的驗證');
  assert.match(section(6), /修正後的驗證/, '階段 6 退回要照修正後的驗證');
  assert.match(section(6), /\*\*合併成一輪修正\*\*/, '階段 6 兩個 reviewer 的發現要合併');

  for (const name of ['backend-engineer', 'frontend-engineer']) {
    const { body: eng } = agents.find((a) => a.fields.name === name);
    const fix = eng.split(/^## /m).find((s) => s.startsWith('修正輪')) ?? '';
    assert.match(fix, /\*\*一次完整測試指令\*\*/, `${name} 修正輪沒有跑完整測試`);
  }
});

test('唯讀角色回報只寫結論與發現，不重述程式碼', () => {
  for (const name of ['code-reviewer', 'security-reviewer', 'verifier']) {
    const { body } = agents.find((a) => a.fields.name === name);
    assert.match(body, /不重述程式碼/, `${name} 沒有限制回報內容`);
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

test('硬性關卡：hooks.json 接上鎖定與綠燈關卡，流程會建立與清除 gate.json', () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const cmds = (event) => (hooks[event] ?? []).flatMap((g) => g.hooks).map((h) => h.command).join('\n');
  assert.match(cmds('PreToolUse'), /guard-locked-tests\.mjs/);
  assert.match(cmds('SubagentStop'), /require-green-on-stop\.mjs/);
  const post = (hooks.PostToolUse ?? []).find((g) => g.hooks.some((h) => h.command.includes('check-locked-after-bash')));
  assert.ok(post, 'PostToolUse 要接上指令改檔的還原檢查');
  for (const tool of ['Bash', 'PowerShell']) assert.ok(new RegExp(post.matcher).test(tool), `還原檢查要涵蓋 ${tool}`);
  const stopHook = hooks.SubagentStop.flatMap((g) => g.hooks).find((h) => h.command.includes('require-green-on-stop'));
  assert.ok(stopHook.timeout >= 600, '綠燈關卡要跑測試，timeout 不能太短');

  const { body } = frontmatter(join(ROOT, 'skills', 'feature', 'SKILL.md'));
  assert.match(body, /\*\*關卡狀態檔 `gate\.json`\*\*/);
  const section = (n) => body.split(/^### /m).find((s) => s.startsWith(`階段 ${n}：`)) ?? '';
  assert.match(section(0), /gate\.json/, '階段 0 要檢查有沒有沒收尾的 gate.json');
  assert.match(section(3), /acceptanceCommands/, '階段 3 要寫入各角色的驗收測試指令');
  assert.match(section(4), /fail-released/, '階段 4 要處理被擋滿後放行的工程師');
  assert.match(section(8), /gate\.mjs clear/, '階段 8 要清除關卡狀態');

  const role = (name) => agents.find((a) => a.fields.name === name).body;
  assert.match(role('test-engineer'), /\*\*依角色分開的驗收測試指令\*\*/);
  for (const name of ['backend-engineer', 'frontend-engineer']) {
    assert.match(role(name), /\*\*不要改用 Bash 或其他方式繞過\*\*/, `${name} 缺少不可繞過鎖定的紅線`);
  }
});

test('防針對測試寫死：verifier 與 code-reviewer 檢查、VERIFY 換值、平行要有檔案所有權、總指揮處理 LockCheck', () => {
  const role = (name) => agents.find((a) => a.fields.name === name).body;
  assert.match(role('verifier'), /\*\*檢查有沒有針對測試寫死答案\*\*/);
  assert.match(role('verifier'), /\*\*產品程式碼針對測試寫死答案也是 FAIL\*\*/);
  assert.match(role('code-reviewer'), /針對測試寫死：/);
  assert.match(role('code-reviewer'), /資料庫（改動碰到 migration/);
  assert.match(role('code-reviewer'), /\*\*只回報缺漏與 bug，不回報風格偏好\*\*/);
  const verify = role('test-engineer').split(/^## /m).find((s) => s.startsWith('VERIFY 模式')) ?? '';
  assert.match(verify, /\*\*新補的測試改用和 RED 不同的輸入值\*\*/);
  assert.match(role('architect'), /\*\*檔案所有權\*\*/);

  const { body } = frontmatter(join(ROOT, 'skills', 'feature', 'SKILL.md'));
  const section = (n) => body.split(/^### /m).find((s) => s.startsWith(`階段 ${n}：`)) ?? '';
  assert.match(section(4), /清單完全沒有重疊/, '階段 4 平行要先確認檔案清單不重疊');
  assert.match(section(4), /`LockCheck`/, '階段 4 要處理被還原過的工程師');
  assert.match(body, /\*\*改了 `gate\.json` 一定要重跑 `gate\.mjs lock`\*\*/);
});

test('防 skip 繞過綠燈：gate.json 有 acceptanceCounts、test-engineer 記數量且不寫佔位 skip、reviewer 檢查測試設定', () => {
  const role = (name) => agents.find((a) => a.fields.name === name).body;
  assert.match(role('test-engineer'), /\*\*依角色分開的驗收測試數量\*\*/);
  assert.match(role('test-engineer'), /\*\*不要寫 skip \/ xfail \/ todo 的佔位測試\*\*/);
  assert.match(role('verifier'), /測試設定或標記被動過/);
  assert.match(role('code-reviewer'), /測試設定：新增或修改 `conftest\.py`/);

  const { body } = frontmatter(join(ROOT, 'skills', 'feature', 'SKILL.md'));
  const section = (n) => body.split(/^### /m).find((s) => s.startsWith(`階段 ${n}：`)) ?? '';
  assert.match(body, /"acceptanceCounts"/, 'gate.json 格式要有 acceptanceCounts');
  assert.match(section(3), /`acceptanceCounts` 照抄/, '階段 3 要寫入驗收測試數量');
  assert.match(section(4), /`pass-unparsed`/, '階段 4 要處理數量檢查沒生效的情況');
});

test('畫面設計：analyst 標畫面規模與 UI 文字、需要設計才派 ui-designer、architect 寫畫面配置、文字照抄 spec', () => {
  const role = (name) => agents.find((a) => a.fields.name === name).body;
  const designer = agents.find((a) => a.fields.name === 'ui-designer');
  const tools = designer.fields.tools.split(',').map((s) => s.trim());
  assert.ok(tools.includes('Skill'), 'ui-designer 要能載入 frontend-design');
  assert.ok(!tools.includes('Agent'), 'ui-designer 不能再派 subagent');
  assert.match(designer.body, /`EXISTING`/);
  assert.match(designer.body, /\*\*只在 `NEW` 模式\*\*/, 'frontend-design 只在 NEW 模式載入');
  assert.match(designer.body, /\*\*不要為了截圖安裝任何套件\*\*/);
  assert.match(designer.body, /### `mockup\.html`/);

  assert.match(role('requirements-analyst'), /\*\*畫面規模\*\*/);
  assert.match(role('requirements-analyst'), /\*\*使用者看得到的文字寫進 AC\*\*/);
  assert.match(role('architect'), /\*\*畫面配置\*\*/);
  assert.match(role('test-engineer'), /\*\*畫面上的文字照抄 spec\*\*/);
  assert.match(role('frontend-engineer'), /\*\*優先順序\*\*/);
  assert.match(role('frontend-engineer'), /不要載入通用的設計 skill/);
  assert.match(role('code-reviewer'), /前端（改動碰到畫面時才看）/);
  assert.match(role('verifier'), /\*\*有畫面變動時對照設計\*\*/);

  const { body } = frontmatter(join(ROOT, 'skills', 'feature', 'SKILL.md'));
  const section = (n) => body.split(/^### /m).find((s) => s.startsWith(`階段 ${n}：`)) ?? '';
  assert.match(body, /\*\*專案前端規範\*\*/);
  assert.match(section(1), /畫面規模/, '關卡 A 要確認畫面規模');
  assert.match(section(2), /先呼叫 `ui-designer`/, '畫面規模是設計時先派 ui-designer');
  assert.match(section(2), /mockup/, '關卡 B 要給使用者看設計稿');
  assert.match(section(4), /\*\*使用者同意才寫入\*\* `\.claude\/rules\/frontend\.md`/);

  const spec = readFileSync(join(ROOT, 'skills', 'feature', 'templates', 'spec.md'), 'utf8');
  assert.match(spec, /^## 畫面規模$/m);
  const design = readFileSync(join(ROOT, 'skills', 'feature', 'templates', 'design.md'), 'utf8');
  assert.match(design, /^## 畫面配置$/m);
});

test('plugin.json 與 marketplace.json 名稱一致', () => {
  const plugin = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const market = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.ok(market.plugins.some((p) => p.name === plugin.name));
});
