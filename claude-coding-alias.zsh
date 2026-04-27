# ─── claude-coding: Qwen3.5-27B base (best quality, full context) ───
# Primary model for TACT 2.0, FDP/Forge, Rust, COTS
# Requires: LM Studio running with mlx-community/Qwen3.5-27B-4bit loaded
# LM Studio settings:
#   Context Length: 65536 (or max your RAM allows)
#   KV Cache Quantization: ON, 8 bits
#   Group size strategy: Balanced
#   Start quantizing when ctx reaches: 1024
alias claude-coding='env \
  ANTHROPIC_BASE_URL="http://localhost:1234" \
  ANTHROPIC_AUTH_TOKEN="lm-studio" \
  ANTHROPIC_MODEL="qwen3.5-27b" \
  ANTHROPIC_SMALL_FAST_MODEL="qwen3-coder-30b-a3b" \
  CLAUDE_AUTOCOMPACT_CAPACITY=60000 \
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80 \
  CLAUDE_CODE_STRIP_BETA_HEADERS=1 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  API_TIMEOUT_MS=600000 \
  claude --permission-mode "bypassPermissions"'

# ─── claude-reasoning: Opus-distilled (short reasoning-only tasks) ───
# Keep for planning, analysis, architecture decisions (< 8K context)
# NOT for coding TACT or Forge — context too short
alias claude-reasoning='env \
  ANTHROPIC_BASE_URL="http://localhost:1234" \
  ANTHROPIC_AUTH_TOKEN="lm-studio" \
  ANTHROPIC_MODEL="mlx-qwen3.5-27b-claude-4.6-opus-reasoning-distilled-v2" \
  ANTHROPIC_SMALL_FAST_MODEL="mlx-qwen3.5-9b-claude-4.6-opus-reasoning-distilled" \
  CLAUDE_AUTOCOMPACT_CAPACITY=7000 \
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=85 \
  CLAUDE_CODE_STRIP_BETA_HEADERS=1 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  API_TIMEOUT_MS=300000 \
  claude --permission-mode "bypassPermissions"'

# ─── Zmiany vs twój obecny claude-local ───
# 1. ANTHROPIC_MODEL: qwen3.5-27b (base, nie distilled) — 262K context, benchmarki
# 2. ANTHROPIC_SMALL_FAST_MODEL: qwen3-coder-30b-a3b — szybki coding MoE
# 3. CLAUDE_AUTOCOMPACT_CAPACITY: 60000 (nie 65536) — 5K margines na overhead
# 4. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: 80 (nie 85) — wcześniejsze compaction = stabilność
# 5. API_TIMEOUT_MS: 600000 (10 min) — 27B dense jest wolniejszy, potrzebuje czasu
#
# Model name w ANTHROPIC_MODEL musi matchować to co LM Studio wystawia.
# Sprawdź: curl http://localhost:1234/v1/models | jq '.data[].id'
