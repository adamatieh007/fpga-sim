// app.js - glues together the editor, the board, the waveform and the server.

const OUTPUT_FIELDS = [
  // name, start index in the 83-char output string, width
  ["LEDR", 0, 18],
  ["LEDG", 18, 9],
  ["HEX0", 27, 7],
  ["HEX1", 34, 7],
  ["HEX2", 41, 7],
  ["HEX3", 48, 7],
  ["HEX4", 55, 7],
  ["HEX5", 62, 7],
  ["HEX6", 69, 7],
  ["HEX7", 76, 7],
];
const MAX_HISTORY = 200000;
const MAX_BATCH = 250000;

const $ = function byId(id) {
  return document.getElementById(id);
};

const state = {
  ws: null,
  connected: false,
  loaded: false,         // a design is compiled and the simulator is running
  running: false,        // clock is free-running
  awaiting: false,       // a step request is in flight
  inputsDirty: false,
  owed: 0,
  lastTick: performance.now(),
  now: 0,                // current cycle
  rateWindowStart: performance.now(),
  rateCycles: 0,
  rate: 0,
  lastOutputs: null,
  liveRows: [],
  rowByName: {},
  liveTrunc: [],
  vcd: null,
  vcdText: null,
  vcdSelected: new Set(),
  errorLines: [],
  consoleErrors: 0,
};

// ------------------------------------------------------------------ editor
let cm = null;
let fallbackArea = null;

function initEditor() {
  const host = $("editor");
  if (window.CodeMirror) {
    cm = CodeMirror(host, {
      lineNumbers: true,
      theme: "material-darker",
      mode: "vhdl",
      indentUnit: 2,
      tabSize: 2,
      matchBrackets: true,
      extraKeys: {
        "Tab": function indentWithSpaces(editor) {
          editor.replaceSelection("  ");
        },
        "Ctrl-Enter": compile,
        "Cmd-Enter": compile,
      },
    });
    cm.on("change", saveCode);
  } else {
    fallbackArea = document.createElement("textarea");
    fallbackArea.className = "fallback";
    fallbackArea.spellcheck = false;
    host.appendChild(fallbackArea);
    fallbackArea.addEventListener("input", saveCode);
    logLine("CodeMirror could not be loaded from the CDN (offline?). Using a plain text editor.", "warn");
  }
}

function getCode() {
  if (cm) {
    return cm.getValue();
  }
  return fallbackArea.value;
}

function setCode(text) {
  if (cm) {
    cm.setValue(text);
  } else {
    fallbackArea.value = text;
  }
}

function setEditorMode(lang) {
  if (cm) {
    if (lang === "vhdl") {
      cm.setOption("mode", "vhdl");
    } else {
      cm.setOption("mode", "text/x-systemverilog");
    }
  }
  if (lang === "vhdl") {
    $("fileName").textContent = "design.vhd";
  } else {
    $("fileName").textContent = "design.sv";
  }
}

function clearErrorMarks() {
  if (cm) {
    for (const ln of state.errorLines) {
      cm.removeLineClass(ln, "background", "cm-error-line");
    }
  }
  state.errorLines = [];
}

function markErrorLine(lineNo) {
  if (cm && lineNo >= 1 && lineNo <= cm.lineCount()) {
    cm.addLineClass(lineNo - 1, "background", "cm-error-line");
    state.errorLines.push(lineNo - 1);
  }
}

function jumpToLine(lineNo) {
  if (cm) {
    cm.setCursor({ line: lineNo - 1, ch: 0 });
    cm.scrollIntoView({ line: lineNo - 1, ch: 0 }, 100);
    cm.focus();
  }
}

function saveCode() {
  try {
    localStorage.setItem("fpgasim.code." + $("lang").value, getCode());
  } catch (e) {
    // storage unavailable; ignore
  }
}

function loadSavedCode(lang) {
  try {
    return localStorage.getItem("fpgasim.code." + lang);
  } catch (e) {
    return null;
  }
}

async function loadExample(name) {
  const lang = $("lang").value;
  let ext = ".v";
  if (lang === "vhdl") {
    ext = ".vhd";
  }
  const res = await fetch("/static/examples/" + name + ext);
  setCode(await res.text());
}

// ----------------------------------------------------------------- console
function logLine(text, level) {
  const box = $("console");
  for (const ln of String(text).split("\n")) {
    const div = document.createElement("div");
    div.className = "line " + (level || "info");
    if (ln.startsWith("$ ")) {
      div.className = "line cmd";
    }
    const m = ln.match(/design\.(?:vhd|sv):(\d+)/);
    if (m) {
      const lineNo = parseInt(m[1], 10);
      div.classList.add("jump");
      div.title = "Jump to line " + lineNo;
      div.addEventListener("click", function jump() {
        jumpToLine(lineNo);
      });
      if (/error/i.test(ln)) {
        markErrorLine(lineNo);
      }
    }
    div.textContent = ln;
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
  if (level === "error" || level === "warn") {
    if (!$("tab-console").classList.contains("hidden")) {
      return;
    }
    state.consoleErrors += 1;
    $("consoleBadge").textContent = state.consoleErrors;
    $("consoleBadge").classList.remove("hidden");
  }
}

function setStatus(text, kind) {
  $("statusText").textContent = text;
  $("status").className = "status " + (kind || "");
}

// ------------------------------------------------------------------ server
function connect() {
  let proto = "ws:";
  if (location.protocol === "https:") {
    proto = "wss:";
  }
  const ws = new WebSocket(proto + "//" + location.host + "/ws");
  state.ws = ws;
  ws.onopen = function opened() {
    state.connected = true;
    setStatus("connected", "ok");
  };
  ws.onclose = function closed() {
    state.connected = false;
    state.loaded = false;
    state.running = false;
    state.awaiting = false;
    updateButtons();
    setStatus("disconnected - is server.py running? retrying...", "err");
    setTimeout(connect, 1500);
  };
  ws.onmessage = function received(ev) {
    handleMessage(JSON.parse(ev.data));
  };
}

function send(obj) {
  if (state.ws && state.connected) {
    state.ws.send(JSON.stringify(obj));
  }
}

function handleMessage(msg) {
  if (msg.type === "hello") {
    const missing = [];
    if (!msg.tools.ghdl) {
      missing.push("GHDL (needed for VHDL)");
    }
    if (!msg.tools.iverilog) {
      missing.push("Icarus Verilog (needed for Verilog)");
    }
    if (missing.length) {
      logLine("Not installed on the server: " + missing.join(", ") + ". See README.md.", "warn");
    }
  } else if (msg.type === "console") {
    logLine(msg.text, msg.level);
  } else if (msg.type === "compile_error") {
    logLine(msg.text, "error");
    setStatus("compile failed", "err");
    showTab("console");
    state.loaded = false;
    updateButtons();
  } else if (msg.type === "ready") {
    onReady(msg);
  } else if (msg.type === "out") {
    onOutput(msg);
  } else if (msg.type === "sim_error") {
    logLine(msg.text, "error");
    setStatus("simulation error", "err");
    state.loaded = false;
    state.running = false;
    state.awaiting = false;
    updateButtons();
  } else if (msg.type === "vcd") {
    onVcd(msg.text);
  } else if (msg.type === "stopped") {
    state.loaded = false;
    state.running = false;
    state.awaiting = false;
    updateButtons();
    board.setClockStatus(false, "stopped");
    if (state.connected && !state.vcd) {
      setStatus("stopped", "ok");
    }
  }
}

// ------------------------------------------------------------- compile/run
function compile() {
  if (!state.connected) {
    logLine("Not connected to the server.", "error");
    return;
  }
  clearErrorMarks();
  $("console").innerHTML = "";
  state.consoleErrors = 0;
  $("consoleBadge").classList.add("hidden");
  state.loaded = false;
  state.running = false;
  state.awaiting = false;
  updateButtons();
  setStatus("compiling...", "busy");
  board.clearOutputs();
  resetLive();
  state.vcd = null;
  state.vcdText = null;
  $("waveSource").value = "live";
  $("waveSource").options[1].disabled = true;
  showWaveSource();
  send({
    type: "compile",
    lang: $("lang").value,
    code: getCode(),
    top: $("top").value,
    vcd: $("recordVcd").checked,
  });
}

function onReady(msg) {
  state.loaded = true;
  state.now = 0;
  state.owed = 0;
  state.lastTick = performance.now();
  setStatus("running " + msg.top, "ok");
  const used = [];
  for (const p of msg.ports) {
    if (p.board) {
      used.push(p.name);
    }
  }
  $("simInfo").textContent = msg.top + ": " + used.join(", ");
  state.inputsDirty = true;
  state.running = true;
  updateButtons();
}

function stopSim() {
  state.running = false;
  send({ type: "stop" });
  if ($("recordVcd").checked) {
    setStatus("stopping, loading recorded waveform...", "busy");
  }
}

function updateButtons() {
  $("btnRun").disabled = !state.loaded;
  $("btnStep").disabled = !state.loaded || state.running;
  $("btnStop").disabled = !state.loaded;
  if (state.running) {
    $("btnRun").textContent = "Pause";
    $("btnRun").classList.add("running");
  } else {
    $("btnRun").textContent = "Run";
    $("btnRun").classList.remove("running");
  }
}

function toggleRun() {
  state.running = !state.running;
  state.owed = 0;
  state.lastTick = performance.now();
  if (!state.running) {
    board.setClockStatus(false, "paused at cycle " + state.now);
  }
  updateButtons();
}

function stepOnce() {
  if (!state.loaded || state.awaiting) {
    return;
  }
  let n = parseInt($("stepN").value, 10);
  if (!(n >= 1)) {
    n = 1;
  }
  sendStep(Math.min(n, MAX_BATCH));
}

function sendStep(n) {
  state.awaiting = true;
  state.inputsDirty = false;
  send({ type: "step", n: n, sw: board.swString(), key: board.keyString() });
}

// main loop: turns "clock speed" into batches of cycles
function tick() {
  const t = performance.now();
  const dt = (t - state.lastTick) / 1000;
  state.lastTick = t;
  if (!state.loaded) {
    return;
  }
  const speed = parseInt($("speed").value, 10);
  if (state.running) {
    state.owed += speed * dt;
    // if the simulator can't keep up, drop the backlog instead of lagging forever
    if (state.owed > Math.max(speed * 0.25, 2)) {
      state.owed = Math.max(speed * 0.25, 2);
    }
  }
  if (state.awaiting) {
    return;
  }
  let n = 0;
  if (state.running) {
    n = Math.min(Math.floor(state.owed), MAX_BATCH);
    state.owed -= n;
  }
  if (n > 0 || state.inputsDirty) {
    sendStep(n);
  }

  if (t - state.rateWindowStart > 1000) {
    state.rate = state.rateCycles * 1000 / (t - state.rateWindowStart);
    state.rateCycles = 0;
    state.rateWindowStart = t;
    if (state.running) {
      let txt = "cycle " + state.now.toLocaleString() + "  |  " + formatHz(state.rate);
      if (state.rate < speed * 0.8 && speed > 1000) {
        txt += " (sim can't keep up with " + formatHz(speed) + ")";
      }
      board.setClockStatus(true, txt);
    }
  }
}

function formatHz(f) {
  if (f >= 1e6) {
    return (f / 1e6).toFixed(2) + " MHz";
  }
  if (f >= 1e3) {
    return (f / 1e3).toFixed(1) + " kHz";
  }
  return f.toFixed(1) + " Hz";
}

// ------------------------------------------------------------ live waveform
function resetLive() {
  state.liveRows = [{ label: "CLOCK_50", width: 1, kind: "clock", tr: [] }];
  state.rowByName = {};
  const defs = [["SW", 18], ["KEY", 4]];
  for (const f of OUTPUT_FIELDS) {
    defs.push([f[0], f[2]]);
  }
  for (const [name, w] of defs) {
    const row = { label: name, width: w, tr: [] };
    if (name === "KEY") {
      row.expanded = true;
    }
    state.liveRows.push(row);
    state.rowByName[name] = row;
  }
  state.liveTrunc = [];
  state.now = 0;
  state.lastOutputs = null;
  if ($("waveSource").value === "live") {
    wave.setModel(state.liveRows, "cycle", 0);
    wave.trunc = state.liveTrunc;
    wave.t0 = 0;
    wave.cursor = null;
  }
}

function pushTr(row, t, v) {
  const tr = row.tr;
  if (tr.length) {
    const last = tr[tr.length - 1];
    if (last[1] === v) {
      return;
    }
    if (last[0] >= t) {
      last[1] = v;
      return;
    }
  }
  tr.push([t, v]);
  if (tr.length > MAX_HISTORY) {
    tr.splice(0, MAX_HISTORY / 4);
  }
}

function pushOutputs(t, bits) {
  for (const [name, start, w] of OUTPUT_FIELDS) {
    pushTr(state.rowByName[name], t, bits.substr(start, w));
  }
  state.lastOutputs = bits;
}

function onOutput(msg) {
  state.awaiting = false;
  const base = msg.base;
  pushTr(state.rowByName["SW"], base, msg.sw);
  pushTr(state.rowByName["KEY"], base, msg.key);
  let lastK = 0;
  for (const [k, bits] of msg.changes) {
    // cycle k's rising edge is drawn at base + k - 0.5
    let t = base;
    if (k > 0) {
      t = base + k - 0.5;
    }
    pushOutputs(t, bits);
    lastK = k;
  }
  if (msg.final && msg.final !== state.lastOutputs) {
    let t = base;
    if (msg.n > 0) {
      t = base + msg.n - 0.5;
    }
    pushOutputs(t, msg.final);
  }
  if (msg.changes.length >= 256) {
    state.liveTrunc.push([base + lastK, base + msg.n]);
    if (state.liveTrunc.length > 2000) {
      state.liveTrunc.splice(0, 500);
    }
  }
  state.now = base + msg.n;
  state.rateCycles += msg.n;
  if (msg.final) {
    board.setOutputs(msg.final);
  }
  if ($("waveSource").value === "live") {
    wave.update(state.now);
  }
  if (!state.running) {
    board.setClockStatus(false, "paused at cycle " + state.now.toLocaleString());
  }
}

// ------------------------------------------------------------- VCD waveform
function onVcd(text) {
  try {
    state.vcd = parseVCD(text);
  } catch (e) {
    logLine("Could not parse VCD: " + e, "error");
    return;
  }
  state.vcdText = text;
  state.vcdSelected = new Set();
  for (const s of state.vcd.signals) {
    // default: everything declared directly inside your top-level design
    if (/\.dut$/.test(s.scope) && state.vcdSelected.size < 60) {
      state.vcdSelected.add(s.path);
    }
  }
  $("waveSource").options[1].disabled = false;
  $("waveSource").value = "vcd";
  buildSignalList();
  showWaveSource();
  wave.zoomFit();
  logLine("Recorded waveform loaded: " + state.vcd.signals.length + " signals. Use Signals... to choose which to show.");
  setStatus("stopped - recorded waveform loaded", "ok");
  showTab("wave");
}

function buildSignalList() {
  const list = $("signalList");
  list.innerHTML = "";
  if (!state.vcd) {
    return;
  }
  const filter = $("signalFilter").value.toLowerCase();
  let lastScope = null;
  for (const s of state.vcd.signals) {
    if (filter && s.path.toLowerCase().indexOf(filter) < 0) {
      continue;
    }
    if (s.scope !== lastScope) {
      const h = document.createElement("div");
      h.className = "scope";
      h.textContent = s.scope;
      list.appendChild(h);
      lastScope = s.scope;
    }
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.vcdSelected.has(s.path);
    cb.addEventListener("change", function toggleSignal() {
      if (cb.checked) {
        state.vcdSelected.add(s.path);
      } else {
        state.vcdSelected.delete(s.path);
      }
      showWaveSource();
    });
    lab.appendChild(cb);
    let suffix = "";
    if (s.width > 1) {
      suffix = " [" + (s.width - 1) + ":0]";
    }
    lab.appendChild(document.createTextNode(" " + s.label + suffix));
    list.appendChild(lab);
  }
}

function showWaveSource() {
  const src = $("waveSource").value;
  if (src === "vcd" && state.vcd) {
    const rows = [];
    for (const s of state.vcd.signals) {
      if (state.vcdSelected.has(s.path)) {
        rows.push(s);
      }
    }
    wave.setModel(rows, "ns", state.vcd.end);
    wave.trunc = [];
    wave.setFollow(false);
    $("btnSignals").classList.remove("hidden");
    $("downloadVcd").classList.remove("hidden");
    $("clearWave").classList.add("hidden");
  } else {
    wave.setModel(state.liveRows, "cycle", state.now);
    wave.trunc = state.liveTrunc;
    $("btnSignals").classList.add("hidden");
    $("signalPicker").classList.add("hidden");
    $("downloadVcd").classList.add("hidden");
    $("clearWave").classList.remove("hidden");
    if (wave.scale < 0.01 || wave.scale > 400) {
      wave.scale = 20;
    }
  }
}

function downloadVcd() {
  if (!state.vcdText) {
    return;
  }
  const blob = new Blob([state.vcdText], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "wave.vcd";
  a.click();
  URL.revokeObjectURL(a.href);
}

// -------------------------------------------------------------------- tabs
function showTab(name) {
  for (const b of document.querySelectorAll(".tab")) {
    if (b.dataset.tab === name) {
      b.classList.add("active");
    } else {
      b.classList.remove("active");
    }
  }
  if (name === "wave") {
    $("tab-wave").classList.remove("hidden");
    $("tab-console").classList.add("hidden");
    $("waveTools").classList.remove("hidden");
    wave.dirty = true;
  } else {
    $("tab-wave").classList.add("hidden");
    $("tab-console").classList.remove("hidden");
    $("waveTools").classList.add("hidden");
    state.consoleErrors = 0;
    $("consoleBadge").classList.add("hidden");
  }
}

// -------------------------------------------------------------------- init
function onBoardInput() {
  state.inputsDirty = true;
}

const board = new Board($("board"), onBoardInput);
const wave = new WaveView($("wave"));

function onFollowChange(v) {
  $("follow").checked = v;
}
wave.onFollowChange = onFollowChange;

function onLangChange() {
  const lang = $("lang").value;
  setEditorMode(lang);
  const saved = loadSavedCode(lang);
  if (saved) {
    setCode(saved);
  } else {
    loadExample("counter");
  }
  try {
    localStorage.setItem("fpgasim.lang", lang);
  } catch (e) {
    // ignore
  }
}

function onExampleChange() {
  const name = $("example").value;
  if (name) {
    loadExample(name);
  }
  $("example").value = "";
}

function onTabClick(ev) {
  showTab(ev.currentTarget.dataset.tab);
}

function onZoomIn() {
  wave.zoom(1.6, NAME_W + VALUE_W + wave.waveWidth() / 2);
}

function onZoomOut() {
  wave.zoom(1 / 1.6, NAME_W + VALUE_W + wave.waveWidth() / 2);
}

function onFollowToggle() {
  wave.setFollow($("follow").checked);
  wave.update(wave.now);
}

function onRadixChange() {
  wave.radix = $("radix").value;
  wave.dirty = true;
}

function onSignalsButton() {
  $("signalPicker").classList.toggle("hidden");
}

function onGlobalKey(ev) {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
    ev.preventDefault();
    compile();
  }
}

function init() {
  initEditor();
  let lang = "vhdl";
  try {
    lang = localStorage.getItem("fpgasim.lang") || "vhdl";
  } catch (e) {
    // ignore
  }
  $("lang").value = lang;
  onLangChange();

  $("lang").addEventListener("change", onLangChange);
  $("example").addEventListener("change", onExampleChange);
  $("btnCompile").addEventListener("click", compile);
  $("btnRun").addEventListener("click", toggleRun);
  $("btnStep").addEventListener("click", stepOnce);
  $("btnStop").addEventListener("click", stopSim);
  $("zoomIn").addEventListener("click", onZoomIn);
  $("zoomOut").addEventListener("click", onZoomOut);
  $("zoomFit").addEventListener("click", wave.zoomFit.bind(wave));
  $("clearWave").addEventListener("click", resetLiveKeepTime);
  $("follow").addEventListener("change", onFollowToggle);
  $("radix").addEventListener("change", onRadixChange);
  $("waveSource").addEventListener("change", showWaveSource);
  $("btnSignals").addEventListener("click", onSignalsButton);
  $("signalFilter").addEventListener("input", buildSignalList);
  $("downloadVcd").addEventListener("click", downloadVcd);
  for (const b of document.querySelectorAll(".tab")) {
    b.addEventListener("click", onTabClick);
  }
  document.addEventListener("keydown", onGlobalKey);

  board.clearOutputs();
  resetLive();
  connect();
  setInterval(tick, 16);
}

function resetLiveKeepTime() {
  const now = state.now;
  const outs = state.lastOutputs;
  resetLive();
  state.now = now;
  if (outs) {
    pushOutputs(now, outs);
  }
  pushTr(state.rowByName["SW"], now, board.swString());
  pushTr(state.rowByName["KEY"], now, board.keyString());
  wave.t0 = now;
  wave.update(now);
}

init();
