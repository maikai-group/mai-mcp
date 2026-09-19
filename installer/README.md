# mai-mcp installer

`npx mai-mcp setup` installs the [mai-mcp](https://github.com/maikai-group/mai-mcp)
persistent memory brain into a **visible local checkout** — never into the npm
cache — and then runs that checkout's guided eight-stage setup.

## What it actually does

```bash
npx mai-mcp setup [--dir PATH] [--yes] [--update] [-- <setup flags...>]
```

1. Asks where the brain checkout should live (`~/mai-mcp` by default; `--yes`
   accepts the default, `--dir` selects another path, `~/` expansion only).
2. Clones `https://github.com/maikai-group/mai-mcp.git` (depth 1) into that
   directory when it is absent. An existing directory must already be a clone
   of the same repository; anything else stops with an error. Only `--update`
   pulls (`--ff-only`).
3. Runs `npm install` and `npm run build` inside the checkout when needed. The
   installer invokes npm's verified `npm-cli.js` through the current Node
   executable with no shell; it never launches an `npm` or `npm.cmd` shim.
4. Delegates to the checkout's own `setup` command with your **original
   working directory** preserved, inherited stdio, and the exact exit status —
   the repository you launched from is the project that gets onboarded.
   Tokens after `--` are forwarded to setup byte-for-byte.

The successful setup summary offers two dashboard choices: ordinary startup,
or an explicit opt-in command that installs login persistence on macOS and
Windows using the exact checkout path. Setup never enables persistence
automatically.

After a successful install, other commands pass through to the checkout CLI:
`npx mai-mcp verify <slug>`, `npx mai-mcp skills status`, and so on. They
require the checkout to exist already (run `setup` first).

`--help` and `--version` answer locally without cloning or writing anything.

## Requirements

- Node 24
- `git` on PATH — on native Windows that means **Git for Windows** (`git.exe`);
  the installer clones the runtime, so this is a hard requirement here even
  though Claude Code treats Git for Windows as optional
- Docker Desktop with Linux containers (the checkout's setup starts a local
  Postgres on `127.0.0.1:54334`)

### Native Windows contract

Windows 11 (native PowerShell 5.1+) is the supported native platform; Windows 10
is best effort. Run the installer from the project you want onboarded:

```powershell
npx mai-mcp setup --yes -- --slug my-project --root $PWD.Path --harness all
```

The installer never launches an `npm.cmd` shim or a shell: it locates
`npm-cli.js` beside the running Node executable and invokes it through Node
(set `MAI_NPM_CLI` to an absolute `npm-cli.js` path if that layout is
unavailable). Everything it writes stays under your user profile and the
checkout you choose; nothing requires elevation. WSL2 is a distinct Linux-mode
path — use the Linux instructions inside the Linux filesystem instead.

## Support

Issues: <https://github.com/maikai-group/mai-mcp/issues>. The installer itself
is dependency-free; everything substantive happens in the checkout it clones.

MIT © Maikai Group Inc.
