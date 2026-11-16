# Throwbacks

A read-only journal of one person's AI-assistant history — Claude Code,
Claude Cowork, Claude.ai exports, GitHub Copilot (VS Code), Copilot CLI and
Cursor — day first: **Today** (the day's summary, when each app was active,
that day's sessions by folder), **Week / Month** (an editable sheet, one row per task, grouped by date or by folder),
**Sessions** (a folder Tree or every chat as Cards; what's still going on top, with pin and archive), **Commits** (every commit of
yours, who made it — you or an AI tool — day by day), **Summaries** (every AI summary: days, recaps of a
week, a month or any dates, chats'), **Insights** (the activity report and
the plans' usage), **Search**, **Expiring** (chats Claude Code deletes soon;
keep a copy) and **Settings**. A session opens beside the
page. Tools are grouped by the plan whose limits they share (Claude ·
Copilot · Cursor); a chip narrows every page. ≈active time throughout, an
optional AI summarizer, an optional usage meter. Plain ES modules, served
locally; no build step. One design: Liquid Glass (`glass.css`).

Every feature, in detail:
@docs/decisions.md

The owner's own record — every decision and its reason, what's still open, the
timeline (on this Mac only; `.gitignore` keeps it out of git, and it's absent
from a clone):
@docs/history.md

## Ground rules

- **Nothing leaves the machine.** No analytics, no uploads. The only outbound
  calls are the optional summarizer's — to the provider the user picked, when
  they click Summarize (on a day, a recap — a week, a month, any dates —, or a chat) — the usage
  meter's, with `--claude`: when the app opens (and when you come back after
  5 min), the server runs each turned-on tool's own app — Claude Code,
  Copilot CLI, and (off by default) Codex's app-server and agy — which asks
  its maker for the plan's usage with its own login (no AI request, nothing
  from the chats, at most once a minute per tool) — plus Google Fonts and
  JSZip (lazy, only for a `.zip`). Summaries are written when you
  click Summarize, or — the end-of-day setting, on by default — at the end
  of the day while Throwbacks is open (today once, plus any of the last 7
  days missing or out of date; only what's new is sent; one tab at a time,
  with a Stop bar while it writes). Never when it's closed, on sample data,
  or when that setting is off.
  Never read or send another app's sign-in token (Cursor's included: it
  gets its plan name only).
- **Read-only.** Never write to, move or delete the user's chat data or any AI
  app's files. `serve.py` opens everything read-only (Cursor's SQLite via
  `mode=ro`, else a private temp copy). The usage meter only *reads* Claude
  Code's `settings.json`; turning it on is your edit (or Claude's, with
  your yes — see Ask first). When Claude Code can't be asked, it reads the
  numbers the Claude apps saved themselves — `~/.claude.json` is parsed and
  only `cachedUsageUtilization` kept (the rest, your account and any key
  Claude Code saved there, is never kept or sent), and Claude desktop's
  `plan-usage-history.json` — numbers and times only. **Copy resume command** only copies text:
  serve.py never starts a terminal or an app (`/api/resume` just reads a
  session's folder and whether it's open right now). The one program it
  starts is macOS's `open -R` for **Show in Finder**: Finder shows a chat's own file, selected, never opened or run
  — a file the server found itself from the chat's app and ID
  (`/api/source`), never a path the page sends (`/api/reveal`). **Your commits** are
  read with `git log` / `rev-parse` / `config --get` / `for-each-ref` only,
  with every repo-config hook to run a program switched off (`GIT_SAFE`);
  never `git status`, never anything that writes; who made each (you, or an AI
  tool) comes from the tools' own logs — Claude Code's, Cowork's, Copilot in VS
  Code's, Copilot CLI's — which are only read. **Keep a copy** (the
  Expiring tab) copies a Claude Code transcript *out* of `~/.claude` into
  `~/.throwbacks/kept/` on the user's click; nothing in `~/.claude` is ever
  written, moved or deleted.
- **No build step, no npm, no dependencies.** `js/package.json` is only a
  `{"type": "module"}` marker so Node can import the app in tests.
- **Pure modules stay DOM-free:** `parse`, `model`, `time`, `tags`, `linkify`,
  `summarize`, `log`, `plans`, `usage`, `resume`, `commits`, `keep` — they must keep running in Node.
- **Escape all message content.** Chat text never becomes HTML: pages build
  DOM from text nodes (`h()` in `ui.js`); chips are built from tokens.
- **Local API guard:** every `/api/*` route goes through `_api_ok()` in
  `serve.py` (loopback client, local `Host`, exact `Origin`, same-origin fetch
  metadata, `X-Throwbacks: 1` sent by `apiFetch`). LAN visitors get static
  files only.
- **Real chat data never enters the repo** — not as fixtures, logs or copies.
  Checks on real data report counts only.
- **Times are estimates** and always carry "≈".

## Run

```bash
python3 serve.py --claude
```
Opens http://127.0.0.1:8770/ — the usual way to run it ("up the server"); `--claude`
enables the keyless summarizer bridge and the live usage meter (they run this Mac's
`claude`, and for usage `copilot`, `codex`, `agy`; `COPILOT_BIN`, `CODEX_BIN`,
`AGY_BIN` point elsewhere). Start it from your own terminal: commands Claude runs here are
sandboxed with no internet, so Claude Code can't reach Anthropic from a server
Claude started. With the server, the app reads every app it
finds as it opens (Settings → Your chats can turn that off); `/?sample` opens the
sample data instead and never reads your apps. Other flags: `--lan`,
`--claude-model <id>`, `--no-store`, `--no-import`; `CLAUDE_BIN=<path>`. HTML/CSS/JS
changes show on reload; restart after editing `serve.py`. `node serve.js` serves the
app without the bridges.

## Test

```bash
node tests/run.mjs
```
Made-up data, ~3 s. Add `--live` for checks against this Mac's real AI-app data
(read at run time through `tests/bridge.py`). Layout: with the server running, open
http://127.0.0.1:8770/tests/layout.html (it uses `/?sample`). Run before and after changes.

## Code map

- `throwbacks.html` — shell: the front page and the journal templates; pre-paint appearance script
- `glass.css` — the design: `--lg-*` tokens, then the skies, at the top
- `js/main.js` — phases, loading every source, the tool filter (a model per filter), routing, the conversation
- `js/parse.js` — every reader → one normalized session shape
- `js/model.js` · `js/time.js` · `js/tags.js` — indexes and queries · ≈time (`GAP_MIN`) · keyword topics
- `js/plans.js` · `js/marks.js` — apps by plan (`APPS`, `PLANS`), the tool filter, weeks, the home day, a day's folders, Still going (pins, archives) · where pins and archives are saved
- `js/log.js` · `js/logstore.js` · `js/daylog.js` — day rows, the sheet's rows and their edits, summary bookkeeping (and Rewrite's earlier versions), Copy rows, CSV · where summaries are saved · writing a day's or week's summary, the end-of-day run, saving edits
- `js/topbar.js` — week strip, month calendar, plan bar and its menus
- `js/journal.js` · `js/sheet.js` · `js/browse.js` · `js/insights.js` · `js/settings.js` — Today, Week and Month · the editable sheet · Sessions and Search · Insights · Settings
- `js/reader.js` · `js/resume.js` — the conversation beside the page (text shaping, path/URL chips, file preview) · the command that continues a session in Claude Code / Copilot CLI, the Claude desktop link, and where a chat's own file is
- `js/commits.js` · `js/commitview.js` · `js/commitspage.js` — your git commits placed on days and folders, who made them (per AI tool, per day / month), the Commits page's filters and bands · how a commit looks (who made it: you, an AI tool, or probably one, and why) · the Commits page
- `js/keep.js` · `js/expiring.js` — which chats Claude Code deletes soon · the Expiring tab (Keep a copy, kept copies, History safety)
- `js/ui.js` · `js/icons.js` · `js/charts.js` — DOM helpers, app marks, rings, toasts, dates · inline SVG icons · hand-rolled charts (SVG, heatmap)
- `js/usage.js` · `statusline.py` — the usage meter's numbers for every plan (Claude, Copilot, ChatGPT/Codex, Google AI/Antigravity, Cursor's plan name) · Claude's status line (the backup)
- `js/sources.js` — the app tiles (front page, Settings)
- `js/theme.js` · `js/glass.js` — appearance (skies, mode, glass, text, fonts) · pointer glare, scrolled bars
- `js/summarize.js` · `js/summarize-ui.js` · `js/summariespage.js` — summarizer logic (and each call's token usage) · its setup dialog, a chat's summary run and the store of chat summaries · the Summaries page (every summary, Recap a period…)
- `js/linkify.js` · `js/sample.js` · `js/util.js` — path/URL detection · sample data · helpers
- `serve.py` — local server, read-only importers, app icons, Claude bridge, summary stores (`~/.throwbacks/summaries`, `daily`, `weekly`), `/api/resume` (a session's folder, open right now?), `/api/source` + `/api/reveal` (a chat's own file; Show in Finder), `/api/commits` (your commits, read-only git; who made each from the AI tools' own logs), `/api/keep` (Claude Code's cleanup setting, kept copies), `/api/marks` (Still going's pins and archives, `~/.throwbacks/marks.json`), `/api/usage` (+ `/refresh {tool}`: asks that tool's own app; `saved`: the Claude apps' own last numbers; `?apps=0` reads no app files)
- `serve.js` — static-only Node equivalent · `tests/` — test suites

## Conventions

- **Colors:** only through `glass.css`'s `--lg-*` tokens (`light-dark()`
  pairs); anything sky-dependent goes in every `[data-sky="…"]` block. Source
  colors `--series-1…6` follow identity, never rank: web, code, copilot,
  cursor, copilot-cli, cowork. Run `python3 tests/contrast.py` (WCAG AA; it
  composites each glass layer over every sky color, light and dark).
- **Type:** `--lg-t-cap` 12.5 · `--lg-t-meta` 13.8 · `--lg-t-ui` 15.5 ·
  `--lg-t-read` 16.6 · `--lg-t-title` 19.2 px; Instrument Serif for titles and
  numbers. Nothing below 12 px.
- **Changing an appearance default:** saves store every setting, defaults
  included, so a new default never reaches existing saves by itself. Bump
  `SAVE_VERSION` in `js/theme.js` (now 3) and read the old default in older
  saves as unset — in `normalizeAppearance` *and* the boot script in
  `throwbacks.html` (tests in `theme.test.mjs` run both).
- **Liquid Glass layering:** an element with `backdrop-filter`, `opacity < 1`,
  a filter or a mask stops its descendants' glass from seeing past it — keep
  frost on pseudo-element layers (as `.pane::after` does) and never fade or
  blur an ancestor of something made of glass.
- **Icons:** `js/icons.js` (`icon`, `iconSvg`, `iconButton`, `<i data-icon>`).
  No emoji in the UI.
- **The `hidden` attribute always wins** (`[hidden] { display: none !important }`).
- **Motion:** `--lg-glide`, `--lg-spring` and `--lg-fast/--lg-mid/--lg-slow`;
  respect reduced motion.
- **Visual changes:** check light and dark, desktop and phone width (and run
  `tests/layout.html`); offer 2–4 options side by side when the choice is a
  matter of taste.
- **New AI-app reader:** needs real files from an installed app. Add a
  read-only `collect_*` in `serve.py` (trim to what `parse.js` reads), a
  parser in `parse.js`, an entry in `SERVER_SOURCES` (`main.js`),
  `APP_SOURCES` (`sources.js`) and `APPS` (`plans.js`, with the plan whose
  limits it uses), and tests (parse, roundtrip, live).

## Ask first

Git commits (there are none yet), downloading anything (e.g. font files), and
changing anything in `~/.claude` (the usage meter's `statusLine` included).
When something is deleted, list each item, its path and why.
