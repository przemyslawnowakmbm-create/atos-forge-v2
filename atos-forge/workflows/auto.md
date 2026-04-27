<purpose>
Forge Auto Mode — autonomous execution of the full project workflow.
Reads disk state, determines next unit of work, dispatches fresh agent sessions,
and advances through phases until milestone is complete or user stops.
</purpose>

<process>
<step name="start_auto">
Start auto mode by invoking the forge-auto module:

```bash
node -e "require('forge-auto/auto').start('.', { verbose: $VERBOSE, hardTimeout: $TIMEOUT || 600 })"
```

Auto mode will:
1. Check for crash recovery (stale lock from previous session)
2. Read .planning/STATE.md and ROADMAP.md to determine current position
3. Determine next unit: research → plan → execute → verify → complete
4. Dispatch a fresh Claude session per unit with pre-inlined context
5. After each unit: log metrics, clear crash lock, read disk state again
6. Repeat until milestone complete or stuck (same unit fails 2x)

To stop: press Ctrl+C or run /forge-auto-stop in another terminal.

Auto mode is crash-safe: if it's interrupted, the next run recovers automatically.
</step>
</process>
