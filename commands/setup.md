---
description: Verify cursor agent is installed and logged in
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run the cursor companion setup check and return its stdout verbatim.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" setup
```

Do not paraphrase, summarize, or add commentary.
