// 100xPortfolio — client game loop.

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "100x_result";

const state = {
  data: null, // daily payload from /api/daily
  round: 0, // current round index
  picks: [], // [{industry, era, ticker}]
  active: null, // active cell {industry, era, stocks}
  eraSkipUsed: false,
  industrySkipUsed: false,
};

// ---- boot ----------------------------------------------------------------
async function boot() {
  state.data = await fetch("/api/daily").then((r) => r.json());
  renderProgress();

  const saved = loadSaved();
  if (saved && saved.day === state.data.day) {
    $("already-played").classList.remove("hidden");
    $("start-btn").textContent = "See today's result →";
    $("start-btn").onclick = () => showResult(saved.result, false);
  } else {
    $("start-btn").onclick = startGame;
  }

  $("skip-era").onclick = () => useSkip("era");
  $("skip-industry").onclick = () => useSkip("industry");
  $("share-btn").onclick = shareResult;
  $("replay-btn").onclick = () => location.reload();
}

function startGame() {
  state.round = 0;
  state.picks = [];
  state.eraSkipUsed = false;
  state.industrySkipUsed = false;
  show("game");
  renderRound();
}

// ---- rendering -----------------------------------------------------------
function renderProgress() {
  const rail = $("progress-rail");
  rail.innerHTML = "";
  for (let i = 0; i < state.data.rounds.length; i++) {
    const pip = document.createElement("div");
    pip.className = "pip";
    if (i < state.round) pip.classList.add("done");
    else if (i === state.round) pip.classList.add("active");
    rail.appendChild(pip);
  }
}

function renderRound() {
  const rnd = state.data.rounds[state.round];
  state.active = rnd.cells.primary;

  renderProgress();
  $("round-counter").textContent = `Round ${state.round + 1} / ${state.data.rounds.length}`;
  $("skip-era").disabled = state.eraSkipUsed;
  $("skip-industry").disabled = state.industrySkipUsed;

  spinReels(rnd.era, rnd.industry, () => renderStocks());
}

function spinReels(finalEra, finalIndustry, done) {
  const eraReel = $("reel-era");
  const indReel = $("reel-industry");
  const eras = ["1990-1994", "1995-1999", "2000-2004", "2005-2009", "2010-2014", "2015-2019", "2020-2024"];
  const inds = ["Technology", "Healthcare", "Energy", "Financials", "Consumer & Retail", "Auto & Transport"];

  eraReel.classList.add("spinning");
  indReel.classList.add("spinning");
  let ticks = 0;
  const spin = setInterval(() => {
    eraReel.textContent = eras[Math.floor(Math.random() * eras.length)];
    indReel.textContent = inds[Math.floor(Math.random() * inds.length)];
    if (++ticks > 14) {
      clearInterval(spin);
      eraReel.classList.remove("spinning");
      indReel.classList.remove("spinning");
      eraReel.textContent = finalEra;
      indReel.textContent = finalIndustry;
      done();
    }
  }, 70);
}

function renderStocks() {
  const grid = $("stock-grid");
  grid.innerHTML = "";
  // Reflect any active skip in the reels.
  $("reel-era").textContent = state.active.era;
  $("reel-industry").textContent = state.active.industry;

  state.active.stocks.forEach((s) => {
    const card = document.createElement("div");
    card.className = "stock-card";
    card.innerHTML = `
      <div class="stock-ticker">${s.ticker}</div>
      <div class="stock-name">${s.name}</div>
      <div class="stock-blurb">${s.blurb}</div>`;
    card.onclick = () => pick(s.ticker);
    grid.appendChild(card);
  });
}

// ---- actions -------------------------------------------------------------
function useSkip(kind) {
  const rnd = state.data.rounds[state.round];
  if (kind === "era" && !state.eraSkipUsed) {
    state.eraSkipUsed = true;
    state.active = rnd.cells.altEra;
    $("skip-era").disabled = true;
  } else if (kind === "industry" && !state.industrySkipUsed) {
    state.industrySkipUsed = true;
    state.active = rnd.cells.altIndustry;
    $("skip-industry").disabled = true;
  }
  renderStocks();
}

function pick(ticker) {
  state.picks.push({
    industry: state.active.industry,
    era: state.active.era,
    ticker,
  });

  if (state.round + 1 >= state.data.rounds.length) {
    submit();
  } else {
    state.round += 1;
    renderRound();
  }
}

async function submit() {
  const res = await fetch("/api/score", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ picks: state.picks, day: state.data.day }),
  }).then((r) => r.json());

  if (res.error) {
    alert("Scoring error: " + res.error);
    return;
  }
  save({ day: state.data.day, result: res });
  showResult(res, true);
}

// ---- result --------------------------------------------------------------
function showResult(res, animate) {
  show("result");

  const badge = $("grade-badge");
  badge.textContent = res.grade;
  badge.className = "grade-badge " + res.gradeColor;

  $("result-multiple").textContent = res.multiple + "×";
  $("result-verdict").textContent = res.verdict;
  $("res-invested").textContent = usd(res.invested);
  $("res-final").textContent = usd(res.finalValue);

  const legs = $("result-legs");
  legs.innerHTML = "";
  res.legs.forEach((l) => {
    const cls = l.multiple >= 2 ? "up" : l.multiple >= 1 ? "flat" : "down";
    const sign = l.gainPct >= 0 ? "+" : "";
    const row = document.createElement("div");
    row.className = "leg";
    row.innerHTML = `
      <div class="leg-tag">${l.era} · ${l.industry}</div>
      <div class="leg-name">${l.name} <small>${l.ticker}</small></div>
      <div class="leg-mult ${cls}">${l.multiple}× <small>${sign}${l.gainPct}%</small></div>`;
    legs.appendChild(row);
  });

  $("best-pick").textContent = `${res.bestPick.name} (${res.bestPick.ticker}) — ${res.bestPick.multiple}×`;
  $("weak-pick").textContent = `${res.weakness.name} (${res.weakness.ticker}) — ${res.weakness.multiple}×`;
}

function shareResult() {
  const saved = loadSaved();
  if (!saved) return;
  const res = saved.result;
  const grid = res.legs
    .map((l) => (l.multiple >= 2 ? "🟩" : l.multiple >= 1 ? "🟨" : "🟥"))
    .join("");
  const text = `100xPortfolio ${res.day}\n${grid}  ${res.multiple}×  Grade ${res.grade}\nplay → 100xportfolio.com`;

  navigator.clipboard
    .writeText(text)
    .then(() => {
      const toast = $("share-toast");
      toast.classList.remove("hidden");
      setTimeout(() => toast.classList.add("hidden"), 2000);
    })
    .catch(() => alert(text));
}

// ---- helpers -------------------------------------------------------------
function show(id) {
  ["intro", "game", "result"].forEach((s) => $(s).classList.add("hidden"));
  $(id).classList.remove("hidden");
}

function usd(n) {
  return "$" + Math.round(n).toLocaleString("en-US");
}

function save(obj) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch (e) {
    /* ignore */
  }
}

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch (e) {
    return null;
  }
}

boot();
