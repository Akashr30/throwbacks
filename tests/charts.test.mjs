// charts.test.mjs — the math behind the report's activity heatmap: the
// four shades (quartiles of the active days), the Monday-first week grid,
// and the longest streak.

import { heatLevels, weekColumns, longestRun, wholePercents } from '../js/charts.js';
import { eq, ok, done } from './harness.mjs';

// Shades: idle days are 0; active days split by quartile; the busiest is darkest.
eq('idle days stay unshaded', heatLevels([0, 0, 0]).join(','), '0,0,0');
eq('a lone active day is the darkest shade', heatLevels([0, 5, 0]).join(','), '0,4,0');
eq('equal days share the darkest shade', heatLevels([3, 3, 3]).join(','), '4,4,4');
eq('active days split into four steps by quartile', heatLevels([1, 2, 3, 4, 5, 6, 7, 8]).join(','), '1,1,2,2,3,3,4,4');
// (a straight scale to the busiest day would leave the first four all at 1)
eq('one huge day doesn\'t wash out the rest', heatLevels([10, 20, 30, 40, 5000]).join(','), '1,1,2,3,4');
eq('order doesn\'t matter', heatLevels([8, 0, 1, 5]).join(','), '4,0,1,2');

// Weeks: Monday first; days outside the range are empty slots.
// (2026-10-01 is a Thursday, 2026-10-05 a Monday.)
const weeks = weekColumns('2026-10-01', '2026-10-05');
eq('a range is cut into Monday-first weeks', weeks.length, 2);
eq('the first week starts on its Monday, before the range', JSON.stringify(weeks[0]),
  JSON.stringify([null, null, null, '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']));
eq('the last week ends after the range', JSON.stringify(weeks[1]),
  JSON.stringify(['2026-10-05', null, null, null, null, null, null]));
const year = weekColumns('2025-10-06', '2026-10-05');
eq('a year of days fits 53 weeks', year.length, 53);
eq('…and holds every day once', year.flat().filter(Boolean).length, 365);
ok(year.every((w) => w.length === 7), 'every week has seven slots');
// Across the end of daylight saving time (Europe and the US move clocks in Oct/Nov).
const dst = weekColumns('2026-10-19', '2026-11-08').flat().filter(Boolean);
eq('no day is skipped or repeated across a clock change', `${dst.length} ${new Set(dst).size}`, '21 21');

// Streaks
eq('the longest run of active days', longestRun([0, 1, 2, 0, 3, 4, 5, 0]), 3);
eq('no active days, no streak', longestRun([0, 0]), 0);
eq('a streak that runs to the end counts', longestRun([1, 0, 1, 1]), 2);

eq('shares in whole percents add up to 100', [wholePercents([4, 2, 1, 1], 8).reduce((a, b) => a + b, 0), wholePercents([1, 2], 3)], [100, [33, 67]]);
eq('…nothing to share', wholePercents([0, 0], 0), [0, 0]);

done();
