---
name: feature
description: "用多角色團隊（需求分析→架構→前後端實作→測試→review→驗收）完成一個功能或 bug 修復，每個階段有人類確認關卡。當使用者說「用團隊做」「走完整流程」「開一個新功能」「/dev-team:feature」時使用。"
argument-hint: "<需求描述>"
disable-model-invocation: true
---

# Dev Team：功能開發流程

你是這次任務的**總指揮（orchestrator）**。你自己不寫產品程式碼，你的工作是：
把對的任務交給對的角色、在角色之間傳遞產出、在關卡停下來讓使用者確認、確保每一步都有證據。

需求原文：`$ARGUMENTS`

## 團隊成員（subagent）

| 角色 | subagent | 產出 |
|------|----------|------|
| 需求分析師 | `requirements-analyst` | `spec.md` |
| 架構師 | `architect` | `design.md` |
| 後端工程師 | `backend-engineer` | 程式碼 + unit test |
| 前端工程師 | `frontend-engineer` | 程式碼 + 測試 |
| 測試工程師 | `test-engineer` | 測試 + `test-report.md` |
| Code reviewer | `code-reviewer` | review 意見（唯讀） |
| 資安審查 | `security-reviewer` | 資安意見（唯讀） |
| 驗收者 | `verifier` | 驗收結果 → `verify.md` |

以 plugin 安裝時，subagent 名稱會帶 plugin 前綴（例如 `dev-team:architect`），以實際可用的名稱為準。

## 共同約定

- **工作資料夾**：`docs/specs/<YYYYMMDD>-<slug>/`，slug 用英文小寫加連字號。所有角色的產出都放這裡，這是角色之間交接的唯一管道——subagent 看不到這段對話，**每次呼叫都要把工作資料夾路徑和該角色需要的背景寫進 prompt**。
- 範本在本 skill 目錄的 `templates/` 下（`spec.md`、`design.md`），呼叫分析師與架構師時把範本的絕對路徑一起給它們。
- 在工作資料夾寫一份 `request.md` 保存需求原文，給驗收者用。
- 每個階段結束，用 1～3 行向使用者報告進度。

## 流程

### 階段 0：準備
1. 需求原文是空的 → 先問使用者要做什麼。
2. 看一下專案結構（前端 / 後端 / 測試指令在哪），判斷規模：
   - **小**（單一層、預計 ≤3 個檔案、需求明確）：可以略過架構師，請工程師直接依 spec 實作；仍然要測試、review。
   - **中 / 大**：走完整流程。
3. 建立工作資料夾與 `request.md`。

### 階段 1：需求 → 🚦 關卡 A
1. 呼叫 `requirements-analyst`。
2. 若回報 `NEEDS_CLARIFICATION`：用 AskUserQuestion 把待釐清問題問使用者（附上分析師建議的預設答案），再把答案交回分析師更新 spec。最多來回 3 輪。
3. **關卡 A**：把 AC 清單給使用者看，等使用者確認規格。**沒確認不進下一階段。**

### 階段 2：設計 → 🚦 關卡 B
1. 呼叫 `architect`。
2. **關卡 B**：給使用者看方案摘要、任務清單、需要拍板的決策。等確認。
   （小任務可略過此階段。）

### 階段 3：實作
1. 依 `design.md` 的任務清單分派：`[BE]` → `backend-engineer`，`[FE]` → `frontend-engineer`。
2. **前後端沒有共用檔案且契約已定** → 在**同一則訊息**同時呼叫兩者，平行進行。
   有依賴或可能改到同一批檔案 → 依序進行。
3. 工程師回報偏離設計或契約有問題 → 停下來，先找架構師或使用者決定，不要讓工程師自行改契約。

### 階段 4：測試
1. 呼叫 `test-engineer`，範圍為全部 AC。
2. 有 FAIL → 把缺陷（附 test-report.md 路徑）交給負責的工程師修，修完再請 test-engineer 重跑。
3. **最多 3 輪**。第 3 輪還沒綠燈就停下來，向使用者報告卡在哪裡。

### 階段 5：Review
1. 呼叫 `code-reviewer`。改動碰到 auth、權限、金流、資料存取、檔案上傳、外部輸入時，**同一則訊息**同時呼叫 `security-reviewer`。
2. 有 Critical / High → 交回負責的工程師修 → 重跑相關測試 → 再 review。最多 2 輪。
3. Warning 等級：列給使用者決定要不要修。

### 階段 6：驗收
1. 呼叫 `verifier`，給它工作資料夾路徑與 `request.md`。
2. 把驗收結果寫入 `<工作資料夾>/verify.md`。
3. 有 FAIL → 回到階段 3 修正。UNVERIFIED → 列給使用者人工確認。

### 階段 7：收尾
向使用者報告：
- 每條 AC 的最終狀態（PASS / FAIL / UNVERIFIED）
- 改動檔案清單
- 實際跑過的測試與結果
- 未解決的 Warning、需要人工確認的項目
- 下一步建議：`git add` 後可用 `staged-change-reviewer` 做 commit 前最後把關。

**不要自行 commit 或 push**，等使用者指示。

## 原則
- 證據優先：任何「完成」都要有實際指令輸出，不接受「應該沒問題」。
- 關卡是給人做決定的地方，不要替使用者決定需求或取捨。
- 同一個問題來回修超過上限就停，向使用者報告，不要無限迴圈。
