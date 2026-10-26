# AGENTS.md

Release checklist for `cortico-world-sysmon`, a Cortico World extension. How to write one:
[docs/worlds.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/worlds.md) and
[docs/extensions.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md).
`pnpm describe:extension <dir>` and `pnpm check:extension <dir>` run from the root of a Cortico
checkout; `<dir>` is this package's directory.

Run `pnpm typecheck` and `pnpm test` in this directory. After changing tools, event types or the
env prompt, run `pnpm describe` to regenerate `describe.json`.

- [ ] **Contract version**: `cortico.api` is `6`, the current World contract.
- [ ] **Self-description**: `cortico.describe` points to `describe.json`; `tests/world.test.ts`
  compares it with the code and `ENV_PROMPT.md` and it must match exactly.
- [ ] **Tags**: `cortico.tags` lists `experimental` (notice) and `sensitive-data` (warning), per
  [TAGS.md](https://github.com/Pal-AI-Lab/cortico-extensions/blob/main/TAGS.md).
- [ ] **CHANGELOG.md** has a `## 0.1.0` section for the version being published.
- [ ] **`os`**: `["win32"]`; the collectors use Windows WMI, `nvidia-smi` and PowerShell.
- [ ] **WebUI panel**: none; the World page renders the config group and the env prompt doc.
- [ ] **Privacy**: no key anywhere; no network requests; no user files read or written; sampling
  history stays in memory and is dropped on stop. Process names, paths and peer addresses can
  appear in events (declared with the `sensitive-data` warning tag).
- [ ] **Requests to the maintainers** (tag changes, certification, a replacement package, appeals)
  are issues in [Pal-AI-Lab/cortico-extensions](https://github.com/Pal-AI-Lab/cortico-extensions).
