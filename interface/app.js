// Watch — Trunk Recorder Pro's recorded calls with on-device transcripts.
//
// It looks and works like TRP's Listen page (the display and its buttons,
// Calls and Talkgroups), but what it does with a call is transcribe it: each
// new call that's wanted is fetched from the recorder (/calls/…, this page's
// origin) and sent to trp-watch-helper, which runs Apple's SpeechTranscriber
// on this Mac. The selection rules (systems and talkgroups on or off, hold,
// avoid) follow TRP's web/src/listen.ts.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { TrunkClient, duration, escapeHtml as esc } from "/api/client.js";

const QUEUE_MAX = 50;       // calls waiting for the helper (as Listen's queue)
const RECENT_MAX = 5;       // the display's Recent
const CALLS_MAX = 5000;
const CALLS_SHOWN = 500;
const OLDER_PAGE = 200;
const SAVED_MAX = 2000;     // transcripts kept in this browser
const TIMEOUT_MS = 120_000;

const $ = (id) => document.getElementById(id);
const load = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const keep = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* this session only */ } };

// ── state ────────────────────────────────────────────────────────────────────

const settings = { helperUrl: "http://127.0.0.1:8765", minSeconds: 0.5, feed: true, onlySelected: true, ...load("watch.settings", {}) };
const saveSettings = () => keep("watch.settings", settings);

/** What to transcribe, kept in this browser (Listen's Selection). Talkgroups are `<system>:<talkgroup>`. */
let sel = readSelection(load("watch.sel", null));
function readSelection(v) {
  const strings = (x) => (Array.isArray(x) ? x.filter((y) => typeof y === "string") : []);
  if (!v || typeof v !== "object") return { offSystems: [], offTalkgroups: [], hold: null, avoid: {} };
  return {
    offSystems: strings(v.offSystems),
    offTalkgroups: strings(v.offTalkgroups),
    hold: v.hold && typeof v.hold.system === "string" ? { system: v.hold.system, talkgroup: typeof v.hold.talkgroup === "number" ? v.hold.talkgroup : null } : null,
    avoid: v.avoid && typeof v.avoid === "object" ? { ...v.avoid } : {},
  };
}

/** path → { state: "queued" | "working" | "done" | "failed", text, confidence, error } */
const transcripts = new Map(load("watch.transcripts", []));
function saveTranscripts() {
  keep("watch.transcripts", [...transcripts].filter(([, t]) => t.state === "done").slice(-SAVED_MAX));
}

const rec = new TrunkClient({ historyLimit: 1000 });
let calls = [];             // every call known, newest first
let queue = [];             // waiting for the helper, oldest first
let working = null;         // the call at the helper now
let paused = false;
let missed = 0;
let current = null;         // the call in the display
let recent = [];            // transcribed, newest first (paths)
let loadingOlder = false, moreOlder = null;
let helper = { ok: false, text: "Helper…", level: "" };
let tab = "calls";

const audio = new Audio();
let playing = null, position = 0;

// ── which calls (TRP's listen.ts) ────────────────────────────────────────────

const systemOf = (c) => c.record.short_name || c.path.split("/")[0] || "";
const tgKey = (system, talkgroup) => `${system}:${talkgroup}`;
const systemOfKey = (key) => key.slice(0, key.lastIndexOf(":"));
const talkgroupsOf = (c) => [c.record.talkgroup, ...(c.record.patched_talkgroups ?? [])];
const playable = (c) => c.audio !== false && (!c.record.encrypted || !!c.record.decrypted);

function avoided(key, now = Date.now()) {
  const until = sel.avoid[key];
  return until !== undefined && (until === 0 || until > now);
}

function wanted(c, now = Date.now()) {
  if (!playable(c)) return false;
  const system = systemOf(c);
  if (sel.hold) return sel.hold.system === system && (sel.hold.talkgroup === null || talkgroupsOf(c).includes(sel.hold.talkgroup));
  if (sel.offSystems.includes(system)) return false;
  return talkgroupsOf(c).some((tg) => {
    const k = tgKey(system, tg);
    return !sel.offTalkgroups.includes(k) && !avoided(k, now);
  });
}

function setSelection(next) {
  sel = next;
  keep("watch.sel", sel);
  // What's queued follows the selection.
  const drop = queue.filter((c) => !wanted(c));
  for (const c of drop) transcripts.delete(c.path);
  queue = queue.filter((c) => wanted(c));
  draw();
}

function setSystemOn(system, on) {
  const off = sel.offSystems.filter((x) => x !== system);
  setSelection({ ...sel, offSystems: on ? off : [...off, system] });
}

/** Switch talkgroups on or off together; switched on in a system that's off, the system comes on with only them. */
function setTalkgroupsOn(keys, on, known = []) {
  const drop = new Set(keys);
  let off = sel.offTalkgroups.filter((x) => !drop.has(x));
  if (!on) return setSelection({ ...sel, offTalkgroups: [...off, ...keys] });
  const waking = new Set(keys.map(systemOfKey).filter((x) => sel.offSystems.includes(x)));
  const others = known.filter((k) => !drop.has(k) && waking.has(systemOfKey(k)));
  off = [...new Set([...off, ...others])];
  const avoid = Object.fromEntries(Object.entries(sel.avoid).filter(([k]) => !drop.has(k)));
  setSelection({ ...sel, offSystems: sel.offSystems.filter((x) => !waking.has(x)), offTalkgroups: off, avoid });
}

function setAll(on, systems, keys) {
  setSelection({ ...sel, offSystems: on ? [] : systems, offTalkgroups: on ? [] : keys });
}

/** The call the buttons act on: the one in the display. */
const subject = () => current;

function holdSystem() {
  const c = subject();
  if (sel.hold && sel.hold.talkgroup === null) return setSelection({ ...sel, hold: null });
  if (c) setSelection({ ...sel, hold: { system: systemOf(c), talkgroup: null } });
}

function holdTalkgroup() {
  const c = subject();
  if (sel.hold && sel.hold.talkgroup !== null) return setSelection({ ...sel, hold: null });
  if (c) setSelection({ ...sel, hold: { system: systemOf(c), talkgroup: c.record.talkgroup } });
}

function avoid(minutes) {
  const c = subject();
  if (!c) return;
  const k = tgKey(systemOf(c), c.record.talkgroup);
  const now = Date.now();
  const { [k]: _, ...rest } = sel.avoid;
  for (const [key, until] of Object.entries(rest)) if (until && until <= now) delete rest[key];
  const again = minutes === 0 && avoided(k, now);
  setSelection({ ...sel, avoid: again ? rest : { ...rest, [k]: minutes ? now + minutes * 60_000 : 0 } });
}

function letGo(key) {
  const { [key]: _, ...rest } = sel.avoid;
  setSelection({ ...sel, avoid: rest });
}

/** Every system and talkgroup there is: talkgroup files, conventional channels, and what calls were heard on. */
function audioNotKept() {
  const c = rec.config;
  if (!c?.recording) return [];
  const kept = (o) => (o?.archiveWav ?? c.recording.archiveWav) || (o?.archiveM4a ?? c.recording.archiveM4a);
  return [...(c.systems ?? []), ...(c.conventional ?? [])].filter((x) => x.enabled !== false && !kept(x.recording)).map((x) => x.shortName);
}

function catalog() {
  const out = new Map();
  const silent = new Set(audioNotKept());
  const sys = (name) => out.get(name) ?? out.set(name, new Map()).get(name);
  const add = (m, name, t) => { if (!m.has(t.talkgroup)) m.set(t.talkgroup, { system: name, key: tgKey(name, t.talkgroup), ...t }); };
  for (const x of [...(rec.config?.systems ?? []), ...(rec.config?.conventional ?? [])]) {
    if (x.enabled === false || silent.has(x.shortName)) continue;
    const m = sys(x.shortName);
    for (const t of rec.talkgroups(x.shortName).values()) {
      add(m, x.shortName, { talkgroup: t.talkgroup, alphaTag: t.alphaTag, description: t.description, tag: t.tag, group: t.group });
    }
  }
  for (const c of calls) {
    const name = systemOf(c);
    if (silent.has(name)) continue;
    const r = c.record;
    add(sys(name), name, { talkgroup: r.talkgroup, alphaTag: r.talkgroup_tag ?? "", description: r.talkgroup_description ?? "", tag: r.talkgroup_group_tag ?? "", group: r.talkgroup_group ?? "" });
  }
  return new Map([...out].map(([name, m]) => [name, [...m.values()].sort((a, b) => a.talkgroup - b.talkgroup)]));
}

// ── transcribing ─────────────────────────────────────────────────────────────

function enqueue(c, { manual = false } = {}) {
  const t = transcripts.get(c.path);
  if (t && t.state !== "failed") return;
  if (!playable(c)) return;
  if (!manual && c.record.call_length < settings.minSeconds) return;
  transcripts.set(c.path, { state: "queued" });
  if (manual) queue.unshift(c); else queue.push(c);
  while (queue.length > QUEUE_MAX) {
    transcripts.delete(queue.shift().path);
    missed++;
  }
  draw();
  pump();
}

async function pump() {
  if (working || paused || !queue.length) return;
  const c = queue.shift();
  working = c;
  transcripts.set(c.path, { state: "working" });
  if (!current || settings.feed) current = c;
  draw();
  let t;
  try { t = await transcribe(c); } catch (e) { t = { state: "failed", error: e.message || String(e) }; }
  transcripts.set(c.path, t);
  if (t.state === "done") recent = [c.path, ...recent.filter((p) => p !== c.path)].slice(0, RECENT_MAX);
  working = null;
  saveTranscripts();
  draw();
  pump();
}

async function transcribe(c) {
  const wav = await fetch(rec.callUrl(c, "wav"));
  if (!wav.ok) return { state: "failed", error: wav.status === 404 ? "Audio is gone from the recordings folder" : `Audio: HTTP ${wav.status}` };
  const body = await wav.arrayBuffer();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${helperBase()}/transcribe?path=${encodeURIComponent(c.path)}`, {
      method: "POST",
      headers: { "Content-Type": wav.headers.get("Content-Type") || "audio/wav" },
      body,
      signal: ctrl.signal,
    });
  } catch {
    setHelper(false, "Helper not running", "bad");
    throw new Error(ctrl.signal.aborted ? "The helper took too long" : "The helper isn't running");
  } finally {
    clearTimeout(timer);
  }
  const r = await res.json().catch(() => ({ status: "error", message: `Helper: HTTP ${res.status}` }));
  if (r.status !== "ok") return { state: "failed", error: r.message || r.error || `Helper: HTTP ${res.status}` };
  return { state: "done", text: r.text ?? "", confidence: r.confidence ?? null };
}

const helperBase = () => settings.helperUrl.replace(/\/+$/, "");

function setHelper(ok, text, level) {
  helper = { ok, text, level };
  const el = $("helper-chip");
  el.textContent = text;
  el.className = `chip ${level}`;
}

async function checkHelper() {
  try {
    const r = await (await fetch(`${helperBase()}/health`, { cache: "no-store" })).json();
    if (r.speech === "ready") setHelper(true, `Speech ready · ${r.locale}`, "ok");
    else if (r.speech === "failed") setHelper(false, `Speech: ${r.lastError || "failed"}`, "bad");
    else setHelper(true, `Speech ${r.speech}…`, "warn");
  } catch {
    setHelper(false, "Helper not running", "bad");
  }
  drawHead();
}

// ── audio ────────────────────────────────────────────────────────────────────

function play(c) {
  if (playing?.path === c.path) { audio.pause(); playing = null; drawAll(); return; }
  playing = c;
  position = 0;
  audio.src = rec.callUrl(c, "wav");
  audio.play().catch(() => { playing = null; drawAll(); });
  drawAll();
}
audio.ontimeupdate = () => { position = audio.currentTime; drawProgress(); };
audio.onended = audio.onerror = () => { playing = null; position = 0; drawAll(); };

// ── drawing ──────────────────────────────────────────────────────────────────

const timeOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const mmss = (s) => duration(Math.max(0, s || 0));
const labelOf = (c) => c.record.talkgroup_tag || `TG ${c.record.talkgroup}`;
const startMs = (c) => c.record.start_time_ms ?? c.record.start_time * 1000;
const lengthS = (c) => (c.record.call_length_ms ?? c.record.call_length * 1000) / 1000;

function systemColor(name) {
  const k = rec.config?.systems?.findIndex((x) => x.shortName === name) ?? -1;
  if (k >= 0) return `var(--sys-${k % 6})`;
  return rec.config?.conventional?.some((x) => x.shortName === name) ? "var(--muted)" : "var(--line)";
}
const led = (color, blink = false) => `<span class="led${blink ? " blink" : ""}" style="background:${color};color:${color}" aria-hidden="true"></span>`;

function unitOf(c) {
  const u = c.record.srcList?.find((x) => x.src > 0);
  if (!u) return "";
  return rec.unitName(systemOf(c), u.src) || u.tag || u.tag_ota || String(u.src);
}

function drawHead() {
  const status = !rec.connected ? ["bad", "No link"] : !helper.ok ? ["bad", "No helper"] : settings.feed ? (paused ? ["off", "Paused"] : ["live", "Live"]) : ["off", "Feed off"];
  const waiting = queue.length + (working ? 1 : 0);
  $("scan-head").innerHTML = `
    <span class="scan-status ${status[0]}">${status[1]}</span>
    ${sel.hold ? `<span class="chip small">Holding ${esc(sel.hold.system)}${sel.hold.talkgroup !== null ? ` TG ${sel.hold.talkgroup}` : ""}</span>` : ""}
    <span class="spacer"></span>
    ${missed ? `<span class="small warn-text">${missed} missed</span>` : ""}
    <span class="mono small" title="Calls waiting to be transcribed">Q ${waiting}</span>`;
}

function transcriptBlock(c, cls) {
  if (!playable(c)) return `<div class="${cls} state">${c.record.encrypted ? "Encrypted" : "Audio not kept"}</div>`;
  const t = transcripts.get(c.path);
  if (!t) return `<div class="${cls} state">Not transcribed</div>`;
  if (t.state === "queued") return `<div class="${cls} state">Waiting…</div>`;
  if (t.state === "working") return `<div class="${cls} state">Transcribing…</div>`;
  if (t.state === "failed") return `<div class="${cls} err">${esc(t.error)}</div>`;
  return t.text ? `<div class="${cls}">${esc(t.text)}</div>` : `<div class="${cls} state">(no speech)</div>`;
}

function drawDisplay() {
  const c = current;
  if (!c) {
    // Drawn over an invisible call display of the same shape, so it's just as tall.
    $("display").innerHTML = `
      <div class="scan-display watch-steady">
        <div class="watch-skeleton" aria-hidden="true">
          <div class="scan-top"><span class="scan-sys">&nbsp;</span><span class="spacer"></span><span class="btn ghost small">Save</span></div>
          <div class="scan-label">&nbsp;</div>
          <div class="scan-sub">&nbsp;</div>
          <dl class="scan-fields"><div><dt>TGID</dt><dd>&nbsp;</dd></div><div><dt>Freq</dt><dd>&nbsp;</dd></div><div><dt>Unit</dt><dd>&nbsp;</dd></div><div><dt>Length</dt><dd>&nbsp;</dd></div></dl>
          <div class="scan-transcript">&nbsp;</div>
          <span class="scan-conf">&nbsp;</span>
          <div class="scan-progress"></div>
        </div>
        <div class="watch-idle">
          <div class="scan-label">${!rec.connected ? "No link" : !helper.ok ? "No helper" : settings.feed ? (paused ? "Paused" : "Watching…") : "Feed off"}</div>
          <div class="muted small">${!rec.connected ? "Not connected to the recorder."
            : !helper.ok ? "Start trp-watch-helper on this Mac to transcribe calls."
            : settings.feed ? "New calls are transcribed here as they're recorded."
            : "Press Live transcripts to transcribe calls as they're recorded, or pick one from the list."}</div>
        </div>
      </div>`;
    return;
  }
  const r = c.record;
  const system = systemOf(c);
  const sub = [r.talkgroup_description, r.talkgroup_group_tag, r.talkgroup_group].filter((x, i, a) => x && a.indexOf(x) === i);
  const t = transcripts.get(c.path);
  // Every line is drawn even when empty, so the display keeps its height and the buttons below stay put.
  const conf = `<span class="scan-conf">${t?.state === "done" && t.confidence != null ? `confidence ${Math.round(t.confidence * 100)}%` : "&nbsp;"}</span>`;
  const len = lengthS(c);
  $("display").innerHTML = `
    <div class="scan-display">
      <div class="scan-top">
        ${led(systemColor(system), working?.path === c.path)}
        <span class="scan-sys">${esc(system)}</span>
        ${r.emergency ? `<span class="badge bad">EMERG</span>` : ""}
        <span class="spacer"></span>
        <span class="mono muted">${timeOf(startMs(c))}</span>
        <a class="btn ghost small" href="${esc(rec.callUrl(c, "wav"))}" download title="Save this call's audio">Save</a>
      </div>
      <div class="scan-label" title="Talkgroup ${r.talkgroup}">${esc(labelOf(c))}</div>
      <div class="scan-sub">${sub.length ? esc(sub.join(" · ")) : "&nbsp;"}</div>
      <dl class="scan-fields">
        <div><dt>TGID</dt><dd class="mono">${r.talkgroup}</dd></div>
        <div><dt>Freq</dt><dd class="mono">${r.freq ? (r.freq / 1e6).toFixed(4) : "—"}</dd></div>
        <div><dt>Unit</dt><dd class="mono">${esc(unitOf(c) || "—")}</dd></div>
        <div><dt>Length</dt><dd class="mono" id="disp-len">${playing?.path === c.path ? `${mmss(position)} / ` : ""}${mmss(len)}</dd></div>
      </dl>
      ${transcriptBlock(c, "scan-transcript")}
      ${conf}
      <div class="scan-progress" id="progress" role="slider" aria-label="Position" aria-valuemin="0" aria-valuemax="${Math.round(len)}">
        <span style="width:0%;background:${systemColor(system)}"></span>
      </div>
    </div>`;
  drawProgress();
}

function drawProgress() {
  const bar = $("progress")?.firstElementChild;
  if (!bar || !current) return;
  const mine = playing?.path === current.path;
  const len = audio.duration || lengthS(current);
  bar.style.width = `${mine && len > 0 ? Math.min(100, (100 * position) / len) : 0}%`;
  const dd = $("disp-len");
  if (dd) dd.textContent = `${mine ? `${mmss(position)} / ` : ""}${mmss(lengthS(current))}`;
}

function drawControls() {
  const c = subject();
  const hold = sel.hold;
  const key = c ? tgKey(systemOf(c), c.record.talkgroup) : null;
  const isAvoided = key !== null && avoided(key);
  const timed = isAvoided && sel.avoid[key] !== 0;
  const t = c && transcripts.get(c.path);
  const set = (id, { on = false, disabled = false, label } = {}) => {
    const b = $(id);
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
    b.disabled = disabled;
    if (label) b.textContent = label;
  };
  $("feed").classList.toggle("on", settings.feed);
  $("feed").setAttribute("aria-pressed", String(settings.feed));
  $("feed-label").textContent = `Live transcripts ${settings.feed ? "on" : "off"}`;
  set("hold-sys", { on: hold?.talkgroup === null, disabled: !c && !hold });
  set("hold-tg", { on: hold !== null && hold?.talkgroup !== null, disabled: !c && !hold });
  set("pause", { on: paused, label: paused ? "Resume" : "Pause", disabled: !paused && !settings.feed && !queue.length });
  set("play", { on: !!playing && playing.path === c?.path, label: playing && playing.path === c?.path ? "Stop" : "Play", disabled: !c || !playable(c) });
  set("copy", { disabled: !(t?.state === "done" && t.text) });
  set("avoid", { on: isAvoided && !timed, label: isAvoided && !timed ? "Avoided" : "Avoid", disabled: !c });
  for (const b of document.querySelectorAll("[data-avoid]")) b.disabled = !c;
}

function drawRecent() {
  const rows = recent.map((p) => calls.find((c) => c.path === p)).filter(Boolean);
  $("recent").innerHTML = rows.length ? `<h2>Recent</h2>` + rows.map((c) => `
    <button class="scan-recent-row" data-path="${esc(c.path)}" title="Show it">
      <span class="mono muted">${timeOf(startMs(c))}</span>
      ${led(systemColor(systemOf(c)))}
      <span class="scan-recent-tg">${esc(labelOf(c))}</span>
      <span class="muted small">${esc(systemOf(c))}</span>
    </button>`).join("") : "";
}

function drawNoAudio() {
  const systems = audioNotKept();
  const one = systems.length === 1;
  $("no-audio").innerHTML = systems.length ? `
    <div class="banner subtle small"><span><b>${esc(systems.join(", "))}</b> ${one ? "isn't" : "aren't"} here: ${one ? "its" : "their"} calls' audio is deleted once the plugins are done with it (Keep .wav and Keep .m4a are off), so there's nothing to transcribe. To include ${one ? "it" : "them"}, turn on Keep .wav or Keep .m4a in Setup, under Archive on ${one ? "the system's" : "each system's"} card or on the Recording tab.</span></div>` : "";
}

function drawCalls() {
  const f = $("call-filter").value.trim().toLowerCase();
  const multi = new Set(calls.map(systemOf)).size > 1;
  const rows = calls.filter((c) => playable(c) && (!settings.onlySelected || wanted(c))
    && (!f || String(c.record.talkgroup).includes(f) || labelOf(c).toLowerCase().includes(f) || (c.record.talkgroup_description ?? "").toLowerCase().includes(f)));
  $("calls").innerHTML = rows.length === 0
    ? `<p class="empty">${calls.length ? "No calls match." : "No recorded calls yet."}</p>`
    : rows.slice(0, CALLS_SHOWN).map((c) => {
      const t = transcripts.get(c.path);
      const state = playing?.path === c.path ? "▶ playing" : t?.state === "queued" ? "queued" : t?.state === "working" ? "transcribing" : t?.state === "failed" ? "failed" : "";
      return `<li><button class="${current?.path === c.path ? "playing" : ""}" data-path="${esc(c.path)}"${current?.path === c.path ? ` aria-current="true"` : ""}>
        <span class="mono muted">${timeOf(startMs(c))}</span>
        ${led(systemColor(systemOf(c)))}
        <span class="lc-tg">
          <span class="lc-name">${esc(labelOf(c))}${c.record.emergency ? ` <span class="badge bad">EMERG</span>` : ""}</span>
          <span class="muted small lc-sub">${multi ? `${esc(systemOf(c))} · ` : ""}${esc(unitOf(c) || `TG ${c.record.talkgroup}`)}</span>
          ${t?.state === "done" ? (t.text ? `<span class="lc-text">${esc(t.text)}</span>` : `<span class="lc-text state">(no speech)</span>`) : t?.state === "failed" ? `<span class="lc-text err">${esc(t.error)}</span>` : ""}
        </span>
        <span class="mono small muted">${lengthS(c).toFixed(0)} s</span>
        <span class="lc-state small${t?.state === "failed" ? " err" : ""}">${state}</span>
      </button></li>`;
    }).join("");
  const oldest = calls.at(-1) ? startMs(calls.at(-1)) : undefined;
  $("more").innerHTML = `
    ${rows.length > CALLS_SHOWN ? `<span class="muted small">Showing the newest ${CALLS_SHOWN}. </span>` : ""}
    ${moreOlder === false ? `<span class="muted small">That's every call from the last 24 hours.</span>`
      : `<button class="btn ghost" id="load-older"${loadingOlder || !rec.connected ? " disabled" : ""}>${loadingOlder ? "Loading…" : "Load older"}</button>`}
    ${oldest !== undefined ? `<span class="muted small">Back to ${new Date(oldest).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}</span>` : ""}`;
}

function share(tgs) {
  const on = tgs.filter((t) => !sel.offSystems.includes(t.system) && !sel.offTalkgroups.includes(t.key)).length;
  return on === tgs.length ? "on" : on === 0 ? "off" : "some";
}

let cat = new Map();
function drawTalkgroups() {
  cat = catalog();
  const all = [...cat.values()].flat();
  const f = $("tg-find").value.trim().toLowerCase();
  const match = (t) => !f || String(t.talkgroup).includes(f) || `${t.alphaTag} ${t.description} ${t.tag} ${t.group}`.toLowerCase().includes(f);
  const now = Date.now();
  const avoids = Object.entries(sel.avoid).filter(([k]) => avoided(k, now));
  const name = (k) => { const t = all.find((x) => x.key === k); return t ? `${t.alphaTag || `TG ${t.talkgroup}`}${cat.size > 1 ? ` (${t.system})` : ""}` : k; };
  const chips = (title, by) => {
    const groups = new Map();
    for (const t of all) { const g = by(t); if (g) groups.set(g, [...(groups.get(g) ?? []), t]); }
    if (groups.size < 2) return "";
    return `<div class="tg-chips"><h2>${title}</h2><div class="filter-row">${[...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([g, list]) => {
      const st = share(list);
      return `<button class="btn ghost small chip3 ${st}" data-chip="${esc(title)}" data-name="${esc(g)}" aria-pressed="${st === "some" ? "mixed" : st === "on"}">${esc(g)}</button>`;
    }).join("")}</div></div>`;
  };
  $("tgs").innerHTML = `
    ${sel.hold ? `<div class="banner subtle"><span>Holding on ${esc(sel.hold.system)}${sel.hold.talkgroup !== null ? `, talkgroup ${sel.hold.talkgroup}` : ""}: only it is transcribed.</span><button class="btn ghost small" id="release">Release</button></div>` : ""}
    ${avoids.length ? `<div class="tg-chips"><h2>Avoided</h2><div class="filter-row">${avoids.map(([k, until]) => `<button class="btn ghost small" data-letgo="${esc(k)}" title="Transcribe it again">${esc(name(k))}<span class="muted"> ${until ? `until ${new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""} ✕</span></button>`).join("")}</div></div>` : ""}
    ${chips("Groups", (t) => t.group)}
    ${chips("Tags", (t) => t.tag)}
    ${[...cat].map(([system, tgs]) => {
      const sysOn = !sel.offSystems.includes(system);
      const shown = tgs.filter(match);
      const sites = rec.config?.systems?.find((x) => x.shortName === system)?.sites?.length ?? 0;
      if (f && !shown.length) return "";
      return `<div class="tg-system">
        <label class="tg-system-head">
          <input type="checkbox" data-system="${esc(system)}"${sysOn ? " checked" : ""}>
          ${led(systemColor(system))}
          <b>${esc(system)}</b>
          ${sites > 1 ? `<span class="chip small" title="A call is transcribed from whichever site it was kept from">${sites} sites</span>` : ""}
          <span class="muted small">${sysOn ? tgs.filter((t) => !sel.offTalkgroups.includes(t.key)).length : 0} of ${tgs.length} talkgroups</span>
        </label>
        <div class="tg-grid">${shown.map((t) => {
          const on = sysOn && !sel.offTalkgroups.includes(t.key);
          return `<label class="tg-cell${avoided(t.key, now) ? " avoided" : ""}" title="${esc([t.description, t.tag, t.group].filter(Boolean).join(" · "))}">
            <input type="checkbox" data-tg="${esc(t.key)}"${on ? " checked" : ""}>
            <span class="tg-cell-name">${esc(t.alphaTag || `TG ${t.talkgroup}`)}</span>
            <span class="mono muted small">${t.talkgroup}</span>
          </label>`;
        }).join("")}</div>
      </div>`;
    }).join("")}`;
  const off = sel.offSystems.length + sel.offTalkgroups.length;
  $("some-off").textContent = off ? " · some off" : "";
}

function drawAll() {
  drawHead(); drawDisplay(); drawControls(); drawRecent(); drawNoAudio();
  if (tab === "calls") drawCalls(); else drawTalkgroups();
  const off = sel.offSystems.length + sel.offTalkgroups.length;
  $("some-off").textContent = off ? " · some off" : "";
}

// Coalesce redraws: calls can conclude in bursts.
let pending = false;
function draw() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; drawAll(); });
}

// ── the recorder ─────────────────────────────────────────────────────────────

function merge(more) {
  const seen = new Set(calls.map((c) => c.path));
  const add = more.filter((c) => !seen.has(c.path));
  if (!add.length) return;
  calls = [...calls, ...add].sort((a, b) => startMs(b) - startMs(a)).slice(0, CALLS_MAX);
}

rec.on("history", (m) => { merge(m.entries); draw(); });
rec.on("concluded", (m) => {
  merge([m.entry]);
  if (settings.feed && helper.ok && wanted(m.entry)) enqueue(m.entry);
  else draw();
});
rec.on("olderCalls", (m) => { merge(m.entries); loadingOlder = false; moreOlder = m.more; draw(); });
rec.on("callFiles", (m) => {
  calls = calls.map((c) => (c.path === m.path ? { ...c, audio: m.audio, json: m.json } : c));
  draw();
});
rec.on("hello", (m) => { $("version").textContent = m.version ? `Trunk Recorder Pro v${m.version}` : ""; });
rec.on("config", () => draw());
rec.on("talkgroups", () => { if (tab === "talkgroups") draw(); });
rec.on("connection", (up) => {
  $("conn-chip").textContent = up ? "Recorder connected" : "Recorder offline";
  $("conn-chip").className = `chip ${up ? "ok" : "bad"}`;
  draw();
});

// ── the page's controls ──────────────────────────────────────────────────────

function show(c) {
  current = c;
  if (!transcripts.get(c.path) || transcripts.get(c.path).state === "failed") {
    transcripts.delete(c.path);
    enqueue(c, { manual: true });
  }
  draw();
}

$("feed").onclick = () => { settings.feed = !settings.feed; saveSettings(); draw(); };
$("hold-sys").onclick = holdSystem;
$("hold-tg").onclick = holdTalkgroup;
$("pause").onclick = () => { paused = !paused; draw(); pump(); };
$("play").onclick = () => current && play(current);
$("copy").onclick = async () => {
  const t = current && transcripts.get(current.path);
  if (!t?.text) return;
  try { await navigator.clipboard.writeText(t.text); } catch { /* not allowed here */ }
};
$("avoid").onclick = () => avoid(0);
for (const b of document.querySelectorAll("[data-avoid]")) b.onclick = () => avoid(Number(b.dataset.avoid));

$("display").addEventListener("click", (e) => {
  const bar = e.target.closest("#progress");
  if (!bar || !playing || playing.path !== current?.path || !audio.duration) return;
  const b = bar.getBoundingClientRect();
  audio.currentTime = ((e.clientX - b.left) / b.width) * audio.duration;
});

$("recent").addEventListener("click", (e) => {
  const row = e.target.closest("[data-path]");
  const c = row && calls.find((x) => x.path === row.dataset.path);
  if (c) show(c);
});

$("calls").addEventListener("click", (e) => {
  const row = e.target.closest("button[data-path]");
  const c = row && calls.find((x) => x.path === row.dataset.path);
  if (c) show(c);
});

$("more").addEventListener("click", (e) => {
  if (e.target.id !== "load-older" || loadingOlder) return;
  loadingOlder = true;
  rec.send({ type: "olderCalls", before: calls.at(-1) ? startMs(calls.at(-1)) : Date.now(), limit: OLDER_PAGE });
  draw();
});

$("tgs").addEventListener("change", (e) => {
  const el = e.target;
  if (el.dataset.system) setSystemOn(el.dataset.system, el.checked);
  else if (el.dataset.tg) setTalkgroupsOn([el.dataset.tg], el.checked, [...cat.values()].flat().map((t) => t.key));
});
$("tgs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.id === "release") return sel.hold?.talkgroup === null ? holdSystem() : holdTalkgroup();
  if (b.dataset.letgo) return letGo(b.dataset.letgo);
  if (b.dataset.chip) {
    const all = [...cat.values()].flat();
    const by = b.dataset.chip === "Groups" ? (t) => t.group : (t) => t.tag;
    const list = all.filter((t) => by(t) === b.dataset.name);
    setTalkgroupsOn(list.map((t) => t.key), share(list) !== "on", all.map((t) => t.key));
  }
});
$("all-on").onclick = () => setAll(true, [], []);
$("all-off").onclick = () => setAll(false, [...cat.keys()], [...cat.values()].flat().map((t) => t.key));

$("call-filter").oninput = () => drawCalls();
$("tg-find").oninput = () => drawTalkgroups();
$("only-selected").checked = settings.onlySelected;
$("only-selected").onchange = (e) => { settings.onlySelected = e.target.checked; saveSettings(); drawCalls(); };

function setTab(next) {
  tab = next;
  $("tab-calls").classList.toggle("on", tab === "calls");
  $("tab-tgs").classList.toggle("on", tab === "talkgroups");
  $("tab-calls").setAttribute("aria-selected", String(tab === "calls"));
  $("tab-tgs").setAttribute("aria-selected", String(tab === "talkgroups"));
  $("pane-calls").hidden = tab !== "calls";
  $("pane-tgs").hidden = tab !== "talkgroups";
  draw();
}
$("tab-calls").onclick = () => setTab("calls");
$("tab-tgs").onclick = () => setTab("talkgroups");

$("helper-url").value = settings.helperUrl;
$("helper-url").onchange = (e) => { settings.helperUrl = e.target.value.trim() || "http://127.0.0.1:8765"; saveSettings(); checkHelper(); };
$("min-seconds").value = settings.minSeconds;
$("min-seconds").onchange = (e) => { settings.minSeconds = Math.max(0, Number(e.target.value) || 0); saveSettings(); };
$("forget").onclick = () => {
  for (const [p, t] of transcripts) if (t.state === "done" || t.state === "failed") transcripts.delete(p);
  recent = [];
  saveTranscripts();
  draw();
};

// Timed avoids run out on their own: look again each minute.
setInterval(draw, 60_000);
checkHelper();
setInterval(checkHelper, 10_000);
drawAll();
