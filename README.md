# dev-team：Claude Code 多角色開發團隊 + Harness

一個本機 Claude Code **plugin**，裡面有 10 個角色（subagent）、2 個流程指令（skill），以及保護和紀錄用的 hooks。

```
你 ──> /dev-team:feature <需求>
         │  主 session = 總指揮（orchestrator），不寫產品程式碼
         ▼
  requirements-analyst ──> spec.md（AC、畫面規模、UI 文字）   🚦 關卡 A：你確認規格與畫面規模
         ▼
  [畫面規模是「設計」時] ui-designer ──> ui-design.md + mockup.html（+ 截圖）
         ▼
  architect ──> design.md（API 契約、畫面配置、任務拆分）    🚦 關卡 B：你確認設計（含設計稿）
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
| `ui-designer` | 讀 + 寫工作資料夾 | 只在畫面規模是「設計」時派：產出 ui-design.md 與 mockup.html，能截圖就附截圖；新系統 / 改版才載入 frontend-design |
| `staged-change-reviewer` | **唯讀** | commit 前審 staged diff（取自 `claude-code-kit`，這裡改成唯讀） |

工程師和測試角色不能再開 subagent（`disallowedTools: Agent`），任務一律由總指揮分派，避免角色自己越級分工。

### 測試先行（TDD）

流程採兩層 TDD，概念參考 [obra/superpowers](https://github.com/obra/superpowers) 的 `test-driven-development` / `writing-plans` / `systematic-debugging`：

- **外層**：`test-engineer` 在實作前依 AC 寫驗收測試並跑出紅燈；這批測試鎖定，工程師不能改（由 hook 硬性阻擋，見下方 Harness）。
- **內層**：工程師每段行為都走 RED → GREEN → REFACTOR，回報要附紅燈與綠燈的實際輸出。
- **Bug 修復**：先寫出重現 bug 的紅燈測試（重現不了就停），工程師先找根因再修，同一個 bug 修 3 次不過就停下回報。
- 純設定、migration、自動產生的程式、純樣式可以列為「TDD 例外」，由你決定是否接受。

## 畫面設計怎麼分工

| 要決定的事 | 誰 | 寫在哪 | 你在哪確認 |
|-----------|----|--------|-----------|
| 畫面規模：`無` / `配置`（既有畫面加按鈕、彈窗）/ `設計`（新頁面、新系統、改版） | `requirements-analyst` 判斷 | spec.md | 關卡 A |
| 按鈕名稱、彈窗標題 / 內文 / 按鈕、錯誤訊息 | `requirements-analyst` | spec.md 的 AC | 關卡 A |
| 放在哪裡、用哪個既有元件、照哪個參照頁面 | `architect`（`配置`）或 `ui-designer`（`設計`） | design.md「畫面配置」/ ui-design.md | 關卡 B |
| 實作 | `frontend-engineer`：照設計做，設計沒寫到的地方照參照頁面並回報 | — | 收尾 |

測試用來找按鈕的文字一律照抄 spec，不讓 test-engineer 自己取名（寫進鎖定的驗收測試後就改不動）。

### 專案前端規範（每個專案一份）

放在專案的 `.claude/rules/frontend.md`（`CLAUDE.md` 指定其他位置也可以）。dev-team 的角色會被明確告知去讀它，所以不依賴自動載入。建議只寫指向實際程式碼的短內容：

- 元件選用：彈窗、表格、按鈕、表單各用哪個（同類元件很多時一定要寫）
- 樣式寫法：用哪套 UI 庫、主題 / token 檔在哪、哪種樣式寫法
- 參照頁面：兩三個「照這個做」的頁面
- 啟動與登入：dev server 指令、要不要後端、登入方式。**寫了這段，frontend-engineer 才會截實際畫面**；需要 Azure AD 等互動式登入的專案，先維持人工確認

專案還沒有這份規範時，`ui-designer` 或 `frontend-engineer` 會附草稿，總指揮問過你才寫入。檔案可以加 `paths` frontmatter 讓其他 session 只在碰到前端檔案時載入；社群回報過官方文件的 `paths` 寫法有誤，加完要確認有生效。

### 選用：frontend-design 與截圖

- [frontend-design](https://claude.com/marketplace/plugins/frontend-design) 是另外安裝的官方 plugin。有裝時，`ui-designer` 只在 `NEW` 模式（全新系統，或你在關卡 A 確認要改版）載入；在既有系統加畫面時不用，就算那個專案還沒寫前端規範也一樣，以免偏離現有風格。沒裝也能設計，`ui-designer` 內建設計原則。
- mockup 截圖需要 Playwright。dev-team 不會自動安裝；想要截圖就自己裝一次（例如全域安裝 `playwright` 再 `npx playwright install chromium`）。沒有 Playwright 時，用瀏覽器打開 `mockup.html` 即可。

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

所有產出放在專案的 `docs/specs/<日期>-<slug>/`：`request.md`、`spec.md`、`design.md`、`test-report.md`、`verify.md`，有畫面設計時還有 `ui-design.md`、`mockup.html`、`mockup/`、`screenshots/`，以及總指揮的進度檔 `progress.md`（目前階段、關卡確認、重修輪數、你做過的決定）。
對話被壓縮或換 session 時，說「接續 `docs/specs/<日期>-<slug>`」，總指揮會先讀 `progress.md` 從中斷的地方繼續。
subagent 看不到你和總指揮的對話，**角色之間只靠這些檔案交接**，所以它們也是之後回頭查的紀錄。

**待決策怎麼處理**：輸入怎麼清理、錯誤訊息原文、多個錯誤先回哪個這類常見問題，spec 的「輸入與錯誤處理」表會讓你在關卡 A 一次決定。流程中途才冒出來的問題，總指揮依「做錯了影響誰、能不能改回來」分三種：既有程式或規格已有做法的照做、不問；只影響內部又容易改的由總指揮先裁決，收尾時列給你確認；影響使用者看得到的行為、API 契約、資料或鎖定測試的，**就算很明顯也問你**。需要研究的，使用者看得到的行為退給 `requirements-analyst`、技術做法退給 `architect`，請它們寫決策備忘（`decisions/`：選項、既有做法、業界做法、影響、建議；查完仍無法判斷就寫「無建議」與缺少的資訊），再把所有問題一次拿來跟你討論。決定權永遠在你。

## Harness（hooks）

| Hook | 作用 |
|------|------|
| `PreToolUse`（Edit/Write） | 擋下寫入 `.env*`（範例檔除外）、`*.pem`/`*.key`、SSH key、`credentials*.json`、`secrets.*`、`.npmrc`、`.git/` 內部檔。真的要改就用 `DEV_TEAM_ALLOW_SENSITIVE=1` 啟動 Claude，或自己手動改 |
| `PreToolUse`（Edit/Write） | **驗收測試鎖定**：`backend-engineer` / `frontend-engineer` 改 `gate.json` 列出的驗收測試，或改 `.claude/dev-team/` 底下的檔案，直接擋下。`test-engineer` 和主 session 不擋 |
| `PostToolUse`（Bash/PowerShell） | **指令改檔還原**：工程師每跑完一次指令，就比對驗收測試和 `gate.json` 的雜湊；被改或被刪就從 `gate.mjs lock` 的備份還原、回饋給工程師，並在 `activity.jsonl` 記一筆 `LockCheck`。不比對指令字串，所以 `sed -i`、重導向、`python -c` 改的都抓得到 |
| `SubagentStop` | **綠燈關卡**：工程師要結束時，自動跑 `gate.json` 裡該角色的驗收測試指令；紅燈就擋回去繼續修，附測試輸出最後 40 行。exit 0 也會解析測試摘要（pytest / vitest / jest），有 skipped / deselected / xfailed / todo 或通過數少於 `acceptanceCounts` 一樣擋下。同一個工程師最多擋 3 次（`maxStopBlocks`），回報 `BLOCKED` / `NEEDS_CONTEXT` 時不擋 |
| `SubagentStart` / `SubagentStop` | 每個角色的啟動、結束和回報摘要記到 `<專案>/.claude/dev-team/activity.jsonl`；綠燈關卡的結果也記在這裡（`event: StopGate`） |

### 關卡狀態檔 `gate.json`

兩個關卡 hook 都讀 `<專案>/.claude/dev-team/gate.json`。總指揮在階段 3（紅燈測試確認後）建立，階段 8 清除；**沒有這個檔時兩個 hook 都不做事**，所以不跑 `/dev-team:feature` 的 session 不受影響。

```json
{
  "workdir": "docs/specs/20261109-order-filter",
  "lockedTests": ["backend/tests/acceptance/test_order_filter.py"],
  "acceptanceCommands": {
    "backend-engineer": "cd backend && pytest -q tests/acceptance/test_order_filter.py",
    "frontend-engineer": "cd frontend && npx vitest run src/__tests__/order-filter.acceptance.test.tsx"
  },
  "acceptanceCounts": { "backend-engineer": 4, "frontend-engineer": 2 },
  "maxStopBlocks": 3
}
```

總指揮用 `hooks/scripts/gate.mjs` 管理（從專案根目錄執行）：

| 指令 | 作用 |
|------|------|
| `node <plugin>/hooks/scripts/gate.mjs lock` | 計算 `lockedTests` 每個檔案的 sha256 並寫回，同時把測試檔和 `gate.json` 備份到 `.claude/dev-team/locked/` |
| `node <plugin>/hooks/scripts/gate.mjs check` | 比對驗收測試有沒有被改或被刪、`gate.json` 是否和 lock 時相同，有變更時 exit 1 |
| `node <plugin>/hooks/scripts/gate.mjs clear` | 刪掉 `gate.json`、擋停計數 `stop-guard.json` 與備份 |

Edit / Write 會在事前擋下；用指令改檔擋不了，改由 PostToolUse hook 事後還原。**改了 `gate.json` 一定要重跑 `gate.mjs lock`**，否則下一次工程師跑指令時會被還原成舊版。每輪修正後總指揮仍會跑 `gate.mjs check` 當最後防線。

建議在各專案的 `.gitignore` 加上 `.claude/dev-team/`。

> 安裝 plugin 後這些 hooks 對**所有 session** 都會生效，不只在 `/dev-team:feature` 裡。

## 危險指令防護（各專案自己加）

plugin 不負責擋危險指令。請在專案的 `.claude/settings.json`（或個人的 `~/.claude/settings.json`）加上 `permissions.deny`，這是 Claude Code 內建的權限規則，主 session 和所有 subagent 都適用：

```json
{
  "permissions": {
    "deny": [
      "Bash(git push --force*)",
      "Bash(git push -f*)",
      "Bash(git reset --hard*)",
      "Bash(git clean -f*)",
      "Bash(rm -rf*)",
      "Bash(rm -fr*)"
    ]
  }
}
```

注意：

- 規則比對的是指令開頭，換個寫法（例如 `git push origin main --force`、`bash -c "…"`）就攔不到。它是第一層，不是安全邊界；需要更完整的防護，可以看會解析指令語意的 PreToolUse 工具（例如 `cc-safety-net`）。
- `git push --force*` 也會擋到 `--force-with-lease`。
- 這些規則也會擋到你自己透過 Claude 執行的操作，真的需要時自己在終端機執行。
- Windows 上 Claude 若改用 PowerShell 工具執行，`Bash(…)` 規則管不到。
- 官方的 Bash sandbox 只支援 macOS、Linux 和 WSL2，原生 Windows 不能用，所以不能靠它。
- 加完後建議在測試用的 repo 試一次，確認規則有生效。

## 客製化

- **模型**：每個角色都明確指定模型，不用 `inherit`（否則全部跟著主 session 跑，通常是最貴的那個）。負責「想」和「把關」的角色用 `opus`：總指揮（主 session，由你選）、`requirements-analyst`、`architect`、`ui-designer`、`code-reviewer`、`security-reviewer`、`verifier`。照規格「做」的角色用 `sonnet`：`backend-engineer`、`frontend-engineer`、`test-engineer`、`staged-change-reviewer`。
  `test-engineer` 用 sonnet 的前提是預期值不由它決定：`architect` 在 design 的「關鍵斷言」寫出每條 AC 的具體預期值與來源，總指揮在 RED 後對照檢查，`verifier` 最後確認測試真的驗到 AC。工程師與 `test-engineer` 卡住時（RED 被退回第 2 次、`BLOCKED`、同一問題修一輪未解），總指揮下一次派工改傳 `model: opus`。可以改成別名（`opus`、`sonnet`、`haiku`）或完整 model ID，`tests/plugin-structure.test.mjs` 會檢查每個角色的設定。
  注意：Claude Code 版本太舊時，subagent 會直接失敗。2.1.133 實測派 Opus 5.5 的 subagent 時，API 回 `version 2.1.280 or newer is required`。請先 `claude update`，或改用 desktop app。
- **專案測試方式**：在專案 `CLAUDE.md` 寫一段 `## 測試方式`，內容包括測試指令、執行環境、環境變數、需要的服務、已知會失敗的測試。architect 和 test-engineer 會先讀這段，不再每個功能重新摸索環境。沒有這段時，test-engineer 會在第一次 RED 跑通後提出草稿，總指揮問過你才寫入。
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

hook 情境測試（照 `hooks.json` 實際執行 hook，用真的指令嘗試繞過驗收測試鎖定；有 python + pytest 時會多跑 conftest.py / pytest.ini 繞過綠燈關卡的情境）：

```bash
npm run test:e2e --prefix "D:/workshop/claude-agent-harness"
```

這支需要 bash，Windows 請在 Git Bash 執行；找不到 bash 時會直接略過。它依賴 `sed` 等外部指令，所以沒有放進 `npm test`。

## 已知限制

- `CLAUDE.md` 和 skill 裡寫的流程是**軟性**的：模型多半會照做，但不保證。需要「每次一定執行」的檢查要用 hook。目前硬性執行的只有：敏感檔案防護、驗收測試鎖定（含指令改檔還原）、工程師綠燈關卡；其餘（關卡 A / B、輪數上限、review）仍靠總指揮遵守流程。
- 指令改檔還原是事後處理：指令執行完才比對。整個 `.claude/dev-team/` 被刪掉時沒有備份可比，要靠總指揮的 `gate.mjs check`（找不到 `gate.json` 會失敗）。敏感檔案（`.env` 等）只有 Edit / Write 的事前防護，用指令寫入攔不到。
- 安裝 plugin 後，所有 session 每次執行 Bash / PowerShell 都會多跑一次 node（不是工程師就立刻結束）。
- 綠燈關卡的數量檢查靠解析測試輸出的摘要行，支援 pytest、vitest、jest 的預設格式。指令把摘要關掉（例如 pytest `-qq`）或用其他框架時解析不到，會放行並記成 `pass-unparsed`，這時只剩 exit code 和 verifier 把關。
- 綠燈關卡每次工程師結束都會多跑一次驗收測試；指令要只跑這次的驗收測試，不要放整個套件，否則每次都要等很久。hook timeout 是 600 秒。
- Subagent 無法直接問你問題。需求分析師會把問題交回總指揮，再由總指揮問你。
- 前後端平行開發時，如果會改到同一批檔案，總指揮會改成依序進行。真的要隔離的話，可以在 agent frontmatter 加 `isolation: worktree`（需要 git repo）。
