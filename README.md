# dev-team：Claude Code 多角色開發團隊 + Harness

一個本機 Claude Code **plugin**，裡面有 9 個角色（subagent）、2 個流程指令（skill），以及保護和紀錄用的 hooks。

```
你 ──> /dev-team:feature <需求>
         │  主 session = 總指揮（orchestrator），不寫產品程式碼
         ▼
  requirements-analyst ──> spec.md（AC 驗收條件）   🚦 關卡 A：你確認規格
         ▼
  architect ──> design.md（API 契約、任務拆分）      🚦 關卡 B：你確認設計
         ▼
  test-engineer [RED] ──> 紅燈驗收測試（實作前先寫、先跑出紅燈）
         ▼
  backend-engineer ║ frontend-engineer（RED → GREEN → REFACTOR，讓驗收測試變綠）
         ▼
  test-engineer [VERIFY] ──> test-report.md（補邊界、跑全套件；失敗 → 退回工程師，最多 3 輪）
         ▼
  code-reviewer ║ security-reviewer（唯讀，平行審）
         ▼
  verifier ──> verify.md（獨立重跑測試、逐條核對 AC）
         ▼
  你決定 commit（git add 後可用 staged-change-reviewer 做最後把關）
```

## 角色

| 角色 | 權限 | 做什麼 |
|------|------|--------|
| `requirements-analyst` | 讀 + 寫文件 | 需求 → 可驗收的 spec，列出要問你的問題 |
| `architect` | 讀 + 寫文件 | spec → 設計、API 契約、`[TEST]`（先）/`[BE]`/`[FE]` 任務 |
| `test-engineer` | 完整（但不改產品碼） | **先寫測試的人**：實作前依 AC 寫紅燈驗收測試，實作後驗證、找缺陷 |
| `backend-engineer` | 完整 | 以 TDD 實作後端任務 + unit test，附紅燈 / 綠燈證據 |
| `frontend-engineer` | 完整 | 以 TDD 實作前端任務 + 測試，附紅燈 / 綠燈證據 |
| `code-reviewer` | **唯讀** | 對照 spec 審查改動 |
| `security-reviewer` | **唯讀** | 資安審查 |
| `verifier` | **唯讀** | 沒參與開發，獨立驗收 |
| `staged-change-reviewer` | **唯讀** | commit 前審 staged diff（取自 `claude-code-kit`，這裡改成唯讀） |

工程師和測試角色不能再開 subagent（`disallowedTools: Agent`），任務一律由總指揮分派，避免角色自己越級分工。

### 測試先行（TDD）

流程採兩層 TDD，概念參考 [obra/superpowers](https://github.com/obra/superpowers) 的 `test-driven-development` / `writing-plans` / `systematic-debugging`：

- **外層**：`test-engineer` 在實作前依 AC 寫驗收測試並跑出紅燈；這批測試鎖定，工程師不能改。
- **內層**：工程師每段行為都走 RED → GREEN → REFACTOR，回報要附紅燈與綠燈的實際輸出。
- **Bug 修復**：先寫出重現 bug 的紅燈測試（重現不了就停），工程師先找根因再修，同一個 bug 修 3 次不過就停下回報。
- 純設定、migration、自動產生的程式、純樣式可以列為「TDD 例外」，由你決定是否接受。

## 安裝

**先試用（不安裝，只在這次 session 生效）：**

```bash
claude --plugin-dir "D:/workshop/claude-agent-harness"
```

**正式安裝（之後所有專案都能用）：**

```bash
claude plugin marketplace add "D:/workshop/claude-agent-harness"
```

```bash
claude plugin install dev-team@workshop-local
```

改了這個資料夾的內容之後要更新：

```bash
claude plugin marketplace update workshop-local
```

不想要時：`claude plugin uninstall dev-team`。

**只想要某幾個角色、放在單一專案：** 把 `agents/` 裡的 `.md` 複製到該專案的 `.claude/agents/`。這樣名稱不會帶 `dev-team:` 前綴，但也不會有 hooks。

## 使用

| 你要做的 | 怎麼下 |
|---------|--------|
| 完整流程做一個功能 | `/dev-team:feature 訂單列表加上依狀態篩選` |
| 只要 review 目前改動 | `/dev-team:team-review` |
| 單獨叫一個角色 | 「用 dev-team:architect 幫我評估把 session 改成 JWT 的影響」 |

所有產出放在專案的 `docs/specs/<日期>-<slug>/`：`request.md`、`spec.md`、`design.md`、`test-report.md`、`verify.md`，以及總指揮的進度檔 `progress.md`（目前階段、關卡確認、重修輪數、你做過的決定）。
對話被壓縮或換 session 時，說「接續 `docs/specs/<日期>-<slug>`」，總指揮會先讀 `progress.md` 從中斷的地方繼續。
subagent 看不到你和總指揮的對話，**角色之間只靠這些檔案交接**，所以它們也是之後回頭查的紀錄。

## Harness（hooks）

| Hook | 作用 |
|------|------|
| `PreToolUse`（Edit/Write） | 擋下寫入 `.env*`（範例檔除外）、`*.pem`/`*.key`、SSH key、`credentials*.json`、`secrets.*`、`.npmrc`、`.git/` 內部檔。真的要改就用 `DEV_TEAM_ALLOW_SENSITIVE=1` 啟動 Claude，或自己手動改 |
| `SubagentStart` / `SubagentStop` | 每個角色的啟動、結束和回報摘要記到 `<專案>/.claude/dev-team/activity.jsonl` |

建議在各專案的 `.gitignore` 加上 `.claude/dev-team/`。

> 安裝 plugin 後這些 hooks 對**所有 session** 都會生效，不只在 `/dev-team:feature` 裡。

## 客製化

- **模型**：每個角色都明確指定模型，不用 `inherit`（否則全部跟著主 session 跑，通常是最貴的那個）。需求、設計、測試、實作、審查、驗收都用 `opus`。`test-engineer` 寫的驗收測試會鎖定，等於定義了什麼叫「完成」，所以不用比工程師弱的模型。只有 `staged-change-reviewer` 做 commit 前的快速把關，用 `sonnet`。可以改成別名（`opus`、`sonnet`、`haiku`）或完整 model ID，`tests/plugin-structure.test.mjs` 會檢查每個角色的設定。
  注意：Claude Code 版本太舊時，subagent 會直接失敗。2.1.133 實測派 Opus 5.5 的 subagent 時，API 回 `version 2.1.280 or newer is required`。請先 `claude update`，或改用 desktop app。
- **加角色**：在 `agents/` 新增 `.md`（frontmatter 至少要有 `name`、`description`），再到 `skills/feature/SKILL.md` 的流程裡加一個階段。常見的擴充有 `devops-engineer`（CI/CD、容器）、`db-engineer`（migration、索引）、`docs-writer`（README、API 文件）、`debugger`（重現與根因分析）。
- **改流程**：直接改 `skills/feature/SKILL.md`。這是一般的 Markdown，總指揮會照著執行。

## 開發這個 plugin

```bash
npm test --prefix "D:/workshop/claude-agent-harness"
```

```bash
claude plugin validate "D:/workshop/claude-agent-harness/.claude-plugin/plugin.json"
```

測試涵蓋：agent/skill 的 frontmatter 是否合法、名稱是否唯一、唯讀角色有沒有寫入權限、skill 引用的角色是否存在、hooks 腳本實際執行的行為。

## 已知限制

- `CLAUDE.md` 和 skill 裡寫的流程是**軟性**的：模型多半會照做，但不保證。需要「每次一定執行」的檢查要用 hook。
- Subagent 無法直接問你問題。需求分析師會把問題交回總指揮，再由總指揮問你。
- 前後端平行開發時，如果會改到同一批檔案，總指揮會改成依序進行。真的要隔離的話，可以在 agent frontmatter 加 `isolation: worktree`（需要 git repo）。
