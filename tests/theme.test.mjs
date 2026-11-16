// theme.test.mjs — Appearance for the one design, Liquid Glass: the saved
// settings (and saves from the two-design days, which must still open
// right), the live sky's hours, and the boot script in throwbacks.html
// that paints the first frame — run against stand-ins for storage and the page.

import { readFileSync } from 'node:fs';
import { normalizeAppearance, skyForHour, SKIES } from '../js/theme.js';
import { eq, ok, done } from './harness.mjs';

const fresh = normalizeAppearance(null);
eq('a first visit: the Day sky, light, clear glass, Onest, sans replies',
  [fresh.sky, fresh.mode, fresh.glass, fresh.gfont, fresh.text, fresh.reply], ['day', 'light', 'clear', 'onest', 'default', 'sans']);
const kept = normalizeAppearance({ v: 3, sky: 'dusk', mode: 'dark', glass: 'tinted', gfont: 'system', text: 'large', reply: 'serif' });
eq('saved choices are kept', [kept.sky, kept.mode, kept.glass, kept.gfont, kept.text, kept.reply], ['dusk', 'dark', 'tinted', 'system', 'large', 'serif']);
eq('the live sky can be chosen', normalizeAppearance({ sky: 'live', v: 3 }).sky, 'live');
eq('a save from before v2 held "live" only as the old default: it gets Day', normalizeAppearance({ sky: 'live', design: 'glass' }).sky, 'day');
eq('…but any other sky it saved is kept', normalizeAppearance({ sky: 'night' }).sky, 'night');
eq('before v3 Liquid Glass kept its mode in gmode: that mode carries over', normalizeAppearance({ v: 2, gmode: 'dark', mode: 'light' }).mode, 'dark');
eq('…and Classic\'s own mode is not it', normalizeAppearance({ v: 2, design: 'classic', mode: 'dark' }).mode, 'light');
eq('since v3 there is one mode', normalizeAppearance({ v: 3, mode: 'system', gmode: 'dark' }).mode, 'system');
const junk = normalizeAppearance({ v: 3, sky: 'noon', glass: 'frosted', gfont: 'comic', mode: 'sepia', text: 'huge', reply: 'gothic' });
eq('unknown values fall back to the defaults', [junk.sky, junk.glass, junk.gfont, junk.mode, junk.text, junk.reply], ['day', 'clear', 'onest', 'light', 'default', 'sans']);
ok(!('design' in fresh) && !('palette' in fresh) && !('custom' in fresh), 'no design, palette or pasted theme any more');
eq('every sky is offered, live first', SKIES.map(([s]) => s).join(' '), 'live dawn day dusk night mono');

const hours = Array.from({ length: 24 }, (_, h) => skyForHour(h));
eq('the live sky by hour', hours.join(' '),
  'night night night night night dawn dawn dawn dawn dawn day day day day day day day dusk dusk dusk night night night night');

const html = readFileSync(new URL('../throwbacks.html', import.meta.url), 'utf8');
const rule = html.match(/const live = (h >= 5 && h < 10 \? 'dawn'[^;]+);/);
ok(rule, 'the boot script has the live-sky rule');
if (rule) {
  const boot = new Function('h', `return ${rule[1]};`);
  eq('the boot script and theme.js agree on every hour', Array.from({ length: 24 }, (_, h) => boot(h)).join(' '), hours.join(' '));
}
ok(/<link rel="stylesheet" href="glass.css">/.test(html), 'one stylesheet: glass.css');
ok(!/throwbacks\.css|css-classic|data-set-design/.test(html), 'no trace of the Classic design or its switch');

// The boot script itself: what the very first paint shows for a save.
const bootSrc = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
function boot(saved, hour = 21) {
  const dataset = { sky: 'day', mode: 'light' }; // what the <html> tag carries
  const AtHour = class extends Date { getHours() { return hour; } };
  new Function('localStorage', 'document', 'Date', bootSrc)(
    { getItem: () => (saved === undefined ? null : JSON.stringify(saved)) },
    { documentElement: { dataset } },
    AtHour,
  );
  return [dataset.sky, dataset.mode || 'system', dataset.glass || 'clear', dataset.text || 'default', dataset.reply || 'sans'].join(' ');
}
eq('first paint, nothing saved: Day, light', boot(undefined), 'day light clear default sans');
eq('first paint, a v2 save with Liquid Glass dark', boot({ v: 2, gmode: 'dark', sky: 'night' }), 'night dark clear default sans');
eq('first paint, a v2 save from Classic dark: Liquid Glass opens light', boot({ v: 2, design: 'classic', mode: 'dark' }), 'day light clear default sans');
eq('first paint, a v3 save following the system', boot({ v: 3, mode: 'system' }), 'day system clear default sans');
eq('first paint, tinted, large text, serif replies', boot({ v: 3, glass: 'tinted', text: 'large', reply: 'serif' }), 'day light tinted large serif');
eq('first paint, the live sky at 7 in the morning', boot({ sky: 'live', v: 3 }, 7), 'dawn light clear default sans');
eq('first paint, an old save that stored "live" as the default: Day', boot({ sky: 'live', glass: 'clear' }, 23), 'day light clear default sans');

done();
