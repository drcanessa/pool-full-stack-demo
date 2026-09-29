const PREVIEW_MODE = new URLSearchParams(location.search).has("iphone-preview");
const DEMO_MODE = true;
const RESET_DEMO = new URLSearchParams(location.search).has("reset-demo");
const MOCK_DATA_MODE = PREVIEW_MODE || DEMO_MODE;
const STORAGE_KEY = DEMO_MODE ? "vc-cv-presentation-demo-v1" : (PREVIEW_MODE ? "pool-night-preview-v2" : "pool-night-local-v3");
// This presentation copy is intentionally local-only: it never contacts the real scorebook.
const SUPABASE_URL = "";
const SUPABASE_KEY = "";
const EDITOR_TOKEN_KEY = "vc-cv-pool-editor-token";
const SHARED_MODE = false;
let state = loadState();
state.runRecords ||= [];
let openSeriesId = null;
let roundStep = 1;
let roundWinTimer = null;
let editingRunId = null;
let remoteUpdatedAt = null;
let remoteStateExists = false;
let remoteHasScorebookData = false;
let remoteSaveInFlight = false;
let remoteSaveQueued = false;
let remotePollTimer = null;

if (PREVIEW_MODE) {
  document.body.classList.add("iphone-preview");
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const uid = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

function syncDialogViewport() {
  const viewport = window.visualViewport;
  const visibleHeight = viewport?.height || window.innerHeight;
  dialogLayoutHeight = Math.max(dialogLayoutHeight, window.innerHeight, document.documentElement.clientHeight);
  const keyboardOffset = Math.max(0, dialogLayoutHeight - visibleHeight - (viewport?.offsetTop || 0));
  document.documentElement.style.setProperty("--dialog-visible-height", `${Math.round(visibleHeight)}px`);
  document.documentElement.style.setProperty("--dialog-keyboard-offset", `${Math.round(keyboardOffset)}px`);
}

let dialogLayoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
syncDialogViewport();
window.visualViewport?.addEventListener("resize", syncDialogViewport);
window.visualViewport?.addEventListener("scroll", syncDialogViewport);
window.addEventListener("resize", syncDialogViewport);
window.addEventListener("orientationchange", () => {
  setTimeout(() => {
    dialogLayoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
    syncDialogViewport();
  }, 350);
});
document.addEventListener("focusin", () => requestAnimationFrame(syncDialogViewport));

function loadState() {
  try {
    if (DEMO_MODE && RESET_DEMO) {
      localStorage.removeItem(STORAGE_KEY);
      return presentationState();
    }
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved) return saved;
    if (!PREVIEW_MODE && !DEMO_MODE) {
      const previous = ["pool-night-vercel-demo-v1", "pool-night-v1"]
        .map(key => localStorage.getItem(key))
        .find(Boolean);
      if (previous) return JSON.parse(previous);
    }
    return MOCK_DATA_MODE ? (DEMO_MODE ? presentationState() : previewState()) : { series: [] };
  }
  catch { return MOCK_DATA_MODE ? (DEMO_MODE ? presentationState() : previewState()) : { series: [] }; }
}

function emptyState() { return { series: [], runRecords: [] }; }

function normalizeState(value) {
  const next = value && typeof value === "object" ? value : emptyState();
  return { ...next, series: Array.isArray(next.series) ? next.series : [], runRecords: Array.isArray(next.runRecords) ? next.runRecords : [] };
}

function isEditor() { return DEMO_MODE || (!PREVIEW_MODE && Boolean(localStorage.getItem(EDITOR_TOKEN_KEY))); }

function requireEditor() {
  if (isEditor() || PREVIEW_MODE) return true;
  openAccessDialog();
  return false;
}

function rememberLocalState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function hasScorebookContent(value = state) {
  return value.series?.some(series => !series.deleted || series.rounds?.length) || value.runRecords?.length;
}

async function fetchSharedState() {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/pool_app_state?id=eq.shared&select=data,updated_at`, { headers: { apikey: SUPABASE_KEY } });
  if (!response.ok) throw new Error("Couldn't reach the shared scorebook.");
  const rows = await response.json();
  return rows[0] || null;
}

async function pushSharedState() {
  if (!SHARED_MODE || !isEditor()) return;
  if (remoteSaveInFlight) { remoteSaveQueued = true; return; }
  remoteSaveInFlight = true;
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/save-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY, Authorization: `Bearer ${localStorage.getItem(EDITOR_TOKEN_KEY)}` },
      body: JSON.stringify({ data: state })
    });
    if (!response.ok) {
      if (response.status === 401) {
        localStorage.removeItem(EDITOR_TOKEN_KEY);
        toast("Editing access expired — unlock again to save.");
      }
      throw new Error("Shared save failed");
    }
    const saved = await response.json();
    remoteStateExists = true;
    remoteHasScorebookData = hasScorebookContent(saved.data);
    remoteUpdatedAt = saved.updated_at;
  } catch (error) {
    console.warn(error);
  } finally {
    remoteSaveInFlight = false;
    if (remoteSaveQueued) { remoteSaveQueued = false; pushSharedState(); }
  }
}

async function refreshSharedState({ quiet = false } = {}) {
  if (!SHARED_MODE || remoteSaveInFlight) return;
  try {
    const row = await fetchSharedState();
    remoteStateExists = Boolean(row);
    if (!row) return;
    remoteHasScorebookData = hasScorebookContent(row.data);
    if (row.updated_at !== remoteUpdatedAt) {
      state = normalizeState(row.data);
      remoteUpdatedAt = row.updated_at;
      rememberLocalState();
      render();
    }
  } catch (error) {
    if (!quiet) toast("Using this device's saved scorebook while sync reconnects.");
  }
}

async function initializeSharedScorebook() {
  if (!SHARED_MODE) return;
  await refreshSharedState({ quiet: true });
  remotePollTimer = window.setInterval(() => refreshSharedState({ quiet: true }), 5000);
}

function presentationState() {
  const demo = previewState();
  const showcase = demo.series.find(series => series.id === "preview-active");
  if (showcase) {
    showcase.name = "Builders Night Cup";
    showcase.challenge = "Winner picks the next celebration cocktail";
    showcase.createdAt = "2026-09-20T19:00:00.000Z";
    const reasons = ["Fair win", "Sank the 8-ball early", "8-ball in the wrong pocket", "Sunk the cue ball"];
    showcase.rounds = Array.from({ length: 18 }, (_, index) => {
      const winner = index % 2 === 0 ? "Vanessa" : "Carl";
      const playedOn = `2026-09-${String(index + 1).padStart(2, "0")}`;
      const atBar = index % 4 === 1;
      return {
        id: `networking-${index + 1}`,
        winner,
        reason: reasons[index % reasons.length],
        location: atBar ? "🍺 Real Bar" : "💗 AMLI Arc",
        playedOn,
        createdAt: `${playedOn}T20:00:00.000Z`,
        barName: atBar ? ["The High Dive", "Tavern"][index % 2] : "",
        note: index === 12 ? "Vanessa got 5 in a row!" : "",
        vanessaRun: index === 12 ? 5 : 0,
        carlRun: 0
      };
    });
  }
  const showcaseRounds = Array.from({ length: 18 }, (_, index) => {
    const winner = index < 16 ? (index % 2 === 0 ? "Vanessa" : "Carl") : "Vanessa";
    const playedOn = `2026-06-${String(index + 1).padStart(2, "0")}`;
    return {
      id: `midnight-${index + 1}`,
      winner,
      reason: ["Fair win", "Sank the 8-ball early", "8-ball in the wrong pocket", "Sunk the cue ball"][index % 4],
      location: index % 3 === 0 ? "🍺 Real Bar" : "💗 AMLI Arc",
      playedOn,
      createdAt: `${playedOn}T20:00:00.000Z`,
      barName: index % 3 === 0 ? "The High Dive" : "",
      note: "",
      vanessaRun: 0,
      carlRun: 0
    };
  });
  demo.series.push({
    id: "presentation-finished-third",
    name: "Midnight Break",
    challenge: "Loser brings the victory snacks",
    target: 10,
    createdAt: "2026-06-01T19:00:00.000Z",
    deleted: false,
    rounds: showcaseRounds
  });
  demo.runRecords = [
    { id: "demo-run-v1", player: "Vanessa", count: 5, playedOn: "2026-09-18", createdAt: "2026-09-18T20:00:00.000Z" },
    { id: "demo-run-v2", player: "Vanessa", count: 4, playedOn: "2026-08-01", createdAt: "2026-08-01T20:00:00.000Z" },
    { id: "demo-run-c1", player: "Carl", count: 5, playedOn: "2026-09-16", createdAt: "2026-09-16T20:00:00.000Z" },
    { id: "demo-run-c2", player: "Carl", count: 4, playedOn: "2026-05-18", createdAt: "2026-05-18T20:00:00.000Z" }
  ];
  return demo;
}

function previewState() {
  const round = (id, winner, reason, location, playedOn, extras = {}) => ({
    id, winner, reason, location, playedOn, createdAt: `${playedOn}T20:00:00.000Z`,
    barName: "", note: "", vanessaRun: 0, carlRun: 0, ...extras
  });
  const alternatingRounds = (prefix, vanessaWins, carlWins, date, venue = "💗 AMLI Arc") => {
    const winners = [];
    while (winners.filter(name => name === "Vanessa").length < vanessaWins || winners.filter(name => name === "Carl").length < carlWins) {
      if (winners.filter(name => name === "Vanessa").length < vanessaWins) winners.push("Vanessa");
      if (winners.filter(name => name === "Carl").length < carlWins) winners.push("Carl");
    }
    const reasons = ["Fair win", "Sank the 8-ball early", "8-ball in the wrong pocket", "Sunk the cue ball"];
    return winners.map((winner, index) => round(`${prefix}-${index + 1}`, winner, reasons[index % reasons.length], venue, date));
  };
  return {
    series: [
      {
        id: "preview-active", name: "Craft Cup", challenge: "Loser makes the winner a craft", target: 10,
        createdAt: "2026-07-27T19:00:00.000Z", deleted: false,
        rounds: [
          round("active-1", "Vanessa", "Fair win", "💗 AMLI Arc", "2026-07-27", { vanessaRun: 4 }),
          round("active-2", "Carl", "Sank the 8-ball early", "🍺 Real Bar", "2026-07-29", { barName: "The High Dive" }),
          round("active-3", "Vanessa", "8-ball in the wrong pocket", "💗 AMLI Arc", "2026-07-30"),
          round("active-4", "Vanessa", "Fair win", "🍺 Real Bar", "2026-08-01", { barName: "Tavern", note: "Vanessa got 6 in a row!", vanessaRun: 6 }),
          round("active-5", "Carl", "Sunk the cue ball", "💗 AMLI Arc", "2026-08-02"),
          round("active-6", "Vanessa", "Fair win", "💗 AMLI Arc", "2026-08-03")
        ]
      },
      {
        id: "preview-active-two", name: "Bar Crawl Cup", challenge: "Winner picks the next bar", target: 10,
        createdAt: "2026-08-01T19:00:00.000Z", deleted: false,
        rounds: [
          round("bar-crawl-1", "Carl", "Fair win", "🍺 Real Bar", "2026-08-01", { barName: "The High Dive" }),
          round("bar-crawl-2", "Vanessa", "Sunk the cue ball", "🍺 Real Bar", "2026-08-01", { barName: "The High Dive" }),
          round("bar-crawl-3", "Carl", "Fair win", "🍺 Real Bar", "2026-08-02", { barName: "Tavern" }),
          round("bar-crawl-4", "Vanessa", "Sank the 8-ball early", "💗 AMLI Arc", "2026-08-02"),
          round("bar-crawl-5", "Carl", "8-ball in the wrong pocket", "🍺 Real Bar", "2026-08-03", { barName: "The High Dive" })
        ]
      },
      {
        id: "preview-finished-vanessa", name: "Coffee Championship", challenge: "Coffee or tea for a week", target: 10,
        createdAt: "2026-05-02T19:00:00.000Z", deleted: false,
        rounds: alternatingRounds("coffee", 10, 4, "2026-05-18", "💗 AMLI Arc")
      },
      {
        id: "preview-finished-carl", name: "The Dinner Derby", challenge: "Winner chooses date night", target: 10,
        createdAt: "2026-03-08T19:00:00.000Z", deleted: false,
        rounds: alternatingRounds("dinner", 8, 10, "2026-03-24", "🍺 Real Bar").map(item => ({ ...item, barName: "The High Dive" }))
      }
    ],
    runRecords: [
      { id: "preview-run-v", player: "Vanessa", count: 6, playedOn: "2026-08-01", createdAt: "2026-08-01T20:00:00.000Z" },
      { id: "preview-run-c", player: "Carl", count: 5, playedOn: "2026-05-18", createdAt: "2026-05-18T20:00:00.000Z" }
    ]
  };
}

function saveState() {
  rememberLocalState();
  render();
  pushSharedState();
}

function scores(series) {
  return series.rounds.reduce((score, round) => {
    score[round.winner] += 1;
    return score;
  }, { Vanessa: 0, Carl: 0 });
}

function winnerOf(series) {
  const score = scores(series);
  return score.Vanessa >= series.target ? "Vanessa" : score.Carl >= series.target ? "Carl" : null;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function localDateValue(value = new Date()) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function formatPlayedDate(round) {
  return formatDate(round.playedOn ? `${round.playedOn}T12:00:00` : round.createdAt);
}

function isAmliLocation(location = "") {
  return location.includes("AMLI");
}

function displayLocation(round) {
  return isAmliLocation(round.location) ? "AMLI Arc" : (round.barName || "Real Bar");
}

function describeRoundReason(round) {
  const loser = round.winner === "Vanessa" ? "Carl" : "Vanessa";
  const descriptions = {
    "Sank the 8-ball early": `${loser} sank the 8-ball early`,
    "8-ball in the wrong pocket": `${loser} put the 8-ball in the wrong pocket`,
    "Sunk the cue ball": `${loser} sunk the cue ball`
  };
  return descriptions[round.reason] || round.reason;
}

function seriesCard(series, isHistory = false) {
  const score = scores(series);
  const winner = winnerOf(series);
  const rounds = [...series.rounds].reverse();
  return `<article class="series-card ${winner ? "completed" : ""}" id="series-${series.id}">
    <div class="series-head">
      <div><p class="eyebrow">${winner ? `${winner} won the series` : `First to ${series.target}`}</p><h3>${escapeHtml(series.name || "Untitled series")}</h3><p class="series-meta">Started ${formatDate(series.createdAt)}</p></div>
      <button class="delete-round" data-delete-series="${series.id}" aria-label="Move series to trash">🗑️</button>
    </div>
    <div class="scoreboard">
      <div class="player"><span class="player-name">Vanessa</span><span class="score">${score.Vanessa}</span></div>
      <span class="divider">◆</span>
      <div class="player"><span class="player-name">Carl</span><span class="score">${score.Carl}</span></div>
    </div>
    <p class="challenge"><span>Prize</span>${escapeHtml(series.challenge || "To be decided…")}</p>
    ${!winner && !isHistory ? `<button class="primary-button" data-add-round="${series.id}">Add round</button>` : ""}
    ${winner && series.rounds.length ? `<button class="secondary-button" data-undo="${series.id}">Undo last round</button>` : ""}
    ${rounds.length ? `<div class="rounds">${rounds.map((round, index) => roundRow(round, series.rounds.length - index, series.id)).join("")}</div>` : `<p class="helper">No rounds yet.</p>`}
  </article>`;
}

function roundRow(round, number, seriesId) {
  const location = round.location === "🍺 Real Bar"
    ? (round.barName || "Real Bar")
    : isAmliLocation(round.location) ? "AMLI Arc" : round.location.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return `<div class="round-row">
    <span class="round-number">${number}</span>
    <div class="round-copy"><div class="round-win-line"><strong>${escapeHtml(round.winner)} won</strong><time>${formatPlayedDate(round)}</time></div><p class="round-detail">${escapeHtml(describeRoundReason(round))}</p><p class="round-location">📍 ${escapeHtml(location)}</p>${round.note ? `<p class="round-note">✦ ${escapeHtml(round.note)}</p>` : ""}</div>
  </div>`;
}

function poolTableGame(series) {
  const score = scores(series);
  const rounds = [...series.rounds].reverse();
  const raceBalls = series.rounds.length
    ? series.rounds.map((round, index) => `<span class="race-winner-ball ${round.winner.toLowerCase()}" title="Round ${index + 1}: ${round.winner} won"><b>${round.winner.charAt(0)}</b><small>${index + 1}</small></span>`).join("")
    : `<span class="race-empty">No rounds played yet</span>`;
  return `<div class="game-layout">
    <article class="race-track-score">
      <div class="race-track-head"><div><h3>${escapeHtml(series.name || "Untitled series")}</h3><p class="series-meta">Started ${formatDate(series.createdAt)}</p></div></div>
      <div class="race-ball-log" aria-label="Round winners in order">${raceBalls}</div>
      <div class="race-track-scoreboard"><div><b>${score.Vanessa}</b><span>Vanessa</span></div><strong>FIRST TO<br>${series.target}</strong><div><b>${score.Carl}</b><span>Carl</span></div></div>
      <div class="race-track-foot"><p><span>Prize</span>${escapeHtml(series.challenge || "To be decided…")}</p><div class="race-track-actions"><button class="primary-button game-add-round" data-add-round="${series.id}">+ Add round</button><button class="edit-series-button compact" data-edit-menu="${series.id}" aria-label="Edit series or a past round"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l11-11-4-4L4 16v4Zm9.5-13.5 4 4M14.5 5.5l2-2a1.4 1.4 0 0 1 2 0l2 2a1.4 1.4 0 0 1 0 2l-2 2"/></svg></button></div></div>
    </article>
    <div class="game-round-list">${rounds.length ? rounds.map((round, index) => roundRow(round, series.rounds.length - index, series.id)).join("") : `<p class="helper">No rounds yet.</p>`}</div>
  </div>`;
}

function renderPlay() {
  const active = state.series.filter(s => !s.deleted && !winnerOf(s));
  const live = state.series.filter(s => !s.deleted);
  const rounds = live.flatMap(s => s.rounds);
  const finished = live.filter(winnerOf);
  const stat = name => ({
    series: finished.filter(s => winnerOf(s) === name).length,
    rounds: rounds.filter(r => r.winner === name).length,
    percent: rounds.length ? Math.round(rounds.filter(r => r.winner === name).length / rounds.length * 100) : 0
  });
  const vanessa = stat("Vanessa");
  const carl = stat("Carl");
  const primary = active[0];
  $("#play-view").innerHTML = `
    <section class="matchup-card">
      ${primary ? `<div class="home-series-title"><span>Current series</span><strong>${escapeHtml(primary.name || "Untitled series")}</strong></div>` : ""}
      <div class="pixel-sparkles" aria-hidden="true">✦ · ✧ · ✦</div>
      <div class="matchup-grid">
        <div class="avatar-player">
          <div class="pixel-avatar vanessa-avatar"><img src="/assets/avatars/vanessa-candidate-smile-transparent.png?v=2" alt="8-bit game portrait of Vanessa" /></div>
          <strong>VANESSA</strong>
        </div>
        <div class="versus-stats">
          <div class="stat-line"><b>${vanessa.series}</b><span>SERIES</span><b>${carl.series}</b></div>
          <div class="stat-line"><b>${vanessa.rounds}</b><span>ROUNDS</span><b>${carl.rounds}</b></div>
          <div class="stat-line"><b>${vanessa.percent}%</b><span>WIN RATE</span><b>${carl.percent}%</b></div>
        </div>
        <div class="avatar-player">
          <div class="pixel-avatar carl-avatar"><img src="/assets/avatars/carl-game.png" alt="8-bit game portrait of Carl" /></div>
          <strong>CARL</strong>
        </div>
      </div>
      ${primary
        ? `<button class="arcade-button" data-resume="${primary.id}"><span class="play-icon" aria-hidden="true"></span> RESUME SERIES</button>`
        : `<button class="arcade-button" data-new-series><span>＋</span> START A NEW SERIES</button>`}
    </section>
    ${active.length > 1 ? `<section class="other-series"><p class="section-label">OTHER SERIES IN PLAY</p>${active.slice(1).map((s, index) => `<button class="series-strip" data-resume="${s.id}"><span class="series-strip-name"><i class="stripe-ball ${index % 2 ? "cyan" : "coral"}" aria-hidden="true"></i>${escapeHtml(s.name || "Untitled series")}</span><b><span>${scores(s).Vanessa}–${scores(s).Carl}</span><svg class="series-arrow" viewBox="0 0 10 18" aria-hidden="true"><path d="M2 2l6 7-6 7"/></svg></b></button>`).join("")}</section>` : ""}
    ${primary ? `<button class="secondary-arcade-button start-another-home" data-new-series><span>＋</span> START ANOTHER SERIES</button>` : ""}`;
}

function renderGame() {
  const active = state.series.filter(s => !s.deleted && !winnerOf(s));
  const selected = active.find(s => s.id === openSeriesId) || active[0];
  if (selected) openSeriesId = selected.id;
  $("#game-view").innerHTML = selected
    ? `${active.length > 1 ? `<div class="game-picker">${active.map((s, index) => `<button class="series-rail ${s.id === selected.id ? "selected" : ""}" data-open-game="${s.id}"><span class="stripe-ball ${index % 2 ? "cyan" : "coral"}" aria-hidden="true"></span><span class="rail-copy"><strong>${escapeHtml(s.name || "Untitled series")}</strong><small>First to ${s.target}</small></span><b>${scores(s).Vanessa}–${scores(s).Carl}</b></button>`).join("")}</div>` : ""}${poolTableGame(selected)}`
    : `<div class="empty-card"><div class="empty-ball">8</div><h2>No active series</h2><p class="helper">Start one when you're ready to break.</p><button class="primary-button" data-new-series>Start a series</button></div>`;
}

function renderHistory() {
  const complete = state.series
    .filter(s => !s.deleted && winnerOf(s))
    .sort((a, b) => new Date(b.rounds[b.rounds.length - 1]?.playedOn || b.createdAt) - new Date(a.rounds[a.rounds.length - 1]?.playedOn || a.createdAt));
  const ledgerRow = series => {
    const score = scores(series);
    const winner = winnerOf(series);
    const rounds = [...series.rounds].reverse();
    const finishedOn = rounds[0];
    const avatar = winner === "Vanessa" ? "vanessa-candidate-smile-transparent.png" : "carl-game.png";
    return `<article class="history-ledger-row" id="series-${series.id}">
      <button class="history-ledger-summary" data-toggle-history="${series.id}" aria-expanded="false">
        <span class="history-winner-avatar ${winner.toLowerCase()}"><img src="/assets/avatars/${avatar}?v=2" alt=""></span>
        <span class="history-ledger-copy"><small>${winner} won</small><strong>${escapeHtml(series.name || series.challenge || "Untitled series")}</strong><span><time>${formatPlayedDate(finishedOn)}</time><i>Prize · ${escapeHtml(series.challenge || "To be decided…")}</i></span></span>
        <span class="history-ledger-result"><b>${score.Vanessa}–${score.Carl}</b><i aria-hidden="true">›</i></span>
      </button>
      <div class="history-ledger-details hidden" data-history-details="${series.id}">
        <div class="history-final-score">
          <div class="history-final-player"><b>${score.Vanessa}</b><span>Vanessa</span></div>
          <div class="history-final-center"><small>Final score</small><i aria-hidden="true">◆</i></div>
          <div class="history-final-player"><b>${score.Carl}</b><span>Carl</span></div>
        </div>
        <div class="history-actions"><button class="edit-series-button" data-edit-menu="${series.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l11-11-4-4L4 16v4Zm9.5-13.5 4 4M14.5 5.5l2-2a1.4 1.4 0 0 1 2 0l2 2a1.4 1.4 0 0 1 0 2l-2 2"/></svg><span>Edit</span></button><button class="secondary-button history-undo" data-undo="${series.id}">Undo last round</button></div>
        <div class="history-rounds">${rounds.map((round, index) => roundRow(round, series.rounds.length - index, series.id)).join("")}</div>
        <button class="history-trash" data-delete-series="${series.id}">Move series to trash</button>
      </div>
    </article>`;
  };
  $("#history-view").innerHTML = complete.length ? `<section class="history-ledger"><div class="history-ledger-head count-only"><span>${complete.length} completed</span></div>${complete.map(ledgerRow).join("")}</section>` : `<div class="empty-card"><div class="empty-ball">8</div><h2>No finished series yet</h2><p class="helper">Your legendary victories will live here.</p></div>`;
}

function renderStats() {
  const live = state.series.filter(s => !s.deleted);
  const allRounds = live.flatMap(s => s.rounds);
  const finished = live.filter(winnerOf);
  const reasonLabels = {
    "Fair win": "Fair win",
    "Sank the 8-ball early": "Opponent sank 8-ball early",
    "8-ball in the wrong pocket": "Opponent hit wrong pocket",
    "Sunk the cue ball": "Opponent sank cue ball",
    "Other": "Other"
  };
  const favoriteReason = name => {
    const counts = allRounds.filter(r => r.winner === name).reduce((result, round) => {
      const reason = round.reason === "Other" ? "Other" : round.reason;
      result[reason] = (result[reason] || 0) + 1;
      return result;
    }, {});
    const favorite = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return favorite ? `${reasonLabels[favorite[0]] || favorite[0]} · ${favorite[1]}` : "No wins yet";
  };
  const bestRunRecord = name => {
    const manualRecords = state.runRecords.filter(record => record.player === name).map(record => ({ id: record.id, count: Number(record.count) || 0, playedOn: record.playedOn, createdAt: record.createdAt }));
    return manualRecords.filter(record => record.count > 0).sort((a, b) => b.count - a.count || String(a.playedOn).localeCompare(String(b.playedOn)))[0] || null;
  };
  const previousRunRecords = name => state.runRecords
    .filter(record => record.player === name && Number(record.count) > 0)
    .sort((a, b) => String(b.createdAt || b.playedOn).localeCompare(String(a.createdAt || a.playedOn)));
  const values = Object.fromEntries(["Vanessa", "Carl"].map(name => [name, {
    series: finished.filter(s => winnerOf(s) === name).length,
    rounds: allRounds.filter(r => r.winner === name).length,
    percent: allRounds.length ? Math.round(allRounds.filter(r => r.winner === name).length / allRounds.length * 100) : 0,
    favorite: favoriteReason(name),
    bestRunRecord: bestRunRecord(name)
  }]));
  const reasons = Object.keys(reasonLabels).map(reason => ({
    label: reasonLabels[reason],
    count: allRounds.filter(round => (round.reason === "Other" ? "Other" : round.reason) === reason).length
  })).filter(item => item.count);
  const maxReason = Math.max(1, ...reasons.map(item => item.count));
  const venueName = round => displayLocation(round);
  const venueBreakdown = rounds => Object.entries(rounds.reduce((result, round) => {
    const venue = venueName(round); result[venue] = (result[venue] || 0) + 1; return result;
  }, {})).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const locations = venueBreakdown(allRounds);
  const maxLocation = Math.max(1, ...locations.map(item => item.count));
  const topLocationCount = Math.max(0, ...locations.map(item => item.count));
  const favoritePlace = topLocationCount === 0 ? "No rounds yet" : locations.filter(item => item.count === topLocationCount).map(item => item.label).join(" & ");
  const playerShortcut = name => `<button class="overview-player ${name.toLowerCase()}" data-scroll-player="${name.toLowerCase()}" aria-label="View ${name}'s detailed stats"><span class="stats-avatar"><img src="/assets/avatars/${name === "Vanessa" ? "vanessa-candidate-smile-transparent.png" : "carl-game.png"}?v=2" alt="${name}"></span><strong>${name}</strong><b>${values[name].percent}%</b><span>Round win rate</span></button>`;
  const chart = (title, items, max) => `<section class="group-stat-card"><p class="group-stat-kicker">${title}</p>${items.length ? items.map(item => `<div class="chart-row"><div><span>${escapeHtml(item.label)}</span><b>${item.count}</b></div><div class="chart-track"><i style="width:${Math.round(item.count / max * 100)}%"></i></div></div>`).join("") : `<p class="helper">Add a few rounds to unlock this chart.</p>`}</section>`;
  const venueChart = (title, items, max) => `<section class="group-stat-card venue-chart"><p class="group-stat-kicker">${title}</p>${items.length ? items.map((item, index) => `<div class="chart-row ${index >= 5 ? "venue-extra hidden" : ""}"><div><span>#${index + 1} ${escapeHtml(item.label)}</span><b>${item.count}</b></div><div class="chart-track"><i style="width:${Math.round(item.count / max * 100)}%"></i></div></div>`).join("") : `<p class="helper">Add a few rounds to unlock this chart.</p>`}${items.length > 5 ? `<button class="venue-more" data-expand-venues data-more-count="${items.length - 5}">Show ${items.length - 5} more</button>` : ""}</section>`;
  const donutChart = (title, items) => {
    const total = items.reduce((sum, item) => sum + item.count, 0);
    const colors = ["#ff6b4f", "#63edf0", "#e9bd58", "#2bb8b5", "#d88dff"];
    let cursor = 0;
    const stops = total ? items.map((item, index) => { const start = cursor; cursor += item.count / total * 100; return `${colors[index % colors.length]} ${start}% ${cursor}%`; }).join(",") : "#17333a 0 100%";
    return `<section class="group-stat-card"><p class="group-stat-kicker">${title}</p><div class="donut-layout"><div class="stats-donut" style="background:conic-gradient(${stops})"><span><b>${total}</b> rounds</span></div><div class="donut-legend">${items.length ? items.map((item, index) => `<div><i style="background:${colors[index % colors.length]}"></i><span>${escapeHtml(item.label)}</span><b>${item.count}</b></div>`).join("") : `<p class="helper">Add a few rounds to unlock this chart.</p>`}</div></div></section>`;
  };
  const playerDetail = name => {
    const playerRounds = allRounds.filter(round => round.winner === name);
    const wonSeries = finished
      .filter(series => winnerOf(series) === name)
      .sort((a, b) => new Date(b.rounds[b.rounds.length - 1]?.playedOn || b.createdAt) - new Date(a.rounds[a.rounds.length - 1]?.playedOn || a.createdAt));
    const playerReasons = Object.keys(reasonLabels).map(reason => ({ label: reasonLabels[reason], count: playerRounds.filter(round => (round.reason === "Other" ? "Other" : round.reason) === reason).length })).filter(item => item.count);
    const playerLocations = venueBreakdown(playerRounds);
    const runRecord = values[name].bestRunRecord;
    const runHistory = previousRunRecords(name);
    const runHistoryMarkup = runHistory.length ? `<div class="best-run-history"><span class="best-run-history-label">Previous best runs</span>${runHistory.map(record => `<div class="best-run-history-row"><span class="best-run-history-count">${Number(record.count)} balls</span><time>${formatDate(record.createdAt || record.playedOn)}</time></div>`).join("")}</div>` : "";
    const seriesWonMarkup = `<section class="series-won-section"><p class="group-stat-kicker">Series won</p>${wonSeries.length ? `<div class="series-won-list">${wonSeries.map((series, index) => { const lastRound = series.rounds[series.rounds.length - 1]; return `<button class="series-win-card ${index >= 5 ? "series-win-extra hidden" : ""}" data-history-series="${series.id}"><h4>${escapeHtml(series.name || series.challenge || "Craft Series")}</h4><time>${formatPlayedDate(lastRound)}</time><span aria-hidden="true">›</span></button>`; }).join("")}</div>${wonSeries.length > 5 ? `<button class="venue-more" data-expand-series data-more-count="${wonSeries.length - 5}">Show ${wonSeries.length - 5} more</button>` : ""}` : `<p class="helper">No completed series wins yet.</p>`}</section>`;
    return `<section class="player-breakdown ${name.toLowerCase()}" id="${name.toLowerCase()}-stats">
      <div class="player-breakdown-head"><span class="stats-avatar"><img src="/assets/avatars/${name === "Vanessa" ? "vanessa-candidate-smile-transparent.png" : "carl-game.png"}?v=2" alt=""></span><div><span>Player stats</span><h3>${name}</h3></div><button class="run-record" data-add-run="${name}" title="Add a new best run"><span class="run-record-icon" aria-hidden="true"></span><small>+ Add run</small></button></div>
      <div class="group-summary"><div><b>${values[name].rounds}</b><span>Total rounds won</span></div><div><b>${values[name].series}</b><span>Series wins</span></div><div><b>${values[name].percent}%</b><span>Round win rate</span></div><div class="best-run-stat"><button class="best-run-edit" data-edit-best-run="${runRecord?.id || ""}" data-edit-best-player="${name}" data-edit-best-count="${runRecord?.count || ""}" data-edit-best-date="${runRecord?.playedOn || ""}" aria-label="Edit ${name}'s best run"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l11-11-4-4L4 16v4Zm9.5-13.5 4 4M14.5 5.5l2-2a1.4 1.4 0 0 1 2 0l2 2a1.4 1.4 0 0 1 0 2l-2 2"/></svg></button><div class="best-run-ball-wrap"><span aria-hidden="true">✦</span><div class="best-run-ball"><b>${runRecord?.count || "–"}</b></div><span aria-hidden="true">✦</span></div><div class="best-run-copy"><strong>BEST RUN</strong><span>${runRecord ? formatPlayedDate(runRecord) : "No run recorded yet"}</span></div></div></div>${runHistoryMarkup}
      ${donutChart("How wins happened", playerReasons)}
      ${venueChart("Where wins happened", playerLocations, Math.max(1, ...playerLocations.map(item => item.count)))}
      ${seriesWonMarkup}
    </section>`;
  };
  $("#stats-view").innerHTML = `<section class="stats-overview"><div class="overview-players">${playerShortcut("Vanessa")}<span class="overview-vs">VS</span>${playerShortcut("Carl")}</div><p>Tap a player to jump to their stats</p></section>
    <p class="stats-section-title">★ TOGETHER AT THE TABLE ★</p>
    <div class="group-summary together-summary"><div><b>${allRounds.length}</b><span>Total rounds</span></div><div><b>${finished.length}</b><span>Series completed</span></div></div>
    <div class="favorite-place"><span>📍 Most-played table</span><strong>${escapeHtml(favoritePlace)}</strong><small>${topLocationCount || 0} round${topLocationCount === 1 ? "" : "s"}</small></div>
    ${donutChart("How rounds were won", reasons)}
    ${venueChart("Favorite tables", locations, maxLocation)}
    ${playerDetail("Vanessa")}${playerDetail("Carl")}
    ${DEMO_MODE ? `<section class="demo-celebration-controls"><p class="group-stat-kicker">Presentation controls</p><h3>Show a celebration</h3><p>These play the same final animations as a real win, without changing the demo scorecard.</p><div class="demo-celebration-grid"><button data-demo-round-animation="0" data-demo-winner="Vanessa">Round win<br><small>Pocket drop</small></button><button data-demo-round-animation="1" data-demo-winner="Carl">Round win<br><small>Score ball</small></button><button data-demo-round-animation="2" data-demo-winner="Vanessa">Round win<br><small>Cue celebration</small></button><button data-demo-series-animation="0" data-demo-winner="Vanessa">Series win<br><small>Neon champion</small></button><button data-demo-series-animation="1" data-demo-winner="Carl">Series win<br><small>Victory cheers</small></button><button data-demo-series-animation="2" data-demo-winner="Vanessa">Series win<br><small>Table light</small></button></div></section>` : ""}`;
}

function openSeriesEditor(series) {
  if (!series) return;
  const form = $("#series-form");
  form.elements.seriesId.value = series.id;
  form.elements.name.value = series.name;
  form.elements.challenge.value = series.challenge;
  form.elements.target.value = series.target;
  $("#series-dialog-kicker").textContent = "Make a change";
  $("#series-dialog-title").textContent = "Edit series";
  $("#series-submit-button").textContent = "Save changes";
  $("#series-dialog").showModal();
}

function openRoundEditor(series, round) {
  if (!series || !round) return;
  const form = $("#round-form");
  form.reset();
  form.elements.seriesId.value = series.id;
  form.elements.roundId.value = round.id;
  form.elements.winner.value = round.winner;
  const presets = ["Fair win", "Sank the 8-ball early", "8-ball in the wrong pocket", "Sunk the cue ball"];
  if (presets.includes(round.reason)) {
    form.elements.reason.value = round.reason;
    $("#other-reason-wrap").classList.add("hidden");
  } else {
    form.elements.reason.value = "Other";
    form.elements.otherReason.value = round.reason;
    $("#other-reason-wrap").classList.remove("hidden");
  }
  form.elements.location.value = isAmliLocation(round.location) ? "💗 AMLI Arc" : round.location;
  form.elements.barName.value = round.barName || "";
  form.elements.playedOn.value = round.playedOn || localDateValue(round.createdAt);
  form.elements.note.value = round.note || "";
  $("#bar-name-wrap").classList.toggle("hidden", round.location !== "🍺 Real Bar");
  showRoundEdit();
  $("#round-dialog").showModal();
}

function openEditMenu(series, chooseRound = false) {
  if (!series) return;
  const dialog = $("#edit-menu-dialog");
  const content = $("#edit-menu-content");
  if (!chooseRound) {
    const ballIcon = `<span class="edit-menu-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="9" r="2.2"/><circle cx="12" cy="15" r="2.2"/></svg></span>`;
    const clockIcon = `<span class="edit-menu-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5H7"/></svg></span>`;
    const trashIcon = `<span class="edit-menu-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 10v7M14 10v7"/></svg></span>`;
    content.innerHTML = `<h2>What do you want to edit?</h2><div class="edit-menu-options"><button class="edit-menu-choice" data-menu-series>${ballIcon}<div><strong>Series info</strong><small>Name, prize, or target score</small></div><b>›</b></button><button class="edit-menu-choice" data-menu-rounds>${clockIcon}<div><strong>A past round</strong><small>Winner, reason, place, date, or note</small></div><b>›</b></button><button class="edit-menu-choice danger" data-menu-delete>${trashIcon}<div><strong>Delete series</strong><small>Move this series to the trash</small></div><b>›</b></button></div>`;
    $('[data-menu-series]', content).onclick = () => { dialog.close(); openSeriesEditor(series); };
    $('[data-menu-rounds]', content).onclick = () => openEditMenu(series, true);
    $('[data-menu-delete]', content).onclick = () => {
      content.innerHTML = `<div class="delete-series-confirmation"><button class="edit-menu-back" data-delete-cancel>‹ Back</button><h2>Delete ${escapeHtml(series.name || "this series")}?</h2><div class="form-actions"><button type="button" class="secondary-button" data-delete-cancel>Cancel</button><button type="button" class="danger-button" data-delete-confirm>Delete series</button></div></div>`;
      $$('[data-delete-cancel]', content).forEach(button => button.onclick = () => openEditMenu(series, false));
      $('[data-delete-confirm]', content).onclick = () => {
        series.deleted = true;
        dialog.close();
        saveState();
        switchView("game");
        toast("Series moved to trash");
      };
    };
  } else {
    const rounds = [...series.rounds].reverse();
    content.innerHTML = `<button class="edit-menu-back" data-menu-back>‹ Back</button><p class="eyebrow">Edit a round</p><h2>Which round?</h2><div class="edit-round-picker">${rounds.length ? rounds.map((round, index) => `<button class="edit-menu-choice" data-menu-round="${round.id}"><span class="round-number">${series.rounds.length - index}</span><div><strong>${escapeHtml(round.winner)} won</strong><small>${formatPlayedDate(round)} · ${escapeHtml(displayLocation(round))}</small></div><b>›</b></button>`).join("") : `<p class="helper">No rounds to edit yet.</p>`}</div>`;
    $('[data-menu-back]', content).onclick = () => openEditMenu(series, false);
    $$('[data-menu-round]', content).forEach(button => button.onclick = () => {
      const round = series.rounds.find(item => item.id === button.dataset.menuRound);
      dialog.close(); openRoundEditor(series, round);
    });
  }
  if (!dialog.open) dialog.showModal();
}

function render() { renderPlay(); renderGame(); renderHistory(); renderStats(); bindDynamicEvents(); }

function bindDynamicEvents() {
  $$('[data-demo-round-animation]').forEach(button => button.onclick = () => {
    playRoundWinCelebration(Number(button.dataset.demoRoundAnimation), button.dataset.demoWinner);
  });
  $$('[data-demo-series-animation]').forEach(button => button.onclick = () => {
    const selected = state.series.find(series => series.id === "preview-active") || state.series.find(series => !series.deleted && !winnerOf(series));
    if (!selected) return;
    const winner = button.dataset.demoWinner;
    const exhibitionSeries = {
      ...selected,
      rounds: [...selected.rounds, {
        id: `presentation-celebration-${Date.now()}`,
        winner,
        reason: "Fair win",
        location: "💗 AMLI Arc",
        playedOn: localDateValue(),
        createdAt: new Date().toISOString(),
        barName: "", note: "", vanessaRun: 0, carlRun: 0
      }]
    };
    playSeriesWinCelebration(Number(button.dataset.demoSeriesAnimation), exhibitionSeries);
  });
  $$('[data-expand-series]').forEach(button => button.onclick = () => {
    const extras = $$('.series-win-extra', button.closest('.series-won-section'));
    const expanding = extras.some(card => card.classList.contains('hidden'));
    extras.forEach(card => card.classList.toggle('hidden', !expanding));
    button.textContent = expanding ? 'Show less' : `Show ${button.dataset.moreCount} more`;
  });
  $$('[data-history-series]').forEach(button => button.onclick = () => {
    switchView('history');
    requestAnimationFrame(() => {
      const row = $(`#series-${button.dataset.historySeries}`);
      row?.querySelector('[data-toggle-history]')?.click();
      row?.scrollIntoView({ behavior:'smooth', block:'start' });
    });
  });
  $$('[data-toggle-history]').forEach(button => button.onclick = () => {
    const details = $(`[data-history-details="${button.dataset.toggleHistory}"]`);
    const opening = details.classList.contains('hidden');
    details.classList.toggle('hidden', !opening);
    button.classList.toggle('open', opening);
    button.setAttribute('aria-expanded', String(opening));
  });
  $$('[data-expand-venues]').forEach(button => button.onclick = () => {
    const extras = $$('.venue-extra', button.closest('.venue-chart'));
    const expanding = extras.some(row => row.classList.contains('hidden'));
    extras.forEach(row => row.classList.toggle('hidden', !expanding));
    button.textContent = expanding ? 'Show less' : `Show ${button.dataset.moreCount} more`;
  });
  $$('[data-add-run]').forEach(button => button.onclick = () => {
    const form = $("#run-form"); editingRunId = null; form.reset(); form.elements.player.value = button.dataset.addRun; form.elements.playedOn.value = localDateValue(); $("#run-choice-wrap").classList.add("hidden");
    $('[data-delete-run]').classList.add("hidden");
    $("#run-dialog-title").textContent = `${button.dataset.addRun}'s best run`; $("#run-form").querySelector("button.primary-button").textContent = "Save best run"; $("#run-dialog").showModal();
  });
  $$('.best-run-edit').forEach(button => button.onclick = () => {
    const form = $("#run-form");
    const records = state.runRecords.filter(item => item.player === button.dataset.editBestPlayer && Number(item.count) > 0).sort((a, b) => String(b.createdAt || b.playedOn).localeCompare(String(a.createdAt || a.playedOn)));
    const choiceWrap = $("#run-choice-wrap");
    const choice = form.elements.runId;
    const choiceTrigger = $('[data-run-choice-toggle]');
    const choiceList = $('[data-run-choice-list]');
    choice.innerHTML = records.map(item => `<option value="${item.id}">${Number(item.count)} balls · ${formatDate(item.playedOn || item.createdAt)}</option>`).join("");
    choiceList.innerHTML = records.map(item => `<button type="button" data-run-choice="${item.id}">${Number(item.count)} balls <time>${formatDate(item.playedOn || item.createdAt)}</time></button>`).join("");
    choiceWrap.classList.toggle("hidden", records.length < 2);
    choiceList.classList.add("hidden");
    choiceTrigger.setAttribute("aria-expanded", "false");
    const matchingRecord = records.find(item => String(item.count) === String(button.dataset.editBestCount) && String(item.playedOn || "") === String(button.dataset.editBestDate || ""));
    const highestRecord = [...records].sort((a, b) => Number(b.count) - Number(a.count) || String(b.createdAt || b.playedOn).localeCompare(String(a.createdAt || a.playedOn)))[0];
    const selectedId = records.some(item => item.id === button.dataset.editBestRun) ? button.dataset.editBestRun : matchingRecord?.id || highestRecord?.id;
    const selectRun = id => {
      const record = records.find(item => item.id === id);
      if (!record) return;
      choice.value = record.id;
      editingRunId = record.id;
      form.elements.count.value = record.count;
      form.elements.playedOn.value = record.playedOn || localDateValue(record.createdAt);
      choiceTrigger.querySelector("span").textContent = `${Number(record.count)} balls · ${formatDate(record.playedOn || record.createdAt)}`;
      $$('[data-run-choice]', choiceList).forEach(option => option.classList.toggle("selected", option.dataset.runChoice === record.id));
    };
    form.reset();
    form.elements.player.value = button.dataset.editBestPlayer;
    if (selectedId) selectRun(selectedId);
    else { form.elements.count.value = button.dataset.editBestCount || ""; form.elements.playedOn.value = button.dataset.editBestDate || localDateValue(); }
    $('[data-delete-run]').classList.toggle("hidden", !editingRunId);
    choiceTrigger.onclick = () => {
      const opening = choiceList.classList.contains("hidden");
      choiceList.classList.toggle("hidden", !opening);
      choiceTrigger.setAttribute("aria-expanded", String(opening));
    };
    $$('[data-run-choice]', choiceList).forEach(option => option.onclick = () => {
      selectRun(option.dataset.runChoice);
      choiceList.classList.add("hidden");
      choiceTrigger.setAttribute("aria-expanded", "false");
    });
    $("#run-dialog-title").textContent = `Edit ${button.dataset.editBestPlayer}'s best run`;
    $("#run-form").querySelector("button.primary-button").textContent = "Save changes";
    $("#run-dialog").showModal();
  });
  const runChoice = $("#run-form")?.elements.runId;
  if (runChoice) runChoice.onchange = () => {
    const record = state.runRecords.find(item => item.id === runChoice.value);
    if (!record) return;
    editingRunId = record.id;
    $("#run-form").elements.count.value = record.count;
    $("#run-form").elements.playedOn.value = record.playedOn || localDateValue(record.createdAt);
  };
  if ($('[data-delete-run]')) $('[data-delete-run]').onclick = () => {
    if (!editingRunId || !confirm("Are you sure you want to delete this run? This cannot be undone.")) return;
    state.runRecords = state.runRecords.filter(record => record.id !== editingRunId);
    editingRunId = null;
    saveState();
    $("#run-dialog").close();
    toast("Run deleted");
  };
  $$('[data-scroll-player]').forEach(button => button.onclick = () => {
    $(`#${button.dataset.scrollPlayer}-stats`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $$('[data-new-series]').forEach(button => button.onclick = () => {
    $("#series-form").reset();
    $("#series-form [name=seriesId]").value = "";
    $("#series-dialog-kicker").textContent = "Rack 'em up";
    $("#series-dialog-title").textContent = "New series";
    $("#series-submit-button").textContent = "Start series";
    $("#series-dialog").showModal();
  });
  $$('[data-edit-series]').forEach(button => button.onclick = () => {
    const series = state.series.find(s => s.id === button.dataset.editSeries);
    openSeriesEditor(series);
  });
  $$('[data-edit-menu]').forEach(button => button.onclick = () => openEditMenu(state.series.find(series => series.id === button.dataset.editMenu)));
  $$('[data-add-round]').forEach(button => button.onclick = () => {
    const form = $("#round-form");
    form.reset();
    form.classList.remove("editing-round");
    form.elements.seriesId.value = button.dataset.addRound;
    form.elements.roundId.value = "";
    form.elements.playedOn.value = localDateValue();
    $("#other-reason-wrap").classList.add("hidden");
    $("#bar-name-wrap").classList.add("hidden");
    showRoundStep(1);
    $("#round-dialog").showModal();
  });
  $$('[data-edit-round]').forEach(button => button.onclick = () => {
    const series = state.series.find(s => s.id === button.dataset.series);
    const round = series?.rounds.find(r => r.id === button.dataset.editRound);
    openRoundEditor(series, round);
  });
  $$('[data-resume]').forEach(button => button.onclick = () => {
    openSeriesId = button.dataset.resume;
    render();
    switchView("game");
  });
  $$('[data-open-game]').forEach(button => button.onclick = () => {
    openSeriesId = button.dataset.openGame;
    render(); switchView("game");
  });
  $$('[data-undo]').forEach(button => button.onclick = () => {
    const series = state.series.find(s => s.id === button.dataset.undo);
    if (!series?.rounds.length) return;
    if (!confirm("Are you sure you want to undo the last round? This will change the score.")) return;
    series.rounds.pop(); saveState(); toast("Last round undone");
  });
  $$('[data-delete-round]').forEach(button => button.onclick = () => {
    if (!confirm("Are you sure you want to delete this round? This cannot be undone.")) return;
    const series = state.series.find(s => s.id === button.dataset.series);
    series.rounds = series.rounds.filter(r => r.id !== button.dataset.deleteRound);
    saveState(); toast("Round deleted");
  });
  $$('[data-delete-series]').forEach(button => button.onclick = () => {
    if (!confirm("Are you sure you want to move this series to the trash?")) return;
    const series = state.series.find(s => s.id === button.dataset.deleteSeries);
    series.deleted = true; saveState(); toast("Series moved to trash");
  });
}

function escapeHtml(text = "") {
  const div = document.createElement("div"); div.textContent = text; return div.innerHTML;
}

function toast(message) {
  const el = $("#toast"); el.textContent = message; el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2200);
}

function updateAccessUI() {
  const button = $("#access-button");
  const status = $("#access-status");
  if (!button || !status) return;
  const editing = isEditor() || PREVIEW_MODE;
  status.classList.toggle("hidden", editing);
  button.setAttribute("aria-label", editing ? "This device can edit" : "Unlock editing");
}

function openAccessDialog() {
  const dialog = $("#access-dialog");
  $("#access-error").classList.add("hidden");
  $("#access-form").reset();
  if (!dialog.open) dialog.showModal();
}

document.addEventListener("click", event => {
  if (!event.target.closest("#access-button")) return;
  if (isEditor() || PREVIEW_MODE) toast(DEMO_MODE ? "Presentation demo is ready to play with." : (PREVIEW_MODE ? "Preview mode is ready to play with." : "This device is unlocked for editing."));
  else openAccessDialog();
});

$('[data-view-only]').onclick = () => $("#access-dialog").close();

$("#access-form").onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = $("#access-error");
  error.classList.add("hidden");
  const submit = form.querySelector("button.primary-button");
  submit.disabled = true;
  submit.textContent = "Unlocking…";
  try {
    const localBeforeUnlock = normalizeState(state);
    const response = await fetch(`${SUPABASE_URL}/functions/v1/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
      body: JSON.stringify({ passcode: form.elements.passcode.value })
    });
    const payload = await response.json();
    if (!response.ok || !payload.token) throw new Error(payload.error || "Couldn't unlock editing.");
    localStorage.setItem(EDITOR_TOKEN_KEY, payload.token);
    updateAccessUI();
    $("#access-dialog").close();
    await refreshSharedState({ quiet: true });
    if (!remoteHasScorebookData) {
      state = localBeforeUnlock;
      const bringLocalData = hasScorebookContent(localBeforeUnlock) && confirm("This shared scorebook is brand new. Bring this device's current scores into it? Choose Cancel to start it fresh.");
      if (!bringLocalData) {
        state = emptyState();
      }
      rememberLocalState();
      render();
      await pushSharedState();
    }
    toast("Editing unlocked on this device.");
  } catch (error) {
    error && console.warn(error);
    $("#access-error").textContent = error.message || "That passcode doesn't match.";
    $("#access-error").classList.remove("hidden");
  } finally {
    submit.disabled = false;
    submit.textContent = "Unlock editing";
  }
};

const editorOnlyControls = "[data-new-series], [data-add-round], [data-edit-series], [data-edit-menu], [data-undo], [data-delete-series], [data-delete-round], [data-add-run], [data-edit-best-run], [data-menu-series], [data-menu-rounds], [data-menu-delete], [data-menu-round], [data-delete-run], [data-delete-edit-round]";
document.addEventListener("click", event => {
  const control = event.target.closest(editorOnlyControls);
  if (!control || requireEditor()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

["series-form", "round-form", "run-form"].forEach(id => {
  $("#" + id).addEventListener("submit", event => {
    if (requireEditor()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
});

function seriesIntroArt(index) {
  if (index === 0) return `<svg class="intro-svg intro-chalk" viewBox="0 0 360 235" role="img" aria-label="A pool cue being rubbed with chalk"><g class="intro-chalk-cue"><path d="M28 190 L119 139" stroke="#f4d8a1" stroke-width="20" stroke-linecap="round"/><path d="M28 190 L119 139" stroke="#bd7640" stroke-width="12" stroke-linecap="round"/><path d="M119 139 L258 61" stroke="#f7e7c2" stroke-width="12" stroke-linecap="round"/><path d="M255 63 L274 52" stroke="#63edf0" stroke-width="13" stroke-linecap="round"/><path d="M270 55 L279 50" stroke="#17333a" stroke-width="14" stroke-linecap="round"/></g><g class="intro-chalk-block" transform="translate(29 -22)"><rect x="246" y="17" width="57" height="50" rx="8" fill="#174d58"/><path d="M246 29h57v38h-57z" fill="#2db4be"/></g><g class="intro-chalk-dust" fill="#63edf0"><circle cx="263" cy="66" r="3"/><circle cx="276" cy="72" r="2.5"/><circle cx="286" cy="63" r="2"/></g><g class="intro-finish-shine" fill="#fff1c9"><path d="M279 33l3 11 11 3-11 3-3 11-3-11-11-3 11-3z"/></g></svg>`;
  if (index === 1) return `<svg class="intro-svg intro-rack" viewBox="0 0 360 240" role="img" aria-label="A triangle rack nudging pool balls into place"><path d="M40 211h280" stroke="#17333a" stroke-width="5" stroke-linecap="round"/><g class="intro-rack-balls" stroke="#071014" stroke-width="4"><circle cx="180" cy="65" r="18" fill="#fff1c9"/><circle cx="159" cy="101" r="18" fill="#ff6b4f"/><circle cx="201" cy="101" r="18" fill="#63edf0"/><circle cx="138" cy="137" r="18" fill="#63edf0"/><circle cx="180" cy="137" r="18" fill="#071014" stroke="#fff1c9"/><circle cx="222" cy="137" r="18" fill="#ff6b4f"/><circle cx="117" cy="173" r="18" fill="#fff1c9"/><circle cx="159" cy="173" r="18" fill="#ef3f35"/><circle cx="201" cy="173" r="18" fill="#fff1c9"/><circle cx="243" cy="173" r="18" fill="#63edf0"/></g><g class="intro-rack-frame" fill="none" stroke-linejoin="round"><path d="M180 18L58 205H302Z" stroke="#bd7640" stroke-width="18"/><path d="M180 18L58 205H302Z" stroke="#f4d8a1" stroke-width="7"/></g><g class="intro-rack-lines" fill="none" stroke="#63edf0" stroke-width="3" stroke-linecap="round"><path d="M77 109h-18M83 132H69M283 109h18M277 132h14"/></g><g class="intro-rack-shine" fill="#fff1c9"><path d="M180 18l3 10 10 3-10 3-3 10-3-10-10-3 10-3z"/></g></svg>`;
  return `<svg class="intro-svg intro-cue-ball" viewBox="0 0 360 220" role="img" aria-label="A pool cue striking a cue ball that rolls away"><path d="M22 151H338" stroke="#17333a" stroke-width="6" stroke-linecap="round"/><g class="intro-strike-cue"><path d="M18 126H129" stroke="#bd7640" stroke-width="12" stroke-linecap="round"/><path d="M54 126H138" stroke="#f4d8a1" stroke-width="12"/><path d="M138 126H146" stroke="#63edf0" stroke-width="12"/></g><g class="intro-speed-lines" fill="none" stroke="#63edf0" stroke-width="3" stroke-linecap="round"><path d="M154 101h18M147 111h29M151 141h22"/></g><g class="intro-moving-ball"><circle cx="166" cy="126" r="27" fill="#fff1c9"/><path d="M151 112c7-7 17-9 25-5" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/><path d="M179 145c6-3 10-8 12-14" fill="none" stroke="#d9c9a5" stroke-width="5" stroke-linecap="round"/></g><g class="intro-impact" fill="#ff6b4f"><path d="M142 108l4 11 11 4-11 4-4 11-4-11-11-4 11-4z"/></g><g class="intro-trail-sparkles"><path fill="#63edf0" d="M218 96l2 7 7 2-7 2-2 7-2-7-7-2 7-2z"/><path fill="#fff1c9" d="M270 145l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/><path fill="#63edf0" d="M319 101l2 7 7 2-7 2-2 7-2-7-7-2 7-2z"/></g></svg>`;
}

function playSeriesIntro(index, seriesName, onComplete) {
  const overlay = $("#series-intro");
  const titles = ["RACK 'EM UP", "RACK 'EM TIGHT", "BREAK TIME"];
  $("#series-intro-art").innerHTML = seriesIntroArt(index);
  $("#series-intro-title").textContent = titles[index];
  $("#series-intro-name").textContent = seriesName || "your series";
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => overlay.classList.add("playing"));
  const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 150 : 1900;
  setTimeout(() => {
    overlay.classList.remove("playing");
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
    onComplete?.();
  }, duration);
}

const roundWinAnimations = [
  { file: "/round-win-pocket-drop-v8.html", duration: 3800 },
  { file: "/round-win-score-ball-v10.html", duration: 5450 },
  { file: "/round-win-cue-celebration-v2.html", duration: 3550 }
];

const seriesWinAnimations = [
  { file: "/series-win-neon-champion.html", duration: 4800 },
  { file: "/series-win-victory-cheers.html", duration: 3900 },
  { file: "/series-win-table-light-v2.html", duration: 4300 }
];

const bestRunAnimation = { file: "/best-run-ball-parade-v3.html", baseDuration: 3400 };

function closeRoundWinCelebration(onComplete) {
  clearTimeout(roundWinTimer);
  roundWinTimer = null;
  const overlay = $("#round-win-celebration");
  overlay.classList.add("hidden");
  overlay.setAttribute("aria-hidden", "true");
  $("#round-win-frame").src = "about:blank";
  onComplete?.();
}

function playRoundWinCelebration(index, winner, onComplete) {
  const animation = roundWinAnimations[index % roundWinAnimations.length];
  const overlay = $("#round-win-celebration");
  const frame = $("#round-win-frame");
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    closeRoundWinCelebration(onComplete);
  };
  frame.src = `${animation.file}?embed=1&winner=${encodeURIComponent(winner)}&play=${Date.now()}`;
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
  const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 250 : animation.duration;
  roundWinTimer = setTimeout(finish, duration);
}

function playSeriesWinCelebration(index, series, onComplete) {
  const animation = seriesWinAnimations[index % seriesWinAnimations.length];
  const winner = winnerOf(series);
  const score = scores(series);
  const overlay = $("#round-win-celebration");
  const frame = $("#round-win-frame");
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    closeRoundWinCelebration(onComplete);
  };
  const params = new URLSearchParams({
    embed: "1",
    winner,
    vanessaScore: score.Vanessa,
    carlScore: score.Carl,
    target: series.target,
    play: Date.now()
  });
  frame.title = `${winner} wins the series ${score.Vanessa} to ${score.Carl}`;
  frame.src = `${animation.file}?${params}`;
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
  const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 250 : animation.duration;
  roundWinTimer = setTimeout(finish, duration);
}

function playBestRunCelebration(player, run, onComplete) {
  const overlay = $("#round-win-celebration");
  const frame = $("#round-win-frame");
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    closeRoundWinCelebration(onComplete);
  };
  const params = new URLSearchParams({ embed: "1", player, run: String(run), play: String(Date.now()) });
  frame.title = `${player} set a new best run of ${run}`;
  frame.src = `${bestRunAnimation.file}?${params}`;
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
  const runDuration = bestRunAnimation.baseDuration + Math.min(15, Math.max(1, Number(run) || 1)) * 130;
  const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 250 : runDuration;
  roundWinTimer = setTimeout(finish, duration);
}

function switchView(name) {
  $$('.tab').forEach(tab => tab.classList.toggle("active", tab.dataset.view === name));
  $$('.view').forEach(view => view.classList.toggle("hidden", view.id !== `${name}-view`));
  const headers = {
    play: ["VC & CV POOL SERIES", "Ready to break?"],
    game: ["Game", "Current series"],
    history: ["History", "The Trophy Case"],
    stats: ["Stats", "Head to head"]
  };
  $("#page-title").textContent = headers[name][0];
  $("#page-kicker").innerHTML = name === "play"
    ? (DEMO_MODE ? headers[name][1] : `${headers[name][1]} <span id="access-status" class="access-status">View only</span><button id="access-button" class="eight-ball access-eight" type="button" aria-label="Unlock editing">⑧</button>`)
    : headers[name][1];
  updateAccessUI();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

const roundQuestions = ["Who won?", "How?", "Where?", "Anything notable?"];
function roundNeedsContinue() {
  const form = $("#round-form");
  return (roundStep === 2 && form.elements.reason.value === "Other") ||
    (roundStep === 3 && form.elements.location.value === "🍺 Real Bar");
}

function updateRoundActions() {
  const form = $("#round-form");
  if (form.classList.contains("editing-round")) return;
  $('[data-round-back]').classList.toggle("hidden", roundStep === 1);
  $('[data-round-next]').classList.toggle("hidden", !roundNeedsContinue());
  $('[data-round-save]').classList.toggle("hidden", roundStep !== 4);
}

function showRoundStep(step) {
  roundStep = step;
  $$('[data-round-step]').forEach(el => el.classList.toggle("hidden", Number(el.dataset.roundStep) !== step));
  $("#round-progress").textContent = `Question ${step} of 4`;
  $("#round-question").textContent = roundQuestions[step - 1];
  updateRoundActions();
}

function showRoundEdit() {
  const form = $("#round-form");
  form.classList.add("editing-round");
  $("#round-progress").textContent = "Quick edit";
  $("#round-question").textContent = "Edit round";
  $$('[data-round-step]').forEach(el => el.classList.remove("hidden"));
  $('[data-round-back]').classList.add("hidden");
  $('[data-round-next]').classList.add("hidden");
  $('[data-round-save]').classList.remove("hidden");
}

function currentRoundStepIsValid() {
  const form = $("#round-form");
  if (roundStep === 1 && !form.elements.winner.value) return toast("Choose the winner"), false;
  if (roundStep === 2 && !form.elements.reason.value) return toast("Choose how they won"), false;
  if (roundStep === 2 && form.elements.reason.value === "Other" && !form.elements.otherReason.value.trim()) return toast("Add a short explanation"), false;
  if (roundStep === 3 && !form.elements.location.value) return toast("Choose where you played"), false;
  return true;
}

$$('[data-close]').forEach(button => button.onclick = () => button.closest("dialog").close());
$('[data-delete-edit-round]').onclick = () => {
  const form = $("#round-form");
  const series = state.series.find(item => item.id === form.elements.seriesId.value);
  const roundId = form.elements.roundId.value;
  if (!series || !roundId) return;
  if (!confirm("Are you sure you want to delete this round? This cannot be undone.")) return;
  series.rounds = series.rounds.filter(round => round.id !== roundId);
  saveState();
  $("#round-dialog").close();
  toast("Round deleted");
};
$$('.tab').forEach(tab => tab.onclick = () => {
  switchView(tab.dataset.view);
});

$('[data-round-next]').onclick = () => { if (currentRoundStepIsValid()) showRoundStep(roundStep + 1); };
$('[data-round-back]').onclick = () => showRoundStep(roundStep - 1);

$("#series-form").onsubmit = event => {
  event.preventDefault(); const data = new FormData(event.currentTarget);
  const editing = state.series.find(s => s.id === data.get("seriesId"));
  if (editing) {
    editing.name = data.get("name").trim();
    editing.challenge = data.get("challenge").trim();
    editing.target = Number(data.get("target"));
    saveState(); event.currentTarget.reset(); $("#series-dialog").close(); toast("Series updated");
    return;
  }
  const series = { id: uid(), name: data.get("name").trim(), challenge: data.get("challenge").trim(), target: Number(data.get("target")), createdAt: new Date().toISOString(), deleted: false, rounds: [] };
  const introIndex = Number(state.introIndex) || 0;
  state.introIndex = (introIndex + 1) % 3;
  state.series.unshift(series); openSeriesId = series.id;
  saveState(); event.currentTarget.reset(); $("#series-dialog").close();
  playSeriesIntro(introIndex, series.name || "your series", () => { switchView("game"); toast("Series started"); });
};

$("#round-form").addEventListener("change", event => {
  const form = event.currentTarget;
  if (event.target.name === "reason") $("#other-reason-wrap").classList.toggle("hidden", event.target.value !== "Other");
  if (event.target.name === "location") $("#bar-name-wrap").classList.toggle("hidden", event.target.value !== "🍺 Real Bar");
  if (form.classList.contains("editing-round")) return;
  if (event.target.name === "winner") return showRoundStep(2);
  if (event.target.name === "reason") {
    const isOther = event.target.value === "Other";
    $("#other-reason-wrap").classList.toggle("hidden", !isOther);
    if (isOther) {
      updateRoundActions();
      form.elements.otherReason.focus();
    } else showRoundStep(3);
    return;
  }
  if (event.target.name === "location") {
    const isRealBar = event.target.value === "🍺 Real Bar";
    $("#bar-name-wrap").classList.toggle("hidden", !isRealBar);
    if (isRealBar) {
      updateRoundActions();
      form.elements.barName.focus();
    } else showRoundStep(4);
    return;
  }
});

$("#round-form").onsubmit = event => {
  event.preventDefault(); const data = new FormData(event.currentTarget);
  const series = state.series.find(s => s.id === data.get("seriesId"));
  if (!series) return;
  const winnerBeforeSave = winnerOf(series);
  const selectedReason = data.get("reason");
  const other = data.get("otherReason").trim();
  if (selectedReason === "Other" && !other) { toast("Add a short explanation"); return; }
  const values = { winner: data.get("winner"), reason: selectedReason === "Other" ? other : selectedReason, location: data.get("location"), barName: data.get("location") === "🍺 Real Bar" ? data.get("barName").trim() : "", playedOn: data.get("playedOn"), note: data.get("note").trim() };
  const existing = series.rounds.find(round => round.id === data.get("roundId"));
  if (existing) Object.assign(existing, values);
  else series.rounds.push({ id: uid(), ...values, createdAt: new Date().toISOString() });
  const animationIndex = Number(state.roundWinAnimationIndex) || 0;
  const seriesAnimationIndex = Number(state.seriesWinAnimationIndex) || 0;
  const winner = winnerOf(series);
  if (!existing && winner && !winnerBeforeSave) state.seriesWinAnimationIndex = (seriesAnimationIndex + 1) % seriesWinAnimations.length;
  else if (!existing) state.roundWinAnimationIndex = (animationIndex + 1) % roundWinAnimations.length;
  saveState(); $("#round-dialog").close();
  const message = existing ? "Round updated" : winner ? `${winner} wins the series!` : "Round saved";
  if (existing) toast(message);
  else if (winner && !winnerBeforeSave) playSeriesWinCelebration(seriesAnimationIndex, series, () => toast(message));
  else playRoundWinCelebration(animationIndex, values.winner, () => toast(message));
};

$("#run-form").onsubmit = event => {
  event.preventDefault(); const data = new FormData(event.currentTarget);
  const player = data.get("player");
  const count = Number(data.get("count"));
  const recordedRuns = state.runRecords.filter(record => record.player === player).map(record => Number(record.count) || 0);
  const previousBest = Math.max(0, ...recordedRuns);
  const editedRecord = editingRunId && state.runRecords.find(record => record.id === editingRunId);
  if (editedRecord) Object.assign(editedRecord, { player, count, playedOn: data.get("playedOn") });
  else state.runRecords.push({ id: uid(), player, count, playedOn: data.get("playedOn"), createdAt: new Date().toISOString() });
  editingRunId = null;
  saveState(); $("#run-dialog").close();
  if (!editedRecord && count > previousBest) playBestRunCelebration(player, count, () => toast("New best run saved!"));
  else toast("Best run saved");
};

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js?v=162");
render();
updateAccessUI();
initializeSharedScorebook();
