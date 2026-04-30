---
description: Fetch the result of a cursor dispatch job (latest by default)
argument-hint: '[jobId] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run the cursor companion result command and return stdout verbatim.

```bash
TMP=$(mktemp -t cursor-args.XXXXXXXX)
cat >"$TMP" <<'__CURSOR_RAW_ARGS_END_a8f3c91d4b__'
$ARGUMENTS
__CURSOR_RAW_ARGS_END_a8f3c91d4b__
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" result --raw-args-file "$TMP"
```

Do not summarize.
