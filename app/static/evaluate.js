"use strict";

const DEFAULTS = {
  alpha: 0.5, gamma: 0.95, epsilon: 0.2, epsilon_decay: 1, q_init: 0,
  reward_ice: 0, reward_water: 0, reward_goal: 1, repeats: 20,
};
const PARAM_LABELS = [
  ["alpha", "α"], ["gamma", "γ"], ["epsilon", "ε"], ["epsilon_decay", "ε decay"], ["q_init", "Q₀"],
  ["reward_ice", "r ice"], ["reward_water", "r water"], ["reward_goal", "r yeti"],
];
const COLOR_CURRENT = "#2b6cb0", COLOR_BEST = "#d97706", INK = "#1d2b3a", MUTED = "#5d6f82", GRID = "#e3ebf3";
const CONDS = { normal: "normal ice", slippery: "slippery ice" };
const HKEY = "evalHistory", LASTKEY = "evalLastId", PKEY = "evalParams";

const $ = (s) => document.querySelector(s);
const form = $("#params");
let baseline = null;   // {maps, normal: {map: p}, slippery: {...}}
let history = JSON.parse(localStorage.getItem(HKEY) || "[]");
let currentId = +localStorage.getItem(LASTKEY) || null;

function toast(msg, ms = 3000) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}
const f2 = (v) => (+v).toFixed(2);
const pct = (v) => `${Math.round(v * 100)}%`;
const fmtP = (v) => (Number.isInteger(+v) ? `${+v}` : `${+(+v).toFixed(3)}`);

// ------------------------------------------------------------------ form
function readForm() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = parseFloat(form.elements[k].value);
  out.repeats = Math.round(out.repeats);
  return out;
}
function writeForm(p) {
  for (const k of Object.keys(DEFAULTS)) if (p[k] !== undefined) form.elements[k].value = p[k];
  syncOutputs();
}
function syncOutputs() {
  form.querySelectorAll("input[type=range]").forEach((i) => (i.nextElementSibling.textContent = (+i.value).toFixed(2)));
}

async function prefill() {
  const saved = JSON.parse(localStorage.getItem(PKEY) || "null");
  if (saved) return writeForm({ ...DEFAULTS, ...saved });
  writeForm(DEFAULTS);
  // otherwise start from the hyper-parameters used in the playground (same browser tab)
  const sid = sessionStorage.getItem("sid");
  if (!sid) return;
  try {
    const res = await fetch("/api/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid }) });
    if (res.ok) {
      const h = (await res.json()).hyper;
      writeForm({ alpha: h.alpha, gamma: h.gamma, epsilon: h.epsilon, epsilon_decay: h.epsilon_decay });
    }
  } catch {}
}

// ------------------------------------------------------------------ history
function save() {
  localStorage.setItem(HKEY, JSON.stringify(history));
  if (currentId) localStorage.setItem(LASTKEY, currentId); else localStorage.removeItem(LASTKEY);
}
function bestOf(cond) {
  return history.reduce((b, e) => (!b || e[cond].average > b[cond].average ? e : b), null);
}
function entryIndex(e) { return e.n ?? history.indexOf(e) + 1; }

function renderHistory() {
  const t = $("#history");
  if (!history.length) {
    t.innerHTML = `<tr><td class="empty">No evaluation yet.</td></tr>`;
    return;
  }
  const bn = bestOf("normal"), bs = bestOf("slippery");
  const maps = baseline ? baseline.maps : history[0].normal.maps.map((m) => m.map);
  let html = `<thead><tr><th>#</th><th>time</th>${PARAM_LABELS.map(([, l]) => `<th>${l}</th>`).join("")}<th>reps</th>
    <th class="num">normal<br>avg</th><th class="num">slippery<br>avg</th><th class="maps-col">per map (normal / slippery)</th><th></th></tr></thead><tbody>`;
  history.slice().reverse().forEach((e) => {
    const marks = (e === bn ? `<span class="star" title="best on normal ice">★</span>` : "") + (e === bs ? `<span class="star" title="best on slippery ice">❄</span>` : "");
    const perMap = maps.map((m, i) => `<span title="${m}">${f2(e.normal.maps[i].mean)}/${f2(e.slippery.maps[i].mean)}</span>`).join(" · ");
    html += `<tr class="${e.id === currentId ? "current" : ""}">
      <td>${entryIndex(e)} ${marks}</td>
      <td class="muted">${new Date(e.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
      ${PARAM_LABELS.map(([k]) => `<td>${fmtP(e.params[k])}</td>`).join("")}
      <td>${e.repeats}</td>
      <td class="num"><b>${f2(e.normal.average)}</b></td>
      <td class="num"><b>${f2(e.slippery.average)}</b></td>
      <td class="maps-col muted">${perMap}</td>
      <td class="actions"><button data-load="${e.id}">Load</button><button data-del="${e.id}" title="Delete">✕</button></td>
    </tr>`;
  });
  t.innerHTML = html + "</tbody>";
}

// ------------------------------------------------------------------ chart
function roundedTopBar(x, y, w, h, r = 4) {
  if (h <= 0) return "";
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function renderChart(cond) {
  const el = $(`#chart-${cond}`);
  const current = history.find((e) => e.id === currentId) || null;
  const best = bestOf(cond);
  const maps = baseline.maps;
  const W = 900, H = 260, mL = 46, mR = 12, mT = 22, mB = 34;
  const pw = W - mL - mR, ph = H - mT - mB;
  const Y = (v) => mT + (1 - v) * ph;
  const gw = pw / maps.length;
  const series = [];
  if (current) series.push({ key: "current", entry: current, color: COLOR_CURRENT, label: `This run (#${entryIndex(current)})` });
  if (best && best !== current) series.push({ key: "best", entry: best, color: COLOR_BEST, label: `Best (#${entryIndex(best)})` });
  const bw = Math.min(64, gw * 0.3), gap = 2;
  const groupW = series.length * bw + (series.length - 1) * gap;

  let svg = "";
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    svg += `<line x1="${mL}" x2="${W - mR}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 0 ? "#b8c6d4" : GRID}" stroke-width="1"/>`;
    svg += `<text x="${mL - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="12" fill="${MUTED}">${v.toFixed(2)}</text>`;
  }
  svg += `<text x="12" y="${mT + ph / 2}" font-size="12" fill="${MUTED}" transform="rotate(-90 12 ${mT + ph / 2})" text-anchor="middle">test reward (1 = yeti reached)</text>`;

  maps.forEach((m, i) => {
    const cx = mL + gw * (i + 0.5);
    const x0 = cx - groupW / 2;
    series.forEach((s, j) => {
      const r = s.entry[cond].maps[i];
      const x = x0 + j * (bw + gap);
      const y = Y(r.mean);
      svg += `<path d="${roundedTopBar(x, y, bw, Y(0) - y)}" fill="${s.color}"/>`;
      if (r.sem > 0) {
        const y1 = Y(Math.min(1, r.mean + r.sem)), y2 = Y(Math.max(0, r.mean - r.sem));
        svg += `<line x1="${x + bw / 2}" x2="${x + bw / 2}" y1="${y1}" y2="${y2}" stroke="${INK}" stroke-width="1.5" opacity=".55"/>`;
      }
      svg += `<text x="${x + bw / 2}" y="${Math.min(Y(Math.min(1, r.mean + r.sem)), y) - 6}" text-anchor="middle" font-size="12" font-weight="600" fill="${INK}">${f2(r.mean)}</text>`;
      svg += `<rect class="hit" x="${x - 1}" y="${mT}" width="${bw + 2}" height="${ph}" fill="transparent"
        data-tip="${encodeURIComponent(`<b>${m}</b> · ${CONDS[cond]}<br>${s.label}: <b>${f2(r.mean)}</b>${r.sem ? ` ± ${f2(r.sem)} (s.e.)` : ""}<br>yeti reached in ${pct(r.mean)} of the ${s.entry.repeats} test runs<br>random policy: ${baseline[cond][m].toFixed(3)}`)}"/>`;
    });
    // random baseline, dotted, across the group
    const half = Math.max(groupW, bw) / 2 + 12;
    const yr = Y(baseline[cond][m]);
    svg += `<line x1="${cx - half}" x2="${cx + half}" y1="${yr}" y2="${yr}" stroke="${INK}" stroke-width="2" stroke-dasharray="2 4" stroke-linecap="round"/>`;
    svg += `<rect class="hit" x="${cx - half}" y="${yr - 6}" width="${half * 2}" height="12" fill="transparent"
      data-tip="${encodeURIComponent(`<b>${m}</b> · ${CONDS[cond]}<br>random policy: <b>${baseline[cond][m].toFixed(4)}</b><br>(exact probability of reaching the yeti by moving at random)`)}"/>`;
    svg += `<text x="${cx}" y="${H - 10}" text-anchor="middle" font-size="13" fill="${INK}">${m}</text>`;
  });
  if (!series.length) {
    svg += `<text x="${mL + pw / 2}" y="${mT + ph / 2}" text-anchor="middle" font-size="14" fill="${MUTED}">Press “Evaluate” to test your parameters.</text>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Test reward per map on ${CONDS[cond]}">${svg}</svg>`;

  // legend
  const sw = (c) => `<i class="sw" style="background:${c}"></i>`;
  let leg = series.map((s) => `<span>${sw(s.color)}${s.label} · avg <b>${f2(s.entry[cond].average)}</b></span>`).join("");
  if (current && best === current) leg += `<span class="badge">this run is the best so far</span>`;
  leg += `<span><svg width="22" height="6"><line x1="1" x2="21" y1="3" y2="3" stroke="${INK}" stroke-width="2" stroke-dasharray="2 4" stroke-linecap="round"/></svg>random policy · avg <b>${avg(maps.map((m) => baseline[cond][m])).toFixed(3)}</b></span>`;
  $(`#legend-${cond}`).innerHTML = leg;

  // best parameter box
  const box = $(`#best-${cond}`);
  if (!best) { box.innerHTML = ""; return; }
  box.innerHTML = `<span class="best-title">Best parameters on ${CONDS[cond]} (#${entryIndex(best)}, average ${f2(best[cond].average)} over the 4 maps):</span>
    ${PARAM_LABELS.map(([k, l]) => `<span class="chip">${l} = ${fmtP(best.params[k])}</span>`).join("")}
    <button data-load="${best.id}">Load</button>`;
}
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;

function renderAll() {
  if (!baseline) return;
  renderChart("normal");
  renderChart("slippery");
  renderHistory();
}

// tooltips on chart marks
document.addEventListener("mousemove", (e) => {
  const tip = $("#tooltip");
  const hit = e.target.closest && e.target.closest(".hit");
  if (!hit) { tip.hidden = true; return; }
  tip.innerHTML = decodeURIComponent(hit.dataset.tip);
  tip.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${e.clientY + 14}px`;
});

// ------------------------------------------------------------------ actions
form.addEventListener("input", syncOutputs);
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  syncOutputs();
  const params = readForm();
  if (Object.values(params).some((v) => !Number.isFinite(v))) return toast("Please fill in every parameter.");
  localStorage.setItem(PKEY, JSON.stringify(params));
  const btn = $("#btn-eval");
  btn.disabled = true; btn.textContent = "Evaluating…";
  try {
    const res = await fetch("/api/evaluate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(Array.isArray(j.detail) ? j.detail.map((d) => `${d.loc.at(-1)}: ${d.msg}`).join(", ") : j.detail || res.statusText);
    }
    const r = await res.json();
    const strip = (c) => ({ average: c.average, maps: c.maps.map(({ map, mean, sem }) => ({ map, mean, sem })) });
    const n = history.reduce((m, h) => Math.max(m, entryIndex(h)), 0) + 1;
    const entry = { n, id: Date.now(), time: Date.now(), params: r.params, repeats: r.repeats, normal: strip(r.normal), slippery: strip(r.slippery) };
    history.push(entry);
    currentId = entry.id;
    save();
    renderAll();
  } catch (err) {
    toast(`Evaluation failed: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = "Evaluate ▸";
  }
});
$("#btn-defaults").onclick = () => writeForm(DEFAULTS);
$("#btn-clear").onclick = () => {
  if (!history.length || !confirm("Delete the whole evaluation history?")) return;
  history = []; currentId = null; save(); renderAll();
};
document.addEventListener("click", (e) => {
  const load = e.target.closest("[data-load]");
  if (load) {
    const entry = history.find((h) => h.id === +load.dataset.load);
    if (entry) { writeForm({ ...entry.params, repeats: entry.repeats }); toast(`Parameters of #${entryIndex(entry)} loaded. Press Evaluate to rerun them.`); window.scrollTo({ top: 0, behavior: "smooth" }); }
  }
  const del = e.target.closest("[data-del]");
  if (del) {
    history = history.filter((h) => h.id !== +del.dataset.del);
    if (!history.some((h) => h.id === currentId)) currentId = null;
    save(); renderAll();
  }
});

(async function init() {
  await prefill();
  try {
    baseline = await (await fetch("/api/random_baseline")).json();
  } catch (e) {
    toast("Could not reach the server.");
    return;
  }
  renderAll();
})();
