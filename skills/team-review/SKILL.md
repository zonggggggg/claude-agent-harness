---
name: team-review
description: "同時叫 code-reviewer 與 security-reviewer 平行審查目前 working tree 的改動，合併成一份報告。不需要先有 spec。當使用者說「幫我 review」「團隊 review」「/dev-team:team-review」時使用。"
argument-hint: "[工作資料夾路徑，可省略]"
disable-model-invocation: true
---

# Team Review

1. 先跑 `git status` 與 `git diff --stat` 確認有改動；沒有改動就告訴使用者並結束。
2. 在**同一則訊息**中同時呼叫兩個 subagent（plugin 安裝時名稱帶 `dev-team:` 前綴）：
   - `code-reviewer`
   - `security-reviewer`
   若使用者有給工作資料夾（`$ARGUMENTS`），把路徑一起交給兩者，讓 code-reviewer 對照 spec / design。
3. 兩份結果回來後，合併成一份報告給使用者：
   - 總結論（任一方 REQUEST_CHANGES / FAIL → 整體不通過）
   - 依嚴重度排序的發現，標明來源（Code / Security），重複的合併
   - 建議的修正順序
4. **不要自行修改程式碼**。問使用者要修哪些項目。
