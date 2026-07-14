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
  if (lead) lead.innerHTML = DEMO_MODE
    ? `Every flagged transaction is investigated by an AI agent (retrieval, graph fund-tracing, precedent recall, a policy governance layer, and a durable human-approval gate), all on a single MongoDB Atlas cluster. Press <b style="color:var(--mongo)">▶ Replay Investigation</b> to watch a recorded run of the real agent, step for step, then open any case to see exactly how it was decided.`
    : `Every flagged transaction is investigated by an AI agent (retrieval, graph fund-tracing, precedent recall, a policy governance layer, and a durable human-approval gate), all on a single MongoDB Atlas cluster. Press <b style="color:var(--mongo)">▶ Launch Investigation</b>, then open any case to see exactly how it was decided.`;
  const flow = $('#wflow');
  if (flow) flow.innerHTML = WELCOME_FLOW.map((s, idx) =>
    `<div class="wstep"><div class="wi">${icon(s.i, 20)}</div><div class="wn">${s.n}</div><div class="wd">${s.d}</div></div>`
    + (idx < WELCOME_FLOW.length - 1 ? '<div class="warrow">›</div>' : '')).join('');
  const grid = $('#wgrid');
  if (grid) grid.innerHTML = WELCOME_JOBS.map(j =>
    `<div class="wjob"><div class="ji">${icon(j.i, 18)}</div><div><b>${j.b}</b><div class="jd">${j.d}</div><div class="jq">${j.q}</div></div></div>`).join('');
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
function renderQueueCount(visible) {
  $('#qcount').textContent = corpusTotal && corpusTotal > visible
    ? `showing ${visible} · ${corpusTotal.toLocaleString()} corpus` : `${visible ?? ''}`;
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
const theater = { caseId: null, stages: new Set(), done: [] };

function enterTheater() {
  theater.caseId = null; theater.stages = new Set(); theater.done = [];
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
function theaterStart(id) {
  theater.caseId = id; theater.stages = new Set();
  $('#tcase').innerHTML = theaterCaseHead(casesById[id], id);
  queueOverlay[id] = 'investigating';
  loadQueueRender();
}
function theaterStage(stage, d) {
  theater.stages.add(stage);
  document.querySelectorAll('#tcase .tstep').forEach(el => {
    el.classList.toggle('on', theater.stages.has(el.dataset.stage));
    el.classList.toggle('now', el.dataset.stage === stage);
  });
  const now = $('#tnow');
  if (now) now.innerHTML = `${icon(STEP_ICON[d.step] || 'reason', 15)}<span>${esc(d.headline)}</span><span class="d">${esc(d.detail || '')}</span>`;
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
  const stage = STEP_TO_STAGE[d.step];
  if (stage) theaterStage(stage, d);
  if (d.step === 'suspend' || d.step === 'commit') theaterTerminal(d);
}
function endRun() {
  if (!run.active) return;
  run.active = false;
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
  return `
    <div class="section"><div class="lbl">${icon('memory', 13)} Similar precedent <span class="chip2">hybrid search</span></div>
      ${precedents || '<div class="sub dim">none</div>'}</div>
    ${graphSection}
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

  // Verdict + gate FIRST (the money moment lives above the fold), rationale in the open,
  // then the evidence that produced it.
  detail.innerHTML = `${backLink}
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
const STEP_ICON = { triage: 'triage', retrieve: 'retrieve', recall: 'recall', reason: 'reason', graph: 'graph', govern: 'govern', suspend: 'suspend', commit: 'commit', reset: 'reset', human: 'human' };
function addFeed(ico, actor, id, headline, step, detail) {
  const feed = $('#feed');
  const it = document.createElement('div');
  it.className = 'feed-item';
  it.innerHTML = `<div class="fico">${icon(STEP_ICON[step] || ico || 'reason', 15)}</div>
    <div class="fmain"><div class="row"><b>${esc(actor)}</b><span class="t">${new Date().toLocaleTimeString()}</span></div>
      <div>${esc(headline)} <span class="dim mono">${esc(id || '')}</span></div>
      ${detail ? `<div class="fdet">${esc(detail)}</div>` : ''}</div>`;
  feed.prepend(it);
  while (feed.childElementCount > 60) feed.lastElementChild.remove();
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
async function runReplay() {
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
  let i = 0;
  const tick = () => {
    if (!run.active) return;
    if (i >= events.length) { endRun(); return; }
    const d = events[i++];
    addFeed(d.step, `agent · ${d.step || ''}`, d.transaction_id, d.headline, d.step, d.detail);
    (d.capabilities || (d.capability ? [d.capability] : [])).forEach(bumpCap);
    theaterEvent(d);
    // dwell on the verdict so the stamp lands before the next case begins
    const dwell = (d.step === 'commit' || d.step === 'suspend') ? 1600 : 480;
    replayTimer = setTimeout(tick, dwell);
  };
  tick();
}

// ---- top-bar wiring ----------------------------------------------------------
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
}

// ---- theme ------------------------------------------------------------------
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const b = $('#themeBtn'); if (b) b.textContent = t === 'light' ? '☾' : '◐';
}
function initTheme() {
  const saved = localStorage.getItem('marshal-theme') || 'dark';
  applyTheme(saved);
  $('#themeBtn').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    localStorage.setItem('marshal-theme', next); applyTheme(next);
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
function positionTour() {
  const s = TOUR[tourIx]; const el = document.querySelector(s.sel);
  if (!el) return;
  const r = el.getBoundingClientRect(); const pad = 8;
  const hole = $('#tourHole');
  hole.style.left = (r.left - pad) + 'px'; hole.style.top = (r.top - pad) + 'px';
  hole.style.width = (r.width + pad * 2) + 'px'; hole.style.height = (r.height + pad * 2) + 'px';
  const card = $('#tourCard'); card.style.display = 'block';
  const cw = 320, ch = card.offsetHeight || 200;
  let top = r.bottom + 14; if (top + ch > window.innerHeight - 12) top = Math.max(12, r.top - ch - 14);
  let left = Math.min(Math.max(12, r.left), window.innerWidth - cw - 12);
  card.style.top = top + 'px'; card.style.left = left + 'px';
  $('#tourStep').textContent = `Step ${tourIx + 1} of ${TOUR.length}`;
  $('#tourTitle').textContent = s.title; $('#tourBody').textContent = s.body;
  $('#tourDots').innerHTML = TOUR.map((_, i) => `<i class="${i === tourIx ? 'on' : ''}"></i>`).join('');
  $('#tourPrev').style.visibility = tourIx === 0 ? 'hidden' : 'visible';
  $('#tourNext').textContent = tourIx === TOUR.length - 1 ? 'Done ✓' : 'Next ›';
}
function startTour() { TOUR = tourSteps(); tourIx = 0; $('#tourMask').classList.add('on'); positionTour(); }
function endTour() { $('#tourMask').classList.remove('on'); $('#tourCard').style.display = 'none'; localStorage.setItem('marshal-tour-seen', '1'); }
function initTour() {
  $('#tourBtn').addEventListener('click', startTour);
  $('#tourSkip').addEventListener('click', endTour);
  $('#tourPrev').addEventListener('click', () => { if (tourIx > 0) { tourIx--; positionTour(); } });
  $('#tourNext').addEventListener('click', () => { if (tourIx === TOUR.length - 1) endTour(); else { tourIx++; positionTour(); } });
  window.addEventListener('resize', () => { if ($('#tourMask').classList.contains('on')) positionTour(); });
  const suppressed = new URLSearchParams(location.search).get('tour') === '0';
  if (!suppressed && !localStorage.getItem('marshal-tour-seen')) setTimeout(startTour, 700);
}

async function loadMode() {
  const m = await fetch('/api/mode').then(r => r.json()).catch(() => ({ demoMode: false }));
  DEMO_MODE = !!m.demoMode;
  $('#feedMode').textContent = DEMO_MODE ? 'recorded · replay' : 'live · change streams';
  renderLaunchLabel();
  renderWelcome();
}
async function boot() {
  renderLockup(); initTheme(); renderRail(); wire(); showCenter('welcome');
  await loadMode(); // mode shapes the welcome copy, launch label and tour before anything renders
  initTour();
  loadQueue().then(overlayHeldFromReviews);
  loadCaps(); backfillFeed(); refreshAudit(); connect(); loadStats();
  setInterval(loadStats, 45000);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
