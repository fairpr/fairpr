# ProofPR

**Stop AI-slop pull requests without punishing honest contributors.**

Maintainers are drowning in AI-generated PRs that look polished but don't work. Most tools answer by auto-closing PRs, which also drives away real newcomers. ProofPR takes a different approach:

- ✅ **Checks every PR against *your* contribution policy** (AI disclosure, linked issue, size, tests)
- 🔎 **Catches the strongest slop signals**: imports of packages your project doesn't have, placeholder code (`// ... existing code ...`), agent "summary" files, descriptions pasted from a chatbot, and first-time PRs that touch CI workflows
- 💬 **Explains exactly what to fix** in one friendly comment that updates itself
- ⏸️ **Never auto-closes.** Suspicious PRs are put *on hold* with a label, and a maintainer decides
- 🔒 **Safe by design.** It never runs PR code, reads your policy from the default branch only, and stores no data

<!-- TODO before launch: replace with a 20-second GIF of a real PR getting a ProofPR comment -->

## Quick start (2 minutes)

**1.** Add `.github/workflows/proofpr.yml`:

```yaml
name: ProofPR
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
  proofpr:
    if: github.event_name != 'issue_comment' || (github.event.issue.pull_request && startsWith(github.event.comment.body, '/proofpr'))
    runs-on: ubuntu-latest
    steps:
      - uses: proofpr/proofpr@v0
```

**2.** (Optional) Add `.github/proofpr.yml` with your rules. Without it, sensible defaults are used.

**3.** Not sure yet? Set `mode: dry-run` to see results in the Actions log without commenting on anyone's PR.

## What contributors see

Each PR gets one of three labels and a single comment:

| Label | Meaning |
|---|---|
| `proofpr: verified` | Follows your policy, with no slop signals. Ready for review. |
| `proofpr: needs info` | Something to fix (e.g. missing disclosure, no description). The contributor gets clear steps. |
| `proofpr: quarantine` | Several slop signals. On hold until a maintainer looks; **not** closed. |

When the contributor pushes a fix or edits the description, the check re-runs and the same comment updates.

**Commands**
- `/proofpr recheck`: run the checks again
- `/proofpr approve`: maintainers (write access) override the result; the approval sticks across later pushes

## Configuration

`.github/proofpr.yml` (every setting optional):

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
labels:
  verified: "proofpr: verified"
  needs_info: "proofpr: needs info"
  quarantine: "proofpr: quarantine"
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

**Avoiding false accusations:** in monorepos or projects where ProofPR can't see every dependency file, unknown imports are reported as hints instead of signals.

## Security

- Uses `pull_request_target` so it can comment on PRs from forks, but **never checks out or runs PR code**. Don't add a checkout of the PR head to this workflow.
- The policy is read from your **default branch**, so a PR can't change its own rules.
- PR text is treated as data. No AI model decides the verdict, so prompt injection in a PR can't approve it.
- No external services, no data storage. Everything lives in your repo's comments and labels.

## Development

```bash
npm ci
npm test                         # unit tests
npm run build                    # bundles dist/ (commit it)
node test/e2e/mock-github.mjs    # runs the real bundle against a simulated GitHub
```

## License

MIT
