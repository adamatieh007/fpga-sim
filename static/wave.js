// wave.js - waveform viewer (canvas) + VCD parser.
//
// A "row" is { label, width, tr: [[time, value], ...], kind?, expanded? }
//   time  : number (cycles in live mode, ns in VCD mode), sorted ascending
//   value : string of bit characters, MSB first ("0101", "X", "Z", ...)
// kind "clock" draws a synthetic clock (one period = 1 time unit).

const NAME_W = 170;
const VALUE_W = 90;
const ROW_H = 24;
const RULER_H = 22;

function findIndex(tr, t) {
  // index of the last transition with time <= t (or -1)
  let lo = 0;
  let hi = tr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tr[mid][0] <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function formatValue(val, width, radix) {
  if (val === undefined || val === null) {
    return "";
  }
  if (width === 1) {
    return val;
  }
  if (/^[01]+$/.test(val)) {
    if (radix === "bin") {
      return val;
    }
    if (radix === "dec") {
      return BigInt("0b" + val).toString(10);
    }
    return BigInt("0b" + val).toString(16).toUpperCase().padStart(Math.ceil(width / 4), "0");
  }
  if (/^Z+$/.test(val)) {
    return "Z";
  }
  if (val.length <= 8) {
    return val;
  }
  return "X";
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) {
    if (m * p >= raw) {
      return m * p;
    }
  }
  return 10 * p;
}

class WaveView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.rows = [];
    this.now = 0;
    this.unit = "cycle";
    this.trunc = [];
    this.t0 = 0;
    this.scale = 20;          // pixels per time unit
    this.cursor = null;
    this.follow = true;
    this.radix = "hex";
    this.scrollY = 0;
    this.dirty = true;
    this.drag = null;
    this.onFollowChange = null;
    this.attachEvents();
    const self = this;
    function frame() {
      if (self.dirty) {
        self.draw();
        self.dirty = false;
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    new ResizeObserver(function resized() {
      self.dirty = true;
    }).observe(canvas.parentElement);
  }

  setModel(rows, unit, now) {
    this.rows = rows;
    this.unit = unit;
    this.now = now;
    this.dirty = true;
  }

  update(now) {
    this.now = now;
    if (this.follow) {
      const w = this.waveWidth();
      this.t0 = Math.max(0, now - w / this.scale * 0.9);
    }
    this.dirty = true;
  }

  waveWidth() {
    return Math.max(10, this.canvas.clientWidth - NAME_W - VALUE_W);
  }

  visibleRows() {
    const out = [];
    for (const r of this.rows) {
      out.push({ row: r, bit: null });
      if (r.expanded && r.width > 1) {
        for (let b = r.width - 1; b >= 0; b--) {
          out.push({ row: r, bit: b });
        }
      }
    }
    return out;
  }

  timeToX(t) {
    return NAME_W + VALUE_W + (t - this.t0) * this.scale;
  }

  xToTime(x) {
    return this.t0 + (x - NAME_W - VALUE_W) / this.scale;
  }

  formatTime(t) {
    if (this.unit === "cycle") {
      return Math.floor(t).toString();
    }
    if (t >= 1e6) {
      return (t / 1e6).toFixed(3) + " ms";
    }
    if (t >= 1e3) {
      return (t / 1e3).toFixed(3) + " us";
    }
    return (Math.round(t * 1000) / 1000) + " ns";
  }

  zoom(factor, anchorX) {
    const anchorT = this.xToTime(anchorX);
    this.scale = Math.min(400, Math.max(1e-6, this.scale * factor));
    this.t0 = Math.max(0, anchorT - (anchorX - NAME_W - VALUE_W) / this.scale);
    this.dirty = true;
  }

  zoomFit() {
    const end = Math.max(this.now, 1);
    this.scale = this.waveWidth() / end;
    this.t0 = 0;
    this.setFollow(false);
    this.dirty = true;
  }

  setFollow(v) {
    this.follow = v;
    if (this.onFollowChange) {
      this.onFollowChange(v);
    }
  }

  // segments of a row inside [ta, tb]: [[t, value], ...] starting at ta
  segments(row, bit, ta, tb) {
    const tr = row.tr;
    let i = findIndex(tr, ta);
    const out = [];
    let last = null;
    if (i < 0) {
      i = 0;
    } else {
      last = this.pick(tr[i][1], row.width, bit);
      out.push([ta, last]);
      i++;
    }
    for (; i < tr.length && tr[i][0] <= tb; i++) {
      const v = this.pick(tr[i][1], row.width, bit);
      if (v !== last) {
        out.push([tr[i][0], v]);
        last = v;
      }
    }
    return out;
  }

  pick(val, width, bit) {
    if (bit === null) {
      return val;
    }
    const idx = val.length - 1 - bit;
    if (idx < 0) {
      return val[0];
    }
    return val[idx];
  }

  valueAt(row, bit, t) {
    const i = findIndex(row.tr, t);
    if (i < 0) {
      return "";
    }
    return this.pick(row.tr[i][1], row.width, bit);
  }

  // ------------------------------------------------------------------ draw
  draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const W = c.parentElement.clientWidth;
    const H = c.parentElement.clientHeight;
    if (c.width !== Math.floor(W * dpr) || c.height !== Math.floor(H * dpr)) {
      c.width = Math.floor(W * dpr);
      c.height = Math.floor(H * dpr);
      c.style.width = W + "px";
      c.style.height = H + "px";
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#101418";
    g.fillRect(0, 0, W, H);
    g.font = "12px ui-monospace, Menlo, Consolas, monospace";
    g.textBaseline = "middle";

    const x0 = NAME_W + VALUE_W;
    const ta = this.t0;
    const tb = this.xToTime(W);

    // ruler + grid
    g.fillStyle = "#171d23";
    g.fillRect(0, 0, W, RULER_H);
    const step = niceStep(90 / this.scale);
    g.strokeStyle = "#222b33";
    g.fillStyle = "#8a98a6";
    g.lineWidth = 1;
    for (let t = Math.ceil(ta / step) * step; t <= tb; t += step) {
      const x = Math.round(this.timeToX(t)) + 0.5;
      g.beginPath();
      g.moveTo(x, RULER_H);
      g.lineTo(x, H);
      g.stroke();
      g.fillText(this.formatTime(t), x + 3, RULER_H / 2);
    }

    // truncated (decimated) ranges
    for (const [a, b] of this.trunc) {
      if (b < ta || a > tb) {
        continue;
      }
      const xa = Math.max(x0, this.timeToX(a));
      const xb = Math.min(W, this.timeToX(b));
      g.fillStyle = "rgba(255, 80, 80, 0.08)";
      g.fillRect(xa, RULER_H, xb - xa, H);
    }

    const vis = this.visibleRows();
    const maxScroll = Math.max(0, vis.length * ROW_H - (H - RULER_H));
    this.scrollY = Math.min(this.scrollY, maxScroll);
    g.save();
    g.beginPath();
    g.rect(0, RULER_H, W, H - RULER_H);
    g.clip();
    for (let r = 0; r < vis.length; r++) {
      const y = RULER_H + r * ROW_H - this.scrollY;
      if (y + ROW_H < RULER_H || y > H) {
        continue;
      }
      const { row, bit } = vis[r];
      if (r % 2 === 1) {
        g.fillStyle = "#12171c";
        g.fillRect(0, y, W, ROW_H);
      }
      // name
      if (bit === null) {
        g.fillStyle = "#d8e1ea";
      } else {
        g.fillStyle = "#8a98a6";
      }
      let name = row.label;
      if (bit !== null) {
        name = "   [" + bit + "]";
      } else if (row.width > 1) {
        let arrow = "▸ ";
        if (row.expanded) {
          arrow = "▾ ";
        }
        name = arrow + row.label + " [" + (row.width - 1) + ":0]";
      } else {
        name = "  " + row.label;
      }
      g.save();
      g.beginPath();
      g.rect(0, y, NAME_W - 4, ROW_H);
      g.clip();
      g.fillText(name, 6, y + ROW_H / 2);
      g.restore();
      // value at cursor
      if (this.cursor !== null && row.kind !== "clock") {
        const v = this.valueAt(row, bit, this.cursor);
        g.fillStyle = "#ffd479";
        let w = 1;
        if (bit === null) {
          w = row.width;
        }
        g.fillText(formatValue(v, w, this.radix).slice(0, 11), NAME_W + 4, y + ROW_H / 2);
      }
      // wave
      g.save();
      g.beginPath();
      g.rect(x0, y, W - x0, ROW_H);
      g.clip();
      if (row.kind === "clock") {
        this.drawClock(g, y, ta, tb);
      } else if (bit !== null || row.width === 1) {
        this.drawBit(g, this.segments(row, bit, ta, tb), y, W);
      } else {
        this.drawBus(g, this.segments(row, null, ta, tb), row.width, y, W);
      }
      g.restore();
    }
    g.restore();

    // column separators
    g.strokeStyle = "#2b3640";
    g.beginPath();
    g.moveTo(NAME_W + 0.5, 0);
    g.lineTo(NAME_W + 0.5, H);
    g.moveTo(x0 + 0.5, 0);
    g.lineTo(x0 + 0.5, H);
    g.stroke();

    // "now" marker
    const xn = this.timeToX(this.now);
    if (xn >= x0 && xn <= W) {
      g.strokeStyle = "#3fa7ff";
      g.setLineDash([4, 4]);
      g.beginPath();
      g.moveTo(xn + 0.5, RULER_H);
      g.lineTo(xn + 0.5, H);
      g.stroke();
      g.setLineDash([]);
    }

    // cursor
    if (this.cursor !== null) {
      const xc = this.timeToX(this.cursor);
      if (xc >= x0 && xc <= W) {
        g.strokeStyle = "#ffd479";
        g.beginPath();
        g.moveTo(xc + 0.5, 0);
        g.lineTo(xc + 0.5, H);
        g.stroke();
        let label = this.formatTime(this.cursor);
        if (this.unit === "cycle") {
          label += " cyc";
        }
        g.fillStyle = "#ffd479";
        g.fillRect(xc + 1, 2, g.measureText(label).width + 8, RULER_H - 4);
        g.fillStyle = "#101418";
        g.fillText(label, xc + 5, RULER_H / 2);
      }
    }

    g.fillStyle = "#8a98a6";
    if (this.unit === "cycle") {
      g.fillText("signal  (time in clock cycles)", 6, RULER_H / 2);
    } else {
      g.fillText("signal", 6, RULER_H / 2);
    }
  }

  drawClock(g, y, ta, tb) {
    const hiY = y + 5;
    const loY = y + ROW_H - 5;
    if (this.scale < 6) {
      g.fillStyle = "rgba(87, 214, 141, 0.35)";
      const xa = this.timeToX(Math.max(ta, 0));
      const xb = this.timeToX(Math.min(tb, this.now));
      g.fillRect(xa, hiY, xb - xa, loY - hiY);
      g.fillStyle = "#57d68d";
      g.fillText("clock (zoom in to see edges)", Math.max(xa, NAME_W + VALUE_W) + 6, y + ROW_H / 2);
      return;
    }
    g.strokeStyle = "#57d68d";
    g.lineWidth = 1.5;
    g.beginPath();
    const start = Math.max(0, Math.floor(ta));
    const end = Math.min(Math.ceil(tb), this.now);
    let first = true;
    for (let cyc = start; cyc < end; cyc++) {
      // low for the first half of the cycle, rising edge at cyc + 0.5
      const xa = this.timeToX(cyc);
      const xm = this.timeToX(cyc + 0.5);
      const xb = this.timeToX(cyc + 1);
      if (first) {
        g.moveTo(xa, loY);
        first = false;
      }
      g.lineTo(xm, loY);
      g.lineTo(xm, hiY);
      g.lineTo(xb, hiY);
      g.lineTo(xb, loY);
    }
    g.stroke();
    g.lineWidth = 1;
  }

  segEnd(segs, i, W) {
    if (i + 1 < segs.length) {
      return this.timeToX(segs[i + 1][0]);
    }
    return Math.min(W, this.timeToX(this.now));
  }

  drawBit(g, segs, y, W) {
    const hiY = y + 5;
    const loY = y + ROW_H - 5;
    const midY = y + ROW_H / 2;
    let prevY = null;
    g.lineWidth = 1.5;
    for (let i = 0; i < segs.length; i++) {
      const xa = this.timeToX(segs[i][0]);
      const xb = this.segEnd(segs, i, W);
      if (xb < xa) {
        continue;
      }
      const v = segs[i][1];
      if (v === "1" || v === "H") {
        g.strokeStyle = "#57d68d";
        this.line(g, xa, prevY, hiY, xb);
        prevY = hiY;
      } else if (v === "0" || v === "L") {
        g.strokeStyle = "#57d68d";
        this.line(g, xa, prevY, loY, xb);
        prevY = loY;
      } else if (v === "Z") {
        g.strokeStyle = "#e0c341";
        this.line(g, xa, null, midY, xb);
        prevY = null;
      } else {
        g.fillStyle = "rgba(255, 82, 82, 0.35)";
        g.fillRect(xa, hiY, xb - xa, loY - hiY);
        g.strokeStyle = "#ff5252";
        g.strokeRect(xa + 0.5, hiY + 0.5, xb - xa, loY - hiY);
        prevY = null;
      }
    }
    g.lineWidth = 1;
  }

  line(g, xa, prevY, yv, xb) {
    g.beginPath();
    if (prevY !== null && prevY !== yv) {
      g.moveTo(xa, prevY);
      g.lineTo(xa, yv);
    } else {
      g.moveTo(xa, yv);
    }
    g.lineTo(xb, yv);
    g.stroke();
  }

  drawBus(g, segs, width, y, W) {
    const top = y + 4;
    const bot = y + ROW_H - 4;
    const mid = y + ROW_H / 2;
    for (let i = 0; i < segs.length; i++) {
      const xa = this.timeToX(segs[i][0]);
      const xb = this.segEnd(segs, i, W);
      if (xb < xa) {
        continue;
      }
      const v = segs[i][1];
      const bad = !/^[01]+$/.test(v) && !/^Z+$/.test(v);
      const slope = Math.min(3, (xb - xa) / 2);
      g.beginPath();
      g.moveTo(xa, mid);
      g.lineTo(xa + slope, top);
      g.lineTo(xb - slope, top);
      g.lineTo(xb, mid);
      g.lineTo(xb - slope, bot);
      g.lineTo(xa + slope, bot);
      g.closePath();
      if (bad) {
        g.fillStyle = "rgba(255, 82, 82, 0.3)";
        g.fill();
        g.strokeStyle = "#ff5252";
      } else if (/^Z+$/.test(v)) {
        g.strokeStyle = "#e0c341";
      } else {
        g.fillStyle = "rgba(63, 167, 255, 0.12)";
        g.fill();
        g.strokeStyle = "#3fa7ff";
      }
      g.stroke();
      const text = formatValue(v, width, this.radix);
      const tw = g.measureText(text).width;
      const left = Math.max(xa, NAME_W + VALUE_W);
      if (xb - left > tw + 8) {
        g.fillStyle = "#d8e1ea";
        g.fillText(text, left + 5, mid);
      }
    }
  }

  // ---------------------------------------------------------------- events
  attachEvents() {
    const c = this.canvas;
    const self = this;

    function onWheel(ev) {
      ev.preventDefault();
      const rect = c.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      if (ev.shiftKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
        let d = ev.deltaX;
        if (ev.shiftKey) {
          d = ev.deltaY;
        }
        self.t0 = Math.max(0, self.t0 + d / self.scale);
        self.setFollow(false);
      } else if (x < NAME_W + VALUE_W) {
        self.scrollY = Math.max(0, self.scrollY + ev.deltaY);
      } else {
        let factor = 1.15;
        if (ev.deltaY > 0) {
          factor = 1 / 1.15;
        }
        self.zoom(factor, x);
        if (factor < 1) {
          // zooming out keeps following; zooming in to inspect stops it
        } else {
          self.setFollow(false);
        }
      }
      self.dirty = true;
    }

    function onDown(ev) {
      const rect = c.getBoundingClientRect();
      self.drag = { x: ev.clientX, y: ev.clientY, t0: self.t0, moved: false, startX: ev.clientX - rect.left, startY: ev.clientY - rect.top };
      c.setPointerCapture(ev.pointerId);
    }

    function onMove(ev) {
      if (!self.drag) {
        return;
      }
      const dx = ev.clientX - self.drag.x;
      if (Math.abs(dx) > 3) {
        self.drag.moved = true;
      }
      if (self.drag.moved && self.drag.startX > NAME_W + VALUE_W) {
        self.t0 = Math.max(0, self.drag.t0 - dx / self.scale);
        self.setFollow(false);
        self.dirty = true;
      }
    }

    function onUp() {
      if (!self.drag) {
        return;
      }
      const d = self.drag;
      self.drag = null;
      if (d.moved) {
        return;
      }
      if (d.startX < NAME_W) {
        const idx = Math.floor((d.startY - RULER_H + self.scrollY) / ROW_H);
        const vis = self.visibleRows();
        if (idx >= 0 && idx < vis.length && vis[idx].bit === null && vis[idx].row.width > 1) {
          vis[idx].row.expanded = !vis[idx].row.expanded;
        }
      } else if (d.startX > NAME_W + VALUE_W) {
        self.cursor = self.xToTime(d.startX);
      }
      self.dirty = true;
    }

    c.addEventListener("wheel", onWheel, { passive: false });
    c.addEventListener("pointerdown", onDown);
    c.addEventListener("pointermove", onMove);
    c.addEventListener("pointerup", onUp);
  }
}

// --------------------------------------------------------------------- VCD
function parseVCD(text) {
  const units = { s: 1e9, ms: 1e6, us: 1e3, ns: 1, ps: 1e-3, fs: 1e-6 };
  let tsNs = 1;
  const byId = {};
  const signals = [];
  const scope = [];
  let t = 0;
  let maxT = 0;

  const tsMatch = text.match(/\$timescale\s+(\d+)\s*(\w+)\s+\$end/);
  if (tsMatch) {
    tsNs = parseInt(tsMatch[1], 10) * (units[tsMatch[2]] || 1);
  }

  const defsEnd = text.indexOf("$enddefinitions");
  const header = text.slice(0, defsEnd);
  const body = text.slice(defsEnd).replace(/^\$enddefinitions\s+\$end/, "");

  const tokens = header.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "$scope") {
      scope.push(tokens[i + 2]);
      i += 3;
    } else if (tok === "$upscope") {
      scope.pop();
      i += 1;
    } else if (tok === "$var") {
      const width = parseInt(tokens[i + 2], 10);
      const id = tokens[i + 3];
      let ref = tokens[i + 4];
      let j = i + 5;
      while (tokens[j] !== "$end" && j < tokens.length) {
        if (!/^\[.*\]$/.test(tokens[j])) {
          ref += tokens[j];
        }
        j++;
      }
      ref = ref.replace(/\[.*\]$/, "");
      const sig = { path: scope.concat([ref]).join("."), label: ref, scope: scope.join("."), width: width, tr: [] };
      signals.push(sig);
      if (!byId[id]) {
        byId[id] = [];
      }
      byId[id].push(sig);
      i = j;
    }
  }

  function setVal(id, val) {
    const list = byId[id];
    if (!list) {
      return;
    }
    for (const s of list) {
      let v = val.toUpperCase();
      if (v.length < s.width) {
        let pad = "0";
        if (v[0] === "X" || v[0] === "Z") {
          pad = v[0];
        }
        v = pad.repeat(s.width - v.length) + v;
      }
      const tr = s.tr;
      if (tr.length && tr[tr.length - 1][0] === t) {
        tr[tr.length - 1][1] = v;
      } else if (!tr.length || tr[tr.length - 1][1] !== v) {
        tr.push([t, v]);
      }
    }
  }

  const lines = body.split("\n");
  for (let raw of lines) {
    const line = raw.trim();
    if (!line || line[0] === "$") {
      continue;
    }
    const c0 = line[0];
    if (c0 === "#") {
      t = parseInt(line.slice(1), 10) * tsNs;
      if (t > maxT) {
        maxT = t;
      }
    } else if (c0 === "b" || c0 === "B") {
      const sp = line.indexOf(" ");
      setVal(line.slice(sp + 1).trim(), line.slice(1, sp));
    } else if (c0 === "r" || c0 === "R") {
      const sp = line.indexOf(" ");
      setVal(line.slice(sp + 1).trim(), line.slice(1, sp));
    } else {
      setVal(line.slice(1), c0);
    }
  }
  return { signals: signals, end: maxT };
}
