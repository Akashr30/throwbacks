# Throwbacks

*your AI throwbacks — what were you working on?*

A read-only journal of your AI-assistant history, day first. **Today**
opens on the day: its summary (written by an AI you choose, only when you
ask), when each app was active, then that day's sessions from every tool,
grouped by folder — a session opens beside the day. **Week** and **Month**
are an editable sheet, one row per task, ready to copy into any
spreadsheet. **Sessions** shows every
session as a Tree or as Cards: what's still going on top (as cards, with
pin and archive), then either the folder tree in sections (~/Dev, …),
newest first and closed to its paths, with quick chats, commits and
quieter folders folded to a line each, or every other chat as a card,
newest first, by week and month; **Commits** lists every commit of
yours in one place, who made it (you or an AI tool), day by day;
**Insights** has the activity report and
your plans' usage; **Search** finds any message. Tools are grouped by the
plan whose limits they share (Claude · Copilot · Cursor), and a chip
narrows every page to one. Estimated active-hours throughout. No uploads,
no analytics: your chats leave the machine only as the text you send to an
AI summarizer you set up.

The front page lists **your AI apps** as tiles — each with the app's own
icon and what was found on this Mac. Click one to open its conversations,
or *Load all* for everything:

- **Claude Code**, **Claude Cowork**, **GitHub Copilot** (VS Code),
  **Copilot CLI** and **Cursor** — read straight from this machine, one
  click each (needs `python3 serve.py`; see below). *Refresh* re-reads them.
- **Claude.ai** — Settings → Privacy → Export data, then drop the `.zip` or
  `conversations.json` onto the page.
- Tools with no reader yet (Antigravity, Windsurf, ChatGPT, Gemini CLI,
  Codex CLI, OpenCode, Zed) are listed under *Not readable yet*.

Without `serve.py`, *Choose folder* still reads `~/.claude/projects` in the
browser, and any supported file can be dropped onto the page.

## Quick start (macOS)

You need Python 3 (`python3 --version`) and a browser. Claude Code is
optional: with it, the AI day summaries and the usage meter need no key.

1. In this folder, start the server:
   ```bash
   python3 serve.py --claude
   ```
   It opens <http://127.0.0.1:8770/> and reads the AI apps it finds on
   your Mac — read-only — then shows Today.
2. For AI day summaries, Claude Code's command line needs to be logged in
   (the Claude desktop app's login doesn't count). Check:
   ```bash
   claude auth status
   ```
   If it doesn't say `"loggedIn": true`, log in once:
   ```bash
   claude auth login
   ```
   Then in Throwbacks: **Settings → AI summaries → AI summarizer… → Claude
   Code (local)**. (Or paste your own Groq, OpenAI, Anthropic or Gemini
   key there.) Each day is then summarized at 19:00 while Throwbacks is
   open, or when you click **Summarize**; **Summaries → Recap a period…**
   writes older days and a recap of them.
3. Stop it with Ctrl-C in that Terminal. What Throwbacks saves (summaries,
   pins, kept copies) is in `~/.throwbacks`; it never writes to your AI
   apps' own files.

Without Claude Code, `python3 serve.py` runs everything but the keyless
summaries and the live usage meter. To look around with made-up chats
first, open <http://127.0.0.1:8770/?sample>.

## Run it locally

Every way to serve it (the URL to open is printed on start):

```bash
python3 -m http.server 8770
```
…then open <http://127.0.0.1:8770/throwbacks.html> (this one-liner serves a
directory index, so you must open the file by name).

```bash
python3 serve.py
```
…opens <http://127.0.0.1:8770/> (auto-opens your browser).

```bash
node serve.js
```
…opens <http://127.0.0.1:8770/> (auto-opens your browser).

**Why a server, not double-click?** The app is split into native ES modules,
which browsers refuse to load over `file://`; and the live Claude Code folder
reading (with Refresh) uses the File System Access API, which needs a secure
context — `http://localhost` qualifies, `file://` does not.

**Privacy:** by default the bundled servers bind to `127.0.0.1` only —
unreachable from other devices — and nothing is uploaded: the only
outbound calls are the AI summarizer you set up, the usage meter's own
apps (with `--claude`), the fonts, and JSZip when you drop a `.zip`.
Stopping the server (Ctrl-C) stops all access.

**Reading other AI tools' chats:** `serve.py` reads them straight from
this machine, from each tool's own storage:

| Tool | Where it keeps chats |
|---|---|
| Claude Code | `~/.claude/projects/*/*.jsonl` (`$CLAUDE_CONFIG_DIR` respected; subagent transcripts never shown as chats — only their token usage is read) |
| GitHub Copilot (VS Code, Insiders) | `User/workspaceStorage/*/chatSessions/`, `globalStorage/emptyWindowChatSessions/` |
| GitHub Copilot CLI | `~/.copilot/session-state/*/events.jsonl` (fallback: `session-store.db`) |
| Cursor | `state.vscdb` SQLite databases |
| Claude desktop Cowork | `Claude/local-agent-mode-sessions/**/.claude/projects/*/*.jsonl` |

Other tools (OpenCode, Antigravity, Mistral Vibe, Gemini CLI, Codex, …)
need a parser written against a real sample of their data.
Everything is opened **read-only** (Cursor's database through SQLite's own
read-only snapshot, or a private temp copy). The server finds the files
and strips bulky payloads (tool output, diffs, attachments — typically
90–95% of the bytes; trimmed Claude Code files are cached, so *Refresh* only
re-reads sessions that changed). The tiles' icons come from the apps
installed here: `serve.py` reads the PNG images inside each app bundle's
`.icns` (and Copilot's icon from VS Code's built-in Copilot extension) — a
fixed list of bundles, read at request time, never stored or shipped. `js/parse.js` then rebuilds the chats in your browser. Each
chat's VS Code workspace becomes its folder (Sessions → Tree).
`--no-import` disables this. Two caveats: these are **undocumented
internal formats**, so a future Copilot/Cursor update may need a parser
fix; and many Cursor versions store no per-message times — such chats keep
their exact order but show approximate times, marked `~`. Without the
Python server you can still **drop** Copilot session files (`.json` /
`.jsonl`) onto the page.

**Keyless AI summaries via Claude Code (optional):** if this machine has
the Claude CLI installed and logged in, `python3 serve.py --claude`
enables a local bridge (`--claude-model <id>` and `CLAUDE_BIN=<path>` to
configure). The app then offers a **Claude Code (local)** summarizer
provider — no API key; usage draws from your Claude subscription. The CLI
runs with **no tools and no MCP servers** (`--tools "" --strict-mcp-config`)
in an empty temp folder, so text inside a transcript can never make it act
on your machine — and with `--no-session-persistence` (when your CLI has
it), so its runs are never saved into your Claude Code history.

**Picking a session up again:** a Claude Code or Copilot CLI session's
header has **Copy resume command** — `cd '<its folder>' && claude --resume
<id>` (or `copilot --resume=<id>`) to paste into Terminal. Throwbacks runs
nothing; the server only looks up the session's folder (the last one it was
moved to with `/cd`), whether that folder still exists, and whether the
session is open right now — then it says to close it there first, so two
windows never write into one session. Every chat's header also shows **its
file** (click to copy the path) and, on a Mac, **Show in Finder**: the page
names the chat, the server finds its file under the app's own folders and
asks Finder to show it, selected (Cursor: its one database; claude.ai: the
export's name).

**Your commits:** each day's page lists, under each folder, the commits
you made there that day, and Sessions → Folder shows each project's
commits, folded under its chats to one line — yours (the repo's email or
your global one, plus an AI tool's own commit that names you), each tagged
**you** or the AI tool that made it: **Claude**, **Copilot**, **Cursor**,
Codex, Gemini, Aider… or **probably** one. The surest sign is the tool's own
record of the commit it ran — Claude Code's transcripts (with Cowork's and
the copies Throwbacks kept), Copilot in VS Code's chat logs and Copilot
CLI's event logs: the ID git printed, or (amended or rebased since) its copy;
when git printed no ID (`git commit -q`), every commit that landed while it
ran is "probably" the tool's, in the repo it ran in (it follows `cd` and
`git -C`, never a throwaway repo). Then the commit's own mark: a co-author
line, Cursor's `Made-with`, an AI tool as its author. A commit an AI tool's
record shows links to its chat: click its message and the chat opens at the
moment it was made, marked. Each day, week and month says how many
commits and who made them, and **Insights → Who made your commits** adds
them up, month by month. **Commits** (the rail; on a phone, from a day's
commits line, Insights or Search) has them all in one place: how many and
who made them, a square per day (click one to go to that day), then this
week, earlier this month and month by month, each day's commits in columns
— message, who, repo, time, ID — with **Made by** (Anyone · You · each AI
tool), a repo and a filter by words or ID. A day's, week's or month's
commits line opens it at those commits, and Search finds commit messages
too. The server only runs read-only git (`log`,
`rev-parse`, `config --get`, `for-each-ref`), with every way a repo's config
could run a program switched off, and only reads the tools' logs.

**Chats Claude Code is about to delete:** Claude Code deletes a chat once
it hasn't been touched for `cleanupPeriodDays` (30 unless you set it). The
**Expiring** tab lists the ones that go within a week, each with **Keep a
copy** — a gzipped copy in `~/.throwbacks/kept/` on this Mac, shown in
Throwbacks after the original is gone — and says how long your setting
keeps chats (with the line to add when it's short). Throwbacks only copies
out of `~/.claude`; it never changes anything there.

**Local API security:** every `/api/*` bridge (import, app icons, Claude,
summary store) only answers this machine's own browser tab. The request must come
from a loopback client, with a local `Host` header (blocks DNS
rebinding), an exact local `Origin` when one is sent, same-origin fetch
metadata, and the app's custom `X-Throwbacks` header (it forces a CORS
preflight, which is never granted, on any other website). LAN visitors and
other sites get `403`. The bridges exist only in `serve.py`, since Cursor
import needs Python's stdlib `sqlite3`. With `serve.js` or the one-liner, the
app simply hides those features.

**Summaries** (the sidebar): every AI summary in one place — the days, the
recaps (a week's, a month's, any dates' — a short version of the day
summaries: a line, then each project's points, then what's still open;
**Recap a period…** writes one from their day lines, summarizing the missing
days first and saying how many before it starts) and the chats' own (a chat's Summarize button; it
then shows at the top of that chat) — each with the tokens your summarizer
said it used. Day, week, month and period summaries are one small JSON file
each in `~/.throwbacks/daily/`, `weekly/`, `monthly/` and `periods/`, a
chat's in `~/.throwbacks/summaries/` (one JSON + one Markdown file; dirs
0700 / files 0600, written only for loopback requests, named by date only).
Settings → AI summaries → **Send chats from** leaves an app's chats out of
the day summaries, the recaps and the end-of-day run (a chat's own
Summarize still sends that one chat when you click it). Your edits in the sheet
and the rows you add are saved in the same day file. With **end-of-day
summaries** on (Settings → AI summaries, default 19:00), today is summarized
once that time has passed while the app is open, and any of the last 7 days
still missing lines (or with chats since) — only with a summarizer set up,
never on sample data, in one tab at a time, one day at a time, with a
**Stop** bar while it writes; it stops at the first error.
`--no-store` disables these folders (the app then falls back to browser
localStorage).

**Sharing on your LAN (optional):** `python3 serve.py --lan` (or
`node serve.js --lan`) binds to all interfaces and prints a shareable
`http://<your-ip>:8770/` URL. The server only ships the app's files —
each visitor loads *their own* export/folder into *their own* browser.
Over LAN, browsers treat `http://<ip>` as an insecure context, so the
live folder picker degrades to a plain picker and Refresh is
unavailable; everything else works.

**Opening straight into your chats:** with `serve.py` running, Throwbacks
reads every app it finds as it opens and lands on Today (Settings → Your
chats turns this off; nothing is stored either way). `/?sample` opens the
sample data instead and never reads your apps.

**Usage meter (optional):** each plan's limits as a ring on its chip, in the
plan's menu, in Insights and in Settings → Usage meter — always asked of the
tool's **own** app, with its own login; Throwbacks never uses or keeps a login,
sends no message to a model and nothing from your chats. Live asks need
`python3 serve.py --claude` and run at most once a minute per tool, when
the app opens, when you come back after 5 minutes, and on Refresh; Settings
has a switch per tool, kept by the server in `~/.throwbacks/usage-ask.json`.

| Plan | Numbers | How |
|---|---|---|
| Claude | 5-hour, week, per-model weeks (e.g. Fable) | Claude Code's `get_usage` (on); else the newest numbers already saved on this Mac: `statusline.py`'s, Claude Code's own copy of its last check, Claude desktop's record of its checks |
| Copilot | monthly premium allowance (AI credits / requests), resets the 1st | Copilot CLI's hidden JSON-RPC server, `account.getQuota` (on) |
| ChatGPT (Codex) | 5-hour, week, per-model pools | Codex's own session files, no network; `codex app-server` when turned on (off) |
| Google AI (Antigravity) | 5-hour and week per model group | `agy -p /usage` (its tab-separated rows) from agy 1.1.11, when turned on (off) |
| Cursor | plan name only | one key in Cursor's `state.vscdb`; Cursor shares no usage with other apps |

When Claude Code can't be asked (its login lapsed, say), Throwbacks shows the
newest Claude numbers already saved on this Mac, with their age — read only,
no login: the status line's (below); Claude Code's own copy of its last
usage check (`cachedUsageUtilization` in `~/.claude.json`, every limit with
its reset time — the file is parsed whole and only that entry kept; Claude
Code clears it when you log out, and one made for another account is
dropped); or Claude desktop's record of its own checks
(`plan-usage-history.json`: the 5-hour and weekly numbers of the org Claude
Code is logged in to, no reset times — so a session counts as reset 5 hours
after it, a week at Claude's next weekly reset or 7 days). And Today says
Claude Code isn't logged in to a Claude plan, with the one command that logs
it in (`claude auth login`, copied on a click) and **Check again** (which
waits out the server's once-a-minute gap, then says how it went); each plan's
menu and Insights offer the same for Copilot CLI (`copilot login`) and Codex
(`codex login`).

Claude's backup, the status line: in a terminal, Claude Code hands the
5-hour and weekly numbers to its *status line* after each reply.
`statusline.py` keeps only those numbers (and when it saw them) in
`~/.throwbacks/usage.json` and prints them in the terminal. To turn it on,
add this to `~/.claude/settings.json` (Settings → Usage meter shows the
exact line, with your path):

```json
"statusLine": { "type": "command", "command": "python3 /path/to/throwbacks/statusline.py" }
```

Throwbacks only reads that file; it never changes it. With any status line
set, Claude Code hides a few footer hints.

**Settings** is five short cards — Your chats, Usage meter, AI summaries,
Appearance, Privacy — each saying where things stand and the one thing to
do ("Claude · Not logged in to a Claude plan · Run `claude auth login` in
Terminal"), with how things work folded into one line per card. On a wide
page an overview beside them gives each card's status in a few words
("Usage meter · 3 need a login"); click one to go there. On a phone, just
the cards.

**Appearance (Settings → Appearance):** Liquid Glass — translucent panes and
controls floating over a soft "sky". It opens light, with the **Day** sky
(aqua, with a blue accent); Dawn, Dusk, Night and Mono each bring their own
wallpaper and accent, and *Live* follows the clock (dawn, day, dusk, night).
**Mode** System / Light / Dark; **Glass** Clear or Tinted (far less
see-through; the system's "reduce transparency" setting does the same);
**Text size** Default / Large / Larger (scales everything); interface font
Onest or your system font; replies in sans or serif. Every color is a token
defined once with its light and dark value (`light-dark()`). Stored in this
browser only.

## Files

```
CLAUDE.md         project memory for Claude Code: ground rules, run/test, conventions
docs/decisions.md every feature, every decision and why, open threads
throwbacks.html   shell (markup only): the front page and the journal
glass.css         the Liquid Glass design
statusline.py     the usage meter's backup: a Claude Code status line that saves your plan's usage
js/main.js        entry point: front page, loading, the tool filter, routing, the conversation
js/parse.js       parsers for every source → one normalized shape
js/model.js       in-memory indexes (per-day, per-session) + queries
js/plans.js       apps grouped by plan, the tool filter, weeks, a day's folders
js/usage.js       the usage meter's numbers as the app shows them (live from Claude Code, or the newest saved: the status line, Claude Code's last check, Claude desktop's)
js/log.js         each day's rows, the sheet's rows and edits, the AI summaries' bookkeeping, copy, CSV
js/logstore.js    where the day and week summaries are saved
js/marks.js       where Still going's pins and archives are saved (~/.throwbacks/marks.json)
js/daylog.js      writing a day's or a week's summary, sheet edits, end-of-day runs (one job at a time)
js/time.js        ≈active-hours heuristic (GAP_MIN lives here)
js/tags.js        local keyword topics for Insights
js/linkify.js     file-path / URL detection inside messages
js/ui.js          small DOM helpers: element builder, app marks, rings, toasts, dates
js/topbar.js      the week strip, the calendar, the plan bar and its menus
js/journal.js     the Today, Week and Month pages
js/sheet.js       the editable sheet (one row per task, by date or by folder) on Week and Month
js/browse.js      the Sessions page (a Tree, or Cards) and Search
js/insights.js    the Insights page (usage and the activity report)
js/settings.js    the Settings page: five short cards, an overview beside them on a wide page
js/reader.js      the conversation beside the page (chips, code, approximate times)
js/resume.js      the command that continues a session in Claude Code or Copilot CLI (copied, never run); where a chat's file is
js/commits.js     your git commits placed on days and folders (no DOM)
js/commitview.js  how a commit looks: message, who made it (you / Claude / probably Claude), when, ID
js/commitspage.js the Commits page: Made by, a repo, words, the summary and heatmap, day by day
js/summariespage.js the Summaries page: every summary, one beside the page, Recap a period…
js/keep.js        which Claude Code chats its cleanup deletes soon, and the kept copies (no DOM)
js/expiring.js    the Expiring tab: Keep a copy, kept copies, History safety
js/sources.js     the app tiles (front page and Settings)
js/charts.js      hand-rolled charts (SVG, and the activity heatmap)
js/icons.js       the inline SVG line icons
js/theme.js       appearance: skies, mode, glass, text size, fonts
js/glass.js       Liquid Glass helpers (pointer glare, scrolled bars)
js/summarize*.js  optional AI summarizer (logic + dialogs)
js/sample.js      "Try sample data" generator
js/util.js        shared helpers
js/package.json   tells Node these files are ES modules (for the tests)
serve.py          zero-dependency local server (primary)
serve.js          Node equivalent, no packages
tests/            test suites — see "Tests" below
```

No build step, no bundler, no npm. Two kinds of external resource, neither
of which ever carries chat content: the fonts, from Google Fonts — Onest,
Instrument Serif, Geist Mono and Newsreader; the browser downloads only the
ones in use, and offline the app falls back to your system fonts —
and JSZip, lazy-loaded from cdnjs only if you drop a `.zip`.

Times are **estimates**: activity blocks with gaps ≤ 15 min merge together,
plus a 2-minute reading tail — hence the “≈” on every figure. Parallel
sessions are union-merged per day, so a day total never double-counts.

## Tests

Needs Node 18+ and python3; nothing to install.

```bash
node tests/run.mjs
```
…runs every suite in a couple of seconds, using made-up data only:

| Suite | Checks |
|---|---|
| `parse.test.mjs` | every reader: Claude Code (Throwbacks' own summarizer runs skipped), Copilot logs and snapshots, Cursor, Copilot CLI, Cowork |
| `model.test.mjs` | the model on the sample data (a folder's ≈time in Insights a union), the summarizer's flow, path/URL detection |
| `roundtrip.test.mjs` | files trimmed by `serve.py` parse exactly like the raw ones |
| `theme.test.mjs` | the saved appearance (and saves from the two-design days), the live sky's hours, and the boot script's first paint |
| `plans.test.mjs` | apps grouped by plan, the tool filter, weeks and the day Today opens on, a day's folders with their merged ≈time; Sessions: which folders start open, quick chats, Still going (pins, archives, a branched chat once, no command-only chats), the Date bands, the tree's sections; the saved view settings (older saves open Sessions by Folder) |
| `usage.test.mjs` | the usage meter's numbers: live from Claude Code (every limit, per-model ones named, the ring on the fullest) or the newest saved reading (the status line, Claude Code's last check, Claude desktop's — no reset time: 5 hours / 7 days); windows that reset since, a login that reports no plan usage, live readings that failed, the command that logs each tool in again |
| `marks.test.mjs` | where Still going's pins and archives are saved: through `serve.py`, in the browser (`--no-store`, a LAN visitor, `serve.js`), the sample's in its tab; a server away for a moment or from before `/api/marks` never sends them where the next Refresh won't look |
| `sources.test.mjs` | what each front-page app tile offers |
| `charts.test.mjs` | the activity heatmap's math: shades by quartile, the Monday-first weeks, streaks |
| `log.test.mjs` | each day's rows: days by week, chats in order (grouped by folder in the sheet), what a summary covers and what's new since, a Rewrite keeping the previous version, the sheet's rows and edits (kept by Add new), the copy and CSV (formulas can't run) |
| `resume.test.mjs` | Copy resume command: which sessions can be resumed (UUIDs only), shell quoting (quotes, `$(…)`, newlines refused), the command when the session is open elsewhere (close it there first), running in the background, its folder is gone or it's no longer there; where a chat's file is asked for (app and ID only, odd IDs refused) and named; which folders start open in Sessions → Folder |
| `commits.test.mjs` | your commits on the journal: indexed per repo, a folder's (and a subfolder's) commits from its repo, a day's, commits in folders without a chat that day, the sample's, the chat a commit links to for each app, every tool's tag, who made them (a day's line, month by month); the Commits page's filters (Made by, a repo, words or an ID), its bands and the day a link lands on |
| `keep.test.mjs` | which chats Claude Code deletes within a week (by when its file was last written + the setting), not kept ones or other apps', kept copies' order, the sample's |
| `summarize.test.mjs` | the day and week summaries with a stand-in AI: only new parts sent, with earlier lines; chats batched; cancel and errors keep what finished |
| `test_serve.py` | the `/api` guard, path traversal, the icon route, the summary files, the resume route (a session's folder after `/cd`, open right now or not, only an app and a UUID, `.key` files never opened), where a chat's file is and Show in Finder (each app, refused IDs, `open -R` only on the file the server found), the commits route (only your commits — both emails — and an AI tool's own that names you, no stash; which shell commands make a commit and where — `cd`, `git -C`, `sh -c`, here-documents, throwaway repos; tagged by each tool's own record — Claude Code's, a kept copy's, Copilot in VS Code's, Copilot CLI's — by ID, by an amended commit's copy, or probably by time — every commit during a quiet run, an amend by when it was committed, a failed push, a refused run —, by every tool's co-author line or author; a repo whose config would run a program never gets to; nothing under `.git` or in the tools' logs changes), Still going's pins and archives (one change at a time, two tabs at once, 0600, Restore pinning again, a damaged file set aside rather than written over, bad changes refused, `--no-store`), keeping a copy (0600 in a 0700 folder, the whole transcript, shown after the original is gone, following it while it changes; nothing in Claude Code's folder written; removing a copy leaves the original), the usage route (read-only, never writes Claude Code's settings; the Claude apps' saved readings as numbers only — never the account, a key or an id — and none on the sample), the live usage reading (a stand-in Claude Code: locked-down run, numbers only, errors named, at most once a minute), the summarizer bridge never saving its runs, the trimming helpers (a reply's id and request id kept with its usage; subagents' usage only, with their session) |
| `test_usage_tools.py` | the other tools' usage against stand-ins: Copilot CLI's quota (allowance, AI credits, pooled, errors, locked-down run), Codex's session files (every shape) and app-server (handshake), agy (version gate, never via the model), Cursor's plan by one key, the refresh route, sample mode reading no app files |
| `test_statusline.py` | the usage meter's status line: only numbers kept, an idle window can't overwrite newer usage, private atomic writes, never fails |
| `contrast.py` | WCAG contrast of every text color on every surface, light and dark, under every sky (each glass layer blended over every sky color) |

```bash
node tests/run.mjs --live
```
…adds `live.test.mjs`: the same comparisons against the AI-app data actually
on this machine (read at run time through `tests/bridge.py`; only counts are
printed, nothing is saved, and tools that aren't installed are skipped).

Layout needs a real browser: with the server running, open
<http://127.0.0.1:8770/tests/layout.html>. It loads the front page, then the
journal on its sample data (`/?sample`, which never reads your apps), and
checks at 14 widths, every text size and both fonts that nothing scrolls
sideways and the top bar fits; that the conversation sits beside the page,
floats over it on a laptop and fills a phone's screen; that menus open on
screen; that every page renders; that a phone's tab bar never covers
the end of a page; that each of a day's cards fills its place in the
grid with its text and buttons inside, a long path in the first message
included; that a long summary (a made-up one, shown directly) scrolls
as one under a title that stays put, wide and on a phone; that Sessions
shows Still going and the folder tree under its sections, by folder and
by date, no row's buttons on its name or title and every row's times in
one column; that Still going shows every chat as a card (four to a row
wide, a row to swipe on a phone), each with its path and its text clear
of its buttons, and that pin, archive and Restore work, and that Cards
shows every chat once (Still going's, then by week and month), each card's
app and day on one line; and that the
sheet groups by date (a band per day, its folders) and by folder, every
row whole, with nothing cut off; and that Commits shows Made by in the
plan bar's place, each commit in columns that line up (its message on a
line of its own on a phone), that Made by narrows it, that a heatmap square
and a day's commits line land on that day in view (the square's smooth
scroll only while the browser pane is visible), and that Search finds
commit messages; and that Settings shows its overview beside the cards on
a wide page (a click marks and shows a card, the last one marked at the
end) and none on a phone, with a fold staying open when the page redraws; and
that Summaries lists the sample's made-up summaries under bands with its
filter in the plan bar's place, opens one beside the page (full screen on a
phone), and that Today links there and Month has its recap card.
