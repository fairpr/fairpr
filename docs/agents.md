# Using FairPR with AI coding agents

## Claude Code (skills)

Copy the skill into your skills folder:

```bash
mkdir -p ~/.claude/skills/fairpr
curl -fsSL https://raw.githubusercontent.com/fairpr/fairpr/main/skills/fairpr/SKILL.md -o ~/.claude/skills/fairpr/SKILL.md
```

Claude Code will use it automatically before opening pull requests.

## Codex, Cursor and other agents (AGENTS.md)

Add this to your project's `AGENTS.md` (or `.cursor/rules`):

```markdown
## Pull requests
Before opening any pull request:
1. Commit all work on a feature branch. Never create summary/notes markdown files about your own work.
2. Ask me: what problem it solves, what changed, how it was tested. Use my words.
3. Run: npx fairpr check --yes --json --problem "..." --change "..." --tested "..." --ai partial
4. Fix every finding of kind "policy" or "signal", commit, and re-run until "ok": true.
5. If the project does not accept AI contributions, stop and tell me.
6. Open the PR with: gh pr create --title "..." --body-file .git/fairpr/PR_BODY.md
```
