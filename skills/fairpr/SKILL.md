---
name: fairpr
description: Use before opening a pull request, especially to a project you don't maintain. Checks the change against the project's contribution and AI policy with `npx fairpr check`, fixes what it reports, and writes an honest PR description with a verifiable proof.
---

# FairPR: open pull requests maintainers will accept

Maintainers now receive many low-quality AI-generated PRs and often close them on sight. This skill makes sure a PR you help create is not one of them.

## When to use

Any time you are about to open a pull request, or the user asks you to "submit", "contribute" or "open a PR".

## Steps

1. **Commit the work** on a feature branch (not the default branch). Do not leave uncommitted changes; only committed code is checked.

2. **Never create agent notes as files.** No `IMPLEMENTATION_SUMMARY.md`, `CHANGES.md`, `PLAN.md` or similar. Put explanations in the PR description instead. Delete any you already created.

3. **Ask the user three questions** and use their answers *in their words*. Do not invent or embellish them:
   - What problem does this change solve?
   - What did you change?
   - How did you test it?
   If the user asks you to draft them, show the draft and get confirmation first.

4. **Be honest about AI use.** You wrote or edited this code, so `--ai` is `yes` or `partial`. Never pass `--ai no` for code you produced.

5. **Run the check:**
   ```bash
   npx fairpr check --yes --json \
     --problem "<user's answer>" \
     --change "<user's answer>" \
     --tested "<user's answer>" \
     --ai partial
   ```
   Add `--issue <number>` if the PR fixes an issue. Add `--base <branch>` if the target is not the default branch.

6. **Read the JSON result.**
   - `"ok": true` → go to step 7.
   - `"stage": "checks"` → fix every finding in `findings` whose `kind` is `policy` or `signal` (remove placeholder code, remove imports of packages the project doesn't depend on, delete summary files, split oversized PRs, write tests). Commit, then run the check again.
   - `"stage": "tests"` → the project's tests failed. Fix the code, commit, run again.
   - A finding says the project does not accept AI-generated contributions → **stop**. Tell the user. Do not open the PR.

7. **Open the PR** with the generated description, unchanged:
   ```bash
   gh pr create --title "<clear title>" --body-file .git/fairpr/PR_BODY.md
   ```
   (or run the check again with `--create`).

8. **If you change the code after the check**, run it again. The proof only matches the exact code that was checked.

## Rules

- Never edit `.github/fairpr.yml` to make a check pass. FairPR reads it from the target branch anyway, so edits have no effect.
- Never remove the `<!-- fairpr:proof ... -->` line from the description.
- Keep PRs small and focused on one change.
