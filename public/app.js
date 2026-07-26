import { mongoLeafSVG, mastraMarkSVG } from '/brand.js';
import { icon } from '/icons.js';
const $ = s => document.querySelector(s);

// ---- session token (stateless; per browser tab) ----------------------------
const TOKEN_KEY = 'marshal-token';
async function getToken() {
  let tok = sessionStorage.getItem(TOKEN_KEY);
  if (tok) return tok;
  const d = await fetch('/api/token', { method: 'POST' }).then(r => r.json()).catch(() => null);
  if (d?.token) { sessionStorage.setItem(TOKEN_KEY, d.token); return d.token; }
  return null;
}
// fetch wrapper that attaches the Bearer token (self-heals once on 401).
async function api(path, opts = {}) {
  const tok = await getToken();
  const headers = { ...(opts.headers || {}) };
  if (tok) headers.authorization = `Bearer ${tok}`;
  let res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { sessionStorage.removeItem(TOKEN_KEY); const t2 = await getToken(); if (t2) { headers.authorization = `Bearer ${t2}`; res = await fetch(path, { ...opts, headers }); } }
  return res;
}
function renderLockup() {
  const el = $('#lockup');
  if (el) el.innerHTML = mongoLeafSVG(24) + '<span class="divider"></span>' + mastraMarkSVG(20);
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = n => '$' + Number(n || 0).toLocaleString();

let DEMO_MODE = false;

// ---- UI mode (kill switch) --------------------------------------------------
// ?ui=classic pins the pre-responsive stage layout at every width: every new media query is
// scoped :root:not([data-ui="classic"]), and density is forced to full. One attribute, no forked
// bundle. MARSHAL_UI=classic on the server makes it the default for all visitors.
// FIRST PAINT IS NOT OURS — do not restore the claim that used to sit here. This file is
// <script type="module" src="/app.js?v=16"> at the end of <body> in public/index.html, and modules
// are deferred by definition, so module scope cannot be relied on to beat first paint: measured at
// 440x956, the call below lands ~130ms after FCP whenever /app.js is slow (conference wifi), and
// races it even on localhost. The pre-paint resolution of data-ui (and data-theme) therefore lives
// in the inline blocking <script> in public/index.html's <head> — that script, not this call, is
// what stops a ?ui=classic load flashing the responsive layout, so do NOT delete it as logic this
// file already handles. What the call below is for is the re-resolution: it is the only path that
// can see SERVER_UI, and loadMode() invokes it again once /api/mode answers.
let SERVER_UI = '';
function applyUiMode() {
  const q = new URLSearchParams(location.search).get('ui');
  const mode = q === 'classic' || q === 'auto' ? q
    : SERVER_UI === 'classic' ? 'classic' : 'auto';
  if (mode === 'classic') document.documentElement.setAttribute('data-ui', 'classic');
  else document.documentElement.removeAttribute('data-ui');
  // Informational, not a contract: neither call site consumes it, and nothing should start to.
  // data-ui on <html> is the single source of truth for "is the kill switch on" — the inline head
  // script in index.html sets the same attribute without ever calling this function, so a consumer
  // reading a return value here would miss the pre-paint resolution. Read the attribute instead
  // (applyDensity() at :74 is the pattern). Kept because it is free, cannot drift — it is the same
  // `mode` that drove the branch above — and answers "which input won" when debugging on stage.
  return mode;
}
applyUiMode();

// ---- density ----------------------------------------------------------------
// How much explanatory copy the welcome screen carries. Resolution order:
// ?density= (podium override, wins always) -> MARSHAL_DENSITY from /api/mode -> viewport width.
// Nothing is deleted at any tier: the long forms stay in the data and reappear on tap/hover.
const DENSITIES = ['full', 'lean', 'minimal'];
let SERVER_DENSITY = '';
function resolveDensity() {
  const q = new URLSearchParams(location.search).get('density');
  if (DENSITIES.includes(q)) return q;
  if (DENSITIES.includes(SERVER_DENSITY)) return SERVER_DENSITY;
  // PHONE_MQ / TABLET_MQ are declared further down the file; safe because nothing calls
  // resolveDensity() during module evaluation — the first applyDensity() is inside boot().
  if (window.matchMedia(PHONE_MQ).matches) return 'minimal';
  if (window.matchMedia(TABLET_MQ).matches) return 'lean';
  return 'full';
}
let DENSITY = 'full';
function applyDensity() {
  DENSITY = document.documentElement.getAttribute('data-ui') === 'classic' ? 'full' : resolveDensity();
  document.documentElement.setAttribute('data-density', DENSITY);
}
const dense = (full, lean, minimal) =>
  DENSITY === 'minimal' ? (minimal !== undefined ? minimal : lean) : DENSITY === 'lean' ? lean : full;

// ---- welcome ----------------------------------------------------------------
const WELCOME_FLOW = [
  { i: 'triage', n: 'Triage', d: 'rules + compliance screen first' },
  { i: 'hybrid', n: 'Retrieve', d: 'hybrid search for precedent' },
  { i: 'reason', n: 'Reason', d: 'agent weighs the evidence' },
  { i: 'graph', n: 'Trace', d: '$graphLookup fund network' },
  { i: 'governance', n: 'Govern', d: 'policy check + score' },
  { i: 'durable', n: 'Decide', d: 'commit or human gate' },
];
const WELCOME_JOBS = [
  { i: 'vector', b: 'Vector search', d: 'semantic recall of similar cases', q: '$vectorSearch' },
  { i: 'fulltext', b: 'Full-text', d: 'exact names, codes, phrases', q: '$search' },
  { i: 'hybrid', b: 'Hybrid', d: 'both, fused server-side', q: '$rankFusion' },
  { i: 'graph', b: 'Graph', d: 'trace mule / ring networks', q: '$graphLookup' },
  { i: 'memory', b: 'Precedent recall', d: 'recall & cite prior verdicts', q: '$vectorSearch' },
  { i: 'governance', b: 'Policy governance', d: 'grounded, cited compliance', q: 'policy vectors' },
  { i: 'durable', b: 'Durable state', d: 'suspend/resume human gate', q: 'workflow state' },
  { i: 'audit', b: 'Audit', d: 'tamper-evident decision log', q: 'hash chain' },
];
function renderWelcome() {
  const lead = $('#welcomeLead');
  const cta = `<b style="color:var(--mongo)">▶ ${DEMO_MODE ? 'Replay' : 'Launch'} Investigation</b>`;
  const tail = DEMO_MODE
    ? ` to watch a recorded run of the real agent, step for step, then open any case to see exactly how it was decided.`
    : `, then open any case to see exactly how it was decided.`;
  if (lead) lead.innerHTML = dense(
    `Every flagged transaction is investigated by an AI agent (retrieval, graph fund-tracing, precedent recall, a policy governance layer, and a durable human-approval gate), all on a single MongoDB Atlas cluster. Press ${cta}${tail}`,
    `An AI agent investigates every flagged transaction — retrieval, graph fund-tracing, precedent recall, policy governance and a human-approval gate — on one MongoDB Atlas cluster. Press ${cta}.`,
    `An AI agent investigates every flagged transaction on one MongoDB Atlas cluster. Press ${cta}.`);
  const flow = $('#wflow');
  if (flow) flow.innerHTML = WELCOME_FLOW.map((s, idx) =>
    `<div class="wstep" title="${esc(s.d)}"><div class="wi">${icon(s.i, 20)}</div><div class="wn">${s.n}</div>`
    + dense(`<div class="wd">${s.d}</div>`, '') + `</div>`
    + (idx < WELCOME_FLOW.length - 1 ? '<div class="warrow">›</div>' : '')).join('');
  const grid = $('#wgrid');
  if (grid) grid.innerHTML = WELCOME_JOBS.map(j =>
    `<div class="wjob" title="${esc(j.d)}"><div class="ji">${icon(j.i, 18)}</div><div><b>${j.b}</b>`
    + dense(`<div class="jd">${j.d}</div><div class="jq">${j.q}</div>`, `<div class="jq">${j.q}</div>`, '')
    + `</div></div>`).join('');
}

// ---- capability rail --------------------------------------------------------
const CAPS = [
  { key: 'vector', name: 'Vector', tip: '$vectorSearch: semantic recall of similar prior cases from Voyage embeddings, all in Atlas.' },
  { key: 'fulltext', name: 'Full-Text', tip: '$search (Atlas Search): exact names, codes and phrases embeddings blur over.' },
  { key: 'hybrid', name: 'Hybrid', tip: '$rankFusion: vector + full-text fused server-side by reciprocal rank. One query, no client merge.' },
  { key: 'graph', name: 'Graph', tip: '$graphLookup: traverses sender→recipient links to surface mule rings and circular money flow.' },
  { key: 'memory', name: 'Precedent recall', tip: '$vectorSearch over already-decided cases: recalls and cites how similar prior cases were resolved.' },
  { key: 'governance', name: 'Governance', tip: 'Policy layer: retrieves relevant policies by vector, an LLM cites violations, deterministic severity scores them.' },
  { key: 'durable', name: 'Durable', tip: 'Durable workflow state: suspend at the human-approval gate and resume the same case, on Atlas.' },
  { key: 'audit', name: 'Audit', tip: 'Tamper-evident audit: every decision is an HMAC hash-chained, verifiable record.' },
];
const capCounts = {};
function renderRail() {
  $('#rail').innerHTML = CAPS.map(c => `
    <div class="cap ${capCounts[c.key] ? 'active' : ''}" data-cap="${c.key}" data-tip="${esc(c.tip)}">
      <div class="ico">${icon(c.key, 19)}</div>
      <div class="name">${c.name}</div>
      <div class="lbl2">runs</div>
      <div class="n" data-n="${c.key}">${capCounts[c.key] || 0}</div>
    </div>`).join('');
}
function bumpCap(key) {
  if (!CAPS.some(c => c.key === key)) return;
  capCounts[key] = (capCounts[key] || 0) + 1;
  const cap = document.querySelector(`.cap[data-cap="${key}"]`);
  if (cap) { cap.classList.add('active', 'pulse'); cap.querySelector(`[data-n="${key}"]`).textContent = capCounts[key]; setTimeout(() => cap.classList.remove('pulse'), 700); }
}

// ---- center view switching ----------------------------------------------------
function showCenter(which) {
  $('#welcome').style.display = which === 'welcome' ? 'flex' : 'none';
  $('#theater').classList.toggle('show', which === 'theater');
  $('#detail').classList.toggle('show', which === 'detail');
}

// ---- case queue -------------------------------------------------------------
let selected = null;
const casesById = {};        // transaction summary by id (queue data)
const sessionResolved = {};  // THIS session's human decisions (per-user overlay)
// Visual status overlay driven by the run choreography: id -> pending|investigating|held|approve|reject|escalate
const queueOverlay = {};

function displayStatus(t) {
  const mine = sessionResolved[t.transaction_id];
  if (mine) return { s: mine === 'approve' ? 'approved' : 'rejected', mine: true };
  const ov = queueOverlay[t.transaction_id];
  if (ov) {
    const map = { approve: 'approved', reject: 'rejected', escalate: 'escalated' };
    return { s: map[ov] || ov, mine: false };
  }
  return { s: t.status, mine: false };
}
function caseCard(t) {
  const el = document.createElement('div');
  const { s: status, mine } = displayStatus(t);
  el.className = `case s-${status}` + (selected === t.transaction_id ? ' sel' : '');
  el.dataset.id = t.transaction_id;
  const isPrecedent = t.model_used === 'historical';
  const pillText = status === 'held' ? 'held for you' : status;
  el.innerHTML = `
    <div class="row"><span class="amt">${money(t.amount)}</span><span class="pill ${esc(status)}">${esc(pillText)}${mine ? ' ✓' : ''}</span></div>
    <div class="sub">${esc(t.sender?.name)} → ${esc(t.recipient?.name)}</div>
    <div class="sub dim mono">${esc(t.transaction_id)} · ${esc(t.lane)}${isPrecedent ? ' · <span style="opacity:.8">precedent</span>' : ''}</div>`;
  el.onclick = () => openCase(t.transaction_id);
  return el;
}
async function loadQueue() {
  const { cases = [] } = await fetch('/api/cases').then(r => r.json()).catch(() => ({ cases: [] }));
  const q = $('#queue'); q.innerHTML = '';
  for (const t of cases) casesById[t.transaction_id] = t;
  renderQueueCount(cases.length);
  if (!cases.length) { q.innerHTML = '<div class="empty">no cases</div>'; return; }
  cases.forEach(t => q.appendChild(caseCard(t)));
  // Live run completes when every case is settled: committed cases leave 'pending' in the DB,
  // suspended ones stay 'pending' but are marked held by their suspend event.
  const stillOpen = cases.some(t =>
    t.status === 'pending' && queueOverlay[t.transaction_id] !== 'held' && !sessionResolved[t.transaction_id]);
  if (run.active && !DEMO_MODE && !stillOpen) endRun();
}
let corpusTotal = null;
/** "showing 50 of 12,000" — the denominator is the whole transactions collection, not the page.
 *  It used to read "showing 50 · 75 corpus", which buried the one number that makes the scale claim:
 *  a reader parses the pair as "50 of 75" and concludes the demo runs over 75 documents. The queue is
 *  capped at 50 by /api/cases; retrieval, $graphLookup and precedent recall run over the full
 *  collection, so the total is the honest figure to put next to it. "of" instead of "·" because the
 *  interesting relationship is part-of-whole, and a middot states no relationship at all. */
function renderQueueCount(visible) {
  $('#qcount').textContent = corpusTotal && corpusTotal > visible
    ? `showing ${visible} of ${corpusTotal.toLocaleString()}` : `${visible ?? ''}`;
}
// Mark cases sitting at the human gate (works for late joiners after any run).
async function overlayHeldFromReviews() {
  const { reviews = [] } = await api('/api/reviews').then(r => r.json()).catch(() => ({ reviews: [] }));
  for (const r of reviews) {
    if (!sessionResolved[r.transaction_id]) queueOverlay[r.transaction_id] = 'held';
  }
  if (reviews.length) loadQueueRender();
}
function loadQueueRender() { // re-render from cache without a refetch
  const q = $('#queue'); if (!q) return;
  const ids = Object.keys(casesById);
  if (!ids.length) return;
  q.innerHTML = '';
  Object.values(casesById)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .forEach(t => q.appendChild(caseCard(t)));
}

// ---- investigation theater ----------------------------------------------------
// The center of the screen WHILE the agent runs: follows the case under investigation,
// lights pipeline stages as real events land, then stamps the verdict.
const T_STEPS = ['triage', 'retrieve', 'reason', 'graph', 'govern', 'decide'];
const STEP_TO_STAGE = { triage: 'triage', retrieve: 'retrieve', recall: 'retrieve', reason: 'reason', graph: 'graph', govern: 'govern', suspend: 'decide', commit: 'decide' };
const run = { active: false };
const theater = { caseId: null, stages: new Set(), done: [], toolCount: 0 };

function enterTheater() {
  theater.caseId = null; theater.stages = new Set(); theater.done = []; theater.toolCount = 0;
  $('#tdone').innerHTML = ''; $('#tcase').innerHTML = '<div class="empty">waiting for the first case…</div>';
  showCenter('theater');
}
function theaterCaseHead(t, id) {
  return `
    <div class="thead">
      <div>
        <div class="tamt">${money(t?.amount)}</div>
        <div class="tsub">${esc(t?.sender?.name || '')} → ${esc(t?.recipient?.name || '')}</div>
      </div>
      <div style="text-align:right">
        <div class="tlane">${esc(t?.lane || '')}</div>
        <div class="tsub mono">${esc(id)}</div>
      </div>
    </div>
    ${t?.text ? `<div class="tsub" style="margin-top:10px;line-height:1.55">${esc(t.text)}</div>` : ''}
    <div class="tpipe">${T_STEPS.map(s => `<div class="tstep" data-stage="${s}">${s}</div>`).join('')}</div>
    <div id="tnow"></div>
    <div id="tevid"></div>`;
}
/**
 * The dual-attribution line: Mastra on the left of the separator, MongoDB on the right.
 *
 *   hybrid_search · $rankFusion · 214ms
 *
 * This is the moment the whole change is for — it appears DURING the model's thinking window, where
 * the timeline previously showed one 41-second gap (85% of the recorded run's span). Density tiers
 * trim right-to-left: the operator is the last thing to go because it is the MongoDB half of the
 * claim, and on a phone it is the ONLY thing shown.
 */
function toolLine(d) {
  const t = d.tool || {};
  const name = esc(t.name || 'tool');
  const op = t.op ? esc(t.op) : '';
  const ms = Number.isFinite(t.ms) ? `${t.ms}ms` : '';
  const parts = dense(
    [name, op, ms],           // full / laptop
    [name, op],               // tablet
    [op || name],             // phone — the operator alone
  ).filter(Boolean);
  return `<span class="tattr${t.ok === false ? ' bad' : ''}">${parts.join('<span class="sep">·</span>')}</span>`;
}
function theaterStart(id) {
  theater.caseId = id; theater.stages = new Set(); theater.toolCount = 0;
  $('#tcase').innerHTML = theaterCaseHead(casesById[id], id);
  queueOverlay[id] = 'investigating';
  loadQueueRender();
}
function theaterStage(stage, d) {
  theater.stages.add(stage);
  // A step event is a COMPLETION — `retrieve` is emitted *after* hybrid search returned — so the
  // stage actually in flight is the next one the pipeline has not reached yet. Painting the
  // just-completed stage as "now" is what made retrieve look slow: the only event between the
  // search and the model's verdict is `recall` (which also maps to `retrieve`), so the retrieve box
  // stayed lit with its sweep animation for the entire 5–9 s Bedrock call, while Atlas had actually
  // answered in ~200 ms (hybrid $rankFusion 20 ms + Voyage embed 160 ms, measured on the live box).
  // Scan FORWARD from the current stage rather than taking the first incomplete one overall: the
  // hard-compliance lane jumps triage → govern → decide, and a backward scan would light `retrieve`
  // as pending on a case that never runs it.
  const from = T_STEPS.indexOf(stage);
  const inFlight = from < 0 ? null : T_STEPS.slice(from + 1).find(s => !theater.stages.has(s));
  document.querySelectorAll('#tcase .tstep').forEach(el => {
    el.classList.toggle('on', theater.stages.has(el.dataset.stage));
    el.classList.toggle('now', el.dataset.stage === inFlight);
  });
  const now = $('#tnow');
  if (now) now.innerHTML = `${icon(STEP_ICON[d.step] || 'reason', 15)}<span>${esc(d.headline)}</span><span class="d">${esc(d.detail || '')}</span>`;
}
/**
 * A tool event updates the "now" line and the counter on `reason` — and NOTHING else.
 *
 * It deliberately does not call theaterStage(). That function treats its argument as a completed
 * stage and lights the next one; `tool` belongs to `reason`, which sits after `retrieve`, so routing
 * a tool event through it would mark reasoning complete while the model is still thinking and stamp
 * the pipeline ahead of the verdict. Tool calls happen INSIDE the reason stage; they do not advance
 * past it.
 */
function theaterTool(d) {
  theater.toolCount++;
  const now = $('#tnow');
  if (now) {
    now.innerHTML = `${icon('tool', 15)}${toolLine(d)}<span class="d">${esc(d.detail || '')}</span>`;
  }
  const box = document.querySelector('#tcase .tstep[data-stage="reason"]');
  if (box) {
    let badge = box.querySelector('.tbadge');
    if (!badge) { badge = document.createElement('span'); badge.className = 'tbadge'; box.appendChild(badge); }
    badge.textContent = theater.toolCount;
    box.classList.add('working');
  }
}
async function theaterTerminal(d) {
  const id = d.transaction_id;
  const outcome = d.step === 'suspend' ? 'held' : (d.detail || 'approve');
  queueOverlay[id] = outcome;
  loadQueueRender();
  theater.done.push({ id, outcome, amount: casesById[id]?.amount });
  renderDoneChips();
  // The full analysis is stored BEFORE the terminal event — show the evidence with the stamp.
  const a = await fetch(`/api/cases/${encodeURIComponent(id)}`).then(r => r.ok ? r.json() : null).catch(() => null);
  if (theater.caseId !== id) return; // the run moved on while we fetched — don't touch the new case's DOM
  const evid = $('#tevid');
  if (evid && a?.analyzed !== false && a) evid.innerHTML = evidenceSections(a, { compact: true });
  const stampCls = outcome === 'held' ? 'held' : outcome;
  const stampText = outcome === 'held' ? 'HELD: your call' : outcome;
  const tnow = $('#tnow');
  if (tnow) tnow.insertAdjacentHTML('afterend', `<div class="stamp ${esc(stampCls)}">${esc(stampText)}</div>`);
}
function renderDoneChips() {
  $('#tdone').innerHTML = theater.done.map(c => `
    <button class="tchip" data-open="${esc(c.id)}">
      <span>${money(c.amount)}</span><span class="o-${esc(c.outcome)}">${esc(c.outcome.toUpperCase())}</span>
    </button>`).join('');
  document.querySelectorAll('#tdone [data-open]').forEach(b => { b.onclick = () => openCase(b.dataset.open); });
}
function theaterEvent(d) {
  if (!run.active || !d.transaction_id) return;
  if (d.transaction_id !== theater.caseId) theaterStart(d.transaction_id);
  if (d.step === 'tool') { theaterTool(d); return; }   // never reaches theaterStage — see theaterTool
  const stage = STEP_TO_STAGE[d.step];
  if (stage) theaterStage(stage, d);
  if (d.step === 'suspend' || d.step === 'commit') theaterTerminal(d);
}
function endRun() {
  if (!run.active) return;
  run.active = false;
  clearTimeout(replayTimer);
  replayState = null;
  renderReplayControls();
  const b = $('#launchBtn'); b.disabled = false; renderLaunchLabel();
  const held = theater.done.filter(c => c.outcome === 'held').length;
  setStatus(held ? `Run complete: ${held} case${held > 1 ? 's' : ''} held for your decision` : 'Run complete');
  setTimeout(() => setStatus(''), 6000);
  loadStats();
  loadQueue();
}

// ---- evidence rendering (shared: theater terminal + case detail) ---------------
const CTR_THRESHOLD = 5000;
function thresholdGauge(amount) {
  const max = CTR_THRESHOLD * 1.12;
  const pct = Math.min(100, (amount / max) * 100);
  const limitPct = (CTR_THRESHOLD / max) * 100;
  const delta = CTR_THRESHOLD - amount;
  return `<div class="gauge">
    <div class="bar">
      <div class="fill" style="width:${pct}%"></div>
      <div class="limit" style="left:${limitPct}%" data-lbl="CTR $${CTR_THRESHOLD.toLocaleString()}"></div>
      <div class="mark" style="left:${pct}%"></div>
    </div>
    <div class="legend"><span>this deposit <b class="mono">${money(amount)}</b></span>
      <span class="delta">${delta > 0 ? money(delta) + ' below the reporting line' : 'over the line'}</span></div>
  </div>`;
}
function ringSvg(ring, seed) {
  const nodes = [...new Set(ring.edges.flatMap(e => [e.from, e.to]))];
  if (nodes.length < 2) return ''; // degenerate self-loop — caller shows the gauge / note instead
  const W = 440, H = 240, cx = W / 2, cy = H / 2 - 6, R = 78, nodeR = 13;
  const pos = {};
  nodes.forEach((n, i) => { const a = (i / nodes.length) * 2 * Math.PI - Math.PI / 2; pos[n] = { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }; });
  const paths = [];
  const edges = ring.edges.map((e, i) => {
    const p = pos[e.from], q = pos[e.to]; if (!p || !q) return '';
    const dpath = `M${p.x.toFixed(1)} ${p.y.toFixed(1)} Q ${cx} ${cy} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
    paths.push(dpath);
    // amount label at the curve midpoint (t=0.5 of the quadratic)
    const mx = 0.25 * p.x + 0.5 * cx + 0.25 * q.x, my = 0.25 * p.y + 0.5 * cy + 0.25 * q.y;
    const amt = e.amount ? `<text class="edge-amt" x="${mx.toFixed(1)}" y="${(my - 4).toFixed(1)}">$${Number(e.amount).toLocaleString()}</text>` : '';
    return `<path class="edge" style="animation-delay:${(i * 0.25).toFixed(2)}s" d="${dpath}"/>${amt}`;
  }).join('');
  const nodeEls = nodes.map(n => {
    const label = esc(n.replace('ACC-', '').replace('RING-', ''));
    const isSeed = n === seed;
    return `<g class="node">
      <circle cx="${pos[n].x.toFixed(1)}" cy="${pos[n].y.toFixed(1)}" r="${nodeR}" ${isSeed ? 'style="stroke:var(--warn);stroke-width:3"' : ''}/>
      <text x="${pos[n].x.toFixed(1)}" y="${(pos[n].y + nodeR + 15).toFixed(1)}" class="nlabel">${label}${isSeed ? ' ◆' : ''}</text>
    </g>`;
  }).join('');
  // A pulse riding the circular flow makes the laundering loop legible at a glance.
  const pulse = ring.circular_flow && paths.length ? `<circle class="pulse-dot" r="3.5">
      <animateMotion dur="${(paths.length * 1.1).toFixed(1)}s" repeatCount="indefinite" path="${paths.join(' ')}"/>
    </circle>` : '';
  return `<svg class="ringsvg animate" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0 0 L7 3 L0 6 z" fill="var(--crit)"/></marker></defs>${edges}${nodeEls}${pulse}</svg>`;
}
/** Precedents + fund-tracing + policy sections (theater uses compact=true). */
function evidenceSections(a, { compact = false } = {}) {
  const gov = a.governance || {}; const ring = a.ring || {};
  const scorePct = Math.round((gov.compliance_score ?? 1) * 100);
  const scoreColor = scorePct < 70 ? 'var(--crit)' : scorePct < 90 ? 'var(--warn)' : 'var(--accent)';
  const precedents = (a.precedents || []).slice(0, compact ? 2 : 3).map(p =>
    `<div class="mini"><div class="row"><b class="mono">${esc(p.transaction_id)}</b><span class="pill ${esc(p.status)}">${esc(p.status)}</span></div><div class="sub">${esc(p.text?.slice(0, 90))}…</div></div>`).join('');
  const graph = ring.edges?.length ? ringSvg(ring, a.sender?.account_number) : '';
  const graphSection = graph
    ? `<div class="section"><div class="lbl">${icon('graph', 13)} Fund-tracing network <span class="chip2">$graphLookup</span> ${ring.circular_flow ? '<span class="pill rejected">circular flow</span>' : ''}</div>${graph}</div>`
    : (a.lane === 'structuring'
      ? `<div class="section"><div class="lbl">${icon('warn', 13)} Reporting-threshold proximity <span class="chip2">deterministic rule</span></div>${thresholdGauge(a.amount)}</div>`
      : '');
  // The ordered operations the agent actually ran, with the Atlas operator each one used. Ordered by
  // call, not by duration — the sequence is the reasoning. Compact (theater terminal) shows the
  // first three; the full case detail shows all of them.
  const calls = a.tool_calls || [];
  const opsSection = calls.length
    ? `<div class="section"><div class="lbl">${icon('tool', 13)} Agent operations <span class="chip2">${calls.length} tool call${calls.length > 1 ? 's' : ''}</span></div>
        <div class="ops">${calls.slice(0, compact ? 3 : calls.length).map(c => `
          <div class="op${c.ok === false ? ' bad' : ''}">
            <b class="mono">${esc(c.name)}</b>
            <span class="opq mono">${esc(c.op || '—')}</span>
            <span class="sub">${Number.isFinite(c.ms) ? `${c.ms}ms` : ''}</span>
          </div>`).join('')}</div>
        ${compact && calls.length > 3 ? `<div class="sub dim">+${calls.length - 3} more</div>` : ''}</div>`
    : '';
  return `
    <div class="section"><div class="lbl">${icon('memory', 13)} Similar precedent <span class="chip2">hybrid search</span></div>
      ${precedents || '<div class="sub dim">none</div>'}</div>
    ${graphSection}
    ${opsSection}
    <div class="section"><div class="lbl">${icon('governance', 13)} Policy governance <span class="chip2">$vectorSearch on policies</span></div>
      <div class="row" style="margin-bottom:7px"><span class="sub">compliance score</span><b class="mono" style="color:${scoreColor}">${scorePct}%</b></div>
      <div class="meter"><i style="width:${scorePct}%;background:${scoreColor}"></i></div>
      <div style="margin-top:9px">${(gov.violations || []).map(v => `<div class="mini policy"><b class="mono">${esc(v.policy_code)}</b> <span class="pill escalated">${esc(v.severity)}</span><div class="sub">${esc(v.cited_text)}</div></div>`).join('') || '<div class="sub dim">no policy violations</div>'}</div></div>`;
}

// ---- case detail (post-hoc drill-down) ----------------------------------------
async function openCase(id) {
  selected = id;
  document.querySelectorAll('.case').forEach(c => c.classList.toggle('sel', c.dataset.id === id));
  const a = await fetch(`/api/cases/${encodeURIComponent(id)}`).then(r => r.ok ? r.json() : null).catch(() => null);
  const detail = $('#detail');
  if (!a) { showCenter(run.active ? 'theater' : 'welcome'); detail.innerHTML = ''; return; }
  showCenter('detail');
  const backLink = run.active ? `<button class="btn" id="backToRun" style="margin-bottom:10px">‹ Back to the live run</button>` : '';

  // Not investigated this run (a historical/seed precedent) — reference card, not a dead click.
  if (a.analyzed === false) {
    detail.innerHTML = `${backLink}
      <div class="dhead">
        <div><div class="amt">${money(a.amount)}</div><div class="id">${esc(id)} · ${esc(a.lane)}</div></div>
        <span class="pill ${esc(a.status)}">${esc(a.status)}</span>
      </div>
      <div class="flow">${esc(a.sender?.name)} <span class="dim">(${esc(a.sender?.account_number)})</span> → ${esc(a.recipient?.name)} <span class="dim">(${esc(a.recipient?.account_number)})</span></div>
      <div class="section"><div class="mini"><b>Reference precedent</b><div class="sub" style="margin-top:6px">${esc(a.narrative)}</div></div></div>
      <div class="section sub dim">This case is part of the decided-precedent corpus; the agent retrieves it as evidence when investigating new transactions.</div>`;
    wireBackToRun();
    return;
  }
  const dec = a.decision || {};
  const myDecision = sessionResolved[id];
  const held = a.phase === 'suspended' && !myDecision;

  const stepLink = DEMO_MODE
    ? `<button class="btn" id="stepThisCase" style="margin-bottom:10px">▶ Step through this case</button>`
    : '';

  // Verdict + gate FIRST (the money moment lives above the fold), rationale in the open,
  // then the evidence that produced it.
  detail.innerHTML = `${backLink}${stepLink}
    <div class="dhead">
      <div><div class="amt">${money(a.amount)}</div><div class="id">${esc(id)} · ${esc(a.lane)}</div></div>
      <span class="pill ${held ? 'held' : esc(myDecision || dec.disposition)}">${held ? 'HELD FOR REVIEW' : esc(myDecision || dec.disposition || '')}</span>
    </div>
    <div class="flow">${esc(a.sender?.name)} <span class="dim">(${esc(a.sender?.account_number)})</span> → ${esc(a.recipient?.name)} <span class="dim">(${esc(a.recipient?.account_number)})</span></div>

    <div class="verdict ${held ? 'held' : esc(myDecision || dec.disposition)}">
      <div><div class="sub dim">${held ? 'awaiting your decision' : (myDecision ? 'your decision' : `decided by ${esc(dec.reviewed_by || dec.decided_by)}`)}</div>
        <div class="d">${held ? 'Escalate' : esc(myDecision || dec.disposition || '')}</div></div>
      ${held ? `<div class="actions"><button class="btn approve" data-approve>✓ Approve</button><button class="btn reject" data-reject>✕ Reject</button></div>`
             : `<span class="pill ${esc(myDecision || dec.disposition)}">committed</span>`}
    </div>

    <div class="section"><div class="lbl">${icon('reason', 13)} Agent rationale</div>
      <div class="rationale">${esc(dec.rationale)}</div>
      <div style="margin-top:8px">${(dec.risk_factors || []).map(r => `<span class="pstep">${esc(r)}</span> `).join('')}</div></div>

    <div class="section"><div class="lbl">Investigation pipeline</div>
      <div class="pipe">${T_STEPS.map(p => `<span class="pstep on">${p}</span>`).join('')}</div></div>

    ${evidenceSections(a)}`;

  if (held) {
    detail.querySelector('[data-approve]').onclick = () => resolve(id, 'approve');
    detail.querySelector('[data-reject]').onclick = () => resolve(id, 'reject');
  }
  const stepBtn = detail.querySelector('#stepThisCase');
  if (stepBtn) stepBtn.onclick = async () => {
    clearTimeout(replayTimer);
    replayMode = 'step';
    run.active = true;
    $('#launchBtn').disabled = true;
    setStatus(`Stepping through ${id}`);
    await runReplay(id);   // scoped: only this case's events, and theaterStart(id) is forced
  };
  wireBackToRun();
}
function wireBackToRun() {
  const b = $('#backToRun');
  if (b) b.onclick = () => { selected = null; document.querySelectorAll('.case').forEach(c => c.classList.remove('sel')); showCenter('theater'); };
}

async function resolve(id, decision) {
  const detail = $('#detail');
  detail.querySelectorAll('.actions .btn').forEach(b => b.disabled = true);
  setStatus(`Committing ${decision} for ${id}…`);
  const res = await api(`/api/reviews/${encodeURIComponent(id)}/resolve`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }),
  }).then(r => r.json()).catch(e => ({ status: 'error', message: String(e) }));
  if (res.status === 'committed') {
    sessionResolved[id] = decision;
    delete queueOverlay[id];
    addFeed('human', 'human', id, `Human ${decision} committed`, 'commit');
    setStatus(`${id} → ${decision}`); setTimeout(() => setStatus(''), 2500);
    await loadQueue(); openCase(id);
  } else {
    setStatus(`Could not commit: ${res.message || res.status}`);
    detail.querySelectorAll('.actions .btn').forEach(b => b.disabled = false);
  }
}

// ---- feed -------------------------------------------------------------------
const STEP_ICON = { triage: 'triage', retrieve: 'retrieve', recall: 'recall', reason: 'reason', tool: 'tool', graph: 'graph', govern: 'govern', suspend: 'suspend', commit: 'commit', reset: 'reset', human: 'human' };
function addFeed(ico, actor, id, headline, step, detail) {
  const feed = $('#feed');
  const it = document.createElement('div');
  it.className = 'feed-item';
  it.innerHTML = `<div class="fico">${icon(STEP_ICON[step] || ico || 'reason', 15)}</div>
    <div class="fmain"><div class="row"><b>${esc(actor)}</b><span class="t">${new Date().toLocaleTimeString()}</span></div>
      <div>${esc(headline)} <span class="dim mono">${esc(id || '')}</span></div>
      ${detail ? `<div class="fdet">${esc(detail)}</div>` : ''}</div>`;
  feed.prepend(it);
  // Matches FEED_LIMIT in src/server/routes.ts — the server backfills that many, so a smaller cap
  // here would drop events it just sent. No build step means no shared constant; keep them in sync.
  while (feed.childElementCount > 120) feed.lastElementChild.remove();
}
async function backfillFeed() {
  if ($('#feed').childElementCount) return;
  const { events = [] } = await fetch('/api/feed').then(r => r.json()).catch(() => ({ events: [] }));
  events.slice().reverse().forEach(d => addFeed(d.step, `agent · ${d.step || ''}`, d.transaction_id, d.headline, d.step, d.detail));
}
async function loadCaps() {
  const { counts = {} } = await fetch('/api/capabilities').then(r => r.json()).catch(() => ({ counts: {} }));
  Object.assign(capCounts, counts); renderRail();
}

// ---- bottom bar: real cluster stats + the eval scorecard -----------------------
const fmtMs = ms => ms == null ? null : (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms');
async function loadStats() {
  const s = await fetch('/api/stats').then(r => r.ok ? r.json() : null).catch(() => null);
  if (!s) return;
  corpusTotal = s.counts?.transactions ?? null;
  renderQueueCount(Object.keys(casesById).length || undefined);
  const bits = [];
  if (s.counts) {
    bits.push(`<span>corpus <b>${(s.counts.transactions ?? 0).toLocaleString()}</b></span>`);
    bits.push(`<span>precedents <b>${(s.counts.precedents ?? 0).toLocaleString()}</b></span>`);
    bits.push(`<span>policies <b>${s.counts.policies ?? 0}</b></span>`);
    bits.push(`<span>audit <b>${(s.counts.audit_events ?? 0).toLocaleString()}</b></span>`);
  }
  const p50 = fmtMs(s.latency_p50_ms);
  if (p50) bits.push(`<span>p50 <b>${p50}</b>/case</span>`);
  if (s.scorecard) {
    bits.push(`<span>fraud recall <b class="${s.scorecard.fraudRecall >= 0.95 ? 'good' : ''}">${Math.round(s.scorecard.fraudRecall * 100)}%</b></span>`);
    bits.push(`<span>F1 <b>${s.scorecard.f1Macro.toFixed(2)}</b></span>`);
  }
  $('#stats').innerHTML = bits.join('');
}

// ---- write counters (live mode only — every tick is a real DB write) -----------
const counts = {};
function bumpCounter(col) {
  if (DEMO_MODE) return; // demo replays don't write; showing counters would be theater
  counts[col] = (counts[col] || 0) + 1;
  $('#counters').innerHTML = Object.entries(counts).map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('');
}

// ---- audit chip + stage banner --------------------------------------------------
let bannerTimer = null;
function showBanner(kind, html, { sticky = false } = {}) {
  const b = $('#banner');
  b.className = kind; b.innerHTML = html; b.classList.add('show');
  clearTimeout(bannerTimer);
  if (!sticky) bannerTimer = setTimeout(hideBanner, 6000);
}
function hideBanner() { $('#banner').classList.remove('show'); }

let auditWasBroken = false;
async function refreshAudit() {
  const v = await fetch('/api/audit/verify').then(r => r.json()).catch(() => ({ ok: false }));
  const c = $('#auditChip');
  if (v.ok) {
    c.innerHTML = `${icon('audit', 13)} audit chain verified`; c.style.color = 'var(--accent)';
    if (auditWasBroken) { showBanner('info', 'AUDIT CHAIN RESTORED: every record verifies again'); auditWasBroken = false; }
  } else {
    c.innerHTML = `${icon('warn', 13)} audit chain broken`; c.style.color = 'var(--crit)';
    const broken = (v.brokenLinks || [])[0];
    auditWasBroken = true;
    showBanner('alarm', `AUDIT CHAIN BROKEN: record #${broken ? broken.index : '?'} failed HMAC verification${broken?.reason ? ` (${esc(broken.reason)})` : ''}. A tampered ledger cannot hide.`, { sticky: true });
  }
}
function setStatus(m) { $('#status').textContent = m; }

let qThrottle = null;
function reloadQueueSoon() { clearTimeout(qThrottle); qThrottle = setTimeout(loadQueue, 350); }

// ---- change streams → SSE (live reactivity in BOTH modes) -----------------------
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('open', () => $('#live').classList.add('on'));
  es.addEventListener('error', () => $('#live').classList.remove('on'));
  es.addEventListener('change', e => {
    const ev = JSON.parse(e.data);
    if (ev.operation === 'delete') return;
    bumpCounter(ev.collection);
    if (ev.collection === 'agent_events' && ev.operation === 'insert') {
      const d = ev.doc || {};
      addFeed(d.step, `agent · ${d.step || ''}`, d.transaction_id, d.headline, d.step, d.detail);
      (d.capabilities || (d.capability ? [d.capability] : [])).forEach(bumpCap);
      if (!DEMO_MODE) theaterEvent(d); // live runs drive the theater straight off the change stream
    }
    if (ev.collection === 'policies') {
      showBanner('info', 'POLICY UPDATED LIVE: the governance layer reads the new version on the very next case. No redeploy.');
      bumpCap('governance');
    }
    if (ev.collection === 'transactions' || ev.collection === 'case_decisions' || ev.collection === 'reviews') reloadQueueSoon();
    if (ev.collection === 'case_analysis' && ev.doc?.transaction_id === selected) openCase(selected);
    if (ev.collection === 'audit_trail') refreshAudit();
  });
}

// ---- deterministic replay (demo mode) -------------------------------------------
// A recorded run of the REAL agent, replayed client-side: no LLM, no server writes, identical
// for every viewer — and clearly labeled as a replay everywhere it appears.
let replayTimer = null;

/**
 * Step-through state. `replayMode` is the ONLY switch: in 'step' the tick renders its event and
 * returns without arming the timer, so the presenter's Step action is the clock. Same tick, same
 * rendering, same pacing code — a second stepping loop would drift from the auto-play one.
 *
 * Default 'play' is deliberate and load-bearing: an unattended booth box, and every ?ui=classic
 * viewer, must behave exactly as it did before this existed.
 */
let replayMode = 'play';
/** The live replay cursor. `order` is the index sequence tick() walks — the full recording, or one
 *  case's slice when the presenter stepped in from a case. */
let replayState = null;

/**
 * Replay pacing, derived from the RECORDED `ts` deltas rather than a fixed dwell.
 *
 * The old code waited a flat 480 ms between every event (1600 ms after a verdict), which made the
 * replay a uniform metronome that misrepresented the pipeline in both directions: the model's
 * reasoning really takes 8–21 s and was shown in 480 ms, while retrieval really takes ~0.3 s and was
 * also shown in 480 ms — i.e. the replay claimed Atlas reads were ~5× slower and LLM calls ~20×
 * faster than the run it recorded. Timing is part of what this demo is showing, so it is now real.
 *
 * Two bounds, and nothing else, are applied to the recorded gaps:
 *   MIN — most gaps are now sub-frame. In the current recording 19 of 37 are 4–38 ms (retrieval,
 *         graph→govern bookkeeping, case handoffs), which would drop several events into the same
 *         paint and read as steps being skipped.
 *   MAX — the slowest recorded gap is a 16.0 s model call, which alone would be a third of the
 *         replay and read as a hang. Clamping keeps the shape truthful without letting the outlier
 *         become the experience. It bites 3 of 37 gaps.
 * TERMINAL_MIN is a readability floor, not pacing: the recorded gap after a verdict is ~5 ms (the
 * engine moves straight to the next case), nowhere near long enough to read the stamp.
 *
 * These bounds are calibrated to the CURRENT recording, so they go stale when it is re-baked or
 * re-timed — `pnpm check:replay` reports how many gaps each bound is touching. If MIN is floating
 * most of the run the recording is faster than the constants assume; re-tune rather than let the
 * floors become the pacing.
 *
 * `?speed=N` divides every dwell — for a booth loop that needs to fit a shorter window. Default 1
 * is true-to-recording (~48 s for the 6-case run).
 */
const REPLAY_PACE = { MIN_MS: 140, MAX_MS: 6000, TERMINAL_MIN_MS: 1600 };

/** Milliseconds to hold on `ev[i]` before showing `ev[i+1]`, from their recorded timestamps. */
function replayDwellMs(events, i, speed = 1) {
  const cur = Date.parse(tsOf(events[i]?.ts));
  const next = Date.parse(tsOf(events[i + 1]?.ts));
  // Missing/garbled timestamps must not stall or fast-forward the replay — fall back to the floor.
  const gap = Number.isFinite(cur) && Number.isFinite(next) ? next - cur : REPLAY_PACE.MIN_MS;
  const scaled = Math.min(Math.max(gap, 0) / (speed > 0 ? speed : 1), REPLAY_PACE.MAX_MS);
  const terminal = events[i]?.step === 'commit' || events[i]?.step === 'suspend';
  return Math.max(scaled, terminal ? REPLAY_PACE.TERMINAL_MIN_MS / (speed > 0 ? speed : 1) : REPLAY_PACE.MIN_MS);
}

/** Mongo `ts` arrives as an ISO string over JSON, but tolerate an extended-JSON `$date` too. */
function tsOf(ts) {
  return typeof ts === 'object' && ts ? ts.$date ?? '' : ts ?? '';
}

/** Booth override: `?speed=2` runs the replay twice as fast. Ignores junk and non-positive values. */
function replaySpeed() {
  const v = Number(new URLSearchParams(location.search).get('speed'));
  return Number.isFinite(v) && v > 0 ? Math.min(v, 20) : 1;
}

async function runReplay(scopeCaseId = null) {
  const { events = [], analyses = [] } = await fetch('/api/replay').then(r => r.json()).catch(() => ({}));
  if (!events.length) { setStatus('No baked replay found. Run `pnpm bake` first.'); endRun(); return; }
  // Choreography reset: rail + feed count only this run; every analyzed case visually returns
  // to pending, then flips as its terminal event lands.
  for (const k in capCounts) delete capCounts[k];
  renderRail();
  $('#feed').innerHTML = '';
  for (const a of analyses) { if (!sessionResolved[a.transaction_id]) queueOverlay[a.transaction_id] = 'pending'; }
  loadQueueRender();
  enterTheater();

  // Case scoping: step only through ONE case's events, as a filtered index into the same array —
  // not a second loop, so replayDwellMs still reads the real recorded gaps between them.
  const order = events
    .map((e, ix) => ix)
    .filter(ix => !scopeCaseId || events[ix].transaction_id === scopeCaseId);
  replayState = { events, order, at: 0, speed: replaySpeed(), scopeCaseId };
  // Scoped stepping starts mid-recording, so the pipeline would otherwise inherit whatever boxes
  // the previously-played case lit. theaterStart() resets theater.stages, so forcing it is enough.
  if (scopeCaseId) theaterStart(scopeCaseId);
  renderReplayControls();
  replayTick();
}

/** Render one replay event and, in play mode, arm the next. Called by the timer OR by Step. */
function replayTick() {
  const st = replayState;
  if (!run.active || !st) return;
  if (st.at >= st.order.length) { endRun(); return; }
  const ix = st.order[st.at++];
  const d = st.events[ix];
  addFeed(d.step, `agent · ${d.step || ''}`, d.transaction_id, d.headline, d.step, d.detail);
  (d.capabilities || (d.capability ? [d.capability] : [])).forEach(bumpCap);
  theaterEvent(d);
  renderReplayControls();
  if (replayMode !== 'play') return;   // the presenter is the clock now
  // Still dwell after the LAST event (replayDwellMs falls back to the terminal floor when there is
  // no next event) so the closing verdict stamp is readable before `endRun` swaps in the summary.
  replayTimer = setTimeout(replayTick, replayDwellMs(st.events, ix, st.speed));
}

// ---- top-bar wiring ----------------------------------------------------------
/** Show/label the replay controls for the current mode. Hidden outside an active replay. */
function renderReplayControls() {
  const mode = $('#modeBtn'); const step = $('#stepBtn');
  if (!mode || !step) return;
  const on = DEMO_MODE && run.active && !!replayState;
  mode.hidden = !on; step.hidden = !on || replayMode !== 'step';
  if (!on) return;
  const stepping = replayMode === 'step';
  mode.classList.toggle('stepping', stepping);
  mode.querySelector('.micon').textContent = stepping ? '⏸' : '▶';
  mode.querySelector('.mlbl').textContent = stepping ? 'Stepping' : 'Playing';
  mode.setAttribute('aria-label', stepping ? 'Resume automatic playback' : 'Pause and step manually');
  const left = replayState.order.length - replayState.at;
  step.textContent = left > 0 ? `Step › ${left}` : 'Step ›';
  step.disabled = left <= 0;
}

/** Switch between auto-play and manual stepping, re-arming from the CURRENT cursor either way. */
function setReplayMode(next) {
  replayMode = next;
  clearTimeout(replayTimer);
  renderReplayControls();
  // Resuming play continues from wherever stepping left the cursor — the recording is not restarted.
  if (next === 'play' && run.active && replayState) replayTick();
}

function renderLaunchLabel() {
  $('#launchBtn').innerHTML = `${icon('launch', 13)} ${DEMO_MODE ? 'Replay Investigation' : 'Launch Investigation'}`;
}
function wire() {
  $('#launchBtn').addEventListener('click', async () => {
    if (run.active) return;
    const b = $('#launchBtn'); b.disabled = true; b.textContent = DEMO_MODE ? 'Replaying…' : 'Investigating…';
    run.active = true;
    addFeed('launch', 'system', '', DEMO_MODE ? 'Replaying the recorded investigation' : 'Launch: investigating all pending cases', 'commit');
    if (DEMO_MODE) {
      setStatus('Replaying a recorded run of the real agent');
      try { await api('/api/investigate/run', { method: 'POST' }); } catch {}
      runReplay();
      return;
    }
    setStatus('Investigation running');
    enterTheater();
    try { await api('/api/investigate/run', { method: 'POST' }); } catch (e) { setStatus('Launch failed'); endRun(); }
    setTimeout(() => { if (run.active) endRun(); }, 180000); // fallback if the stream goes quiet
  });
  $('#resetBtn').addEventListener('click', async () => {
    const b = $('#resetBtn'); b.disabled = true; setStatus('Resetting…');
    clearTimeout(replayTimer);
    replayState = null; replayMode = 'play'; renderReplayControls();
    run.active = false;
    $('#launchBtn').disabled = false; renderLaunchLabel();
    try {
      const r = await api('/api/reset', { method: 'POST' }).then(x => x.json());
      $('#feed').innerHTML = ''; for (const k in capCounts) delete capCounts[k]; renderRail();
      for (const k in sessionResolved) delete sessionResolved[k];
      for (const k in queueOverlay) delete queueOverlay[k];
      theater.done = [];
      selected = null; showCenter('welcome');
      hideBanner();
      addFeed('reset', 'system', '', `Reset: ${r.transactions ?? ''} cases pending`, 'reset');
      await loadQueue();
      if (DEMO_MODE) {
        // Demo reset returns the QUEUE to its pre-run look (session-scoped; the baked recording
        // itself is shared and untouched).
        const { analyses = [] } = await fetch('/api/replay').then(x => x.json()).catch(() => ({}));
        for (const a of analyses) queueOverlay[a.transaction_id] = 'pending';
        loadQueueRender();
      }
      setStatus('Reset complete'); setTimeout(() => setStatus(''), 2000);
    } catch { setStatus('Reset failed'); }
    b.disabled = false;
  });
  $('#modeBtn').addEventListener('click', () => setReplayMode(replayMode === 'play' ? 'step' : 'play'));
  $('#stepBtn').addEventListener('click', () => { if (replayMode === 'step') replayTick(); });
  document.addEventListener('keydown', e => {
    if (!DEMO_MODE || !run.active || !replayState) return;
    // Never shadow a browser or OS chord, and never fire while someone is typing in the feedback
    // widget's textarea — the same guard initTheme()'s `L` shortcut uses.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    // The guided tour owns the arrow keys while it is open.
    if ($('#tourMask')?.classList.contains('on')) return;
    if (e.key === ' ') { e.preventDefault(); setReplayMode(replayMode === 'play' ? 'step' : 'play'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (replayMode === 'step') replayTick(); }
  });
}

// ---- viewport-aware disclosures ---------------------------------------------
/**
 * The queue and feed ship `open` so they render normally on every desktop tier and degrade to plain
 * open panels with JS off. On the phone tier they must start COLLAPSED, or the hero is pushed
 * ~1200px down the page. Driven by matchMedia rather than a resize handler so it also fires when a
 * phone is rotated, and so an explicit user toggle is never fought: once someone taps a summary we
 * stop managing that panel.
 */
// The two tier boundaries, as media-query strings, declared ONCE for all of this file. Every
// matchMedia() call in app.js must use these — a fourth and fifth copy of "759" is how the
// disclosure sync and the density resolver drift apart by a pixel and only one of them switches.
//
// DUPLICATED ACROSS FILES ON PURPOSE, and there are exactly two other homes for these numbers:
//   1. the @media blocks in public/index.html's "responsive tiers" section (same repo), and
//   2. nothing else — the overlay repo's widgets deliberately do not know them (see the yield note
//      in that repo's public/feedback.js, which keys off geometry rather than a third copy).
// The duplication is not laziness: this project ships with NO build step, so there is no mechanism
// that could feed one definition to both CSS and JS, and the alternative — writing the tier rules
// from JS — would move the layout off the pre-paint path and reintroduce the flash of the wrong
// layout that index.html's head script exists to prevent. If you change a boundary, change it in
// BOTH places; index.html carries the reciprocal pointer back to here.
const PHONE_MQ = '(max-width:759px)';
const TABLET_MQ = '(max-width:1179px)';
const userToggled = new Set();
function syncDisclosures() {
  const phone = isPhoneTier();
  for (const sel of ['#left', '#right']) {
    const el = $(sel);
    if (!el || userToggled.has(sel)) continue;
    el.open = !phone;
  }
}
function initDisclosures() {
  for (const sel of ['#left', '#right']) {
    const el = $(sel);
    if (el) el.querySelector('summary').addEventListener('click', () => userToggled.add(sel));
  }
  syncDisclosures();
  window.matchMedia(PHONE_MQ).addEventListener('change', syncDisclosures);
  // Rotating a phone can cross a density boundary; re-resolve and re-render the welcome copy.
  // Both boundaries, because resolveDensity() reads both: an iPad rotating across 1179 changes
  // lean/full without ever touching the phone breakpoint.
  for (const mq of [PHONE_MQ, TABLET_MQ]) {
    window.matchMedia(mq).addEventListener('change', () => {
      const before = DENSITY;
      applyDensity();
      if (DENSITY !== before) renderWelcome();
    });
  }
}

// ---- theme ------------------------------------------------------------------
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const b = $('#themeBtn');
  if (!b) return;
  // The control names its DESTINATION, not its current state: in dark mode it reads "☀ Light".
  // A presenter scanning the top bar for the words "light mode" then finds them.
  const toLight = t !== 'light';
  b.querySelector('.ticon').textContent = toLight ? '\u2600' : '\u263e';
  b.querySelector('.tlbl').textContent = toLight ? 'Light' : 'Dark';
  b.setAttribute('title', `Switch to ${toLight ? 'light' : 'dark'} mode (L)`);
  b.setAttribute('aria-label', `Switch to ${toLight ? 'light' : 'dark'} mode`);
}
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  localStorage.setItem('marshal-theme', next);
  applyTheme(next);
}
function initTheme() {
  // Default follows the OS; an explicit choice persists and wins. A phone scanning the QR code
  // in Las Vegas daylight, with a light-mode OS, then opens in the readable theme.
  //
  // Guarded because localStorage THROWS, it does not return null, when storage is unavailable —
  // Safari private browsing, blocked third-party storage, kiosk policies. Unguarded, that exception
  // escapes initTheme() and kills the rest of boot(): no tour, no disclosure sync, no wiring. A
  // visitor on a locked-down browser would get a dead console rather than a console in the wrong
  // theme. The OS scheme is a complete fallback, so there is nothing to recover beyond it. The head
  // script in index.html wraps the same read for the same reason — see the note above it about why
  // the statement order there matters.
  let stored = null;
  try {
    stored = localStorage.getItem('marshal-theme');
  } catch (e) {
    stored = null;
  }
  const saved = stored
    || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  applyTheme(saved);
  $('#themeBtn').addEventListener('click', toggleTheme);
  document.addEventListener('keydown', e => {
    if (e.key !== 'l' && e.key !== 'L') return;
    // Cmd/Ctrl+L is the address bar and Alt+L is a menu mnemonic — never shadow them.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // A bare letter must not fire while the visitor is typing in the feedback widget.
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    toggleTheme();
  });
}

// ---- guided walkthrough --------------------------------------------------------
function tourSteps() {
  return [
    { sel: '#brand', title: 'Welcome to Marshal', body: 'A fraud-investigation console that runs an AI agent over flagged transactions, with vector, full-text, hybrid & graph search, precedent recall, a policy governance layer, and a durable human-approval gate. Every one of those jobs runs on a SINGLE MongoDB Atlas cluster.' },
    { sel: '#rail', title: 'The capability rail', body: 'Eight MongoDB jobs the industry usually buys as separate systems: a vector DB, a keyword engine, a graph store, a cache, an audit log… Here they are one cluster. Each tile lights up and counts as the agent uses it during a run.' },
    { sel: '#launchBtn', title: DEMO_MODE ? 'Replay an investigation' : 'Launch an investigation', body: DEMO_MODE
        ? 'This replays a RECORDED run of the real agent against this cluster: every step you will watch was produced by the live pipeline and captured. Identical for every viewer, no tokens spent twice.'
        : 'Click this to have the agent investigate every pending case. The center becomes a live theater: each pipeline stage lights up as the corresponding database write lands.' },
    { sel: '#queue', title: 'The case queue', body: `Every flagged transaction, colour-coded by outcome. Click any case to open its full investigation. Cases the agent is unsure about are HELD for you to decide.${corpusTotal ? ` Behind these active cases sits a decided-precedent corpus of ${corpusTotal.toLocaleString()} documents the retrieval runs over.` : ''}` },
    { sel: '#center', title: 'The investigation theater', body: 'While a run is active this follows the case under the lens: the pipeline fills stage by stage, evidence mounts as it is found, and the verdict stamps down. Afterwards, click any case for the full post-hoc story, including the Approve / Reject gate on held cases.' },
    { sel: '#feed', title: 'Agent operations feed', body: DEMO_MODE
        ? 'Every step of the recorded run, replayed in order. In live mode this feed is a pure projection of MongoDB change streams; during a replay it re-plays the captured events and is labeled as such.'
        : 'A live, icon-tagged trace of what the agent is doing right now: a pure projection of MongoDB change streams. Nothing here is faked client-side; it is the database writes surfacing in real time.' },
    { sel: '#stats', title: 'The payoff readout', body: 'Real numbers from the cluster: corpus size, decided precedents, policies, median wall-clock per case, and the decision-quality scorecard (fraud recall, F1) measured against the labeled ground truth of every investigated case.' },
    { sel: '#auditChip', title: 'Tamper-evident audit', body: 'Every decision is written to an HMAC hash-chained audit trail. This chip re-verifies the whole chain: alter any record in the database and the console raises an alarm within seconds.' },
  ];
}
let tourIx = 0; let TOUR = [];
let tourGen = 0;   // invalidates in-flight flip probes when the step changes
function isPhoneTier() {
  return window.matchMedia(PHONE_MQ).matches
    && document.documentElement.getAttribute('data-ui') !== 'classic';
}
function positionTour() {
  const s = TOUR[tourIx]; const el = document.querySelector(s.sel);
  const card = $('#tourCard');
  // Phone tier: the card is a CSS-positioned bottom sheet, so skip the spotlight geometry
  // entirely. Scroll the step's subject into view instead — the panels are stacked, so the
  // subject is usually off-screen, and a sheet describing an invisible element is useless.
  if (isPhoneTier()) {
    card.style.display = 'block';
    card.classList.remove('attop');
    if (el) {
      const gen = ++tourGen;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // The last elements in the document (#stats, #auditChip) cannot be scrolled above a
      // bottom sheet — the page is already at scrollMax — so move the sheet to the top instead.
      //
      // This MUST measure a settled page, and there is no scrollend event in Safari 18. It used to
      // wait a fixed 420ms, which is not the same thing: smooth-scroll duration grows with distance
      // and with CPU pressure, and #feed is the tour's longest jump (~1982px, straight to
      // scrollMax at 440x956). Measured at that step with the fixed delay — 6x CPU throttle put
      // scrollY at 1867/2058 and vis at 0.558 when the probe fired, against 0.826 once settled;
      // at 14x it read 0.476 and flipped the sheet to the top for a subject that ends up fully
      // visible. A 0.058 margin on a slow phone is not a margin. So poll for the scroll to stop
      // moving instead: two consecutive equal scrollY samples one frame apart, then measure.
      //
      // The cap matters as much as the poll — scroll can be interrupted (the visitor drags
      // mid-animation, or an anchored scroll never reaches its target) and this must not become a
      // probe that never fires. On timeout we measure anyway: a stale-but-real geometry beats no
      // decision, and the worst case is the pre-existing behaviour.
      //
      // The generation check discards a probe whose step has already been left: two taps closer
      // together than the settle would otherwise flip the new step's card off the old one's
      // geometry.
      // START_FLOOR exists because "two equal samples" is also true BEFORE the animation begins.
      // Without it the poll settles on the frame after the click, reading the OLD scroll position:
      // observed #rail flipping to the top on 1 run in 2, because scrollY was 0 twice while the
      // scroll to 561 had not started yet. Motion begins within ~60ms even at 6x throttle, so 200ms
      // is comfortably past the start without being perceptible. A step whose subject is already in
      // view scrolls not at all — that is the case the floor costs, and it costs it 200ms.
      const START_FLOOR = 200;
      const t0 = performance.now();
      let lastY = null, frames = 0;
      const measure = () => {
        const rr = el.getBoundingClientRect();
        const ct = card.getBoundingClientRect().top;
        const vis = Math.max(0, Math.min(rr.bottom, ct) - Math.max(rr.top, 0));
        if (vis / Math.max(1, rr.height) < 0.5) card.classList.add('attop');
      };
      const poll = () => {
        if (gen !== tourGen) return;              // step already left; drop this probe
        const y = Math.round(window.scrollY);
        const still = y === lastY;
        lastY = y;
        if (still && performance.now() - t0 > START_FLOOR) return measure();   // settled
        if (++frames > 120) return measure();     // ~2s cap: interrupted or never-settling scroll
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    }
  } else if (el) {
    const r = el.getBoundingClientRect(); const pad = 8;
    const hole = $('#tourHole');
    hole.style.left = (r.left - pad) + 'px'; hole.style.top = (r.top - pad) + 'px';
    hole.style.width = (r.width + pad * 2) + 'px'; hole.style.height = (r.height + pad * 2) + 'px';
    card.style.display = 'block';
    const cw = 320, ch = card.offsetHeight || 200;
    let top = r.bottom + 14; if (top + ch > window.innerHeight - 12) top = Math.max(12, r.top - ch - 14);
    let left = Math.min(Math.max(12, r.left), window.innerWidth - cw - 12);
    card.style.top = top + 'px'; card.style.left = left + 'px';
  } else {
    return;
  }
  $('#tourStep').textContent = `Step ${tourIx + 1} of ${TOUR.length}`;
  $('#tourTitle').textContent = s.title; $('#tourBody').textContent = s.body;
  $('#tourDots').innerHTML = TOUR.map((_, i) => `<i class="${i === tourIx ? 'on' : ''}"></i>`).join('');
  $('#tourPrev').style.visibility = tourIx === 0 ? 'hidden' : 'visible';
  $('#tourNext').textContent = tourIx === TOUR.length - 1 ? 'Done ✓' : 'Next ›';
}
function startTour() {
  TOUR = tourSteps(); tourIx = 0;
  // #queue and #feed are inside the <details> panels, which are collapsed on the phone tier.
  // A tour step pointing at a closed panel has nothing to scroll to, so open them for the tour
  // and mark them user-toggled so syncDisclosures() stops managing them.
  if (isPhoneTier()) for (const sel of ['#left', '#right']) {
    const el = $(sel); if (el && !el.open) { el.open = true; userToggled.add(sel); }
  }
  $('#tourMask').classList.add('on'); positionTour();
}
function endTour() { tourGen++; $('#tourMask').classList.remove('on'); $('#tourCard').classList.remove('attop'); $('#tourCard').style.display = 'none'; localStorage.setItem('marshal-tour-seen', '1'); }

// ---- rail tip sheet ---------------------------------------------------------
// .cap::after is a :hover tooltip with cursor:help — it never fires on a touch device, so the
// eight capability explanations are unreachable for every QR-code visitor. A tap opens the same
// copy in a sheet. Delegated, because renderRail() replaces the rail's innerHTML.
function initRailTips() {
  $('#rail').addEventListener('click', e => {
    const cap = e.target.closest('.cap');
    if (!cap || !isPhoneTier()) return;
    const c = CAPS.find(x => x.key === cap.dataset.cap);
    if (!c) return;
    $('#tipIcon').innerHTML = icon(c.key, 18);
    $('#tipTitle').textContent = c.name;
    $('#tipBody').textContent = c.tip;
    $('#tipSheet').classList.add('on');
  });
  const close = () => $('#tipSheet').classList.remove('on');
  $('#tipClose').addEventListener('click', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
}

function initTour() {
  $('#tourBtn').addEventListener('click', startTour);
  $('#tourSkip').addEventListener('click', endTour);
  $('#tourPrev').addEventListener('click', () => { if (tourIx > 0) { tourIx--; positionTour(); } });
  $('#tourNext').addEventListener('click', () => { if (tourIx === TOUR.length - 1) endTour(); else { tourIx++; positionTour(); } });
  window.addEventListener('resize', () => { if ($('#tourMask').classList.contains('on')) positionTour(); });
  // Crossing the phone boundary swaps the card between bottom sheet and spotlight; clear the
  // inline top/left the spotlight branch wrote, or they fight the sheet's CSS.
  window.matchMedia(PHONE_MQ).addEventListener('change', () => {
    const card = $('#tourCard');
    card.style.top = ''; card.style.left = ''; card.classList.remove('attop');
    if ($('#tourMask').classList.contains('on')) positionTour();
  });
  const suppressed = new URLSearchParams(location.search).get('tour') === '0';
  if (!suppressed && !localStorage.getItem('marshal-tour-seen')) setTimeout(startTour, 700);
}

async function loadMode() {
  const m = await fetch('/api/mode').then(r => r.json()).catch(() => ({ demoMode: false }));
  DEMO_MODE = !!m.demoMode;
  SERVER_UI = m.uiMode || '';
  SERVER_DENSITY = m.uiDensity || '';
  // Both may change now that the server defaults have arrived. ?ui= / ?density= still win.
  applyUiMode();
  applyDensity(); // renderWelcome() below re-renders at the resolved density
  // isPhoneTier() is false under classic, so a MARSHAL_UI=classic server must re-open the panels
  // that boot() collapsed while it still believed this was a phone.
  syncDisclosures();
  $('#feedMode').textContent = DEMO_MODE ? 'recorded · replay' : 'live · change streams';
  renderLaunchLabel();
  renderWelcome();
}
async function boot() {
  applyDensity(); renderLockup(); initTheme(); renderRail(); wire(); showCenter('welcome'); initDisclosures();
  await loadMode(); // mode shapes the welcome copy, launch label and tour before anything renders
  initRailTips();
  initTour();
  loadQueue().then(overlayHeldFromReviews);
  loadCaps(); backfillFeed(); refreshAudit(); connect(); loadStats();
  setInterval(loadStats, 45000);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
