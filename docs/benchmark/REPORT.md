# FairPR benchmark on real pull requests

Measured **972** closed pull requests from **first-time contributors** in 10 public repositories, created since 2025-06-01.

Each PR was checked with FairPR exactly as the GitHub Action would check it, then compared with what the maintainers actually did.

## Headline numbers

- **14.3%** of PRs that maintainers labeled spam/invalid/AI slop were put on hold (95% CI 5.7–31.5%), n=28.
- **3.7%** of PRs closed without merging were put on hold (95% CI 2.5–5.4%), n=628.
- **0.0%** of PRs that were **merged** were put on hold (95% CI 0.0–1.2%), n=316. This is the false-alarm rate on good PRs (an upper bound: a few merged PRs were still low quality).

## Verdicts by outcome

| What maintainers did | PRs | Verified | Needs info | On hold | Any slop signal |
|---|---:|---:|---:|---:|---:|
| Labeled spam / invalid / AI slop | 28 | 71.4% | 14.3% | 14.3% | 14.3% |
| Closed without merging | 628 | 79.0% | 17.4% | 3.7% | 6.4% |
| Merged | 316 | 93.7% | 6.3% | 0.0% | 0.9% |

"Needs info" is mostly policy items (short description, very large PR). "On hold" requires slop signals. The AI-disclosure rule was switched off because these projects do not require it.

## How often each check fired

| Check | Labeled spam / invalid / AI slop | Closed without merging | Merged |
|---|---:|---:|---:|
| `comment-density` | 0.0% | 1.6% | 0.6% |
| `description` | 25.0% | 12.1% | 3.2% |
| `new-account` | 0.0% | 2.2% | 0.3% |
| `size-files` | 3.6% | 6.8% | 0.3% |
| `size-lines` | 14.3% | 10.2% | 2.2% |
| `summary-docs` | 3.6% | 1.1% | 0.0% |
| `tests` | 67.9% | 36.5% | 41.5% |
| `text-tells` | 0.0% | 0.5% | 0.0% |
| `unknown-imports` | 0.0% | 2.1% | 1.6% |
| `workflow-changes` | 10.7% | 5.9% | 0.9% |

A useful check fires much more often on rejected PRs than on merged ones.

## By repository

| Repository | PRs | Merged on hold | Closed on hold | Sampling |
|---|---:|---:|---:|---|
| godotengine/godot | 167 | 0.0% (0/67) | 6.0% (6/100) |  |
| curl/curl | 101 | 0.0% (0/1) | 0.0% (0/100) |  |
| ghostty-org/ghostty | 155 | 0.0% (0/55) | 13.0% (13/100) |  |
| excalidraw/excalidraw | 144 | 0.0% (0/44) | 5.0% (5/100) |  |
| n8n-io/n8n | 76 | 0.0% (0/3) | 1.4% (1/73) |  |
| langchain-ai/langchain | 187 | 0.0% (0/87) | 0.0% (0/100) |  |
| vercel/next.js | 46 | 0.0% (0/25) | 4.8% (1/21) |  |
| microsoft/vscode | 3 | n/a (0/0) | 0.0% (0/3) | GitHub's list of closed PRs ended early; 400 PRs listed, 361 by maintainers or returning contributors, 21 by bots |
| home-assistant/core | 13 | 0.0% (0/13) | n/a (0/0) | GitHub's list of closed PRs ended early; 200 PRs listed, 176 by maintainers or returning contributors, 12 by bots |
| facebook/react | 80 | 0.0% (0/21) | 1.7% (1/59) |  |

Sample sizes differ because projects receive very different numbers of first-time PRs. Each project was capped at 100 merged and 100 not-merged PRs.

## Merged PRs with at least one slop signal (check these for false alarms)

- [excalidraw/excalidraw#11075](https://github.com/excalidraw/excalidraw/pull/11075): fix: pin 9 actions to commit SHA *(workflow-changes)*
- [langchain-ai/langchain#40794](https://github.com/langchain-ai/langchain/pull/40794): docs(infra): fix AGENTS.md root setup guidance and package doc accuracy *(workflow-changes)*
- [langchain-ai/langchain#36989](https://github.com/langchain-ai/langchain/pull/36989): ci(infra): overlay local `langchain-*` installs for external partners *(workflow-changes)*

## Labeled low-quality PRs that FairPR verified (missed)

- [godotengine/godot#125389](https://github.com/godotengine/godot/pull/125389): Web: Don't busy-wait in add_frame_delay() on non-threaded builds *(no findings)*
- [godotengine/godot#125226](https://github.com/godotengine/godot/pull/125226): 🤖 Fix MultiMesh interpolation with a separate rendering thread *(no findings)*
- [godotengine/godot#125200](https://github.com/godotengine/godot/pull/125200): 🤖 Round vertex colors instead of truncating when packing to 8 bits *(no findings)*
- [godotengine/godot#125199](https://github.com/godotengine/godot/pull/125199): 🤖 Fix BaseMaterial3D `clearcoat_texture` description of the green channel *(no findings)*
- [godotengine/godot#125114](https://github.com/godotengine/godot/pull/125114): 🤖 GUI: Preserve plural SpinBox input on focus loss *(no findings)*
- [godotengine/godot#125112](https://github.com/godotengine/godot/pull/125112): 🤖 TextServer: Fix inline object positions when justified *(no findings)*
- [godotengine/godot#125099](https://github.com/godotengine/godot/pull/125099): 🤖 Core: Wake idle workers after low-priority tasks drain *(no findings)*
- [godotengine/godot#124907](https://github.com/godotengine/godot/pull/124907): 🤖 Rendering: Skip directional shadow tests for non-casters *(no findings)*
- [godotengine/godot#124846](https://github.com/godotengine/godot/pull/124846): 🤖 Fix release provisioning profile UUID environment variable for Apple embedded export *(no findings)*
- [godotengine/godot#124730](https://github.com/godotengine/godot/pull/124730): 🤖 GLES3: Fix WebGL index buffer updates *(no findings)*
- [godotengine/godot#125406](https://github.com/godotengine/godot/pull/125406): 🤖 Core: Fix reentrancy use-after-free in Variant container conversion *(no findings)*
- [godotengine/godot#124226](https://github.com/godotengine/godot/pull/124226): 🤖 Tests: Cover placeholder script instance updates *(no findings)*
- [godotengine/godot#123949](https://github.com/godotengine/godot/pull/123949): 🤖 Wayland: Use unaccelerated relative motion when the mouse is captured *(no findings)*
- [godotengine/godot#123935](https://github.com/godotengine/godot/pull/123935): 🤖 Fix crash when capturing a track with an unresolved path *(no findings)*
- [godotengine/godot#123902](https://github.com/godotengine/godot/pull/123902): 🤖 Web: Handle text from input methods that don't compose *(no findings)*
- [godotengine/godot#123760](https://github.com/godotengine/godot/pull/123760): 🤖 Wayland: Fix occasional hang on exit *(no findings)*
- [godotengine/godot#123721](https://github.com/godotengine/godot/pull/123721): 🤖 macOS: Fix crash when running `--embedded` without a debugger connection *(no findings)*
- [godotengine/godot#123677](https://github.com/godotengine/godot/pull/123677): Fix Enter handling in project manager *(no findings)*
- [godotengine/godot#123472](https://github.com/godotengine/godot/pull/123472): GDScript: Use narrowed types from `is` type checks in `if` blocks *(no findings)*
- [godotengine/godot#123463](https://github.com/godotengine/godot/pull/123463): 🤖 WebSocket: Fix IPv6 literal URLs *(no findings)*

## Examples: closed PRs put on hold

- [godotengine/godot#124501](https://github.com/godotengine/godot/pull/124501): Develop *(description, size-lines, size-files, workflow-changes)*
- [ghostty-org/ghostty#15185](https://github.com/ghostty-org/ghostty/pull/15185): fix(terminal,git): eliminate TUI resize blank flash and simplify commit search prompt *(size-lines, size-files, workflow-changes)*
- [ghostty-org/ghostty#14799](https://github.com/ghostty-org/ghostty/pull/14799): input: select what a Helix word motion moves over, as Helix does *(size-lines, size-files, workflow-changes)*
- [excalidraw/excalidraw#12221](https://github.com/excalidraw/excalidraw/pull/12221): Fix/deep zoom wysiwyg upscale *(size-lines, size-files, workflow-changes)*
- [excalidraw/excalidraw#12080](https://github.com/excalidraw/excalidraw/pull/12080): Hotfix/correctif urgent *(description, workflow-changes)*
- [excalidraw/excalidraw#12062](https://github.com/excalidraw/excalidraw/pull/12062): fix(repo): Revert config *(description, size-lines, size-files, workflow-changes)*
- [excalidraw/excalidraw#11749](https://github.com/excalidraw/excalidraw/pull/11749): Trae/agent 7ahpg i *(description, size-lines, workflow-changes)*
- [excalidraw/excalidraw#11546](https://github.com/excalidraw/excalidraw/pull/11546): Rag self improve campaign *(description, size-lines, size-files, summary-docs, workflow-changes)*
- [facebook/react#37650](https://github.com/react/react/pull/37650): Jjj *(description, size-lines, size-files, workflow-changes)*
- [godotengine/godot#123885](https://github.com/godotengine/godot/pull/123885): Add tvOS platform port *(size-lines, size-files, workflow-changes)*
- [ghostty-org/ghostty#14736](https://github.com/ghostty-org/ghostty/pull/14736): docs(khostty/phase-b-gtk): wire-up specification *(size-lines, size-files, summary-docs, workflow-changes)*
- [ghostty-org/ghostty#14720](https://github.com/ghostty-org/ghostty/pull/14720): test(ipc): wire agent IPC into the Zig build graph (Phase 0) *(size-lines, size-files, summary-docs, workflow-changes)*
- [ghostty-org/ghostty#14271](https://github.com/ghostty-org/ghostty/pull/14271): macos/git: 主干线条颜色保持一致，remote 领先 commit 以虚线区分 *(size-lines, size-files, workflow-changes)*
- [ghostty-org/ghostty#14059](https://github.com/ghostty-org/ghostty/pull/14059): Wrong repo, delete this *(size-lines, size-files, workflow-changes)*
- [ghostty-org/ghostty#13917](https://github.com/ghostty-org/ghostty/pull/13917): Simulator pane *(size-lines, size-files, summary-docs)*
- …and 8 more in results.jsonl

## Method and limits

- Repositories measured: godotengine/godot, curl/curl, ghostty-org/ghostty, excalidraw/excalidraw, vercel/next.js, facebook/react, n8n-io/n8n, langchain-ai/langchain, home-assistant/core, microsoft/vscode.
- Sample: the most recent closed PRs per repository whose author had no previous merged contribution there (GitHub "first-time contributor" or "none"), excluding bots and drafts.
- "Closed without merging" includes many reasonable PRs (duplicates, stale, superseded), so its on-hold rate is not a precision score. The merged group is the fair measure of false alarms.
- Some projects (for example curl) accept changes by pushing the commit themselves and closing the PR, so GitHub shows those PRs as "closed without merging" even though the change was accepted.
- For a few very large repositories (VS Code, Home Assistant) GitHub's API stopped returning closed PRs after a few hundred, and most of those were by maintainers or returning contributors, so their samples are small.
- GitHub reports the author's *current* relationship to the repo. Merged PRs from authors now shown as "contributor" were counted when the commit history of the project showed no earlier commit by them.
- The "spray" check (many PRs across GitHub in 24 hours) cannot be reconstructed for past PRs and was not measured.
- Policy used: ai_policy=allowed, max_changed_lines=800, max_changed_files=30, min_description_length=40.
- Raw per-PR results are in `results.jsonl` so anyone can re-check them.
