# 9router Infrastructure Remediation (2026-09-15 Review)

- **Date:** 2026-09-15
- **Status:** Phase 2 — VPS execution pending
- **Scope:** Harden 9router deployment against 6 findings (cloudflared pin, log rotation, builder cache floor, JWT rotation, VPS cleanup)

---

## Overview

Post-infra-review remediation: version pins, prune policies, session hygiene, disk/service cleanup. Three phases: deploy repo changes (merged), 9router fork docs (this repo), VPS execution.

---

## Task Summary

| ID | Finding | Action | Status |
|----|---------|--------|--------|
| T1 | JWT secret rotation plan | Write `jwt-rotation.md` runbook | ✓ Done (this repo) |
| T2 | Full remediation plan | Write `remediation-plan.md` tracker | ✓ Done (this file) |
| T3 | Cloudflared floating latest | Pin `cloudflare/cloudflared:2026.9.1` | ✓ Done (deploy repo PR #4) |
| T4 | No log rotation | Add x-logging anchor, apply to 5 services | ✓ Done (deploy repo PR #4) |
| T5 | Builder prune 168h | Lower to 72h in CI (deploy.yml) | ✓ Done (deploy repo PR #4) |
| T6 | Kiro token-refresh disable | Add `DISABLE_BACKGROUND_TOKEN_REFRESH=true` to `env/9router.env` (VPS only) | **Pending VPS** |
| T7 | api JWT_SECRET removal | Remove from `env/9router-api.env` (VPS only) | **Pending VPS** |
| T8 | Unused data/ growth | Audit+prune `/opt/9router/data/` (manual VPS step, post-backup) | **Pending VPS** |
| T9 | JWT secret rotation | Follow `jwt-rotation.md` runbook | **Deferred (T1 review first)** |
| T10 | Verification checklist | Post-deploy health check | **Pending all tasks** |

---

## T6 — Disable Kiro Background Token Refresh

**Why:** The codebase has a Kiro OAuth background refresh loop (`src/sse/services/backgroundTokenRefresh.js`) that runs every 10 minutes when Kiro connections exist. The 9router instance does NOT use Kiro — no connections, no OAuth flows — so the loop is dead code that still ticks. Disabling it eliminates needless work cycles.

**Action (VPS):**
```bash
ssh <vps>
cd /opt/9router
# Edit env/9router.env and add:
DISABLE_BACKGROUND_TOKEN_REFRESH=true

# Recreate the container to load the new env:
docker compose --profile dashboard up -d --force-recreate 9router
```

**Verification:**
```bash
docker logs 9router --tail 50 | grep -i token
# Expected: no "BG_TOKEN_REFRESH" log entries post-restart
```

**Note:** Accepted values (case-insensitive): `1`, `true`, `yes`, `on`.

---

## T7 — Remove api JWT_SECRET

**Why:** The api service (`9router-api`) has `JWT_SECRET` in its env file, but the api codebase contains **zero jwt code**. That env var is vestigial (likely docs copypasta) — safe to remove.

**Action (VPS):**
```bash
ssh <vps>
cd /opt/9router
# Edit env/9router-api.env and delete the JWT_SECRET line
# Then recreate the container (or next deploy will pick it up):
docker compose up -d --force-recreate 9router-api
```

**Verification:** `docker exec 9router-api env | grep JWT_SECRET` returns nothing.

---

## T8 — Data Directory Audit & Prune

**Why:** The `/opt/9router/data/` directory accumulates SQLite DBs, legacy files, and orphaned state over deployments. Left unchecked, it grows into multi-GB disk waste and slows down backups/migrations.

**Targets (ordered by expected reclaim size):**
1. **Logs/debug artifacts** — dev-time `*.log` files, crash dumps, debug snapshots
2. **Orphaned OAuth tokens** — If the DB has OAuth rows for decommissioned providers (e.g. Kiro, now unused)
3. **Stale `jwt-secret` fallback** — The `/app/data/jwt-secret` file is dormant (overridden by env `JWT_SECRET`) but holds an old value

**Action (VPS, requires backup first):**

```bash
ssh <vps>
cd /opt/9router

# 1. Backup the data directory (safety):
sudo tar czf ~/9router-data-backup-$(date +%Y%m%d-%H%M%S).tar.gz data/

# 2. List top 20 largest files:
du -ah data/ | sort -rh | head -20

# 3. Identify safe-delete candidates:
# - *.log files (unless actively debugging a current issue)
# - jwt-secret file (stale, overridden by env; see T9 runbook for rotation steps)
# - Orphaned provider subdirs (if the folder structure has provider-specific state you no longer use)

# 4. Example prune (adjust paths based on du output):
# rm data/9router/*.log
# rm data/9router/jwt-secret  # Only if env JWT_SECRET is set (see T9 runbook)

# 5. Reclaim check:
df -h /opt
```

**Verification:**
- [ ] Backup tar.gz created and valid (`tar tzf <backup>` lists files)
- [ ] No LLM/API traffic degradation post-prune
- [ ] Dashboard still loads (if you pruned DB-adjacent files)
- [ ] Disk usage reduced (compare `df -h /opt` before/after)

**Caution:** Do NOT delete `data/9router/db.sqlite` (the live profiles/settings DB). If unsure whether a file is safe to delete, skip it or verify with the codebase first.

---

## T9 — JWT Secret Rotation

**Status:** Deferred until T1 runbook (`jwt-rotation.md`) is reviewed and approved.

**Steps:** Follow the complete runbook at `changelog/20260915-REMED-jwt-rotation.md` in this repo.

**Prerequisites:**
- T6/T7/T8 completed (env edits + cleanup) to avoid layering config changes mid-rotation
- VPS data backup (T8 step 1 covers this)

**Outcome:** New 64-hex secret in `env/9router.env`, one dashboard re-login wave, zero LLM/API impact.

---

## T10 — Verification Checklist

Run **after T6/T7/T8 VPS steps** (and optionally T9, if rotation proceeds):

- [ ] **Logs clean:** `docker logs 9router --tail 50` → no errors, no token-refresh ticks (T6)
- [ ] **api env clean:** `docker exec 9router-api env | grep JWT_SECRET` returns nothing (T7)
- [ ] **Disk reclaimed:** `df -h /opt` shows reduced usage (T8)
- [ ] **LLM/API health:** `curl https://<domain>/v1/responses` returns 200 (unaffected by env/cleanup changes)
- [ ] **Dashboard reachable:** `https://<domain>` loads, login works (if T9 rotation done, expect one re-login)
- [ ] **Log rotation active:** `docker inspect --format '{{.HostConfig.LogConfig}}' 9router` shows `max-size=10m, max-file=3` (T4)
- [ ] **Builder cache floor:** Next deploy checks `~/.cache/docker/buildx` — stale builders pruned at 72h (T5, verifiable post-deploy)
- [ ] **Cloudflared pinned:** `docker compose --profile dashboard config | grep cloudflared` shows `image: cloudflare/cloudflared:2026.9.1` (T3)

---

## References

- **T1 runbook:** `changelog/20260915-REMED-jwt-rotation.md` (this repo)
- **Deploy repo PR:** https://github.com/vianhanif/9router-deploy/pull/4 (T3/T4/T5)
- **REMED task doc (deploy repo):** `9router-deploy/changelog/20260915-REMED-9router-remediation.md`
- **Code references:**
  - JWT: `src/lib/auth/dashboardSession.js`
  - Kiro kill-switch: `src/sse/services/backgroundTokenRefresh.js` (line 148: `isTruthyEnv(DISABLE_BACKGROUND_TOKEN_REFRESH)`)
  - Data dir: `src/lib/dataDir.js` (line 37: `DATA_DIR = getDataDir()`)
