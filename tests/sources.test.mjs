// sources.test.mjs — what each app tile on the front page offers, from
// serve.py's import status (or its absence).

import { APP_SOURCES, tileState, importableIds } from '../js/sources.js';
import { eq, done } from './harness.mjs';

const tile = (id) => APP_SOURCES.find((s) => s.id === id);
const status = { enabled: true, claudeCode: 60, cowork: 0, copilot: 1, copilotCli: 4, cursor: true, later: {}, icons: [] };

eq('while checking, server tiles wait', tileState(tile('copilot'), undefined), { enabled: false, detail: 'Checking…', action: null });
eq('claude.ai always opens the file picker', tileState(tile('claude-web'), undefined).action, 'file');
eq('counts are spelled out', tileState(tile('claude-code'), status), { enabled: true, detail: '60 sessions', action: 'import' });
eq('one of something is singular', tileState(tile('copilot'), status).detail, '1 chat file');
eq('a found app without a count says so', tileState(tile('cursor'), status).detail, 'Found on this Mac');
eq('an app with nothing found is switched off', tileState(tile('cowork'), status), { enabled: false, detail: 'Not found on this Mac', action: null });
eq('without serve.py, Claude Code falls back to the folder picker', tileState(tile('claude-code'), null).action, 'folder');
eq('without serve.py, the other apps are off', tileState(tile('cursor'), null), { enabled: false, detail: 'Needs python3 serve.py', action: null });
eq('Claude Code with no history found still offers a folder', tileState(tile('claude-code'), { ...status, claudeCode: 0 }).action, 'folder');
eq('"Load all" takes exactly the importable apps', importableIds(status), ['claude-code', 'copilot', 'copilot-cli', 'cursor']);
eq('"Load all" is empty without serve.py', importableIds(null), []);

done();
