# Throwbacks — features

What Throwbacks does, feature by feature. Read this before changing
behaviour. How to run, test and navigate the code is in `CLAUDE.md` and
`README.md`.

---

## 1. What it is

A read-only journal of one person's AI-assistant history, **day first**:
Today opens on the day — its summary, when each app was active, then that
day's sessions from every tool, grouped by folder — and a session opens
beside the page. Week is a sheet of each day's lines; Sessions shows every
session as a folder tree or as cards; Commits lists every commit of yours,
who made it, day by day; Summaries holds every AI summary — days, recaps of
a week, a month or any dates, and chats'; Insights holds the activity report and the
plans' usage; Search finds any message. Tools are grouped by the plan whose
limits they share (Claude · Copilot · Cursor), and a chip narrows every page.
Estimated active time throughout, an optional AI summarizer and an optional
usage meter. It runs locally: plain ES modules served by a tiny local server.
Nothing about the chats leaves the machine unless the user explicitly asks
for an AI summary.

One design, **Liquid Glass** (`glass.css`). It started (2026-09-06) as a
WhatsApp-style chat viewer; the journal replaced that structure on
2026-10-06, and the earlier **Classic** design was retired with it.

---

## 2. Features

### 2.1 Loading data
- **Straight into your chats.** With `serve.py` running, Throwbacks reads
  every app it finds as it opens and lands on Today (Settings → Your chats →
  "Open straight into my chats" turns this off; nothing is stored either
  way). `/?sample` opens the sample data instead and never reads any app.
- **The front page = "Your AI apps"**, for a first run, a machine without
  `serve.py`, or after Clear: one tile per tool, showing the app's own icon
  and what was found on this Mac ("60 sessions", "Found on this Mac", "Not
  found on this Mac"). Click a tile to open that tool's chats; **Load all N
  apps** loads everything found. The same tiles are in Settings → Your chats,
  with a check mark on tools already loaded.
- **Sources and how each is read** (all read-only):

  | Tool | Where it lives | How |
  |---|---|---|
  | Claude Code | `~/.claude/projects/*/*.jsonl` (respects `CLAUDE_CONFIG_DIR`) | one click via `serve.py`, or **Choose folder** in the browser |
  | Claude Cowork | `Claude/local-agent-mode-sessions/**` | `serve.py` |
  | Claude.ai | the account export (`.zip` or `conversations.json`) | drop or choose the file |
  | GitHub Copilot (VS Code / Insiders) | `workspaceStorage/*/chatSessions/`, `emptyWindowChatSessions/` | `serve.py`, or drop session files |
  | Copilot CLI | `~/.copilot/session-state/*/events.jsonl`, fallback `session-store.db` | `serve.py` |
  | Cursor | `state.vscdb` SQLite databases | `serve.py` |

- **Not readable yet:** Antigravity, Windsurf, ChatGPT, Gemini CLI, Codex CLI,
  OpenCode, Zed — listed under the tiles; the server reports which are present
  on this machine ("on this Mac").
- **Drop anywhere / Choose file / Choose folder / Try sample data.** The sample
  generator makes Claude.ai, Claude Code, Copilot and Cursor sessions,
  including multi-day and overlapping ones, so the views, cross-day links and
  time math can be demoed without real data.
- **Refresh** (in the top bar and in Settings) re-reads every tool loaded
  through `serve.py` and the picked folder; pages update in place.
- Without `serve.py` (plain static server, `serve.js`, or a LAN visitor) the
  tiles fall back: Claude Code → folder picker, Claude.ai → file, others →
  "Needs python3 serve.py".

### 2.2 What each reader does
- **Claude Code:** one file = one session. Title = the name the user set
  (`custom-title`) > the latest auto name (`ai-title`) > `summary` > first
  message — the same name Claude Code shows. The first `cwd` gives the
  session's folder and project. Only typed text renders; tool calls, tool
  output, thinking and subagent traffic count as activity but are never
  shown as bubbles. Nor are the "user" lines Claude Code writes itself
  (since 2026-11-02): a background task's notification, a command's
  output, a skill's text, "[Request interrupted by user]", a compacted
  session's summary (marked `isMeta` / `isCompactSummary`, which the
  server's trimming keeps) — they count as activity, never as your message,
  the first thing you asked or a title; a slash command you ran shows as
  you typed it ("/model opus"). Subagent transcripts (`…/subagents/`) are never
  sessions, nor are Throwbacks' own summarizer runs — by their
  `throwbacks-claude-…` temp folder, or, for the oldest (saved in the
  folder serve.py ran in, Sept 2026), by their one message starting with
  the bridge's fixed prompt — or being Test key's "Reply with exactly: OK"
  / "ping" (since 2026-11-13: two had shown as chats). Token usage feeds the
  token chart — every kind, as Claude Code's own stats count it: input,
  cache writes, cache reads and output (since 2026-11-16; cache reads, most
  of it, were only in the tooltip before) — each reply once (Claude Code writes one reply as several
  lines, its text and each tool call, every one repeating its usage as it
  streams: the same message id and request id are one reply, at its
  largest counts), its subagents' and workflow agents' replies included
  (their usage only, never as messages or time), and a reply copied into a
  branched or resumed chat once overall (since 2026-11-16; until then it
  counted most replies two or three times and left subagents out).
- **Server trimming for Claude Code:** `serve.py` cuts each line down to what
  `parse.js` reads (type, timestamp, first `cwd`, titles, usage with its
  reply's id and request id, text parts; a session's subagent transcripts
  as their usage lines only, `subTokens`)
  — about 8% of the bytes (e.g. 189 MB → 15 MB) — and
  caches trimmed files by (mtime, size), so Refresh only re-reads changed
  sessions. A test proves trimmed and raw files parse identically.
- **Copilot (VS Code):** reads `.json` snapshots and `.jsonl` operation logs.
  Log ops: kind 0 = initial state, 1 = set at path, 2 = push to array (with
  `i`: truncate to `i` first, then append — determined empirically), 3 =
  delete. Replies are stamped at request time + `totalElapsed`; long agent
  runs fill activity so they aren't cut into blocks. Inline references
  become paths/names in the sentence; text breaks into a new paragraph at
  each tool call. A session stored twice (snapshot + log) collapses to the
  copy with more requests. The server prunes bulky payloads index-safely
  (215.7 MB → 8.9 MB). The VS Code workspace becomes the folder; a deleted
  untitled workspace gives no folder.
- **Cursor:** composers + bubbles from SQLite, opened read-only
  (`mode=ro`, else a private temp copy). Many Cursor versions store no
  per-message time: such messages keep exact order but get synthesized
  times one minute apart, shown with `~` and a header note.
- **Copilot CLI:** events log first, database turns as fallback. Messages
  injected by the CLI (skill context, autopilot) are hidden but still count
  as activity; every message the user typed appears.
- **Cowork:** Claude Code-format transcripts; the desktop app's title wins
  unless it is the "New chat" placeholder. No folder (its cwd is a sandbox).
- **Claude.ai export:** per spec — text or joined text content, sessions by
  `uuid`, untitled → "Untitled conversation".

### 2.3 The journal: pages and navigation
- **Two phases:** the front page and the journal are never mounted at the
  same time (`setPhase`). A failed load never leaves the front page; inside
  the journal, load errors show in Settings → Your chats and as a toast.
- **A rail** (Today · Sessions · Commits · Summaries · Insights · Search ·
  Expiring, Settings at the bottom); on a phone, tabs along the bottom —
  five of them: Commits, Summaries and Expiring are reached from the pages
  that link to them. Routes are hashes: `#/today`, `#/day/<date>`,
  `#/week/<monday>`, `#/month/<YYYY-MM>`, `#/sessions`, `#/commits`
  (`/<day or month>`: at those commits), `#/summaries`, `#/insights`,
  `#/search?q=`, `#/expiring`, `#/settings` — back / forward work.
- **The plan bar** on every page: All tools, then one chip per plan with
  chats — **Claude** (Claude Code, Cowork, claude.ai), **Copilot** (VS Code,
  Copilot CLI), **Cursor** — plus **ChatGPT** (Codex) and **Google AI**
  (Antigravity) when the usage meter has something for them (they have no
  chat reader yet, so their menu shows only usage) — each with a ring for
  how much of its tightest limit is used (amber from 80%, red from 95%;
  dashed when there's no number). A chip narrows every page to that plan; its menu picks one app
  and shows the plan's usage windows, when they reset and how fresh the
  reading is. The filter builds a model of just those sessions, so every
  ≈time stays a true union.
- **Today (home):** the day the app opens on — today, or the last day with
  chats before it ("Nothing yet today — here's …"). A **week strip** on top
  (each day's ≈time as a little bar, today ringed; ‹ › step to the previous
  / next day with chats, ← → too), a **month calendar** to jump further
  (shaded by ≈time, Latest month), and **Day / Week**. The day: its title,
  ≈time and first–last activity, **Copy rows**; the **summary** (§2.6);
  **when each app was active** (a lane per app, a block per stretch of a
  session — click one to open it); then the **sessions** as cards grouped
  by folder (each folder's ≈time a union; "No folder" last), with app, time
  range, the first thing asked, ≈time, messages and "day 2 of 3"; under
  each folder, that day's commits (§2.14).
- **Week and Month: the sheet** (Day · Week · Month in the top bar; Day
  goes back to the day you came from when it's in that week or month, and
  the browser's back works too) — a spreadsheet-looking grid, one row per
  task, with **Group by Date / Folder** above it (remembered; "Date", like
  Sessions', so the page's only Day button is the top bar's). **By Date**
  (the default): each day is a band across the sheet (its date, ≈time,
  first–last, tasks, Open day; today marked), its folders are sub-heads
  (the folder, the apps of its chats, their ≈time together; "No folder"
  last), then the numbered tasks — **# · Task · App · ≈Time**, a chat's
  app (opens it) and ≈time on its first line — and each week's total
  after its days. **By Folder**: each folder once for the week or month,
  busiest first ("No folder", then your own rows, last), with its ≈time
  and how many days and tasks, then **Day · # · Task · App · ≈Time** with
  the day on its first row (a new day gets a firmer line), and a total at
  the end. Every row is whole: no merged cells (they read as rows left
  open). A day's rows are its summary lines (its chats grouped by folder,
  in the order each folder's first chat started), the rows you added, or
  — until it's summarized — its chats' titles. **Editable** (§2.6; add a
  row of your own by Date). The Week page has the week's **summary** card
  on top; Month (`#/month/YYYY-MM`, ‹ › and ← →) lists its days with chats
  and, by Date, each week's summary inline. Both pages are as wide as
  Insights. On a phone or beside the conversation, an app shows as its
  icon; by Date the sheet fits the screen, by Folder it scrolls inside its
  card. **Copy rows** and **CSV** keep their columns and give the
  day-by-day rows in either grouping; selecting cells and copying works
  too.
- **Sessions:** every session, with a filter field (finding nothing, it
  offers to search every message) and **Tree / Cards** (until 2026-11-12
  "Group by Folder / Date"), Tree first (remembered; the plan bar does
  what Group by Tool did). Both start with Still going. Tree:
  - **Still going** on top — chats you came back to on another day and
    worked on in the last two weeks, and the ones you **pinned** (they
    stay until you unpin them), pinned first, then newest first. Every
    one is a card, none behind "Show more" (since 2026-11-12): four to a
    row on a wide page, one row to swipe on a phone with the next card
    peeking in. A card: the app, when you last worked on it, the title
    (two lines at most), the folder's path ("No folder" when it has
    none), how many days, ≈time; **pin** and **archive** at its top
    right when you point at it (in place of the day; on a touch screen
    they stay), the resume buttons bottom right; a pinned card is
    outlined. **Archive** takes a chat out until you work on it again
    (compared with its own last message, not the clock); the archived
    fold under the cards ("2 archived · back here when you work on one
    again") lists them, newest archived first, with **Restore** — which
    pins it again if it was pinned — until two weeks after you archived
    a chat that has gone quiet. Left out: a chat where you only
    ran commands ("/model") or typed nothing, and a branched chat's other
    copies (they start with the same message of yours at the same
    moment: the pinned one shows, else the newest; an archived copy keeps
    the others out with it unless one is worked on after) — but a chat you
    pin always shows, whatever these rules say. Pins and
    archives are Throwbacks' own — chat IDs and times in
    `~/.throwbacks/marks.json` (0600, one change at a time under a lock,
    `GET`/`POST /api/marks`; a damaged file is set aside as
    `marks.json.damaged-…`, never written over; this browser's storage
    with `--no-store`, on a LAN visitor's page or without serve.py; the
    sample's in its tab only). A serve.py from before `/api/marks`, or
    one that isn't answering, saves nothing — the toast says to restart
    it — so no pin lands where the next Refresh won't look. Archiving
    here never archives the chat in its app. A folder holding a chat
    that's still going shows a dot.
  - The tree of folders sessions started in (chains of empty folders
    compressed; sessions by their exact names) **in sections**: a folder
    at the top that holds only folders is a label over them (**~/Dev**,
    with its projects as the rows; a folder of only such folders hands
    them down: ~ → ~/Dev, ~/Work), and the rest go under **Elsewhere** —
    your home folder's own chats as "~ (home folder)", any other folder,
    and "No folder" (claude.ai, Cowork, …). Rows **newest first** (by your
    last chat or commit there).
  - It **opens closed, to its paths**: folders of folders open, the rest
    closed, each row with its count, ≈time together (the union of its
    sessions), its commits and when you last worked there; a folder with
    just one session is that session's row (folder · app · title · ≈time
    · date — a click opens it). Inside an open folder: its subfolders,
    its chats (what they span — "since 7 Sep · active on 31 days", or
    their messages — ≈time and last day), then two folds of one line
    each: its **quick chats** (two or more of a question and its answer,
    under 5 minutes: "3 quick chats · ≈6m together") and its **commits**
    ("184 commits · 2 by Claude · newest yesterday"; open, the newest 10,
    then Show all; "you" goes without saying there). A section's folders
    with nothing in the last 90 days fold into "N quieter folders".
  - On hover or focus, a row shows its buttons in place of its ≈time and
    date (so every row's times stay in one column): **Open as one chat**
    on a folder (not on your home folder, which holds every other one),
    the resume buttons on a chat you can pick up again, and a one-chat
    folder's commits (which open it with its commits). On a touch screen
    they stay beside the row, Open as one chat on an open folder only; on
    a narrow tree (a phone, or beside the conversation) the rows' resume
    buttons go (they're on Still going and in the conversation's header),
    Open as one chat is its icon, and the ≈time and date — and a
    one-session folder's title — move to a second line.
  - **Expand all** (every folder, quick chats and quieter folders; not
    commits) / **Collapse all** (back to the paths); what you open or
    close, folds included, is remembered in this browser (up to 400);
    while you filter, everything opens, nothing folds and commits hide.
  Cards (since 2026-11-12; it was Date, a list): Still going, then every
  other chat as the same card — its path on it, pin but no archive;
  pinning one puts it in Still going — newest first, in bands: **This
  week**, **Earlier in November**, then one band per month (each a link
  to its sheet), a band's quick chats folded into one line that opens to
  their cards. On the Tree, Still going's heading has **See all N as
  cards**, which switches to it. A phone gets one card to a row. A
  folder's name on **Today** opens it in the Tree, open and in view.
- **The conversation** opens beside the page from any session (wide
  screens: a third column; laptops: floating over the page; phones: full
  screen with a back arrow; Esc closes). Header: the title (the whole width,
  two lines at most), then one line of what it is and where it lives — the
  app, the folder (click to copy), the chat's own file (click to copy its
  path; Show in Finder — §2.13), ≈time; each whole, a long name shortened
  with "…" — then its buttons on a row of their own: **Copy resume
  command** for Claude Code and Copilot CLI sessions (§2.13); **Summarize**
  (a whole-session summary) when a summarizer is set up; icons only on a
  narrow conversation. (Until 2026-11-02 the buttons sat beside the title
  and squeezed it, and the file name broke letter by letter.) A multi-day session opened from a day shows
  "<day> only / Whole session" and a pill per day (opens that day). What the
  day summaries say about the session comes first; then the messages — your
  messages as bubbles, the AI's replies full width like a document, with
  paragraphs, lists, headings, **bold** and `code` shaped from the text,
  fenced code as code blocks, times (`~` when approximate). Messages over
  3,000 characters show the start with "Show all"; long chats draw the
  latest 160 messages with "Show earlier", and a whole session or a folder
  as one chat **opens at its latest day** (its date at the top) — a session
  opened from a day starts at that day, a search hit at the hit. (Until
  2026-10-09 it opened at the top of those 160, which in a busy folder was
  two days back, so the latest days seemed missing.)
  **Oldest first / Newest first** (shown when it spans more than one day,
  remembered): Newest first puts the newest day on top, like the Sessions
  list, with each day's messages still in reading order (a question above
  its answer) and "Show older messages" at the bottom — rather than reversing
  every message, which would put each answer above its question. Oldest first stays the default. A folder as one chat interleaves
  its sessions with a chip at each change.
- **Paths and URLs in messages** become chips: URLs open in a new tab; a file
  inside the folder opened with Choose folder opens a read-only preview;
  any other path copies to the clipboard. Relative paths are completed from
  the session's folder. Paths inside code blocks are left alone.
- **Search:** ≥2 characters, debounced, across messages and titles (⌘K /
  Ctrl+K from anywhere); results grouped by session with up to three
  highlighted snippets; a hit opens the conversation at that message,
  highlighted. The tool filter applies. Your commits are searched too (all
  tools only): the newest three that match, above the sessions, then **See
  all N on the Commits page**, which opens it with the same words.

### 2.4 Time estimates
- Activity blocks: gaps ≤ 15 min (`GAP_MIN`) merge; each block gets a
  2-minute reading tail (`TAIL_MIN`). Day totals are the **merged union** of
  all sessions that day, so parallel sessions never double count. Every
  timed line counts, rendered or not. Every figure carries "≈".

### 2.5 Insights
Your plans' **usage** first (each plan's windows, or why there's no number
yet), then the activity report for whatever the tool filter shows: cards
(sessions, messages, active days, active time, Claude tokens); an **Activity
heatmap** like GitHub's (a square per day for the last 12 months, weeks as
columns, Monday on top, darker for more ≈active time; hover for the day's
time and messages, click to open the day; year buttons when the history
spans several years; total, active days and longest streak below); "where
the time went" donut by each session's primary topic; **Activity over time**
and **Token consumption** (dot chart; every kind of token, cache reads
included, as Claude Code's stats count them, the split on each dot) with
Daily / Weekly / Monthly; Topics
and Folders bars (expand to their sessions); Apps share bar; busiest days;
longest sessions; most active hours; **Who made your commits** (all tools
only, §2.14); **Markdown** download in the top bar.
**Topics are local keyword matches** (`js/tags.js`) — no AI, no network.
A folder's ≈time in the Folders bars is its sessions' union, as on Sessions
(until 2026-10-27 it added parallel sessions up).

### 2.6 Day summaries and recaps
- **A day's summary:** short work-log lines per chat, grouped by folder,
  written by the summarizer you set up (your Claude Code login works, no
  key) — when you click, or at the end of the day (below). Until then the
  card lists what you worked on (titles and the first thing asked) with
  **Summarize this day**. When you chat more that day it shows "New since
  15:02 · 2 chats" and **Add new** sends only the messages not summarized
  yet, adding lines under each chat; **Rewrite** redoes the whole day (and
  keeps the version it replaces, below); the bin removes it — under a tool
  filter only that tool's lines (other tools' lines and your rows stay).
  Under a tool filter it summarizes that tool's chats and keeps the rest.
- **Edit it in the sheet:** click a task to change it (Enter or click away
  saves, Esc undoes, an emptied cell is removed), × removes a row, "Add a
  row…" adds one of your own. Edits are applied to the whole saved day
  (never a filtered copy) and saved with it; **Add new keeps them** (it only
  adds lines), your own rows survive Rewrite, and the day shows "edited".
  A week's or month's recap is edited as its text (§2.6 Recaps: Edit, Enter
  a new line, ⌘/Ctrl+Enter or leaving saves, Esc undoes, emptied it keeps
  the old text). A redraw never pulls a
  cell out from under your typing (a cell you only clicked into is redrawn
  and you're put back in it). A line is saved by the text it showed, so an
  edit made after the rows shifted still finds its line, or says the row
  changed; a summary finishing while you edit adds onto the day as it is
  then, so your edits and rows stay.
- **End-of-day summaries** (Settings → AI summaries, on by default, at
  19:00): while Throwbacks is open, today's summary is written once your end
  of day has passed, and any of the last 7 days with chats not summarized
  yet (checked when it opens and every 5 minutes; oldest first; only what's
  new is sent). While it writes, a bar at the bottom right (the top on a
  phone) says which day and has **Stop**; the day's card can stop it too,
  and unticking the setting does. Stop, or an error (the toast names the
  day), ends it for that session — ticking the setting again or setting up
  a summarizer starts it again. One tab at a time (a Web Lock, which every
  summary job takes since 2026-11-14 — a day's, a recap's — waiting for
  another tab's, "Waiting for another tab's summary to finish…"), after
  reading the saved summaries again, so two open tabs never write a day
  twice or over each other's edits (a lock is per address: a tab on
  localhost and one on 127.0.0.1 don't share it). A tab takes a setting
  changed in another (Send chats from, the end of day) at once, so it never
  sends a left-out app nor writes the old setting back. Nothing runs when Throwbacks is closed,
  on sample data (`/?sample`, Try sample data, Add sample data), without a
  summarizer, or when it's turned off; a day with only activity and no
  messages has nothing to write and is skipped.
- **Recaps** (since 2026-11-14; a week's before): a short version of the
  day summaries — never of the chats themselves — written from the day lines
  of a **week** (its page's card), a **month** (the Month
  page's card) or **any dates** (Summaries → Recap a period…: Last 7 days,
  This month, Last month, Custom dates — up to ten years, ending today at
  the latest). Each opens a small window first that says what it will do —
  "Written from 10 days; 9 of them have chats not summarized yet. It
  summarizes those first, then writes the recap — about 10 calls to your
  summarizer.", and how many days have nothing to send and why (only apps
  you left out, only sample chats, no messages); with nothing to send,
  Start is off — and on Start summarizes those days (all tools you send,
  the way Add new does; they then show on their pages too), then writes the
  recap from **every day of it with a summary**, its chats loaded now or
  not, never a left-out app's lines; it keeps which days (Written from) and
  says when a day changed since. Too long for one call (a month on a small
  provider, a long period), it's written a stretch of days at a time, those
  combined again while they don't fit, then the recap — so no day is cut
  out. **In parts** (since 2026-11-16; 2–4 sentences before, which on a
  long period read as one block): a line on the main outcome, then each
  project's points under its name — the day lines are sent under their
  chat's folder, kept with each chat's lines in the day's file since then —
  then "Still open". Drawn that way on the Week and Month cards, the Month
  sheet, the Summaries page and its pane; an older recap shows as its
  paragraph; Copy rows puts it in one cell ("A line · etl: a; b · Still
  open: c"). The window, the empty cards, the Summaries page (with Recaps
  chosen) and the pane ("Written from these day summaries") say what a
  recap is; the cards are "Week recap" / "Month recap" ("Recap the week",
  "Update the recap"). Edited on the Week and Month pages as its text —
  Edit (or a click on it), then a line per row, "## " a project, "- " a
  point; ⌘/Ctrl+Enter or leaving saves, Esc undoes; leaving the window
  keeps it open.
  A recap that isn't written says why (a toast, and on the Summaries
  page until it's written or dismissed); it opens beside the page when
  done, unless you opened something else or went to another page.
  Editable in place on the Week and Month pages (a failed save shows on the
  card). One summary job at a time (a chat's summary included); its bar
  (what it's writing, Stop) shows on every page but the one whose card is
  running it; Stop keeps what finished.
- **Apps left out** (Settings → AI summaries → Send chats from, since
  2026-11-14): a ticked-off app's chats are never sent — by a day's
  Summarize, Add new, Rewrite, a recap or the end-of-day run — and never
  count as "new"; the day's card says "not sent: Cursor is left out in
  Settings" (a day of only those offers no Summarize). A chat's own
  Summarize button still sends that one chat when you click it (Settings
  and the Privacy card say so). Saved with the view settings, in this
  browser. **Sample chats beside yours** (after Try or Add sample data on
  the normal address) are never sent either — "a sample chat: never sent"
  — so no made-up line lands in your saved days or recaps, and a sample
  chat's own summary stays in the tab (Clear forgets it).
- Saved as one JSON file per day in `~/.throwbacks/daily/`, per week in
  `weekly/`, per month in `monthly/` (`YYYY-MM.json`) and per period in
  `periods/` (`YYYY-MM-DD_YYYY-MM-DD.json`) — this browser's storage with
  `--no-store`, and the tab only (made-up ones) on `/?sample`, which never
  reads yours (until 2026-11-14 it showed your real ones). A day also keeps
  `manual` (your rows), `editedAt`, `previous` — up to three versions a
  Rewrite replaced — and `usage`: the tokens the summarizer said its runs
  used (in, out, cache writes and reads, calls), added up; a recap keeps its
  version's. Both keep `spent`, every run's tokens by the month it ran in
  (`{"2026-11": 18200}`), which the Summaries page's "this month" adds up.
- **Copy rows** (a day, a week, a month): tab-separated, with a header row
  — Date · Time · # · Task · Folder · App · ≈Time, it pastes into any
  spreadsheet — each day's tasks numbered in the sheet's order (by folder),
  and a week's summary as its own row. **CSV:** one row per task, minutes as numbers,
  24-hour times, and what each row is (summary · added by you · not
  summarized yet); cells that would start a formula get an apostrophe.

### 2.7 Optional AI summarizer
- Usable once a provider is set up (Settings → AI summaries → AI
  summarizer…). Providers: **Groq, OpenAI, Claude (Anthropic), Gemini** with
  the user's own API key (stored in this browser's localStorage only), and
  **Claude Code (local)**: no key — it pipes text to this machine's own
  `claude` CLI through `python3 serve.py --claude` (`--claude-model`,
  `CLAUDE_BIN`). Until then the Summarize buttons are replaced by a note
  saying what's missing, with a link to set it up.
- Where it runs: a day and the recaps (§2.6), or a chat (Summarize in the
  conversation's header — its summary then shows at the top of that chat,
  "Summary of this chat", and under Chats on the Summaries page). **Summarize
  a range…** went on 2026-11-14 (below): it re-read every chat of a range
  from scratch, uncapped, and its window didn't stop it.
- A chat's summary: map-reduce. Its text is packed into batches that fit
  the provider's token budget (a very long one is middle-truncated, keeping
  start and end), each gets 3–6 bullets, then one overall recap. It's one
  job like the others: it waits its turn, and closing its window (×, Esc, a
  click outside) stops it. Model lists can be fetched live; "Test key"
  makes one tiny call.
- **Tokens, as counted:** every provider's answer carries what the call
  used (Claude Code: `claude -p --output-format json`'s `usage`; the APIs'
  own usage fields), and each summary keeps the total — shown on it ("12k
  tokens") and added up on the Summaries page ("this month: 36k tokens").
  Older summaries, written before, have none.
- **The summary window** (a range or session as it's written, and every
  summary opened from the history): the title and its buttons (Copy,
  close) and the status line stay put; everything under them, the recap
  too, scrolls as one, and a thin line marks the top once scrolled. Until
  2026-10-13 the recap stayed still and only the list under it scrolled:
  a session's long recap left that list a thin
  strip.
- **The Summaries page** (`#/summaries`, since 2026-11-14; until then a
  "Summary history" window under Settings): **every summary in one place**,
  read from where each is saved, as it is now (edits included) — Days,
  Recaps (weeks, months, periods, and the older range summaries, still
  readable) and Chats, the filter (with counts) in the plan bar's place —
  newest first by the day each reaches, in bands (This week, Earlier in
  November, a month each). A strip on top: how many of each, how they're
  written ("Claude Code (local) · each day at 19:00"), the tokens this
  month, the apps not sent, Settings. A row: its kind, its day or name (a
  chat's name as its app has it now), its first line, its lines / days /
  "a day changed since" / tokens, when it was written. One opens beside the
  page like a chat (a phone: full screen): a day's lines under each chat
  (its app, its name now), your rows, the versions a Rewrite replaced; a
  recap's text and the days it was written from (each opens); a chat's
  recap and points — with Open the day / week / month / chat, Write again
  (a recap), Copy (Markdown) and Delete. **Recap a period…** is on its top
  bar. A chat's and the older range summaries are saved to
  `~/.throwbacks/summaries/` (one JSON + one Markdown file each);
  `--no-store` falls back to browser localStorage. On a phone the page isn't
  in the five-tab bar: Today's summary card has **All summaries**.

### 2.8 Usage meter (optional)
- **What it shows:** each plan's limits as the ring on its chip (the fullest
  limit), in the plan's menu, in Insights and in Settings → Usage meter:
  - **Claude** — the 5-hour session, the week (all models) and per-model
    weekly limits such as **Fable** (below);
  - **Copilot** — the monthly premium allowance (AI credits or premium
    requests), resetting at 00:00 UTC on the 1st; when the organisation
    pools its credits there is no per-person number, and it says so;
  - **ChatGPT (Codex)** — the 5-hour and weekly limits, plus per-model
    pools (e.g. a Spark model);
  - **Google AI (Antigravity)** — a 5-hour and a weekly limit for each model
    group (Gemini; Claude & GPT);
  - **Cursor** — only its plan name and a link to Cursor's usage page:
    Cursor shares no usage with other apps.
- **Live readings, one switch per tool** (Settings → Usage meter): when the
  journal opens, when you come back after 5 minutes, and on Refresh / Check
  again, the app asks the server once per tool that's turned on (`POST
  /api/usage/refresh {tool}`, side by side); the server runs that tool's own
  command-line app — only with `--claude`, at most once a minute per tool —
  and the app tells it nothing but "what's my usage". Claude Code and
  Copilot CLI are on until you turn them off (both approved); Codex and agy
  are off until you turn them on. The switches are kept by the server
  (`~/.throwbacks/usage-ask.json`, 0600; memory only with `--no-store`), so
  it never runs a tool you turned off, whichever browser asks; turning one
  off also forgets its last answer. A switch shows for each tool whose
  command is found.
- **Live, from Claude Code** (the main source; needs `python3 serve.py
  --claude` and Claude Code installed and logged in). When the journal
  opens, when you come back to the tab or window after 5 minutes or more,
  and on Refresh / Check again, the app calls `POST /api/usage/refresh`;
  the server runs Claude Code in the background and sends it one
  `get_usage` request (experimental, with `skip_behaviors`), which answers
  with the rows `/usage` shows. Claude Code makes that one request to
  Anthropic (`GET /api/oauth/usage`) with its own login — Throwbacks never
  sees the login, sends no message to Claude (no AI request) and nothing
  from the chats. The run: `claude -p` with stream-json in and out, no
  tools, no MCP servers, `--no-session-persistence`, an empty
  `throwbacks-claude-…` folder, telemetry / crash reports / update checks
  and the claude.ai connectors fetch off. About 1–2 s. The server keeps only
  numbers and the server's short labels (kind, group, a model's name,
  percent, reset time), runs it at most once a minute (requests in between
  share the answer, one run at a time), and keeps the answer in memory only.
  `/?sample` never asks. Problems are named: not installed, not logged in to
  a plan, couldn't get it right now, essential-traffic-only mode, timed out,
  too old to report usage.
- **Copilot, from Copilot CLI:** `copilot --headless --stdio --no-auto-update
  --log-level error --log-dir <temp>` — its hidden JSON-RPC server
  (Content-Length framing) — then `ping` (protocol 2–3) and
  `account.getQuota` (experimental). The CLI fetches GitHub's numbers with
  its own stored login; no premium request is used. Its log goes to the run's
  temp folder, not `~/.copilot/logs`. It sends GitHub its own startup
  telemetry event, which 1.0.5 can't turn off. The CLI's `resetDate` is the
  fetch time, so the reset shown is the documented 1st of the month (UTC).
- **Codex:** without asking, from its own session files
  (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` and
  `archived_sessions/`): the newest `token_count` rate-limit snapshot per
  limit (the last few MB of the newest files, cached by size and time) — no
  process, no network, as of Codex's last reply. Windows are classified by
  length (300 min / 10080 min), never by primary/secondary (a plan with no
  5-hour limit sends its week as primary); every shape Codex has written is
  read (flat ≈0.40, `resets_in_seconds`, `resets_at`, limit ids). Live when
  turned on: `codex app-server` (one JSON object per line): `initialize`,
  `initialized`, `account/rateLimits/read`; Codex asks ChatGPT with its own
  login and may update its own files while it runs.
- **Antigravity, from the agy CLI** when turned on: `agy --version` must say
  1.1.11 or later (older versions send `/usage` to the model as a prompt,
  spending quota), then `agy -p /usage`, whose print mode writes one
  tab-separated row per limit — `group · window · percent LEFT · reset
  (UTC)` (agy's changelog; its JSON mode's shape isn't documented, so it
  isn't used). A failed run (not signed in, an error exit) is asked again
  later; a normal exit with anything but usage rows (the model answering,
  or a new format) stops all asking until the server restarts. The desktop app's local language server is not
  used (it needs a secret read from another process), nor Google's API (it
  needs Antigravity's sign-in, which its terms forbid other apps to use).
- **Cursor:** one key, `cursorAuth/stripeMembershipType`, read by its exact
  name from `state.vscdb`, so Cursor's sign-in rows are never read. Signing
  out writes "free", so whether Cursor is signed in is told by the length
  of its cached email (cleared on sign-out) — only the length leaves the
  database. Signed out, it says so instead of claiming a plan.
- **Plans with no chats** (ChatGPT, Google AI): their chip opens their menu
  rather than filtering every page to nothing. Both always show — as
  placeholders with a dashed ring until Codex or agy is installed; the
  menu says what's missing and how it fills in.
- **Usage updates redraw only what shows usage** — the plan bar, and
  Insights or Settings when open — never an open conversation.
- **Stuck tools:** every tool runs in its own process group; after a
  timeout the whole group is killed (an npm/nvm launcher runs the real CLI
  as a child sharing our pipes).
- **The status line** (the backup): in a terminal, Claude Code hands the
  5-hour and weekly numbers (`rate_limits` `five_hour` / `seven_day`, each
  `used_percentage` and `resets_at`) to its status-line command after each
  reply — per-model limits aren't passed on. `statusline.py` is that
  command: it keeps only those numbers and when it saw them in
  `~/.throwbacks/usage.json` (dir 0700, file 0600, written atomically under
  a lock) and prints "Session 42% · resets 19:05   Week 31% · resets Mon
  09:00" in the terminal (amber / red near the limit). In one window (the
  same reset time) usage only goes up, so the higher reading wins and an
  idle Claude Code window can never overwrite newer numbers; a later reset
  time is a new window. A reply without numbers is noted. It never fails (a
  status line must not break Claude Code's footer). Turning it on is one
  `statusLine` entry in `~/.claude/settings.json`; Settings → Usage meter
  shows the exact line with a Copy button. Throwbacks itself only reads that
  file (`/api/usage`); it never writes it.
- **Numbers the Claude apps saved themselves** (since 2026-11-16): when
  Claude Code can't be asked (its login lapsed), the meter reads, read-only
  and numbers only, what the Claude apps already keep on this Mac —
  **Claude Code's own copy of its last usage check** (`cachedUsageUtilization`
  in `~/.claude.json`, written whenever it checks: every limit, Fable and
  reset times included; that one entry is taken — the file also holds your
  account's name and email, never kept or sent) and **Claude desktop's
  record of its own checks** (`plan-usage-history.json` in its folder: the
  5-hour and weekly percent, per-model weeks when it has them, no reset
  times; desktop checks when it starts, then for 24 hours after you open
  its menu-bar usage menu). A window with no reset time counts as reset at
  the latest 5 hours (a session) or 7 days (a week) after its reading — a
  week sooner, at Claude's weekly reset time when another reading knows it
  (it repeats every week); the plan's bars say "resets by …". Claude Code
  clears its copy when you log out and drops one made for another account
  (so does Throwbacks); desktop's numbers are those of the org Claude Code
  is logged in to (any org's when it knows none). `~/.claude.json` is
  parsed whole — only that entry is kept, the rest (your account, any key
  Claude Code saved there) is never kept or sent; neither file is read while
  the live reading has numbers, nor on `/?sample`. A live answer that is
  only Claude Code's copy (a login it holds but can't use) keeps that copy's
  age rather than "just now".
- **Which one shows:** the live reading whenever it has numbers — every
  limit from one answer, with one time ("From Claude Code · 3 min ago") —
  else the newest of the status line's ("From the status line · …"),
  Claude Code's last check ("From Claude Code’s last check") and Claude
  desktop's ("From Claude desktop"), whole. They aren't mixed. A
  window past its reset time is set aside ("Session reset since then").
  `/api/usage` is re-read every 2 minutes while the tab is open (the status
  line's file, the saved readings and the last live answer — it never runs
  Claude Code).
- **A lapsed login says so, with its fix** (since 2026-11-16): when Claude
  Code answers that it isn't logged in to a plan (and names no plan — an
  API key or Bedrock answers the same, so the words don't say "logged
  out"), Today (the home day) shows "Claude Code isn't logged in to a Claude
  plan, so your Claude usage (and day summaries, when Claude Code writes
  them) can't update", a button that copies `claude auth login` and
  **Check again** — which waits out the server's once-a-minute gap if it
  asked just now ("Checking…"), then says how it went ("Claude Code is
  logged in — usage updated" / "Still not logged in…") and puts the
  keyboard on the day's title; the note goes when the login is back (a
  toast says so when that happens on its own). Each plan's menu and
  Insights offer the same for Copilot CLI (`copilot login`) and Codex
  (`codex login`); Settings' rows say the command. A Copilot 403 is "no
  Copilot on this account", not a missing login. One command each, run in
  Terminal: Throwbacks never logs in for you (the sign-in must be the
  app's own).

### 2.9 Appearance (Settings → Appearance)
- **Sky:** **Day** (default — aqua sky, blue accent), Dawn, Dusk, Night,
  Mono, or **Live**, which follows the clock (dawn 05–10, day 10–17, dusk
  17–20, night 20–05). Each sky sets the wallpaper and the accent (your
  bubbles, the selected chip, the heat): blue, rose, violet, indigo, graphite.
- **Mode:** opens **light** even when the Mac is in dark mode; Dark and
  System in Settings. **Glass:** Clear / Tinted (far less see-through; the
  system's "reduce transparency" setting gets the tinted values).
  **Text size:** 16 / 17.25 / 18.5 px root (everything scales).
  **Interface font:** Onest (default) / System. **Replies:** Sans (default)
  / Serif (Newsreader). Instrument Serif for the wordmark, titles and
  numbers; Geist Mono for code.
- Saved in localStorage (`throwbacks-appearance`, v3) and applied before
  first paint; saves from the two-design days open right.

### 2.10 Sharing and server
- `python3 serve.py --lan` (or `node serve.js --lan`) shares the app on the
  network; each visitor loads their own data into their own browser. The
  local bridges (import, icons, Claude, summary store) refuse LAN visitors.
- Port 8770, trying the next 5 if busy; `/` and `/?anything` serve the app;
  path traversal and directory listing are refused.

### 2.11 Settings and small touches
- **Settings** (since 2026-11-13: said shorter, with an overview): five
  cards, each saying where things stand in a few words and the one thing to
  do, how things work folded into one line ("How it works"; a fold you
  open stays open when the page redraws, this tab only):
  - **Your chats** — the app tiles ("N more apps Throwbacks can't read
    yet" folded), Load all, Choose file / folder, Add sample data, Refresh,
    "Open straight into my chats", History safety ("Claude Code keeps chats
    365 days", Expiring and kept chats) and **Clear loaded data…** (asks
    first, forgets everything loaded in this tab and returns to the front
    page; files on disk are untouched).
  - **Usage meter** — Check again in its head; one row per plan: who ·
    where it stands ("Not logged in · last numbers from 16 d ago, reset
    since", "Live · 3 min ago", "From its own files · 2 h ago") and under
    it the one thing to do ("Run `claude auth login` in Terminal"; until
    2026-11-16 "Run `claude` in Terminal, then type `/login`") · its Ask switch (what asking sends in its tooltip); the
    bars under a row with numbers; while Codex's or agy's switch is off,
    what turning it on means, on its row; Cursor's usage page; the status
    line backup (on / another one set — its command — / off, with the line
    to add and Copy). How it works holds when it asks, what each tool
    sends, Cursor's terms and the status line. The plan menus and Insights
    keep the full sentences (`liveProblem`); the rows use `liveShort`, a
    short wording of the same problems (a test checks every problem has
    both).
  - **AI summaries** — on (which summarizer) or what's missing; "Write
    each day's summary at [19:00]"; Send chats from (a tick per app,
    since 2026-11-14); AI summarizer…, Your summaries → (the Summaries
    page; until 2026-11-14 Summarize a range… and Summary history were
    here); How it works (when, what's sent, where it's saved).
  - **Appearance** — as §2.9.
  - **Privacy** (was About) — what leaves the Mac (the summarizer you
    pick, the usage tools you turn on, the fonts, JSZip for a .zip),
    read-only, what's saved where (`~/.throwbacks`, or this browser with
    `--no-store` or no server), times are ≈; the keys.
  Beside the cards on a wide page, an **overview** (B's list from the
  demo): each card's status in a few words — "5 apps loaded", "3 need a
  login", "Claude Code · daily at 19:00", "Day · Light" — a click scrolls
  to the card and marks it, and the mark follows the card you're reading.
  Under 44rem (a phone, or beside the conversation) just the cards.
- Escape closes a menu, then the conversation; a click outside closes a
  menu. ⌘K searches; ← → step days (Today) or weeks (Week).
- Dragging a file over the page shows a "Drop to load" overlay; while
  something loads in the journal, a small busy pill shows at the top.
- Short confirmations appear as toasts ("Path copied", "Summary updated",
  "Sky: Dusk").
- Insights: clicking a bar in Activity over time or Token consumption opens
  that day; Topic and Folder rows expand to their sessions.
- Summaries can be copied as Markdown. If a page defines
  `window.throwbacksExportHook(markdown, label)`, an **Export** button
  appears too (an integration point; nothing uses it yet).
- The front page states the privacy promise: no uploads, no analytics —
  your chats leave the machine only as the text you send to an AI
  summarizer you set up (since 2026-11-13; it said "never leaves", as the
  Privacy card did) — loaded chats live only in the tab, only generated
  summaries are saved (and the chats you keep a copy of, and what you pin
  or archive).

### 2.12 Tests
`node tests/run.mjs` (made-up data, ~3 s), `node tests/run.mjs --live` (this
Mac's real data, read at run time, counts only), and `/tests/layout.html` in
a browser (on `/?sample`: 14 widths × text sizes × fonts, the conversation's
three placements, menus on screen, every page, the phone's tab bar, a day's
cards in their places, a long summary scrolling as one, the sheet by date and
by folder with every row whole, the Commits page's columns, Made by and its
jumps). Details in README → Tests.

### 2.13 Picking a session up again (Copy resume command)
- **What it copies:** for a Claude Code session, `cd '<folder>' && claude
  --resume <id>`; for a Copilot CLI session, `cd '<folder>' && copilot
  --resume=<id>`. You paste it into a terminal; **Throwbacks runs nothing**.
  The app you paste it into continues the same session and writes to it as
  it always does. The button's tooltip says that continuing uses your plan,
  and that a long session's history is sent again with the first message.
- **What it checks first** (`GET /api/resume?app=&id=`, read-only, behind
  `_api_ok()`, off with `--no-import`): the page sends only the app and the
  session's UUID; serve.py finds the transcript itself and returns the
  folder — the last `relocatedCwd` (a session moved with `/cd`), else the
  first `cwd` — whether it still exists, how it was started (terminal or
  Claude desktop), and whether it's **open right now**:
  `~/.claude/sessions/<pid>.json` naming that session with a live process
  (only `sessionId`, `pid` and `entrypoint` are used; the `.key` files
  beside them are never opened). Then:
  - open right now (in Claude desktop, a terminal, or Copilot CLI elsewhere)
    → still the same command, and a note above the conversation plus the
    toast: close it there first — two windows on one session mix their
    messages into one transcript. "Open" means the process exists *and*
    started when the record says (`ps` in UTC, as Claude Code writes
    `procStart`), so a pid reused after a crash doesn't count; an
    interactive record parked in the background (`parkedJobId`) is left to
    its background one; a Copilot CLI session counts as open when an
    `inuse.<pid>.lock` beside it (read by name only) has a live process.
    (First built as `--fork-session`, a copy; changed 2026-10-09: resuming
    means continuing *that* session — a fork only fits wanting both
    running.)
  - running in the background (kind `bg` / `daemon` / `daemon-worker`) →
    the plain command, which opens that run;
  - its folder is gone → the bare command (Claude Code 2.1.223+ finds a
    session from any folder) and a note saying it runs where you paste it;
  - the app no longer has it (cleaned up) → nothing to copy, and a note.
- **Only UUIDs:** `claude --resume` takes anything else as a name to
  search for, and Copilot CLI starts a new, empty session for an unknown id.
  Folders are POSIX single-quoted; a folder with a control character is
  never put in a command. Without serve.py (or on a LAN visitor's page) the
  folder the session started in is used, with no checks; `/?sample` never
  asks (one sample session has a UUID name, so the button shows there).
- **Open in Claude desktop** (Claude Code sessions, one click, nothing to
  paste): a link to `claude://resume?session=<id>` — what `claude
  --desktop --resume <id>` opens. Anthropic doesn't document it, so it was
  built only after it was tried by hand (2026-10-09: it opened the right
  session); Copy resume command stays beside it in case a Desktop
  update changes it. Chrome asks "Open Claude?" the first time ("Always
  allow" remembers it for 127.0.0.1). Shown only on this Mac's own tab,
  with Claude desktop installed (serve.py's app scan), never for sample
  chats. Desktop may mark the session's folder as trusted, touch the
  transcript's modified time and un-archive it.
- **On the day's cards too** (2026-10-11): each Claude
  Code card has two small buttons bottom right — Open in Claude desktop
  (screen icon) and Copy resume command (terminal icon); Copilot CLI cards
  only the copy. The rest of the card still opens the conversation; the
  buttons sit beside the card's button, not inside it. Each card is
  exactly as wide as its place in the grid, and a long path or ID in its
  title or first message breaks inside it (2026-10-13: the wrapper for
  the buttons had let a card grow to the width
  of a long path — even the part cut off after two lines — under the card
  beside it, with the buttons left on its text). `tests/layout.html` checks
  it on the sample's resumable chat, whose first message holds a long path.
- **Its file** (2026-10-23): the conversation's header
  shows the chat's own file after its folder — click to copy the full path
  — and, on a Mac, **Show in Finder** beside it (Finder shows the file,
  selected; nothing opens). Claude Code: `~/.claude/projects/<folder>/<id>
  .jsonl` (a chat Claude Code deleted: Throwbacks' kept copy, said so);
  Cowork: its transcript under Claude's `local-agent-mode-sessions`;
  Copilot in VS Code (and Insiders): `chatSessions/<id>.jsonl`, else the
  older `.json`; Copilot CLI: `session-state/<id>/events.jsonl` (shown with
  its folder, since every one is called that), an old one only in
  `session-store.db`; Cursor keeps every chat in one database, so it's
  `state.vscdb` and the chat's key inside it (`composerData:<id>`);
  claude.ai shows the export file's name, all the browser is told. The
  page sends only the chat's app and its own ID (`GET /api/source`,
  behind `_api_ok()`, off with `--no-import`); the server finds the file
  under that app's own folders — the ID must be a file name's stem (no
  `/`, no glob characters) — and Show in Finder (`POST /api/reveal`) runs
  `/usr/bin/open -R` on that file only, never a path it's sent. Only on
  this Mac's own tab, never on `/?sample` or for sample chats; a LAN
  visitor's page never asks. They're the apps' own live files: for
  looking at or copying, not editing.
- **Not resumable from a terminal:** Cowork, claude.ai, VS Code's Copilot
  and Cursor chats (VS Code and Cursor have no link to a past chat).


### 2.14 Your commits
- **Where:** on a day's page, under each folder's sessions, that day's
  commits in its repo; repos you committed to without a chat that day under
  **Commits in other folders** (All tools only — commits belong to no tool,
  and an empty day shows them too). In Sessions → Folder, each row adds
  "N commits", and an open folder folds its commits into one line under
  its sessions ("184 commits · 2 by Claude · newest yesterday"; open, the
  newest 10, then "Show all N commits"); a repo's commits are listed once,
  at the first folder down the tree that's in it, and a folder with one
  session but commits is that session's row with a commits button, which
  opens it as a folder with its commits (until 2026-10-27 the commits
  were listed among the sessions, and such a folder was always a folder).
- **The Commits page** (`#/commits`, since 2026-11-12): every commit in
  one place. On top, how many and who made them ("142 commits since 20 Jan
  · 25 by an AI tool (18%)"), the share bar and a square per day for the
  last 12 months (a year each when they span several) — click a square to
  go to that day, marked. Then **This week**, **Earlier in November** and a
  band per month (each a link to its sheet), the newest two whole, an older
  month its newest 4 days, then "Show N more days"; under each day (Today,
  Yesterday, Tue 10 Nov…, how many, who made them, **Open day**) its
  commits in columns that line up down the page: message (and branch) ·
  who · repo · time · ID; beside the conversation or on a phone the message
  gets a line of its own. In the plan bar's place, **Made by**: Anyone ·
  You · each AI tool with commits, each with how many the other filters
  leave (none: greyed out); in the top bar a repo ("~/Dev/etl" when two
  share a name) and words, matched in the message, repo or branch, or the
  start of the ID. All of it this tab only. The tool filter doesn't apply
  (a commit belongs to no chat app); a commit's message opens its chat
  whatever the filter (all tools then, as Expiring does). Reached from the
  rail; a day's, week's or month's commits line (to that day — a week's or
  month's newest day with commits — with every filter cleared); Insights
  (See every commit; a month's bar opens it at that month); Search; on a
  phone, from those. A day with only commits can be picked in the
  calendar (a dot under its number). No server change.
- **Each commit:** its message, **who made it**, when, the branch (if not
  main/master), the short ID (click to copy). Who (since 2026-11-02; until
  then Claude only, and Copilot / Cursor by their co-author lines), from the
  surest sign down:
  - **an AI tool's own record says it ran that commit** — the shell runs
    that make a commit (`git commit`, a merge, a revert) in Claude Code's
    transcripts (its subagents', the copies Throwbacks kept of chats Claude
    Code deleted, Cowork's), in Copilot in VS Code's chat logs (each
    terminal command, its output, folder, exit code and times) and in
    Copilot CLI's event logs (a run you refused never ran): the ID git
    printed, near the run; or, when that commit was amended or rebased
    since and is on no branch any more, its copy (same message, and same
    author time or same content). Tagged **Claude** / **Copilot** and linked
    to the chat that ran it;
  - **probably** that tool, when its run printed no ID (`git commit -q`,
    which Claude uses for most of its commits here): every commit that
    landed while it ran (an amend by when it was committed), in the repo it
    ran in — following `cd` and `git -C` (a variable keeps the chat's
    folder), never a throwaway repo (`git init`, `$(mktemp -d)`); a run with
    nothing during it takes the closest commit within 2 minutes; a run that
    failed (a push after the commit) only what landed during it;
  - **the commit's own mark**: a co-author line naming an AI tool (Claude —
    Claude Code writes it itself, when the model remembers —, Copilot CLI's
    and VS Code's, Cursor's — Cursor adds its own —, Codex, Gemini,
    Antigravity, Aider, OpenCode, Devin), Cursor's `Made-with: Cursor`,
    Claude's `Claude-Session`, an `Assisted-by` (an unknown tool: "an AI"),
    or an AI tool as its author (a cloud agent; Aider's "(aider)");
  - else **you** (a terminal or an editor). Code an AI wrote that you
    committed by hand is yours, and a message from a "Generate commit
    message" button leaves no trace anywhere.
  A rebased or cherry-picked copy is one commit (same author time and
  message), and a commit two repos share (a clone, a worktree) is listed
  once, with its strongest tag. **Clicking a commit's message** (one an AI
  tool's record ran) opens that chat at the moment it was made: a marker
  — "This commit was made here", its message, ID and time — after the
  last message before it, scrolled into view (since 2026-11-02; it used to
  open the chat at its latest day, the commit nowhere to be seen).
- **Which commits:** yours — the repo's `user.email` or your global one,
  never through `.mailmap` — and an AI tool's own commit (a cloud agent's:
  Copilot's coding agent, Cursor's or Claude Code's in the cloud) whose
  message names you as co-author; since midnight of the first day of your
  history, every branch, never a stash, a note or a backup ref. Folders come
  from where your sessions started; a folder inside a repo shows that repo.
- **Who made them, added up:** each day's, week's and month's line says
  how many commits and who made them ("5 commits · 2 by Claude (1
  probably)", all tools only); **Insights → Who made your commits**: the
  total, a bar of you and each tool, and a stacked bar per month (the last
  12 with commits; click one to open it).
- **How it's read** (`POST /api/commits {folders, since}`, behind
  `_api_ok()`, off with `--no-import`, never on `/?sample`): only `git log`,
  `git rev-parse`, `git config --get` and `git for-each-ref` — none changes
  a repo — with every way a repo's own config could run a program, reach
  the network or write switched off (pager, signature checks, external
  diffs, text conversion, fsmonitor, hooks, mailmap, lazy fetching of
  missing objects, optional locks) and no input; a second read lists AI
  tools' own commits whose message names you (an author AND a message
  match). The tools' commit runs are read from their logs directly
  (serve.py's trimmed copies drop tool calls), each remembered until its
  file changes; a printed ID no branch holds is looked up with `git log -1
  --no-walk`, read-only. A
  repo's log is remembered until its branches move (a `for-each-ref`
  fingerprint), folders' repos and emails for 10 minutes: the first look at
  a big shared repo takes seconds, so it runs in the background after the
  page shows, and later ones take under a second.

### 2.15 Expiring chats and kept copies
- **Why:** Claude Code deletes a session's transcript once it hasn't been
  touched for `cleanupPeriodDays` (30 unless set). Claude Cowork keeps its own; Copilot and Cursor keep
  theirs until the workspace is deleted.
- **The Expiring tab** (the rail, with a count badge; on a phone the
  five-tab bar stays, the count shows on Today and Today's note links
  here): **Deleted within a week** — each Claude Code
  chat whose file was last written more than (setting − 7) days ago, when
  it goes, and **Keep a copy**; **Kept by Throwbacks** — each kept chat,
  whether Claude Code still has the original, and **Remove copy** (asks
  first; removing never touches the original); **History safety** — the
  setting, on top with the exact line to add (`"cleanupPeriodDays": 365`,
  Copy) when it's short (< 90 days) or Claude Code's default. Today shows
  a note when something goes this week; Settings → Your chats has the
  same safety line.
- **A kept copy** is the whole transcript, gzipped, in
  `~/.throwbacks/kept/claude-code/<id>.jsonl.gz` with a small `.json`
  beside it (folder 0700, files 0600, this Mac only), written whole and
  renamed into place. It follows the original while that keeps changing
  (refreshed when the Expiring tab reads the list) and, once Claude Code
  has deleted the original, it's read in its place, so the chat, its
  summaries and its commits stay in Throwbacks, marked "Kept copy only"
  (no resume or Claude desktop buttons: Claude Code no longer has it).
  Throwbacks only copies out of `~/.claude`; it never writes, moves or
  deletes anything there. Off with `--no-store` or `--no-import`, and for
  sample chats (the sample has a made-up 4-day setting so the tab shows
  something).
- **The setting Claude Code really uses:** an organisation's value
  (Claude Code's `remote-settings.json` cache, or a `managed-settings`
  file) wins; otherwise the shortest of yours and every session folder's
  `.claude/settings.json` / `settings.local.json` (the sweep runs with the
  settings of the folder it starts in, across every project). `0` or a
  value Claude Code can't read pauses its sweep: nothing is shown as
  expiring. Sessions started in Claude desktop aren't swept. Set-aside
  transcripts (`<id>.orphaned-…`) can be kept too. Dates carry the year,
  and "today / tomorrow / in N days" counts calendar days.
- **Throwbacks' own Claude Code runs never sweep:** the summarizer's and
  the usage meter's `claude -p` pass `--settings '{"cleanupPeriodDays":
  36500}'`, so starting Claude Code for them can't delete a chat the
  Expiring tab still offers to keep.
- **The review** (32 agents, 27 confirmed, all fixed or folded into the
  above): also a lock so a refresh can't bring back a copy just removed,
  temp files removed on a failed write (and fsynced), a damaged copy
  can't break the import, `GET` never writes with `--no-store`, re-reading
  Claude Code's chats drops the ones it deleted (and a removed kept-only
  copy), Keep a copy works for real chats after "Add sample data", opening
  a chat from Expiring under a tool filter shows all tools first, an
  honest "can't tell" when there are no dates (a chosen folder, dropped
  files), the privacy line on the front page mentions kept copies, and
  per-chat button labels with focus kept after each action.
