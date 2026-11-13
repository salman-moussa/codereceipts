---
name: receipt
description: Show what a Claude Code session really cost - spend by model and subagent, cache savings and misses, what filled the context, and concrete tips to pay less. Use when the user asks what a session cost, why it was expensive, where the tokens went, or how to cut cost.
---

Run the Receipts CLI and show the result to the user.

1. Pick the session. With no session named, use the latest one. To list recent sessions:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/cli/receipts.js" list -n 10
   ```

2. Print the receipt (add a session id prefix to choose one):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/cli/receipts.js" --no-color
   ```

3. Show the receipt to the user inside a code block, unchanged. Then add at most three short lines: the biggest cost driver and the single most useful tip from the receipt. Do not invent numbers; every figure must come from the receipt.

4. If the user wants the visual version, run `node "${CLAUDE_PLUGIN_ROOT}/cli/receipts.js" report` (opens the Context X-ray page) or `card` (saves a shareable SVG) and give them the file path it prints.

For totals across all projects, run `node "${CLAUDE_PLUGIN_ROOT}/cli/receipts.js" week --no-color`.
