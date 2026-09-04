# Project Profile — discogs-tool (Vinyl Collection Player)

> Written by `project-intake` on 2026-09-04. Re-run project-intake to refine
> these answers, especially once a backend actually lands (PROJECT_PLAN.md B3).

## Project Context (injected into kept agents)

- Stack: Vanilla JavaScript (script-tag ES modules), HTML5, CSS3 — no framework, no bundler.
- Runtime: GitHub Pages, static files served directly from this branch — no build/deploy pipeline.
- Data: Client-side only (IndexedDB); external Discogs REST API + YouTube iframe API. No server DB.
- Conventions: No build step for the shipped app; solo dev, self-review via `/code-review` before merging.
- Constraints: Discogs personal access token lives in IndexedDB (sensitive credential — see PROJECT_PLAN.md C1 stored-XSS history). Node-based unit tests (Vitest/node:test) + GitHub Actions CI are being introduced as dev-only tooling.
- Non-goals: No backend/server yet — payments/auth deferred until PROJECT_PLAN.md B1-B3 land.

## Full Q&A

1. **Domain(s):** `web_app` only. Considered `backend_heavy` too since
   PROJECT_PLAN.md's B3 blocker plans a thin backend (Cloudflare Workers/D1 or
   Supabase), but decided to tune for the current pure-frontend reality and
   re-run project-intake once that backend actually lands.
2. **Language & stack:** Vanilla JavaScript (no framework), HTML5, CSS3.
   `src/*.js` loaded as plain `<script>` tags in a fixed order (see
   `app.js` header comment); no `package.json` today.
3. **Runtime / deploy target:** GitHub Pages, serving this branch's static
   files directly — confirmed no build/deploy pipeline exists.
4. **Data stores:** IndexedDB only, client-side. No server database. External
   dependencies: Discogs REST API (auth via personal access token) and the
   YouTube iframe API.
5. **Team & review norms:** Solo developer. No required PR review, but wants
   self-review discipline via `/code-review` before merging.
6. **Testing maturity:** None today (no test files, no runner configured).
   Decision: start adding **Node-based unit tests only** (Vitest or Node's
   built-in `node:test`) for `src/*.js` logic, as a dev-only dependency — the
   shipped app stays build-free. No e2e/browser tests planned yet.
7. **CI/CD:** None today. Decision: add GitHub Actions to run the new test
   suite on push/PR. Note: an unmerged branch
   `origin/claude/add-github-ci-workflow-fHHnF` already attempted this and is
   worth revisiting/superseding rather than starting from scratch.
8. **Performance / reliability budgets:** Best effort — no server exists to
   set SLIs/SLOs against. Client-side performance (crossfade timing, visualizer
   rendering, large-collection views) stays each engineer's judgment call.
9. **Security & compliance:** No payments or PII today — out of scope until
   PROJECT_PLAN.md B1-B3 land. `security-architect` kept, but scoped narrowly
   to token/auth handling and verification (the Discogs personal access token
   sits in IndexedDB; PROJECT_PLAN.md C1 documents a related stored-XSS bug,
   already patched in `escJs`).
10. **Conventions & non-goals:** No build step for the *shipped* app is a hard
    constraint (script-tag includes only, load order matters). No backend/server
    yet — explicitly out of scope until PROJECT_PLAN.md's B1 (Discogs commercial
    consent), B2 (YouTube player visibility), and B3 (backend) blockers are
    resolved.

## Changes Applied

**Removed (11 agents, domain not in `web_app`/`cross_cutting`):**
`backend-engineer-platform`, `data-engineer`, `database-engineer`,
`devops-build-engineer-embedded`, `embedded-product-manager`,
`embedded-system-architect`, `firmware-engineer`, `hardware-integration-engineer`,
`low-level-software-engineer`, `qa-engineer-embedded`,
`test-automation-engineer-embedded`. Also removed the now-empty
`domains/backend_heavy/` and `domains/embedded/` canonical dirs.

**Kept (17 agents):** the 3 `web_app` roles (`backend-engineer-web`,
`frontend-engineer`, `ux-ui-designer`) and all 14 `cross_cutting` agents.
`backend-engineer-web` is kept per the domain rule but flagged dormant in its
Project Context — there is no backend to work on yet.

**Tuned:**
- All 17 kept agents got a `## Project Context` block (stack/runtime/data/
  conventions/constraints/non-goals) prepended to their body.
- `code-reviewer` gained `model: sonnet` (it was the one reviewer role missing
  the lighter-model tuning already applied to `ux-ui-designer`,
  `incident-review`, `product-manager`, `qa-engineer`, `project-intake`).
- `security-architect`, `platform-engineer`, `reliability-engineer`,
  `test-runner`, `qa-engineer`, `backend-engineer-web` got a customized
  Constraints/Non-goals line reflecting this project's specific gaps (no
  backend, no CI, no tests, payments out of scope) instead of the generic block.
- Tools were already least-privilege per role (advisory reviewers have no
  `Bash`; engineers do) — no changes needed there.

## Next Step

Run the `orchestrator` agent for the first non-trivial task, or use
`code-reviewer` / `debugger` / `test-runner` / `security-architect` directly
day to day.
