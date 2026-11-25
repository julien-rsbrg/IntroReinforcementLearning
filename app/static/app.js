"use strict";

// ---------------------------------------------------------------- constants
const ARROWS = ["←", "↓", "→", "↑"];
const ACTION_NAMES = ["left", "down", "right", "up"];
const DEFAULT_REWARD = { S: 0, F: 0, H: 0, W: 0, G: 1 };
const TILE_NAMES = { S: "start", F: "ice", H: "water", W: "wall", G: "yeti" };
const NEUTRAL = [244, 247, 250], POS = [31, 138, 112], NEG = [209, 73, 91];

// ---------------------------------------------------------------- state
const sid = sessionStorage.getItem("sid") || crypto.randomUUID().replace(/-/g, "");
sessionStorage.setItem("sid", sid);

let S = null;                // last state received from the server
let Q = null;                // Q-table being displayed (may lead the server during animation)
let shownPos = 0;            // where the character is drawn
let shownOutcome = null;     // outcome currently drawn (goal / water / timeout / null)
let lastTr = null;           // last transition shown
let character = localStorage.getItem("character") || "penguin";
let tool = "none";
let busy = false, stopRequested = false;
let presets = {};
let paint = null;            // {desc, rewards} while dragging a brush

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nrow = () => S.desc.length, ncol = () => S.desc[0].length;
const letterAt = (s) => S.desc[Math.floor(s / ncol())][s % ncol()];
const rc = (s) => `(${Math.floor(s / ncol())}, ${s % ncol()})`;

// ---------------------------------------------------------------- server
async function api(path, body = {}) {
  const res = await fetch(`/api/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sid, ...body }),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function toast(msg, ms = 2500) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

function applyState(st) {
  const tiles = $("#board").querySelectorAll(".tile").length;
  const rebuilt = !$("#agent") || tiles !== st.desc.length * st.desc[0].length || (S && S.desc[0].length !== st.desc[0].length);
  S = st;
  Q = st.q.map((r) => r.slice());
  shownPos = st.pos;
  shownOutcome = st.done ? st.outcome : null;
  if (rebuilt) buildBoard();
  syncPresetSelect();
  syncControls();
  renderAll();
}

// ---------------------------------------------------------------- timing
function stepDelay() {
  const v = +$("#speed").value / 100;
  return Math.round(20 + 900 * (1 - v) ** 2);
}

// ---------------------------------------------------------------- board (left)
function buildBoard() {
  const board = $("#board");
  board.innerHTML = "";
  board.style.gridTemplateColumns = `repeat(${ncol()}, 1fr)`;
  board.style.gridTemplateRows = `repeat(${nrow()}, 1fr)`;
  board.style.aspectRatio = `${ncol()} / ${nrow()}`;
  for (let r = 0; r < nrow(); r++) {
    for (let c = 0; c < ncol(); c++) {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.dataset.s = r * ncol() + c;
      board.appendChild(tile);
    }
  }
  const agent = document.createElement("div");
  agent.className = "agent";
  agent.id = "agent";
  agent.style.width = `${100 / ncol()}%`;
  agent.style.height = `${100 / nrow()}%`;
  agent.innerHTML = `<img alt="agent">`;
  board.appendChild(agent);
}

function renderTiles() {
  const board = $("#board");
  board.classList.toggle("editing", tool !== "none");
  board.classList.toggle("no-rewards", !$("#show-rewards").checked && tool !== "reward");
  board.classList.toggle("hide-zero", tool !== "reward");
  const tiles = board.querySelectorAll(".tile");
  tiles.forEach((tile) => {
    const s = +tile.dataset.s;
    const r = Math.floor(s / ncol()), c = s % ncol();
    const ch = S.desc[r][c];
    let html = "";
    if (ch === "H") html += `<img src="/assets/water.png" alt="">`;
    if (ch === "W") html += `<img src="/assets/wall.png" alt="">`;
    if (ch === "G") {
      let mood = "neutral";
      if (shownOutcome === "goal" && shownPos === s) mood = "happy";
      else if (shownOutcome === "water") mood = "angry";
      html += `<img src="/assets/yeti-${mood}.png" alt="yeti">`;
    }
    if (ch === "S") html += `<span class="start-mark">START</span>`;
    if (ch !== "W") {
      const v = S.rewards[r][c];
      const cls = v > 0 ? "pos" : v < 0 ? "neg" : "zero";
      html += `<span class="reward-badge ${cls}" title="reward for entering this cell">${fmtSigned(v)}</span>`;
    }
    if (tile._html !== html) { tile.innerHTML = html; tile._html = html; }
  });
}

function placeAgent(s, { animate = true, bumpAction = null } = {}) {
  const agent = $("#agent");
  if (!agent) return;
  const r = Math.floor(s / ncol()), c = s % ncol();
  const ms = animate ? Math.min(260, Math.round(stepDelay() * 0.8)) : 0;
  agent.style.setProperty("--move-ms", `${ms}ms`);
  agent.style.transform = `translate(${c * 100}%, ${r * 100}%)`;
  const ch = letterAt(s);
  const img = agent.querySelector("img");
  const frozen = ch === "H";
  const src = `/assets/${character}${frozen ? "-frozen" : ""}.png`;
  if (!img.src.endsWith(src)) img.src = src;
  agent.classList.toggle("frozen", frozen);
  // the happy yeti replaces the character when the goal is reached
  agent.classList.toggle("hidden", ch === "G" && shownOutcome === "goal");
  agent.classList.remove("bump");
  if (bumpAction !== null && ms > 0) {
    const d = [[-25, 0], [0, 25], [25, 0], [0, -25]][bumpAction];
    agent.style.setProperty("--bx", `${d[0]}%`);
    agent.style.setProperty("--by", `${d[1]}%`);
    void agent.offsetWidth; // restart the animation
    agent.classList.add("bump");
  }
}

// ---------------------------------------------------------------- Q grid (right)
function mix(a, b, t) { return a.map((x, i) => Math.round(x + (b[i] - x) * t)); }
function qColor(v, maxAbs) {
  if (!maxAbs) return `rgb(${NEUTRAL})`;
  const t = Math.min(1, Math.sqrt(Math.abs(v) / maxAbs));
  return `rgb(${mix(NEUTRAL, v >= 0 ? POS : NEG, t)})`;
}
function fmt(v) {
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}
function fmtSigned(v) { return (v > 0 ? "+" : "") + (Number.isInteger(v) ? v : +v.toFixed(2)); }

function qMaxAbs() {
  let m = 0;
  Q.forEach((row, s) => {
    const ch = letterAt(s);
    if (ch === "W" || ch === "H" || ch === "G") return;
    row.forEach((v) => (m = Math.max(m, Math.abs(v))));
  });
  return m;
}

function renderQ() {
  const svg = $("#qgrid");
  const R = nrow(), C = ncol(), U = 100;
  svg.setAttribute("viewBox", `0 0 ${C * U} ${R * U}`);
  svg.style.aspectRatio = `${C} / ${R}`;
  const maxAbs = qMaxAbs();
  const showNums = $("#show-numbers").checked && C <= 6 && R <= 6;
  const tri = [
    [[0, 0], [0, U], [U / 2, U / 2]],          // left
    [[0, U], [U, U], [U / 2, U / 2]],          // down
    [[U, 0], [U, U], [U / 2, U / 2]],          // right
    [[0, 0], [U, 0], [U / 2, U / 2]],          // up
  ];
  const textPos = [[18, 54], [50, 88], [82, 54], [50, 20]];
  const arrowDir = [[-1, 0], [0, 1], [1, 0], [0, -1]];
  let out = "";
  for (let s = 0; s < R * C; s++) {
    const x = (s % C) * U, y = Math.floor(s / C) * U;
    const ch = letterAt(s);
    out += `<g transform="translate(${x},${y})">`;
    if (ch === "W") {
      out += `<rect width="${U}" height="${U}" fill="#c9d3dd"/><image href="/assets/wall.png" x="15" y="15" width="70" height="70" opacity=".55"/>`;
    } else if (ch === "H" || ch === "G") {
      out += `<rect width="${U}" height="${U}" fill="${ch === "H" ? "#d4e8f7" : "#eef3e6"}"/>`;
      out += `<image href="/assets/${ch === "H" ? "water" : "yeti-neutral"}.png" x="20" y="14" width="60" height="60" opacity=".75"/>`;
      out += `<text x="50" y="91" text-anchor="middle" font-size="11" fill="#5d6f82">terminal</text>`;
    } else {
      const row = Q[s];
      for (let a = 0; a < 4; a++) {
        const pts = tri[a].map((p) => p.join(",")).join(" ");
        out += `<polygon points="${pts}" fill="${qColor(row[a], maxAbs)}" stroke="#ffffff" stroke-width="1.5"><title>Q(${rc(s)}, ${ACTION_NAMES[a]}) = ${row[a].toFixed(4)}</title></polygon>`;
      }
      if (showNums) {
        for (let a = 0; a < 4; a++) {
          const t = maxAbs ? Math.sqrt(Math.abs(row[a]) / maxAbs) : 0;
          const fill = t > 0.65 ? "#ffffff" : "#1d2b3a";
          out += `<text x="${textPos[a][0]}" y="${textPos[a][1]}" text-anchor="middle" font-size="12.5" fill="${fill}">${fmt(row[a])}</text>`;
        }
      }
      const best = Math.max(...row);
      const tied = row.map((v, a) => (Math.abs(v - best) < 1e-9 ? a : -1)).filter((a) => a >= 0);
      if (tied.length < 4) {
        for (const a of tied) {
          const [dx, dy] = arrowDir[a];
          const L = showNums ? 9 : 26;
          const x2 = 50 + dx * L, y2 = 50 + dy * L;
          out += `<line x1="50" y1="50" x2="${x2}" y2="${y2}" stroke="#1d2b3a" stroke-width="4" stroke-linecap="round" marker-end="url(#ah)"/>`;
        }
      } else {
        out += `<circle cx="50" cy="50" r="3.5" fill="#8a9bb0"/>`;
      }
    }
    out += `</g>`;
  }
  // grid lines
  for (let c = 1; c < C; c++) out += `<line x1="${c * U}" y1="0" x2="${c * U}" y2="${R * U}" stroke="#9fb3c8" stroke-width="2"/>`;
  for (let r = 1; r < R; r++) out += `<line x1="0" y1="${r * U}" x2="${C * U}" y2="${r * U}" stroke="#9fb3c8" stroke-width="2"/>`;
  // last updated (s, a)
  if (lastTr) {
    const x = (lastTr.s % C) * U, y = Math.floor(lastTr.s / C) * U;
    const pts = tri[lastTr.a].map((p) => `${p[0] + x},${p[1] + y}`).join(" ");
    out += `<polygon points="${pts}" fill="none" stroke="#f2a900" stroke-width="5" stroke-linejoin="round"/>`;
  }
  // where the character is
  {
    const x = (shownPos % C) * U, y = Math.floor(shownPos / C) * U;
    out += `<rect x="${x + 3}" y="${y + 3}" width="${U - 6}" height="${U - 6}" rx="8" fill="none" stroke="#2b6cb0" stroke-width="4" stroke-dasharray="10 6"/>`;
  }
  svg.innerHTML = `<defs><marker id="ah" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="2.6" markerHeight="2.6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#1d2b3a"/></marker></defs>${out}`;

  const m = maxAbs || 1;
  $("#legend").innerHTML =
    `<span>${fmt(-m)}</span><div class="bar" style="background:linear-gradient(90deg, rgb(${NEG}), rgb(${NEUTRAL}) 50%, rgb(${POS}))"></div><span>+${fmt(m)}</span>` +
    `<span style="margin-left:10px"><svg width="14" height="14" style="vertical-align:middle"><polygon points="1,1 13,1 7,7" fill="none" stroke="#f2a900" stroke-width="2"/></svg> last update</span>` +
    `<span><svg width="14" height="14" style="vertical-align:middle"><rect x="1" y="1" width="12" height="12" rx="2" fill="none" stroke="#2b6cb0" stroke-width="2" stroke-dasharray="3 2"/></svg> agent</span>`;
}

// ---------------------------------------------------------------- status, update text, curve
function successRate(n = 100) {
  const h = S.history.slice(-n);
  return h.length ? h.filter((e) => e.ok).length / h.length : null;
}

function renderStatus(tr = null) {
  const outcome = shownOutcome;
  const label = { goal: `<span class="goal">reached the yeti!</span>`, water: `<span class="water">fell in the water</span>`, timeout: `<span>ran out of time</span>` }[outcome] || "";
  const sr = successRate();
  const step = tr ? tr.step : S.ep_steps;
  const ret = tr ? tr.ep_return : S.ep_return;
  const episode = tr ? S.episode + (tr.outcome ? 1 : 0) : S.episode;
  $("#status").innerHTML =
    `<span>Episodes <b>${episode}</b></span>` +
    `<span>Step <b>${step}</b>/${S.max_steps}</span>` +
    `<span>Return <b>${fmt(ret)}</b></span>` +
    `<span>Success (last 100) <b>${sr === null ? "–" : Math.round(sr * 100) + "%"}</b></span>` +
    (label ? `<span>${label}</span>` : "");
}

function renderUpdate() {
  const el = $("#update");
  const tr = lastTr;
  if (!tr) {
    el.innerHTML = `<p class="muted">Press <b>Step</b> to let the agent take one action. The Q-learning rule then updates one entry of the table:</p>
      <div class="eq">Q(s,a) ← Q(s,a) + α · [ r + γ · max<sub>a'</sub> Q(s',a') − Q(s,a) ]</div>
      <p class="muted">The reward r is the one attached to the cell the agent lands in (edit it with <b>± Rewards</b>).</p>`;
    return;
  }
  const how = tr.explored
    ? `<span class="tag explore">random, ε = ${tr.epsilon.toFixed(2)}</span>`
    : `<span class="tag">greedy</span>`;
  const bumped = tr.s === tr.s2 && !tr.terminated;
  const where = tr.terminated
    ? (letterAt(tr.s2) === "G" ? "reached the yeti" : "fell into the water")
    : bumped ? "bumped into a wall/edge and stayed" : `moved to ${rc(tr.s2)}`;
  const maxTxt = tr.terminated
    ? `<span title="s' is terminal: no future rewards">0</span>`
    : fmt(tr.max_next);
  el.innerHTML = `
    <p>In state <b>${rc(tr.s)}</b> the agent chose <b>${ARROWS[tr.a]} ${ACTION_NAMES[tr.a]}</b> ${how},
    ${where}${tr.terminated ? "" : ""} and received <b>r = ${fmt(tr.r)}</b>.</p>
    <div class="eq">Q(s,a) ← Q(s,a) + α · [ r + γ · max Q(s',·) − Q(s,a) ]</div>
    <div class="eq">${fmt(tr.q_new)} = ${fmt(tr.q_old)} + ${tr.alpha} · [ ${fmt(tr.r)} + ${tr.gamma} · ${maxTxt} − ${fmt(tr.q_old)} ]</div>
    <p class="muted">Target = ${fmt(tr.target)}, TD error = ${fmt(tr.td_error)}.
    ${tr.terminated ? "Since s' ends the episode, there is no future value to add." : ""}
    ${tr.truncated && !tr.terminated ? "The step limit was reached: the episode is cut short." : ""}</p>`;
}

function renderCurve() {
  const cv = $("#curve");
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = 180;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d");
  g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);
  g.font = "11px system-ui, sans-serif";
  const h = S.history;
  if (!h.length) {
    g.fillStyle = "#5d6f82";
    g.fillText("No finished episode yet.", 10, 20);
    return;
  }
  const first = S.episode - h.length;
  const padL = 40, padR = 10;
  const top = { y0: 8, y1: 100 }, bot = { y0: 118, y1: 168 };
  const n = h.length;
  const X = (i) => padL + (n === 1 ? 0.5 : i / (n - 1)) * (W - padL - padR);
  const rets = h.map((e) => e.ret);
  let lo = Math.min(0, ...rets), hi = Math.max(0, ...rets);
  if (hi - lo < 1e-9) hi = lo + 1;
  const Yr = (v) => top.y1 - ((v - lo) / (hi - lo)) * (top.y1 - top.y0);
  const Ys = (v) => bot.y1 - v * (bot.y1 - bot.y0);

  // axes / grid
  g.strokeStyle = "#e3ebf3"; g.lineWidth = 1; g.fillStyle = "#5d6f82"; g.textAlign = "right"; g.textBaseline = "middle";
  for (const v of [lo, 0, hi]) {
    g.beginPath(); g.moveTo(padL, Yr(v)); g.lineTo(W - padR, Yr(v)); g.stroke();
    g.fillText(fmt(v), padL - 4, Yr(v));
  }
  for (const v of [0, 1]) {
    g.beginPath(); g.moveTo(padL, Ys(v)); g.lineTo(W - padR, Ys(v)); g.stroke();
    g.fillText(`${v * 100}%`, padL - 4, Ys(v));
  }
  g.textAlign = "left"; g.textBaseline = "alphabetic";
  g.fillText("return", padL + 2, top.y0 + 9);
  g.fillText("success", padL + 2, bot.y0 - 3);
  g.textAlign = "center";
  g.fillText(`episode ${first + 1}`, padL + 30, H - 2);
  g.fillText(`episode ${S.episode}`, W - padR - 34, H - 2);

  // raw returns
  g.fillStyle = "rgba(120,150,180,.45)";
  h.forEach((e, i) => { g.beginPath(); g.arc(X(i), Yr(e.ret), n > 400 ? 1.2 : 2, 0, 7); g.fill(); });

  const win = 20;
  const movAvg = (f) => h.map((_, i) => {
    const sl = h.slice(Math.max(0, i - win + 1), i + 1);
    return sl.reduce((a, e) => a + f(e), 0) / sl.length;
  });
  const line = (vals, Y, color) => {
    g.strokeStyle = color; g.lineWidth = 2; g.beginPath();
    vals.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))));
    g.stroke();
  };
  line(movAvg((e) => e.ret), Yr, "#2b6cb0");
  line(movAvg((e) => (e.ok ? 1 : 0)), Ys, "#1f8a70");
}

function renderAll(tr = null) {
  renderTiles();
  placeAgent(shownPos, { animate: false });
  renderQ();
  renderStatus(tr);
  renderUpdate();
  renderCurve();
}

// ---------------------------------------------------------------- controls
function syncControls() {
  for (const k of ["alpha", "gamma", "epsilon", "epsilon_decay"]) {
    const input = $(`#${k}`);
    if (document.activeElement !== input) input.value = S.hyper[k];
    input.nextElementSibling.textContent = (+input.value).toFixed(k === "epsilon_decay" ? 3 : 2);
  }
  $("#slippery").checked = S.slippery;
  $("#speed-out").textContent = `${stepDelay()} ms/step`;
}

function setBusy(b) {
  busy = b;
  for (const id of ["btn-step", "btn-episode", "btn-train", "btn-reset-ep", "btn-reset-q", "preset", "slippery"]) $(`#${id}`).disabled = b;
  $$(".tool").forEach((t) => (t.disabled = b));
  $("#btn-pause").disabled = !b;
}

async function animateTransitions(trs, finalState) {
  for (let i = 0; i < trs.length; i++) {
    const tr = trs[i];
    if (stopRequested) break;
    if (shownPos !== tr.s || shownOutcome) {
      // new episode: teleport back to the start
      shownOutcome = null;
      shownPos = tr.s;
      renderTiles();
      placeAgent(tr.s, { animate: false });
      await sleep(Math.min(250, stepDelay()));
    }
    Q[tr.s][tr.a] = tr.q_new;
    lastTr = tr;
    shownPos = tr.s2;
    shownOutcome = tr.outcome || null;
    renderTiles();
    placeAgent(tr.s2, { bumpAction: tr.s === tr.s2 && !tr.terminated ? tr.a : null });
    renderQ();
    renderStatus(tr);
    renderUpdate();
    await sleep(stepDelay() + (tr.outcome ? 400 : 0));
  }
  lastTr = trs[trs.length - 1];
  applyState(finalState);
}

async function run(fn) {
  if (busy) return;
  setBusy(true);
  stopRequested = false;
  try { await fn(); }
  catch (e) { toast(e.message); }
  finally { setBusy(false); }
}

function bindControls() {
  $("#btn-step").onclick = () => run(async () => {
    const res = await api("step");
    await animateTransitions(res.transitions, res.state);
  });
  $("#btn-episode").onclick = () => run(async () => {
    const res = await api("episode");
    await animateTransitions(res.transitions, res.state);
  });
  $("#btn-train").onclick = () => run(async () => {
    const n = Math.max(1, Math.min(20000, +$("#n-episodes").value || 1));
    if ($("#animate").checked) {
      for (let i = 0; i < n && !stopRequested; i++) {
        const res = await api("episode");
        await animateTransitions(res.transitions, res.state);
      }
    } else {
      const res = await api("train", { n });
      lastTr = null;
      applyState(res.state);
      toast(res.capped
        ? `Stopped after ${res.episodes} episodes (${res.steps.toLocaleString()} steps limit). Run again to continue.`
        : `Ran ${res.episodes} episodes (${res.steps.toLocaleString()} steps).`);
    }
  });
  $("#btn-pause").onclick = () => { stopRequested = true; };
  $("#btn-reset-ep").onclick = () => run(async () => { lastTr = null; applyState(await api("reset_episode")); });
  $("#btn-reset-q").onclick = () => run(async () => { lastTr = null; applyState(await api("reset_q")); toast("Q-table reset to 0."); });

  $("#speed").oninput = () => ($("#speed-out").textContent = `${stepDelay()} ms/step`);
  for (const k of ["alpha", "gamma", "epsilon", "epsilon_decay"]) {
    const input = $(`#${k}`);
    input.oninput = () => (input.nextElementSibling.textContent = (+input.value).toFixed(k === "epsilon_decay" ? 3 : 2));
    input.onchange = async () => {
      try { applyState(await api("config", { [k]: +input.value })); }
      catch (e) { toast(e.message); }
    };
  }
  $("#slippery").onchange = () => run(async () => {
    applyState(await api("config", { slippery: $("#slippery").checked }));
    toast($("#slippery").checked ? "Slippery: each move succeeds only 1/3 of the time." : "Ice is no longer slippery.");
  });
  $("#show-numbers").onchange = renderQ;
  $("#show-rewards").onchange = renderTiles;
  window.addEventListener("resize", () => S && renderCurve());

  // characters
  $$(".char").forEach((b) => (b.onclick = () => setCharacter(b.dataset.char)));

  // presets
  $("#preset").onchange = () => run(async () => {
    const desc = presets[$("#preset").value];
    if (!desc) return;
    lastTr = null;
    const rewards = desc.map((row) => [...row].map((ch) => DEFAULT_REWARD[ch]));
    applyState(await api("config", { desc, rewards }));
  });

  // edit tools
  $$(".tool").forEach((b) => (b.onclick = () => {
    tool = b.dataset.tool;
    $$(".tool").forEach((t) => t.classList.toggle("active", t === b));
    renderTiles();
  }));
  const board = $("#board");
  board.addEventListener("pointerdown", onBoardDown);
  board.addEventListener("pointerover", onBoardOver);
  window.addEventListener("pointerup", onBoardUp);
}

function setCharacter(c) {
  character = c;
  localStorage.setItem("character", c);
  $$(".char").forEach((b) => b.classList.toggle("active", b.dataset.char === c));
  $("#start-brush-img").src = `/assets/${c}.png`;
  if (S) placeAgent(shownPos, { animate: false });
}

function syncPresetSelect() {
  const sel = $("#preset");
  const match = Object.keys(presets).find((k) => presets[k].join() === S.desc.join());
  let custom = sel.querySelector('option[value="__custom"]');
  if (!match && !custom) {
    custom = new Option("Custom map", "__custom");
    sel.add(custom);
  }
  sel.value = match || "__custom";
}

// ---------------------------------------------------------------- board editing
function tileFromEvent(e) {
  const t = e.target.closest(".tile");
  return t ? +t.dataset.s : null;
}

function onBoardDown(e) {
  if (busy || tool === "none") return;
  const s = tileFromEvent(e);
  if (s === null) return;
  if (tool === "reward") { openRewardPopover(s, e); return; }
  e.preventDefault();
  paint = { desc: S.desc.map((r) => [...r]), rewards: S.rewards.map((r) => r.slice()), changed: false };
  paintAt(s);
}
function onBoardOver(e) {
  if (!paint || tool === "S") return;
  const s = tileFromEvent(e);
  if (s !== null) paintAt(s);
}
function paintAt(s) {
  const r = Math.floor(s / ncol()), c = s % ncol();
  const old = paint.desc[r][c];
  if (old === tool) return;
  if (tool === "S") {
    paint.desc.forEach((row, i) => row.forEach((ch, j) => { if (ch === "S") { row[j] = "F"; paint.rewards[i][j] = 0; } }));
  }
  paint.desc[r][c] = tool;
  paint.rewards[r][c] = DEFAULT_REWARD[tool];
  paint.changed = true;
  // preview locally
  S.desc = paint.desc.map((row) => row.join(""));
  S.rewards = paint.rewards;
  renderTiles();
}
async function onBoardUp() {
  if (!paint) return;
  const p = paint;
  paint = null;
  if (!p.changed) return;
  const desc = p.desc.map((row) => row.join(""));
  await run(async () => {
    try {
      lastTr = null;
      applyState(await api("config", { desc, rewards: p.rewards }));
    } catch (e) {
      applyState(await api("state"));
      throw e;
    }
  });
}

let popoverCell = null;
function openRewardPopover(s, e) {
  const ch = letterAt(s);
  if (ch === "W") { toast("Walls cannot be entered, so they have no reward."); return; }
  popoverCell = s;
  const pop = $("#popover");
  const r = Math.floor(s / ncol()), c = s % ncol();
  pop.querySelector(".pop-title").textContent = `Reward for entering ${TILE_NAMES[ch]} ${rc(s)}`;
  const input = $("#reward-input");
  input.value = S.rewards[r][c];
  $("#reward-all").checked = false;
  $("#reward-all").parentElement.lastChild.textContent = ` apply to every ${TILE_NAMES[ch]} cell`;
  pop.hidden = false;
  const x = Math.min(e.clientX + 10, window.innerWidth - pop.offsetWidth - 10);
  const y = Math.min(e.clientY + 10, window.innerHeight - pop.offsetHeight - 10);
  pop.style.left = `${x}px`; pop.style.top = `${y}px`;
  input.focus(); input.select();
}
function closePopover() { $("#popover").hidden = true; popoverCell = null; }
function bindPopover() {
  $$(".pop-quick button").forEach((b) => (b.onclick = () => ($("#reward-input").value = b.dataset.v)));
  $("#reward-cancel").onclick = closePopover;
  $("#reward-ok").onclick = submitReward;
  $("#reward-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitReward();
    if (e.key === "Escape") closePopover();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!$("#popover").hidden && !e.target.closest("#popover") && !e.target.closest(".tile")) closePopover();
  });
}
async function submitReward() {
  const s = popoverCell;
  if (s === null) return;
  const v = parseFloat($("#reward-input").value);
  if (!Number.isFinite(v)) { toast("Please enter a number."); return; }
  const ch = letterAt(s);
  const rewards = S.rewards.map((r) => r.slice());
  if ($("#reward-all").checked) {
    S.desc.forEach((row, i) => [...row].forEach((x, j) => { if (x === ch || (ch === "F" && x === "S") || (ch === "S" && x === "F")) rewards[i][j] = v; }));
  } else {
    rewards[Math.floor(s / ncol())][s % ncol()] = v;
  }
  closePopover();
  await run(async () => {
    const st = await api("config", { rewards });
    S.rewards = st.rewards;
    renderTiles();
  });
}

// ---------------------------------------------------------------- init
(async function init() {
  setCharacter(character);
  bindControls();
  bindPopover();
  try {
    presets = await (await fetch("/api/presets")).json();
    const sel = $("#preset");
    Object.keys(presets).forEach((k) => sel.add(new Option(k, k)));
    applyState(await api("state"));
  } catch (e) {
    toast(`Could not reach the server: ${e.message}`, 6000);
  }
})();
