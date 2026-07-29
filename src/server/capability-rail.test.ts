import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The capability rail's reset contract, asserted against `public/app.js` as SOURCE TEXT.
 *
 * There is no build step and no module boundary to import across, so this is the only way to hold a
 * client-side invariant. It exists because the invariant already broke once: the rail is backfilled
 * at boot from `/api/capabilities` (the cluster's running total over all of `agent_events`), and the
 * three places a run's tally starts over each cleared it with the same three statements written
 * inline. The replay path had them, the live Launch path did not — so a live run incremented on top
 * of the boot totals and the rail read 20 for a run that produced 10. The label says `runs` and the
 * pulse fires per event, so an accumulated number matches nothing the viewer watched.
 *
 * The fix was one named `resetRail()` rather than a third copy, and what these tests protect is that
 * there is no fourth: a new inline clear, or a Launch path that forgets to reset, is the same bug.
 */
const APP_JS = readFileSync(join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');

describe('capability rail reset contract (public/app.js)', () => {
  it('clears the rail through ONE named helper, not an inline loop per call site', () => {
    expect(APP_JS).toContain('function resetRail()');
    // The inline form is what drifted. Only resetRail itself may delete from capCounts.
    const inlineClears = APP_JS.match(/for \(const k in capCounts\) delete capCounts\[k\]/g) ?? [];
    expect(inlineClears).toHaveLength(1);
  });

  it('resets on all three run boundaries — replay Launch, live Launch, and Reset', () => {
    // Three call sites, so neither Launch path can regress to accumulating on the boot backfill.
    const calls = APP_JS.match(/^\s*(?:\$\('#feed'\)\.innerHTML = ''; )?resetRail\(\);/gm) ?? [];
    expect(calls).toHaveLength(3);
  });

  it('does not let a slow boot backfill land on top of a run already counting', () => {
    // loadCaps() is fired without await at boot; without this guard a late /api/capabilities
    // response re-adds the history that Launch just cleared.
    const loadCaps = APP_JS.slice(APP_JS.indexOf('async function loadCaps()'));
    expect(loadCaps.slice(0, loadCaps.indexOf('renderRail()'))).toContain('if (run.active) return;');
  });

  it('labels the backfilled total differently from a run count, since the same 10 means both', () => {
    expect(APP_JS).toContain("capCountsAreCumulative ? 'to date' : 'runs'");
    // Cleared alongside the counts, or the per-run rail keeps the cumulative label.
    expect(APP_JS.slice(APP_JS.indexOf('function resetRail()'), APP_JS.indexOf('function resetRail()') + 200))
      .toContain('capCountsAreCumulative = false');
  });
});
