# Publishing to GitHub

**Status:** draft
**Owner:** Petar Nenov
**Updated:** 2026-08-24

## Problem

The repository exists on one machine and nowhere else. `git remote -v` is empty, there are 9
commits on `main`, and 83 tracked files. There is no off-machine copy and no URL to point anyone
at.

This spec publishes it as a **public** repository under the GitHub account `petarnenov`.

Public is the part that needs care. A push to a public repository is not practically reversible:
once the history is on GitHub it can be cloned, forked, indexed by search engines and captured by
third-party archives within minutes, and deleting the repository afterwards does not retract any of
that. Everything that must be checked has to be checked **before** the push, which is why the audit
below is a step and not a footnote.

## Scope

- Choose the repository name — recommendation with alternatives, confirmed before anything runs.
- Audit exactly what becomes public, verified against git history rather than the working tree.
- Create the public repository under `petarnenov` with a one-line description.
- Wire `origin`, push `main` with all 9 commits, set upstream tracking.
- Verify from the remote side, including a fresh clone that builds and passes the full suite.

**Non-goals:** a README; a LICENSE; CI workflows; branch protection or rulesets; topics; releases
or tags; renaming the local directory; rewriting, squashing or amending any commit; pushing
anything currently ignored; GitHub Pages; issue or PR templates. README and LICENSE are the two
that have real consequences for a public repository — both are raised under Open questions instead
of being invented into this scope.

## Design

### The name

The task asks for "a suitable name". The local directory is `mcp-tutorial` and stays that way
(owner's decision, 2026-08-23, recorded in [[ARCHITECTURE]]); the GitHub name is a separate
decision and does not have to match.

| Candidate | For | Against |
|---|---|---|
| **`mcp-tasks`** *(recommended)* | Says what it is in two words: a task list exposed over MCP. Short, greppable, sorts next to the owner's other work | Slightly undersells the browser client and the nginx/Docker layer |
| `mcp-tutorial` | Matches the local directory exactly; zero cognitive mapping | Generic, thousands of repositories share it, and it describes the project's origin rather than what it now contains |
| `task-api-mcp` | Names both halves — the Java API and the MCP surface | Reads like a component, not a project; longer with no gain |

Recommendation: **`mcp-tasks`**. Uniqueness only has to hold within the `petarnenov` account, so a
name being common elsewhere costs nothing. A GitHub repository can be renamed later and GitHub
keeps a redirect from the old URL, so this is reversible — unlike the push itself.

**A contradiction to resolve first.** `vault/ARCHITECTURE.md` currently states, under *On the name*,
that "this project has nothing to do with the Model Context Protocol. Do not infer scope from it."
That line is false as written and is contradicted by the rest of the same document, which maps
`mcp-server/src/tools.ts`, `resources.ts`, `prompts.ts` and the whole `mcp-client` module, and by
four shipped specs. It appears to be stale text from before the MCP server landed. It mattered here
because it argued against every recommended name. **Corrected on 2026-08-24**, together with four
other stale claims found by re-verifying the whole document against the working tree.

### What becomes public

Verified 2026-08-24 against the repository, not assumed:

| Check | Result |
|---|---|
| Tracked files | 83, under 15 top-level paths: `task-api/`, `mcp-server/`, `mcp-client/`, `nginx/`, `vault/`, `gradle/`, plus `Makefile`, `compose.yaml`, `CLAUDE.md`, the two Gradle build files, `gradle.properties`, both wrappers, `.gitignore`, `.dockerignore` |
| Database or data files ever committed | **None.** `git log --all --diff-filter=A --name-only` matches nothing against `*.db`, `data/`, `.env`, `*.pem`, `*.key` |
| Secret material in tracked files | **None.** A grep for `ghp_`, `github_pat_`, `AKIA`, `-----BEGIN`, `api_key`, `password`, `secret`, `token` returns nothing outside the Gradle wrapper |
| `node_modules/`, `dist/`, `build/`, `.gradle/`, `data/` | Ignored by `.gitignore` and never tracked |
| `.claude/settings.local.json` | Ignored, but by the user's **global** excludes file (`**/.claude/settings.local.json`), not by this repository's `.gitignore` — see Open questions |
| Author identity in all 9 commits | `Petar Nenov <petarnenovpetrov@gmail.com>`, single author. This email becomes publicly visible on every commit |
| Lockfiles | `mcp-server/package-lock.json` and `mcp-client/package-lock.json` are both tracked, so a clone can `npm ci` |

The last row is what makes obligation 9 achievable: `make build` runs `npm ci` for both TypeScript
modules and `./gradlew build` for the Java one, so a clone needs no file carried over by hand.

### The commands

Preconditions, both already true: `gh` 2.92.0 is installed and authenticated as `petarnenov` with
the `repo` scope, and `git status` is clean.

```sh
# 1. Audit — must all come back empty before anything is created.
git status --short
git log --all --pretty=format: --name-only --diff-filter=A | sort -u \
  | grep -Ei '\.db$|^data/|\.env|node_modules|\.pem$|\.key$'

# 2. Create the empty public repository. Creates nothing locally.
gh repo create petarnenov/mcp-tasks --public \
  --description "A task list exposed over MCP: Micronaut 5 CRUD API, a TypeScript MCP server on protocol 2026-07-28, and a browser MCP client, behind nginx in Docker."

# 3. Wire the remote.
git remote add origin https://github.com/petarnenov/mcp-tasks.git

# 4. Push all 9 commits and set upstream tracking.
git push -u origin main
```

Steps 2–4 collapse into `gh repo create mcp-tasks --public --source=. --remote=origin --push`, and
that shorthand is fine once the name is settled. They are kept apart here because the audit gate
sits between "decided" and "published", and because a failure in step 4 is easier to read when the
remote already exists.

`main` is pushed first and therefore becomes the default branch; no rename step is needed.

## Correctness obligations

1. `petarnenov/<name>` exists, visibility is **public**, and its default branch is `main`.
2. `git ls-remote origin` lists exactly one ref, `refs/heads/main`, at the same SHA as local `main`
   (`582eb49` at the time of writing).
3. All **9** commits are present with their SHAs unchanged — nothing rewritten, squashed or amended.
4. The published tree contains exactly the 83 tracked files and nothing else, verified against a
   fresh clone rather than the local working tree.
5. No path matching `data/`, `*.db`, `node_modules/`, `dist/`, `build/`, `.gradle/`, `.claude/` or
   `.DS_Store` appears anywhere in the published history — not just in the tip commit.
6. No secret material appears in any published commit.
7. Every published commit carries `Petar Nenov <petarnenovpetrov@gmail.com>`, and publishing that
   email is an accepted consequence rather than a surprise.
8. Local `main` tracks `origin/main`, `git status` reports up to date, and the working tree is
   still clean afterwards.
9. A fresh clone into an empty directory builds and passes all **113** tests (23 api + 40 mcp + 50
   client) with no file copied from the original working directory.
10. The local directory is still named `mcp-tutorial` and the local `data/tasks.db` is untouched —
    publishing changes nothing about how the project runs locally.

## Verification

| # | Command | Expected |
|---|---|---|
| 1 | `gh repo view petarnenov/mcp-tasks --json visibility,defaultBranchRef` | `"visibility":"PUBLIC"`, `"name":"main"` |
| 2 | `git ls-remote origin` vs `git rev-parse main` | One `refs/heads/main`, SHAs equal |
| 3 | `git rev-list --count origin/main` | `9` |
| 4 | `git ls-tree -r --name-only origin/main \| wc -l` | `83` |
| 5 | `git log origin/main --pretty=format: --name-only \| sort -u \| grep -Ei 'data/\|\.db$\|node_modules\|/dist/\|/build/\|\.gradle/\|\.claude/\|\.DS_Store'` | no output |
| 6 | The grep from step 1 of the command list, run against `origin/main` | no output |
| 7 | `git log origin/main --format='%an <%ae>' \| sort -u` | one line |
| 8 | `git status -sb` | `## main...origin/main`, nothing else |
| 9 | `git clone https://github.com/petarnenov/mcp-tasks.git /tmp/clone-check && cd /tmp/clone-check && make build` | `113` tests pass. Needs Java 25, Node 20+, network for `npm ci`; takes several minutes |
| 10 | `ls data/tasks.db && git -C . rev-parse --show-toplevel` | file present, path still ends in `mcp-tutorial` |

Obligation 9 is the one that actually proves "everything so far" was pushed. The other nine can
pass on a repository that is missing a file the build needs, because the local working tree still
has it.

## Open questions

1. **The name — blocking.** `mcp-tasks` is a recommendation, not a decision. Nothing runs until it
   is confirmed, because it becomes a public URL.
2. **No README.** A public repository with no README renders as a bare file tree. Out of scope here
   by the letter of the task ("push what is done so far", and a README is not done), but it is the
   first thing worth adding afterwards. The vault already contains the material.
3. **No LICENSE.** Without one, default copyright applies and no one may legally reuse the code —
   which may or may not be the intent for a public repository. Worth a deliberate decision rather
   than a default.
4. ~~**The stale line in `ARCHITECTURE.md`** asserting the project has nothing to do with MCP.~~
   **Resolved 2026-08-24.** The paragraph was rewritten, and a full re-verification of
   `ARCHITECTURE.md` against the working tree corrected four further inaccuracies. The naming
   argument in Design above now rests on a document that matches the code.
5. **`.claude/settings.local.json` is protected only by a global excludes file.** In this working
   copy it is ignored and will not be pushed. In any clone on a machine without that global
   setting, it is an ordinary untracked file that `git add -A` would stage. One line in
   `.gitignore` would make the repository self-sufficient.
