// resume.test.mjs — the command that picks a session up again in its own
// app (Claude Code or Copilot CLI), where a chat's own file is (what the page
// asks the server, what the header says), and the folder view's open/closed rule.

import { resumeTarget, shellQuote, resumeCommand, liveWhere, desktopLink, sourceTarget, sourceText } from '../js/resume.js';
import { folderIsOpen } from '../js/plans.js';
import { eq, done } from './harness.mjs';

const ID = '7d3f9a2e-4b1c-4e8a-9f6d-2c5b8e1a0f47';
const code = { id: `code:${ID}.jsonl`, source: 'code', startDir: '/Users/dev/projects/fetch-kit' };

// Which sessions can be resumed
eq('a Claude Code session, by its file name', resumeTarget(code), { app: 'claude', id: ID });
eq('a Copilot CLI session, by its id', resumeTarget({ id: `copilot-cli:${ID}`, source: 'copilot-cli' }), { app: 'copilot', id: ID });
eq('a file name that isn\'t a UUID: no (claude would search for it as a name)', resumeTarget({ id: 'code:a1b2c3d4.jsonl', source: 'code' }), null);
eq('a Copilot CLI id that isn\'t a UUID: no (copilot would start a new session)', resumeTarget({ id: 'copilot-cli:hello', source: 'copilot-cli' }), null);
eq('Cowork, claude.ai, VS Code Copilot and Cursor chats: no', ['cowork', 'web', 'copilot', 'cursor'].map((source) => resumeTarget({ id: `${source}:${ID}`, source })), [null, null, null, null]);
eq('nothing, or a session without an id: no', [resumeTarget(null), resumeTarget({ source: 'code' })], [null, null]);

// Quoting a folder for the shell
eq('a plain path', shellQuote('/Users/dev/my app'), "'/Users/dev/my app'");
eq('quotes and $(…) stay text', shellQuote("/tmp/it's $(rm -rf ~)"), "'/tmp/it'\\''s $(rm -rf ~)'");
eq('control characters (a newline) are refused', [shellQuote('/tmp/a\nb'), shellQuote('/tmp/a\u0007'), shellQuote('')], [null, null, null]);

// The command
const t = resumeTarget(code);
eq('from its folder', resumeCommand(t, { found: true, folder: '/Users/dev/projects/fetch-kit', exists: true, live: null }),
  { command: `cd '/Users/dev/projects/fetch-kit' && claude --resume ${ID}`, attach: false, closeFirst: false, gone: false });
eq('open somewhere right now: still the same session (never a copy), and "close it there first"', resumeCommand(t, { found: true, folder: '/p', exists: true, live: { where: 'claude-desktop', kind: 'interactive' } }),
  { command: `cd '/p' && claude --resume ${ID}`, attach: false, closeFirst: true, gone: false });
eq('running in the background: the plain command, which opens that run (no copy)', resumeCommand(t, { found: true, folder: '/p', exists: true, live: { where: 'cli', kind: 'bg' } }),
  { command: `cd '/p' && claude --resume ${ID}`, attach: true, closeFirst: false, gone: false });
eq('its folder is gone: the command alone, and say so', resumeCommand(t, { found: true, folder: '/gone', exists: false }),
  { command: `claude --resume ${ID}`, attach: false, closeFirst: false, gone: true });
eq('Claude Code no longer has it: nothing to copy', resumeCommand(t, { found: false }), null);
eq('without the server: the folder the session started in', resumeCommand(t, { folder: code.startDir }).command, `cd '/Users/dev/projects/fetch-kit' && claude --resume ${ID}`);
eq('…or no folder at all', resumeCommand(t, {}), { command: `claude --resume ${ID}`, attach: false, closeFirst: false, gone: false });
eq('a folder with a newline is never put in a command', resumeCommand(t, { folder: '/tmp/a\nrm -rf ~', exists: true }).command, `claude --resume ${ID}`);
eq('Copilot CLI, open elsewhere: close it there first', resumeCommand({ app: 'copilot', id: ID }, { found: true, folder: '/w', exists: true, live: { where: 'vscode', kind: 'copilot' } }),
  { command: `cd '/w' && copilot --resume=${ID}`, attach: false, closeFirst: true, gone: false });
eq('an id that isn\'t a UUID is refused here too', resumeCommand({ app: 'claude', id: 'x; rm -rf ~' }, {}), null);
eq('where it\'s open, in words', [liveWhere({ where: 'claude-desktop' }), liveWhere({ where: 'cli' }), liveWhere({ where: 'claude-vscode' }), liveWhere({ where: 'cli', kind: 'daemon-worker' })],
  ['Claude desktop', 'a terminal', 'your editor', 'the background']);

// Open in Claude desktop: the link Desktop handles, for Claude Code sessions only
eq('a Claude Code session opens in Claude desktop', desktopLink(t), `claude://resume?session=${ID}`);
eq('…not Copilot CLI, nor an id that isn\'t a UUID', [desktopLink({ app: 'copilot', id: ID }), desktopLink({ app: 'claude', id: 'x&y=1' }), desktopLink(null)], [null, null, null]);

// Sessions → Folder: closed to the paths until you open one
eq('a folder of folders starts open', folderIsOpen('/Users/dev', true, {}), true);
eq('a folder of sessions starts closed', folderIsOpen('/Users/dev/etl', false, {}), false);
eq('what you opened or closed wins', [folderIsOpen('/Users/dev/etl', false, { '/Users/dev/etl': true }), folderIsOpen('/Users/dev', true, { '/Users/dev': false })], [true, false]);
eq('while filtering, everything is open', folderIsOpen('/Users/dev/etl', false, { '/Users/dev/etl': false }, true), true);
eq('only true/false count', folderIsOpen('/x', false, { '/x': 'yes' }), false);

// Where a chat lives: the page names the chat (its app and own ID), never a path
eq('every app with a file per chat, and Cursor', [
  sourceTarget(code),
  sourceTarget({ id: 'cowork:a1b2c3d4-0000-4000-8000-000000000001.jsonl', source: 'cowork' }),
  sourceTarget({ id: 'copilot:9f8e7d6c-1111-4222-8333-444455556666', source: 'copilot' }),
  sourceTarget({ id: `copilot-cli:${ID}`, source: 'copilot-cli' }),
  sourceTarget({ id: 'cursor:3e1c2b7a-aaaa-4bbb-8ccc-ddddeeeeffff', source: 'cursor' }),
  sourceTarget({ id: 'code:a1b2c3d4.jsonl', source: 'code' }),  // a short name is still a file name
  sourceTarget({ id: `code:${ID}.orphaned-1760000000.jsonl`, source: 'code' }),
], [
  { app: 'code', id: ID }, { app: 'cowork', id: 'a1b2c3d4-0000-4000-8000-000000000001' },
  { app: 'copilot', id: '9f8e7d6c-1111-4222-8333-444455556666' }, { app: 'copilot-cli', id: ID },
  { app: 'cursor', id: '3e1c2b7a-aaaa-4bbb-8ccc-ddddeeeeffff' }, { app: 'code', id: 'a1b2c3d4' },
  { app: 'code', id: `${ID}.orphaned-1760000000` },
]);
eq('…not claude.ai (an export: its folder is never told), nor an odd ID', [
  sourceTarget({ id: `web:${ID}`, source: 'web' }),
  sourceTarget({ id: 'code:../../etc/passwd.jsonl', source: 'code' }),
  sourceTarget({ id: 'copilot:a/b', source: 'copilot' }),
  sourceTarget({ id: 'cursor:*', source: 'cursor' }),
  sourceTarget({ id: `cursor:${ID}\n`, source: 'cursor' }),
  sourceTarget({ id: 'code:.hidden.jsonl', source: 'code' }),
  sourceTarget({ id: `copilot:${ID}`, source: 'cursor' }),  // the app and the ID's prefix must agree
  sourceTarget(null),
], [null, null, null, null, null, null, null, null]);

const file = sourceText({ found: true, kind: 'file', path: `/Users/dev/.claude/projects/-Users-dev-x/${ID}.jsonl` });
eq('a file: its name, the full path on hover', [file.name, file.title.split('\n')[0], file.toast],
  [`${ID}.jsonl`, `/Users/dev/.claude/projects/-Users-dev-x/${ID}.jsonl`, 'File path copied']);
const kept = sourceText({ found: true, kind: 'file', path: `/Users/dev/.throwbacks/kept/claude-code/${ID}.jsonl.gz`, kept: true });
eq('…Throwbacks’ kept copy says so, and not that it’s the app’s live file', [kept.name, /kept copy/.test(kept.title), /live file/.test(kept.title), kept.toast],
  [`${ID}.jsonl.gz`, true, false, 'Path of the kept copy copied']);
const db = sourceText({ found: true, kind: 'database', path: '/Users/dev/Library/Application Support/Cursor/User/globalStorage/state.vscdb', key: 'composerData:abc' });
eq('a shared database: its name, and which chat inside it', [db.name, db.title.includes('composerData:abc')], ['state.vscdb (shared database)', true]);
eq('…Copilot CLI’s files are all events.jsonl: its folder says which', sourceText({ found: true, kind: 'file', path: `/Users/dev/.copilot/session-state/${ID}/events.jsonl` }).name,
  `${ID}/events.jsonl`);
eq('nothing found, nothing said', [sourceText({ found: false }), sourceText(null), sourceText({ found: true, path: '' })], [null, null, null]);

done();
