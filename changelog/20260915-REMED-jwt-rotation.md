# JWT Secret Rotation Runbook

- **Date:** 2026-09-15
- **Scope:** 9router dashboard JWT secret rotation (HS256, 24h expiry, single-secret)
- **Risk:** Low — zero LLM/API downtime, one re-login wave
- **Rollback:** Restore old value + recreate container (users re-login)

---

## Context

9router signs/verifies dashboard session tokens with a single HS256 secret (`JWT_SECRET`) configured per instance. The **api service does not use it** — its `JWT_SECRET` env var is present for docs consistency only (no jwt code exists in the api codebase).

**Secret resolution** (once at container start):
1. `process.env.JWT_SECRET` → if set, use it
2. Fallback: read `${DATA_DIR}/jwt-secret` → if absent, generate + write it
3. The loaded value is bound to module scope (`SECRET`) and never reloaded until container restart

**Current deployment:**
- VPS: `/opt/9router` (compose project root)
- DATA_DIR: `/app/data` (container path) mounted from `./data/9router`
- Secret sources: `env/9router.env` (env dominates) + persisted `data/9router/jwt-secret` (dormant fallback — exists but never read while env is set)

**Impact:**
- Rotation invalidates all live dashboard sessions → users re-login once
- LLM/API traffic unaffected (JWT is dashboard-only)
- Zero downtime (9router container recreate takes ~2–5s)

---

## Rotation Procedure

### Prerequisites

- SSH access to the VPS
- Backup `/opt/9router/data` before rotating (safety)
- Access to `env/9router.env` on the VPS and its hub copy (if versioned elsewhere)

### Steps

1. **Backup the data directory** (rollback + audit trail):
   ```bash
   ssh <vps>
   cd /opt/9router
   sudo tar czf ~/9router-data-backup-$(date +%Y%m%d-%H%M%S).tar.gz data/
   ```

2. **Generate a new 64-hex secret**:
   ```bash
   openssl rand -hex 32
   ```
   Example output: `a3f9b8...` (64 chars)

3. **Update `env/9router.env` on the VPS**:
   ```bash
   # Edit /opt/9router/env/9router.env
   # Replace the JWT_SECRET= line with the new value:
   JWT_SECRET=<new-secret-from-step-2>
   ```

4. **Sync the hub copy** (if `env/9router.env` is kept anywhere outside the VPS):
   Update the corresponding copy to match. Env files are gitignored in the deploy repo, so this is a manual side-channel sync with no CI enforcement — the VPS copy is the source of truth.

5. **Recreate the 9router container**:
   ```bash
   cd /opt/9router
   docker compose --profile dashboard up -d --force-recreate 9router
   ```
   This forces the container to reload `env/9router.env` and bind the new secret.

6. **Verify** the new secret took effect:
   ```bash
   # Check container logs for startup success (no JWT-related errors):
   docker logs 9router --tail 20

   # Attempt dashboard login at https://<your-domain>
   # Old sessions → redirect to /login (expected)
   # New login → 200 OK, dashboard loads
   ```

7. **Optional cleanup — overwrite the dormant file fallback** (eliminates stale-secret resurrection risk):
   ```bash
   # The persisted file at data/9router/jwt-secret is currently stale (old secret),
   # but it is never read while JWT_SECRET env is set. Overwriting it keeps the
   # deployment consistent if the env var is ever unset in the future:
   echo "<new-secret>" > /opt/9router/data/9router/jwt-secret
   chmod 600 /opt/9router/data/9router/jwt-secret
   ```

---

## Verification Checklist

- [ ] Dashboard login successful with new credentials
- [ ] Old sessions invalidated (redirect to /login on stale cookie)
- [ ] No JWT verification errors in `docker logs 9router`
- [ ] LLM/API requests unaffected (`/v1/responses` still works for existing clients)
- [ ] `env/9router.env` on VPS contains the new secret
- [ ] Hub copy of `env/9router.env` synced (if applicable)
- [ ] Optional: `data/9router/jwt-secret` file overwritten with new value

---

## Rollback

If rotation causes unexpected issues:

1. **Restore the old `JWT_SECRET`** in `env/9router.env`
2. **Recreate the container**:
   ```bash
   docker compose --profile dashboard up -d --force-recreate 9router
   ```
3. Users re-login with the old secret (sessions from the new secret are now invalid)

**Data loss:** None — rotation only affects session tokens, not persisted state.

---

## Notes

- **Single-secret limitation**: The codebase does not support dual-secret rotation (old + new valid concurrently). Rotation = one re-login wave; no graceful overlap period.
- **24h expiry**: Sessions last 24h post-login. Rotation does NOT affect that window for newly issued tokens — it only invalidates tokens signed with the old secret.
- **api service `JWT_SECRET` removal** (T7): The api env file has `JWT_SECRET` but the api codebase has zero jwt code. That var can be safely removed in a future cleanup — it is not used.
- **Why backup `data/`?** The `data/9router/` directory holds the SQLite DB (profiles, settings, logs). Rotation does not touch the DB, but pre-rotation backup is standard safety for any env-file edit that triggers a container recreate.

---

## References

- Code: `src/lib/auth/dashboardSession.js` (`loadJwtSecret` function, lines 12–22)
- Algorithm: HS256 (symmetric HMAC SHA-256)
- Expiry: 24h (set at token creation, line 37: `.setExpirationTime("24h")`)
- Cookie: `auth_token`, httpOnly, secure (when HTTPS), sameSite=lax, maxAge=24h
