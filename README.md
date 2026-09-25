# prism-local

A local, Overleaf/Prism-style studio for LaTeX projects on your own machine:

- **Editor**: CodeMirror 5 with tabs, LaTeX highlighting and search. It autocompletes
  `\cref{…}`/`\eqref{…}` from your labels, `\cite{…}` from your `.bib` files, and `\…` from your
  own `\newcommand`s. An insert menu offers your `\newtheorem` environments.
- **Compile and see errors**: one click (⌘↵) builds the project. Errors and warnings
  (undefined references and citations included) are listed with their source lines, and a click
  jumps to the line.
- **PDF preview with SyncTeX**: the preview reloads after every build and keeps its scroll position.
  Double-click the PDF to jump to the source; ⌘J jumps from the source to the PDF. The PDF can
  **pop out into its own tab** and stays in sync there.
- **✦ Claude panel**: an AI agent that edits your project. It runs your local
  [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI in the project directory.
  Every turn ends with a per-file diff and **Undo this turn**. The panel also shows your
  remaining 5-hour and 7-day Claude usage limits.
- **Works with other tools**: files changed on disk (by Claude Code in a terminal, `git
  checkout`, another editor) reload automatically. A save never silently overwrites a newer
  version on disk.

It is a single Python process that uses only the standard library, listens on `127.0.0.1`, and
needs nothing from npm. The front-end libraries are vendored, so it also works offline.

## Requirements

- Python ≥ 3.9 (tested with 3.11)
- A LaTeX build tool:
  - [Tectonic](https://tectonic-typesetting.github.io/), used by default if it is on `PATH`, or
  - `latexmk` with a TeX distribution, used if Tectonic is not found, or
  - any command you configure in `prism.json`.
- Optional: `git`, for the file status markers and the Diff view.
- Optional: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), for the Claude panel.
  You must be logged in (`claude` works in your terminal).

## Quick start

```sh
git clone https://github.com/DengZhiyuan-math/prism-local.git
cd prism-local
bin/prism-local examples/minimal          # opens http://127.0.0.1:8765/
```

To use it on your own project:

```sh
/path/to/prism-local/bin/prism-local /path/to/your/latex-project
# or, from inside the project:
/path/to/prism-local/bin/prism-local
```

Options: `--port 8765` and `--no-browser`. Stop the server with Ctrl-C.

## Keyboard

| Key | Action |
|---|---|
| ⌘S / Ctrl-S | Save |
| ⌘↵ / Ctrl-Enter | Save all and compile |
| ⌘J / Ctrl-J | Show the cursor line in the PDF |
| double-click in PDF | Jump to the source line |
| ⌘L / Ctrl-L | Ask Claude about the selection |
| ⌘/ / Ctrl-/ | Toggle `%` comments |
| ⌘B / Ctrl-B | Show/hide the file sidebar |
| Ctrl-Space | Completion |

## Build modes

The mode picker next to **Compile** offers:

- **Draft**: keeps going after TeX errors, so you still get a PDF while you write. Errors are
  still reported in red. Tectonic uses `-Z continue-on-errors`; latexmk uses `-f`.
- **Strict**: stops at the first error.
- **Check**: only appears if you configure it, for example as a project script that runs extra lint checks.

## Configuration: `prism.json` (optional)

Place `prism.json` in the project root. Every key is optional:

```json
{
  "main": "main.tex",
  "outdir": "build",
  "build": {
    "draft":  ["tectonic", "-o", "{outdir}", "--keep-logs", "--synctex", "-Z", "continue-on-errors", "{main}"],
    "strict": "scripts/build.sh",
    "check":  "scripts/check.sh"
  },
  "files":   ["main.tex", "chapters/**/*.tex", "*.bib"],
  "exclude": ["drafts/old/**"],
  "labelPrefixes": { "claim": "clm" },
  "snippets": [
    { "name": "TODO marker", "text": "% TODO: ", "caret": 8 }
  ]
}
```

- `main`: the root document. Default: `main.tex`, otherwise the first top-level `.tex` file
  containing `\documentclass`.
- `outdir`: where the build writes `<main>.pdf`, `.log` and `.synctex.gz`. Default: `build`.
- `build`: commands for the `draft`, `strict` and `check` modes. Each is either an argv list or a
  shell string (run with `bash -c`). `{main}` and `{outdir}` are substituted. The build must
  produce SyncTeX data (`--synctex` for Tectonic, `-synctex=1` for latexmk/pdflatex).
- `files`: globs for the file tree. By default every `.tex/.bib/.md/.sty/.cls/.txt` file is listed,
  skipping hidden directories, `outdir` and `node_modules`.
- `exclude`: globs to hide from the file tree.
- `labelPrefixes`: label prefixes for inserted environments. The defaults are `thm`, `lem`, `prop`,
  `cor`, `def`, `rem`, `ex`, `eq`, …
- `snippets`: extra entries for the Insert menu. `caret` is the cursor offset within the first line.

## The Claude panel

Each message runs Claude Code headlessly in your project:

```
claude -p --output-format stream-json --verbose --include-partial-messages \
       --permission-mode <acceptEdits|plan> [--resume <session>] --append-system-prompt <…>
```

Consequences:

- Claude reads your project's `CLAUDE.md`, skills and `.claude/settings.json`, exactly as it
  would in a terminal. Put writing conventions or rules for the paper in `CLAUDE.md`.
- **Edit** mode (`acceptEdits`) may change files. Nothing can be approved interactively, so
  shell commands are limited to the `permissions.allow` list in `.claude/settings.json`, and
  anything else is refused. The card at the end of a turn names any refused tools.
- **Ask** mode (`plan`) is read-only.
- Messages include the open file, the cursor line and the selection. Untick "Attach" to send
  the message without them.
- The conversation continues across messages until you press **New chat**.
- After each turn, a card lists the changed files with diffs and offers **Undo this turn**.
  - Undo restores a file only if nobody edited it since that turn.
  - Undo history lives in server memory, so it is lost when the server restarts.
  - For durable history, use git.
- **Cost**: each message is a full Claude Code run, billed to your Claude plan or API account
  like any other Claude Code usage.
- **Usage limits**: the bars show the 5-hour and 7-day utilization that Claude Code reports.
  - They update after each message.
  - **↻** refreshes them with a tiny Haiku call (about $0.001).
  - Usage from other sessions shows up at the next update.
- The panel finds the CLI on `PATH`. Set `CLAUDE_BIN=/path/to/claude` to override. Start
  prism-local from the same environment you use for `claude`, including any `CLAUDE_CONFIG_DIR`.

## Security model

prism-local is meant for a single user on their own machine.

- It binds to `127.0.0.1` only and rejects requests whose `Host` header is not `127.0.0.1` or `localhost`.
- Every state-changing request needs the header `X-Prism-Local: 1`. Browsers send a custom
  header cross-origin only after a CORS preflight, and the server never answers preflights, so
  other websites cannot drive the server.
- It reads and writes only text source files inside the project directory. Hidden directories
  and the build directory are excluded.
- Anyone who can reach the port can run your build commands and the Claude agent. Do not expose
  the port to a network: no port forwarding, no `0.0.0.0`.

## Layout

```
bin/prism-local            launcher
prism_local/server.py      HTTP server: files, builds, log parsing, SyncTeX
prism_local/agent.py       Claude Code runner, per-turn diffs and undo, usage limits
prism_local/static/        front end (app.js, pdfview.js, viewer.*, common.js, app.css)
prism_local/static/vendor/ CodeMirror 5.65.18 (MIT), PDF.js 3.11.174 (Apache-2.0)
examples/minimal/          a small amsart project to try it on
```

## Limitations

- SyncTeX lookup is a compact reimplementation, not the `synctex` library. It is accurate to the
  line for ordinary text and math. Inside complex constructs (tables, TikZ, floats) it can land a few lines off.
- The Tectonic build path is the one tested most. The latexmk defaults use standard flags
  (`-pdf -synctex=1 -file-line-error`).
- No collaborative editing, and no file creation, rename or delete from the UI. Use your file
  manager, git or Claude for those.

## License

MIT, see [LICENSE](LICENSE). The vendored third-party libraries keep their own licenses: see
`prism_local/static/vendor/LICENSE-*`.

"Prism" in the name refers to the general idea of an AI-assisted LaTeX workspace. This
project is not affiliated with OpenAI's Prism or with Anthropic.
