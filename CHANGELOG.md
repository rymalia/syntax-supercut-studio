# Fork changelog

Major changes in this fork relative to the original
[wesbos/syntax-supercut-studio](https://github.com/wesbos/syntax-supercut-studio).
The fork point is tagged `upstream-baseline` (`f7d0c1e`, 2026-05-28); see the
full divergence with:

```sh
git log --oneline upstream-baseline..HEAD
git diff --stat upstream-baseline
```

Changes are not sent upstream. Newest first; group entries by date.

## 2026-10-15

### Added
- **Talking-heads engine integration.** Bridge to the external Python engine at
  `TH_ENGINE_DIR` via `engine_cli.py` (protocol in `docs/ENGINE_CONTRACT.md`).
  New job kinds `film-plan`, `film-render` (render + QA), and `ingest`.
- **Film, People, and Ingest pages.** `/film` edits film scripts (casting,
  per-line buildability check, plan, draft/final render, phrase grep);
  `/people` browses castable identities; `/ingest` runs incremental ingest.
- **Engine media route** `/api/engine-media/...`, a second read-only media root
  limited to `identities/`, `proxy/`, and `films/out/`.
- **Engine snapshot** in `engine/` (versioned copy; the live engine runs from
  `TH_ENGINE_DIR`), plus seven v2 film scripts. The engine skips takes from a
  source's last 8 s (end-card guard).
- **Dark mode** with a Dark/Light toggle in the top bar; follows the OS setting
  until chosen, applied before first paint. Fonts, layout, and the lime accent
  are unchanged.
- `CLAUDE.md` with commands, architecture, and theming rules.

### Fixed
- **Renders on ffmpeg 9.** Pipelines use `-/filter_complex <file>` and
  `-fps_mode` instead of the removed `-filter_complex_script` and `-vsync`.
  Requires ffmpeg 7+.
- Hero heading highlights overlapped the subtitle; the Library "Transcribed"
  highlight overlapped its label; filled status pips were invisible on a
  hovered (lime) table row.
