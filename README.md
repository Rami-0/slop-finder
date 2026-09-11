Note: tested on Mac OS only

# Local Project Index

A small, dependency-free local dashboard that finds development projects and repos, records their sizes, and remembers whether each project is still present between scans.

# WHY??
Because memory is expensive these days, and trust me you'll find a ton of sloped node_modules in worktrees that you never touched, and projects you don't know they still exist.


## Run it

```bash
npm start
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173), choose a folder, and click **Scan projects**.

The inventory is stored next to the app in `data/projects.json`. That file is intentionally ignored by Git because it contains local paths and project names.

The scanner recognizes Git, bare Git, Mercurial, and Subversion repositories plus common project formats for JavaScript/TypeScript, Python, Rust, Go, Ruby, PHP, Java, Kotlin, .NET, Swift/Xcode, C/C++, Dart/Flutter, Elixir/Erlang, R, Julia, Haskell, OCaml, Lua, Zig, Arduino, Unity, Unreal, Godot, Solidity, Docker, Terraform, Pulumi, Helm, Ansible, Nix, Bazel, notebooks, and documentation sites.

Generated and dependency folders are skipped during project *discovery* so their internal manifests do not create false projects. They are still fully counted when measuring disk usage.

The default **code** view shows top-level development projects. Dedicated filters expose infrastructure projects, repository-only or documentation folders, data/docs projects, nested workspaces, missing projects, and ignored entries.

You can search, sort, select visible results, copy one or many paths, and bulk-ignore entries. Ignored paths remain ignored after future scans and can be restored from the **ignored** filter.

**Disk** is the allocated size of the complete project folder, matching operating-system disk usage and including `node_modules`, virtual environments, build output, caches, and Git metadata. **Cleanup** is the portion occupied by dependencies, generated output, and caches. Hover over a cleanup value to see its breakdown. Cleanup is an estimate of reproducible data; review it before deleting anything.

Every scan also compares top-level projects with the previous scan. Size reductions and removed project folders are recorded as reclaim events in the local inventory, giving the dashboard a cumulative **reclaimed over time** total, a **this scan** value, and a recent history. Nested projects are excluded from this calculation so their space is not counted twice through their parent.

## Configuration

Set a different port if needed:

```bash
PORT=8080 npm start
```

The server only listens on `127.0.0.1`; it is not exposed to your network.
