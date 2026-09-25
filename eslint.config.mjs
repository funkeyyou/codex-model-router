// src/ 的四段負載最後會被塞進 bash heredoc 與 PowerShell 註解裡，編輯器看不出錯；
// 在這裡以一般模組檢查。例如 "HKCU:\SOFTWARE\..." 這種反斜線被 JS 吃掉的字串，
// 執行時不會報錯，只有 no-useless-escape 抓得到。
import js from "@eslint/js";
import globals from "globals";

export default [
  // 根目錄的兩支安裝器是建置產物，內容與 src/ 相同。
  { ignores: ["node_modules/**", "codex-model-router.sh", "codex-model-router.ps1"] },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // 擷取、診斷檔與清理步驟刻意吞掉失敗：它們不能中斷對話或安裝流程。
      "no-empty": ["error", { allowEmptyCatch: true }],
      // 消毒終端機輸出與上游錯誤訊息時，本來就要比對控制字元。
      "no-control-regex": "off",
      // 上游錯誤常改寫成不含原文的訊息（原文可能帶憑證或對話內容），不附 cause 是刻意的。
      "preserve-caught-error": "off",
      // 以解構剔除欄位（const { id, ...rest } = item）是常見寫法。
      "no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
];
