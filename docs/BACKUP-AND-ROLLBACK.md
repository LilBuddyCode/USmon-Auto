# Backup and rollback strategy

Last updated: 2026-06-10 (Day 5 of the 14-day USmon-Auto sprint)

This document is the operational answer to: *"What do we do if it breaks?"*
It also doubles as the answer to: *"How do we rebuild this from scratch if everything else is gone?"*

The deliberate principle: **multiple independent backup layers, each capable of recovering the project alone.**

---

## Layer 1 — Documentation as recovery

The `_starter/` folder is the entire source of truth. If everything else burns down — the Vercel project, the Neon database, every clone — the codebase can be rebuilt from these files alone.

Critical docs that make recovery possible:

| File | Recovers |
|---|---|
| `README.md` | Project overview, surfaces, conventions |
| `BUILD-LOG.md` | Day-by-day what shipped, why, what broke, what was learned |
| `docs/adr/*.md` | The 8 architecture decisions and their trade-offs. ADR-008 captures the customer-driven pivot. ADR-005 is the PHI floor. |
| `docs/BACKUP-AND-ROLLBACK.md` | This file. Recovery procedures. |
| `schema.sql` | Full DB schema, idempotent (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS) |
| `.env.example` | Every env var that must be configured |
| `package.json` | Every dependency at a known version |

And the operational records in the vault (not in the repo, by design — `_data/` is gitignored to prevent leaking customer PII or PHI):

| File | Recovers |
|---|---|
| `_data/toya-po-001.md` | The catalog seed data: supplier, SKUs, prices, lot conventions |
| `_data/scouting-log.md` | USmon navigation paths we learned |
| `_data/usmon-auto-keys.txt` (in vault root) | All secrets (API keys, DB conn string, bot token). Never committed. |

**Recovery test:** anyone given the `_starter/` repo + the `_data/` notes + the secrets file can rebuild a working deployment in under an hour. That's the bar.

---

## Layer 2 — Git history as version control

The repository is at `github.com/LilBuddyCode/USmon-Auto` (private).

Every commit represents a known-good state of the code. Major commits:

| Commit | Day | What it represents |
|---|---|---|
| `528ae76` | 0 | Initial commit (README only) |
| `c3711af` | 1 | Day 1 starter — ADRs, schema, parser, 6 passing tests |
| `d309636` | 1 | Schema rewrite (topologically ordered) + `/api/admin/migrate` |
| `9f997a6` | 2 | Telegram webhook + button UI + file-upload handler |
| `89acbad` | 3 | Stage 1 capture: ADR-008 + parser + supply_requests |
| `3a0c658` | 4 | Day 4 bundle: sort fix + Mark Ordered + Draft Email |
| `5c6dfdd` | 5 | Day 5: Mark Received + Lot # capture + pending-action state |

**Roll back code to any commit:**

```bash
git revert <commit-sha>            # creates a new revert commit (safer)
# OR
git reset --hard <commit-sha>      # rewrites main (only if no one else has pulled)
git push --force-with-lease origin main
```

Vercel will auto-redeploy from the new HEAD within ~90 seconds.

---

## Layer 3 — Vercel deployment history

Every push to `main` creates a Vercel deployment. **Past deployments stay available indefinitely** — Vercel lets you promote any prior deployment back to production with one click.

**To roll back a deploy without touching code:**

1. Go to https://vercel.com/lilbuddycodes-projects/usmon-auto-staging/deployments
2. Find the last known-good deployment (probably the one before the breaking commit)
3. Click the three-dot menu → **Promote to Production** (for staging this means "make the alias point at this older deploy")
4. The alias `usmon-auto-staging.vercel.app` is now serving the older code

No git commits required. The bad commit stays in main as a record; the deploy alias just no longer serves it.

**When to use this vs. a git revert:**
- Promote-back-an-old-deploy = fast recovery (~30 seconds), but main still has the broken code
- Git revert + push = slower (~90 seconds for redeploy), but main is clean

Use Vercel promote during an active incident. Follow up with a git revert when there's time.

---

## Layer 4 — Neon database backups

Neon's free tier includes automatic **6-hour history retention**. This means the database can be restored to any point in time within the last 6 hours. (Paid tiers extend this to 7+ days.)

**To restore the database:**

1. Go to Neon console → `usmon-auto` project → Branches
2. Click the production branch → "Restore from history"
3. Pick a timestamp before the data was corrupted
4. Confirm

This creates a new branch from that point. To make it primary, swap the connection string in Vercel env vars.

**Schema migrations are additive by design:**

Every schema change in `schema.sql` uses `CREATE TABLE IF NOT EXISTS` or `ADD COLUMN IF NOT EXISTS`. This means re-running the migration is always safe. It also means **we don't have explicit "down" migrations** — rolling forward is the recovery model.

If a schema change must be reversed:
- New migration that drops the offending column (`ALTER TABLE ... DROP COLUMN ... IF EXISTS`)
- Bump the migration version (e.g. via comment header) so old envs can re-run it
- Test against a Neon branch first before applying to main

---

## Layer 5 — Secrets and rotation

Secrets are in `D:\Obsidian\usmon-auto-keys.txt` (local to Duran's machine, never committed). They are also active in Vercel env vars.

**When to rotate:**

| Trigger | Rotate |
|---|---|
| Telegram bot token visible in any screenshot we share publicly | `@BotFather` → `/revoke` → `/token` → update Vercel env |
| Anthropic API key visible in error logs or screenshots | Anthropic console → revoke → generate new → update Vercel env |
| Neon connection string visible | Neon → Reset password → update Vercel env |
| Dashboard password compromised | Pick new strong one → update Vercel env |
| End of Day 14 (portfolio submission) | Rotate ALL of the above by default. The staging bot becomes public-facing; minimize blast radius. |

**Rotation runbook:**

1. Mint new secret in the source (Telegram, Anthropic, Neon, or just pick a new value)
2. Update `D:\Obsidian\usmon-auto-keys.txt` with new value
3. Update Vercel env var (Settings → Environment Variables → edit → re-deploy)
4. Wait ~90 seconds for Vercel redeploy
5. Verify health endpoint still returns `ok:true` (proves DB conn works)
6. Verify bot still responds to `/menu` (proves bot token works)
7. Revoke old secret if applicable (so it can't be used anymore)

---

## Disaster scenarios

### Scenario A: Vercel deploy is broken (white screen, crashes, 500s)

**Recovery time: 30 seconds**

1. Go to Vercel deployments page
2. Find the last "Ready" deployment that worked
3. Promote it
4. Tell anyone affected (via bot DM or chat) that the issue is being fixed

Diagnose offline with the git diff.

### Scenario B: Database tables are corrupted or missing

**Recovery time: 2-5 minutes**

1. Run the migration endpoint: `https://usmon-auto-staging.vercel.app/api/admin/migrate?password=...`
2. Migration is idempotent — re-running creates anything missing without touching what's there
3. If actual data corruption, restore from Neon's 6-hour history

If the migration endpoint itself is broken: paste `schema.sql` directly into Neon's SQL Editor.

### Scenario C: Bot stops responding

**Recovery time: 1-5 minutes**

1. Check `/api/health` returns 200 — proves deploy is up and DB is reachable
2. Check Vercel function logs for handler errors
3. If errors → roll back via Vercel promote
4. Verify webhook is still set: `https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
   - If webhook URL is empty or wrong, re-set it: `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://usmon-auto-staging.vercel.app/api/telegram/webhook`

### Scenario D: Secret is exposed (token in a screenshot, key in a commit)

**Recovery time: 10 minutes**

1. Rotate the secret immediately (see Rotation Runbook above)
2. Audit logs in the source service for any unauthorized use
3. If the leaked secret was in a git commit, also use `git filter-repo` or `BFG Repo-Cleaner` to remove it from history
4. Force-push the cleaned history

### Scenario E: Catastrophic — Vercel, Neon, GitHub all down or unrecoverable

**Recovery time: 1-2 hours**

1. From the `_starter/` folder, init a new git repo and push to a fresh GitHub repo
2. Create new Vercel project, point at the new repo
3. Create new Neon project, paste the connection string into Vercel env
4. Create new Anthropic API key, paste into Vercel env
5. Create new Telegram staging bot via @BotFather, paste token into Vercel env
6. Set webhook URL via `setWebhook`
7. Run migration endpoint
8. Run seed endpoint
9. Smoke-test by texting the bot
10. Reconnect existing users (the operator + 2 techs) to the new bot handle

The deployment is fully reproducible from the files in this folder.

---

## Why this matters for the portfolio narrative

Hiring managers reading the BUILD-LOG and the repo are evaluating: *"can this person handle production?"*

Production is not when things go right. It's when:
- A deploy breaks at 9 PM Friday
- A secret leaks via a screenshot in a Slack channel
- A schema migration fails halfway through
- A vendor API rate-limits during a customer demo

Having documented recovery procedures, additive-only migrations, multi-layer backups, and a tested disaster-recovery plan is what separates portfolio projects from production code.

This document exists so that if the worst happens, the recovery is mechanical, not improvised.

---

## Cross-links

- [[../docs/adr/005-non-phi-boundary]] — what cannot be in any backup
- [[../docs/adr/008-capture-first-over-csv-source-of-truth]] — the pivot rationale
- [[../BUILD-LOG]] — the narrative of what got built
- [[../README]] — top-level project overview
