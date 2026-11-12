# FairPR

**Stop AI-slop pull requests without punishing honest contributors.**

Maintainers are drowning in AI-generated PRs that look polished but don't work. Most tools answer by auto-closing PRs, which also drives away real newcomers. FairPR works on **both sides**:

- **For maintainers:** a GitHub Action that checks every PR against your policy and explains what to fix.
- **For contributors (and their AI agents):** `npx fairpr check` runs the same checks *before* you open the PR and adds a proof that maintainers can verify.

### For maintainers

- ✅ **Checks every PR against *your* contribution policy** (AI disclosure, linked issue, size, tests)
- 🔎 **Catches the strongest slop signals**: imports of packages your project doesn't have, placeholder code (`// ... existing code ...`), agent "summary" files, descriptions pasted from a chatbot, and first-time PRs that touch CI workflows
- 💬 **Explains exactly what to fix** in one friendly comment that updates itself
- ⏸️ **Never auto-closes.** Suspicious PRs are put *on hold* with a label, and a maintainer decides
- 🔒 **Safe by design.** It never runs PR code, reads your policy from the default branch only, and stores no data

<!-- TODO before launch: replace with a 20-second GIF of a real PR getting a FairPR comment -->

## Quick start (2 minutes)

**1.** Add `.github/workflows/fairpr.yml`:

```yaml
name: FairPR
on:
  pull_request_target:
    types: [opened, edited, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]
permissions:
  contents: read
  pull-requests: write
  issues: write
jobs:
  fairpr:
    if: github.event_name != 'issue_comment' || (github.event.issue.pull_request && startsWith(github.event.comment.body, '/fairpr'))
    runs-on: ubuntu-latest
    steps:
      - uses: fairpr/fairpr@v0
```

**2.** (Optional) Add `.github/fairpr.yml` with your rules. Without it, sensible defaults are used.

**3.** Not sure yet? Set `mode: dry-run` to see results in the Actions log without commenting on anyone's PR.

### Trying it on your own repo

FairPR skips maintainers and returning contributors by default, so it will skip **your own** test PRs. To test it, add this to `.github/fairpr.yml` on your default branch, then open a PR:

```yaml
skip_maintainers: false
skip_returning_contributors: false
```

Remove these two lines when you're done testing.

## For contributors: `npx fairpr check`

Run this in your clone, on your branch, before opening a PR:

```bash
npx fairpr check
```

It reads the project's rules from the target branch, runs the same checks the maintainers run, asks you three short questions (what problem, what changed, how you tested), runs the project's tests if it defines a `test_command`, and writes a PR description with a **proof**:

```
<!-- fairpr:proof v1 fingerprint: sha256:4c0a... -->
🔏 Self-checked with FairPR: 9 checks passed for this exact code.
```

The proof is a fingerprint of the exact files in your PR. The maintainer-side Action recomputes it, so it can't be copied to a different change. If you edit the code afterwards, just run the check again.

Open the PR straight away with `npx fairpr check --create` (requires the [GitHub CLI](https://cli.github.com)).

<details><summary>All options</summary>

```
--base <branch>        Target branch (default: the remote's default branch)
--remote <name>        Remote of the project (default: upstream, else origin)
--title <text>         PR title (default: last commit message)
--problem <text>       What problem does this solve?
--change <text>        What did you change?
--tested <text>        How did you test it?
--ai <yes|partial|no>  Did you use AI to write this change?
--issue <number>       Issue this PR fixes
--skip-tests           Do not run test_command
--create               Open the PR with gh when all checks pass
--yes                  Never prompt (for scripts and agents)
--json                 Machine-readable output
```
</details>

## For AI coding agents

Agents now open many PRs. Give yours the FairPR skill so its PRs follow each project's rules and disclose AI use honestly:

- **Claude Code:** copy [`skills/fairpr/SKILL.md`](skills/fairpr/SKILL.md) to `~/.claude/skills/fairpr/SKILL.md`
- **Codex, Cursor and others:** add the snippet from [`docs/agents.md`](docs/agents.md) to your `AGENTS.md`

## What contributors see

Each PR gets one of three labels and a single comment:

| Label | Meaning |
|---|---|
| `fairpr: verified` | Follows your policy, with no slop signals. Ready for review. |
| `fairpr: needs info` | Something to fix (e.g. missing disclosure, no description). The contributor gets clear steps. |
| `fairpr: quarantine` | Several slop signals. On hold until a maintainer looks; **not** closed. |

When the contributor pushes a fix or edits the description, the check re-runs and the same comment updates.

**Commands**
- `/fairpr recheck`: run the checks again
- `/fairpr approve`: maintainers (write access) override the result; the approval sticks across later pushes

## Configuration

`.github/fairpr.yml` (every setting optional):

```yaml
ai_policy: allowed_with_disclosure   # allowed | allowed_with_disclosure | not_allowed
require_linked_issue: false
require_tests_for_code_changes: false
max_changed_lines: 800               # lockfiles & generated files are not counted
max_changed_files: 30
min_description_length: 40
mode: label                          # label | comment | dry-run
allowlist: []                        # usernames never checked (bots are always skipped)
skip_maintainers: true
skip_returning_contributors: true    # only first-time contributors are checked
ignore_paths: ["docs/"]
test_command: "npm test"              # run by the contributor CLI before it creates a proof
labels:
  verified: "fairpr: verified"
  needs_info: "fairpr: needs info"
  quarantine: "fairpr: quarantine"
```

With `ai_policy: allowed_with_disclosure`, contributors add one line to the PR description:

```
AI-Assisted: yes | partial | no
```

Tip: add that line to your `.github/pull_request_template.md`.

## The checks

| Check | Type | What it looks for |
|---|---|---|
| `ai-disclosure` | policy | Disclosure line present / AI use allowed |
| `linked-issue` | policy | `Fixes #123` or an issue link (if required) |
| `description` | policy | A real description, not an empty template |
| `size` | policy | Changed lines and files within your limits |
| `tests` | policy or hint | Code changed without any test changes |
| `unknown-imports` | signal | JS/TS or Python imports of packages not in `package.json` / `requirements` / `pyproject.toml` |
| `placeholder-code` | signal | `// ... existing code ...`, `TODO: implement`, "in a real implementation" |
| `summary-docs` | signal | New files like `IMPLEMENTATION_SUMMARY.md` |
| `chat-paste` | signal | "I hope this helps", "Here is the updated code" |
| `workflow-changes` | signal | First-time contributors editing `.github/workflows` |
| `spray` | signal | Accounts opening many PRs across GitHub in 24h |
| `new-account`, `text-tells`, `comment-density` | hint | Context for reviewers only; never changes the result |

**Verdict rules:** 2+ signals, or a signal plus a policy problem, means **quarantine**. Any policy problem or a single signal means **needs info**. Otherwise the PR is **verified**. Hints never change the verdict.

**Self-check proof:** a valid proof is shown in the comment (🔏). A proof that no longer matches the code is reported as a note asking the contributor to re-run the check.

**Avoiding false accusations:** in monorepos or projects where FairPR can't see every dependency file, unknown imports are reported as hints instead of signals.

## Security

- Uses `pull_request_target` so it can comment on PRs from forks, but **never checks out or runs PR code**. Don't add a checkout of the PR head to this workflow.
- The policy is read from your **default branch**, so a PR can't change its own rules.
- PR text is treated as data. No AI model decides the verdict, so prompt injection in a PR can't approve it.
- No external services, no data storage. Everything lives in your repo's comments and labels.

## Development

```bash
npm ci
npm test          # unit tests
npm run build     # bundles dist/ (Action) and bin/ (CLI); commit both
npm run e2e       # runs both bundles end-to-end (simulated GitHub + real git repos)
```

## License

MIT
