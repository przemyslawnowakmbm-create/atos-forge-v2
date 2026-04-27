# Best Local Coding LLM — Analiza (marzec 2026)

## TL;DR

**Twój obecny model (Qwen3.5-27B-Claude-Opus-Distilled-v2) ma krytyczny problem: kontekst ucięty do 8K tokenów.** To dyskwalifikuje go do pracy z Forge/FDP (długie system prompty, plany, ledgery, code graph context). Do Rusta i COTS też potrzebujesz szerokiego kontekstu.

**Rekomendacja: zamień na bazowy Qwen3.5-27B (MLX 4-bit) jako domyślny model.** Dla czystego kodowania dodaj Qwen3-Coder-30B-A3B jako second slot.

---

## Porównanie modeli (27B-32B class, MLX-compatible)

| Model | Parametry | Kontekst | SWE-bench | LiveCodeBench | HumanEval | VRAM Q4 | MLX | Licencja |
|---|---|---|---|---|---|---|---|---|
| **Qwen3.5-27B** (base) | 27B dense | 262K | 72.4% | 80.7 | ~90% | ~16GB | tak | Apache 2.0 |
| **Qwen3.5-27B-Opus-Distilled-v2** (twój) | 27B dense | **8K** | brak oficjalnych | brak | brak | ~16GB | tak | Apache 2.0 |
| **Qwen3-Coder-30B-A3B** (MoE) | 30B/3B active | 256K | SOTA open | top-tier | top-tier | ~18GB | tak | Apache 2.0 |
| **Qwen2.5-Coder-32B** | 32B dense | 128K | — | — | 92.7% | ~20GB | tak | Apache 2.0 |
| **Gemma 3-27B** | 27B dense | 128K | ~68% | — | ~85% | ~16GB | tak | Gemma |
| **Codestral-22B** | 22B dense | 32K | — | — | ~88% | ~14GB | tak | MNPL |

---

## Analiza per use case

### 1. Rust Development
Rust wymaga modelu z dobrą znajomością borrow checkera, lifetimes, trait bounds. Modele generalistyczne (Qwen3.5-27B) radzą sobie lepiej niż wąsko-kodowe, bo Rust wymaga rozumowania o ownership, nie tylko pattern matchingu.

**Najlepszy: Qwen3.5-27B base** — 262K kontekst pozwala na pełne repo-level understanding. Qwen3-Coder-30B-A3B jako alternatywa do szybkich zadań (3B active = szybka inferencja).

### 2. COTS (RabbitMQ, Terraform, Azure, infrastruktura)
Tu potrzebujesz szerokiego training data (nie tylko kod), znajomości HCL, YAML, ARM templates, Helm charts. Modele code-only (StarCoder, Codestral) tu odpadają.

**Najlepszy: Qwen3.5-27B base** — trénowany na mix kodu i tekstu, zna Terraform, Azure CLI, RabbitMQ configs. 262K kontekst pomaga przy dużych Terraform modułach.

### 3. Forge/FDP (agents, commands, skills)
Forge ma ogromne wymagania kontekstowe: system prompty agentów (agent-entrypoint.js buduje multi-sekcyjne prompty), session ledger, code graph context, plany z frontmatterem, knowledge base. Typowy agent config to 20-50K tokenów.

**Twój distilled model z 8K kontekstem nie nadaje się do tego.** Agent dostaje ucięty kontekst, traci graph context, session warnings, knowledge base — a to jest core value Forge'a.

**Najlepszy: Qwen3.5-27B base** — 262K kontekst, stabilny tool-calling, thinking mode.

### 4. Reasoning
Tu distilled model faktycznie wygrywa — chain-of-thought z Claude Opus jest lepszy od bazowego. Ale zysk z reasoning nie rekompensuje straty 254K tokenów kontekstu.

**Najlepszy do reasoning: Qwen3.5-27B base w thinking mode** — natywnie wspiera `<think>` tags, reasoning jest dobry choć nie na poziomie Claude Opus. Dla krytycznych reasoning tasks i tak używasz API Claude.

---

## Problemy twojego obecnego modelu

1. **Kontekst 8K** — obcięty z 262K. Dealbreaker dla Forge, dużych Terraform modułów, Rust repo-level tasks.
2. **Brak oficjalnych benchmarków** — community vibes, 57K downloads, ale zero weryfikowalnych metryk.
3. **Mały training set** — 3,950 samples (v1) / 14,000 (v2). Dla porównania DeepSeek-R1 distillation: 800K samples.
4. **Utrata multimodalności** — bazowy Qwen3.5-27B obsługuje obrazy, distilled nie.
5. **Stabilność** — community reports mówią o lepszym tool-calling, ale to anecdotal, nie mierzone.

### Co distilled robi dobrze
- Lepsze structured reasoning traces
- Stabilniejszy tool-calling w krótkich sesjach agentowych
- 9+ minut autonomicznej pracy bez interwencji (community tests)
- Native "developer" role support

---

## Rekomendacja końcowa

### Primary model: `mlx-community/Qwen3.5-27B-4bit`
- 262K kontekst, 16GB VRAM, pełna kompatybilność z LM Studio
- Najlepsza jakość kodu w klasie 27B (SWE-bench 72.4%, LiveCodeBench 80.7)
- Rust, Terraform, Azure, Node.js — wszystko jedno modelem
- Thinking mode do reasoning

### Secondary model (opcjonalnie): `qwen3-coder:30b-a3b`
- Wyspecjalizowany w kodowaniu, 256K kontekst
- 3B active params = 3-5x szybsza inferencja niż 27B dense
- Idealny do szybkich code completions, refactorów
- Dostępny w Ollama i MLX

### Zachowaj distilled jako third slot
- Użyteczny do krótkich reasoning-heavy zadań (analiza, planowanie)
- Nie używaj do Forge, nie używaj do czegokolwiek wymagającego >8K kontekstu

---

## Modele za duże na lokalne uruchomienie (ale warte uwagi)

Jeśli kiedyś upgrade'ujesz hardware (Mac Studio M4 Ultra 192GB):

| Model | Params | SWE-bench | Uwagi |
|---|---|---|---|
| Qwen3-Coder-480B-A35B | 480B MoE / 35B active | SOTA open | Wymaga ~60GB+ Q4 |
| DeepSeek-V3.2 | 685B MoE | 67.8% | Za duży na lokalne |
| GLM-5 | 744B MoE / 40B active | 77.8% | Za duży na lokalne |
| MiMo-V2-Flash | 309B MoE / 15B active | 73.4% | Brak MLX support, SGLang only |

---

*Wygenerowano 2026-03-30. Źródła: HuggingFace, InsiderLLM, Onyx AI, Artificial Analysis, community benchmarks.*
