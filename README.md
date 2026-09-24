> **Note:** Currently tested on macOS only.

# Local Project Index

A small, dependency-free local dashboard that finds development projects and repos, shows where their disk space goes, and lets you clean out the rebuildable parts (dependencies, build output, caches) of projects you are no longer working on. Nothing is ever deleted automatically: you review every deletion first and confirm it yourself.

## Why?

Storage is expensive these days—and, trust me, you'll find a ton of bloated `node_modules` folders in worktrees you never touched, plus projects you forgot still existed.

## Run it

```bash
npm start
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173), choose a folder, and click **scan**.

The inventory is stored next to the app in `data/projects.json`. That file is intentionally ignored by Git because it contains local paths and project names.

## What you see

**Tree view** (the default) shows projects where they live on disk: `~ → Desktop → side-projects → Addtech → depository`. Folder chains with a single child collapse into one row (`clients/acme/internal`). Every folder row adds up the disk use, rebuildable space, and latest activity of the projects beneath it, and its bars compare it with its siblings, so each level shows where its own space goes. Nested projects (workspace packages, an `android/` app inside a React Native project) appear inside their parent. When a filter hides a parent but matches something inside it, the parent stays in the tree, dimmed, so nesting is never lost.

Expand a project to see its **rebuildable folders**: every `node_modules`, `.next`, `dist`, `target`, `.venv`, `__pycache__`, `Pods`, and so on, with its size and how to get it back (`pnpm install`, `uv sync`, `cargo build`, …). Install commands come from the lockfile, including a monorepo root's lockfile for its packages. Folders whose names are sometimes used for hand-written files (`vendor`, `build`, `dist`, `out`, `target`) carry a **verify** badge.

**List view** is the flat, sortable table of top-level projects.

**Active** shows when each project last changed: its newest source file, or its latest commit or checkout, whichever is later (dependencies, builds, caches, and `.DS_Store` are ignored). The **inactive** filter uses `activityLevel()` in `public/js/activity.js` to decide what counts as idle.

**Disk** is the allocated size of the whole project folder, including `node_modules`, virtual environments, build output, caches, and Git metadata. **Rebuildable** is the part that tools can recreate. It excludes source files and Git history.

**Git** shows, for every project, whether its work also exists somewhere else: the most urgent fact (`no remote`, `8 uncommitted`, `17 unpushed`, `4 stashed`, `synced`, or `no git` for a folder outside any repository) above where the code is pushed (`owner/repo`, `local only`). Its color comes from `gitVerdict()` in `public/js/git-view.js`. Click it for the full picture and the GitHub actions (see [Git and GitHub](#git-and-github)). A deleted project keeps the remote it had when last seen (`was on owner/repo`), with the command to clone it back.

The header shows the system Slop Finder runs on (`macOS 26.6.2`) and whether the GitHub CLI is signed in (`gh · you`).

The **browse** button opens a folder browser beside the tree. It lists any folder's contents with sizes (measured in the background, largest first), marks rebuildable folders and projects, and lets you select items to delete by hand. Protected items show a lock with the reason.

## Cleaning up

Every deletion goes through the same review:

1. **Choose what to clean.** Use **clean** on a project (all its rebuildable folders), **clean** on a folder row (every project beneath it), **delete** on a single rebuildable folder, **review cleanup** on selected projects, or select items in the folder browser.
2. **Review.** For each item the app measures the exact size and file count, and shows what is inside and how to restore it. It also asks Git whether the item is ignored (disposable), untracked, or tracked (part of the source). For folders that contain repositories, it reports uncommitted changes, unpushed commits and branches, stashes, and repositories with no remote. Each item gets a low, medium, or high risk level. High-risk items start unchecked.
3. **Pick how.** Rebuildable output defaults to **Delete permanently**, which frees the space now. Anything else defaults to **Move to Trash**, which is recoverable with Put Back. Permanently deleting anything that cannot be rebuilt requires typing `delete`.
4. **Watch it run.** Items are deleted one at a time with progress, and you can stop between items. Partial failures report exactly how much was freed.

The inventory updates immediately: containing projects shrink, projects inside a removed folder become missing, and the freed space is added to **reclaimed over time** and its history. Scans also compare top-level projects with the previous scan and record space you freed outside the app.

## Git and GitHub

The Git dialog (click a project's git chip) shows:

- **The repository**: its branch, every remote with a link, and, on GitHub, whether it is public or private and whether your account can push.
- **Sync**: whether the branch matches the remote. With the GitHub CLI signed in, Slop Finder asks GitHub directly (`git ls-remote`, which writes nothing), so a branch deleted on GitHub or a stale fetch cannot make work look safe. A commit counts as safe when *any* remote has it. Without gh, the answer is "as of the last fetch", with its date.
- **What exists only here**: uncommitted changes (every file listed), commits that no remote has, the branches holding them, and stashes (which are never pushed).

**Actions**, all through the GitHub CLI and the session it already holds:

- **Commit** every listed change with a message. The commit is refused if the files changed since you looked, if a rebuildable folder (`node_modules`, `.venv`, …) is about to be committed because `.gitignore` misses it, or if a file is over GitHub's 100 MB limit. Likely secrets (`.env`, `*.pem`, `id_rsa`, `credentials.json`, …) and files over 50 MB need an explicit confirmation. The repository's own hooks run, as they would in a terminal.
- **Push** the current branch, or any other local branch that has commits no remote has. Pushes are fast-forward only: the refspec is explicit, so force-push or mirror settings in a repository's config never apply. If GitHub has commits you don't, the push is refused and you are told to pull first.
- **Create on GitHub** for a repository with no remote: `gh repo create` (private by default, or under an organization with `org/name`), added as `origin`, and pushed.

Slop Finder never reads or stores your token. Each network command gets `gh auth git-credential` as its only credential helper for that one command, and SSH remotes on GitHub are sent over HTTPS for that command so the gh session applies. Nothing is written to any Git config. When gh is not installed or not signed in, the Git facts still show, the actions are hidden, and the dialog says what to run (`gh auth login`).

## Safety

- **Preview is enforced by the server.** Deleting requires the id of a review you opened. Only items from that review can be deleted, each only once. Right before deleting, the server checks again that the item is allowed and is still the same file on disk (same inode), so something swapped in after the review is refused.
- **Delete locations.** Deletions are allowed only inside your home folder, `/tmp`, and your own temporary folder (`$TMPDIR`). macOS gives every user on every Mac a different `$TMPDIR` (`/private/var/folders/<xx>/<id>/T`), so it is found at runtime and shown by name. Only that `T` folder is allowed: its siblings `C`, `0`, and `X` hold live caches and state for macOS services, and the rest of `/private/var` belongs to the system, so none of it can be added as a location either. To allow a drive or folder outside these (for example `/Volumes/Archive`), add it under **Delete locations**. That list is saved in this browser only, and the server re-validates it on every request.
- **Never deleted:** system folders (`/System`, `/usr`, `/opt/homebrew`, …), `~/Library`, credential folders (`~/.ssh`, `~/.aws`, `~/.config`, …), the Trash, `.git`/`.hg`/`.svn` metadata, mounted volumes, and Slop Finder itself. Your home folder, allowed locations, and standard folders (Desktop, Documents, Downloads, …) can be cleaned inside but never removed whole. Symlinks are removed as links, never followed.
- **Other websites can't use it.** The server only listens on `127.0.0.1`. It rejects requests with a foreign `Host` header (DNS rebinding) or `Origin`, and requires a custom header that cross-site pages cannot send without a CORS preflight, which the server never approves. The page cannot be framed.
- **Git is only read** unless you click commit, push, or create. Status checks run with `GIT_OPTIONAL_LOCKS=0`, so they never rewrite a repository's index, and with `core.fsmonitor` off, so a repository's own config cannot make a status check run a program. Remote URLs are shown without any credentials they contain. Only one Git action runs per repository at a time.

## Scanning

The scanner recognizes Git, bare Git, Mercurial, and Subversion repositories plus common project formats for JavaScript/TypeScript, Python, Rust, Go, Ruby, PHP, Java, Kotlin, .NET, Swift/Xcode, C/C++, Dart/Flutter, Elixir/Erlang, R, Julia, Haskell, OCaml, Lua, Zig, Arduino, Unity, Unreal, Godot, Solidity, Docker, Terraform, Pulumi, Helm, Ansible, Nix, Bazel, notebooks, and documentation sites.

Generated and dependency folders are skipped during project *discovery*, so their internal manifests do not create false projects. They are still fully counted when measuring disk usage. When scanning from `/`, operating-system and package-manager trees (`/System`, `/usr`, `/opt/homebrew`, …) are skipped. macOS mirrors `/Users` into `/System/Volumes/Data`, so walking it would list every project twice.

You can search, filter by type and status, sort, select results, copy paths, and ignore entries. Ignored paths stay ignored after future scans and can be restored from the **ignored** filter.

## Configuration

```bash
PORT=8080 npm start                          # a different port
SLOP_FINDER_DATA_DIR=/tmp/sandbox npm start  # a separate inventory (for experiments)
```

## Tests

```bash
npm test
```

The cleanup tests use a temporary inventory and temporary folders; they never touch `data/projects.json`.
