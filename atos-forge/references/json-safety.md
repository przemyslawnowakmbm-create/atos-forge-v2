# JSON Safety — Claude Code Persisted Output

## The Problem

When a Bash tool output exceeds Claude Code's inline display limit, it is
persisted to a file under `.claude/projects/<id>/tool-results/<tool_id>.txt`.
Claude Code appends a **`[rerun: bN]` footer** (e.g. `[rerun: b7]`) to the end
of that file.  This footer is NOT valid JSON.

If you later `cat` that file and pipe it through `jq`, `python3 -c "json.load(sys.stdin)"`,
or `JSON.parse()`, the parse will fail with "Extra data" or "Unexpected token".

## Rules

1. **NEVER** `cat` a `tool-results/*.txt` file and pipe it directly through a
   JSON parser (`jq`, `python3 -c "json.load(...)"`, `node -e "JSON.parse(...)"`).
2. If you MUST re-read a persisted Bash output, **strip the footer first**:
   ```bash
   # Option A: sed
   sed 's/\[rerun: b[0-9]*\]$//' < file.txt | jq .

   # Option B: head (drop last line)
   head -n -1 file.txt | jq .
   ```
3. **Prefer re-running the original command** instead of reading the cached
   tool-results file.  The original command produces clean output.
4. For `echo "$VAR" | jq ...` — the shell variable itself is clean (the footer
   is only in the persisted *file*, not in the captured variable).  This is safe.
