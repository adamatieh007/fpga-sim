// board.js - draws an interactive DE2-115 board as SVG.
//
// Output string layout (83 chars, MSB first in each field):
//   [0..17]  LEDR17..LEDR0
//   [18..26] LEDG8..LEDG0
//   [27..33] HEX0 bits 6..0, [34..40] HEX1, ... [76..82] HEX7
// HEX bit i drives segment i (0=a, 1=b, ... 6=g). Segments are active low.

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs, parent) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) {
    el.setAttribute(k, attrs[k]);
  }
  if (parent) {
    parent.appendChild(el);
  }
  return el;
}

function svgText(text, attrs, parent) {
  const el = svgEl("text", attrs, parent);
  el.textContent = text;
  return el;
}

class Board {
  constructor(container, onInputChange) {
    this.onInputChange = onInputChange;
    this.sw = new Array(18).fill("0");    // index = switch number
    this.key = new Array(4).fill("1");    // '1' = released (active low)
    this.keyLatched = new Array(4).fill(false);
    this.ledr = [];
    this.ledg = [];
    this.hex = [];
    this.swEls = [];
    this.keyEls = [];
    this.build(container);
  }

  // ---------------------------------------------------------------- drawing
  build(container) {
    const svg = svgEl("svg", { viewBox: "0 0 1100 470", class: "board-svg" });
    container.appendChild(svg);
    this.svg = svg;

    const defs = svgEl("defs", {}, svg);
    const glowR = svgEl("filter", { id: "glowR", x: "-100%", y: "-100%", width: "300%", height: "300%" }, defs);
    svgEl("feGaussianBlur", { stdDeviation: "3", result: "b" }, glowR);
    const mR = svgEl("feMerge", {}, glowR);
    svgEl("feMergeNode", { in: "b" }, mR);
    svgEl("feMergeNode", { in: "SourceGraphic" }, mR);

    // PCB
    svgEl("rect", { x: 5, y: 5, width: 1090, height: 460, rx: 18, class: "pcb" }, svg);
    for (const [cx, cy] of [[25, 25], [1075, 25], [25, 445], [1075, 445]]) {
      svgEl("circle", { cx: cx, cy: cy, r: 8, class: "pcb-hole" }, svg);
    }
    svgText("DE2-115", { x: 40, y: 48, class: "silk silk-title" }, svg);
    svgText("terasic-style virtual board", { x: 150, y: 48, class: "silk" }, svg);

    // FPGA chip
    const chip = svgEl("g", {}, svg);
    svgEl("rect", { x: 880, y: 80, width: 150, height: 150, rx: 6, class: "chip" }, chip);
    for (let i = 0; i < 14; i++) {
      const px = 888 + i * 10;
      const py = 88 + i * 10;
      svgEl("rect", { x: px, y: 72, width: 4, height: 8, class: "pin" }, chip);
      svgEl("rect", { x: px, y: 230, width: 4, height: 8, class: "pin" }, chip);
      svgEl("rect", { x: 872, y: py, width: 8, height: 4, class: "pin" }, chip);
      svgEl("rect", { x: 1030, y: py, width: 8, height: 4, class: "pin" }, chip);
    }
    svgText("CYCLONE IV E", { x: 955, y: 145, class: "chip-text", "text-anchor": "middle" }, chip);
    svgText("EP4CE115", { x: 955, y: 165, class: "chip-text small", "text-anchor": "middle" }, chip);
    svgText("(simulated)", { x: 955, y: 185, class: "chip-text small", "text-anchor": "middle" }, chip);

    // Clock crystal + activity LED
    svgEl("rect", { x: 880, y: 250, width: 60, height: 22, rx: 11, class: "crystal" }, svg);
    svgText("CLOCK_50", { x: 950, y: 266, class: "silk" }, svg);
    this.clkLed = svgEl("circle", { cx: 1040, cy: 261, r: 6, class: "led led-off" }, svg);
    this.clkText = svgText("stopped", { x: 880, y: 292, class: "silk small" }, svg);

    // Seven segment displays: HEX7 (left) ... HEX0 (right)
    for (let d = 7; d >= 0; d--) {
      const pos = 7 - d;
      let x = 45 + pos * 98;
      if (pos >= 4) {
        x += 20;   // gap between the two groups of four digits
      }
      this.hex[d] = this.buildDigit(svg, x, 80, d);
    }

    // Red LEDs above switches
    for (let i = 17; i >= 0; i--) {
      const x = this.switchX(i);
      const led = svgEl("rect", { x: x - 6, y: 255, width: 12, height: 18, rx: 3, class: "led led-off" }, svg);
      svgText("LEDR" + i, { x: x, y: 290, class: "silk tiny", "text-anchor": "middle" }, svg);
      this.ledr[i] = led;
    }

    // Green LEDs above keys
    for (let i = 8; i >= 0; i--) {
      const x = 760 + (8 - i) * 36;
      const led = svgEl("rect", { x: x - 6, y: 320, width: 12, height: 18, rx: 3, class: "led led-off" }, svg);
      svgText("LEDG" + i, { x: x, y: 354, class: "silk tiny", "text-anchor": "middle" }, svg);
      this.ledg[i] = led;
    }

    // Slide switches
    for (let i = 17; i >= 0; i--) {
      this.swEls[i] = this.buildSwitch(svg, this.switchX(i), 310, i);
    }

    // Push buttons KEY3..KEY0
    for (let i = 3; i >= 0; i--) {
      const x = 790 + (3 - i) * 80;
      this.keyEls[i] = this.buildKey(svg, x, 410, i);
    }
    svgText("shift-click a KEY to hold it down", { x: 760, y: 458, class: "silk tiny" }, svg);
  }

  switchX(i) {
    return 40 + (17 - i) * 38;
  }

  buildDigit(svg, x, y, d) {
    const g = svgEl("g", { transform: "translate(" + x + "," + y + ") skewX(-6)" }, svg);
    svgEl("rect", { x: -8, y: -10, width: 72, height: 120, rx: 4, class: "digit-bg" }, g);
    const w = 48;
    const h = 92;
    const t = 9;
    const hh = h / 2;
    const segRects = [
      [t, 0, w - 2 * t, t],                       // a
      [w - t, t, t, hh - 1.5 * t + t / 2],        // b
      [w - t, hh + t / 2, t, hh - 1.5 * t],       // c
      [t, h - t, w - 2 * t, t],                   // d
      [0, hh + t / 2, t, hh - 1.5 * t],           // e
      [0, t, t, hh - 1.5 * t + t / 2],            // f
      [t, hh - t / 2, w - 2 * t, t],              // g
    ];
    const segs = [];
    for (let s = 0; s < 7; s++) {
      const r = segRects[s];
      segs.push(svgEl("rect", {
        x: r[0] + 4, y: r[1] + 4, width: r[2], height: r[3], rx: 3, class: "seg seg-off",
      }, g));
    }
    svgText("HEX" + d, { x: x + 28, y: y + 128, class: "silk tiny", "text-anchor": "middle" }, svg);
    return segs;
  }

  buildSwitch(svg, x, y, i) {
    const g = svgEl("g", { class: "clickable" }, svg);
    svgEl("rect", { x: x - 11, y: y, width: 22, height: 56, rx: 4, class: "switch-body" }, g);
    svgEl("rect", { x: x - 5, y: y + 6, width: 10, height: 44, rx: 3, class: "switch-track" }, g);
    const knob = svgEl("rect", { x: x - 8, y: y + 30, width: 16, height: 20, rx: 3, class: "switch-knob" }, g);
    svgText("SW" + i, { x: x, y: y + 74, class: "silk tiny", "text-anchor": "middle" }, g);
    const self = this;
    function toggle() {
      if (self.sw[i] === "1") {
        self.setSwitch(i, "0");
      } else {
        self.setSwitch(i, "1");
      }
    }
    g.addEventListener("click", toggle);
    return { knob: knob, y: y };
  }

  buildKey(svg, x, y, i) {
    const g = svgEl("g", { class: "clickable" }, svg);
    svgEl("rect", { x: x - 26, y: y - 26, width: 52, height: 52, rx: 6, class: "key-body" }, g);
    const cap = svgEl("circle", { cx: x, cy: y, r: 17, class: "key-cap" }, g);
    svgText("KEY" + i, { x: x, y: y - 32, class: "silk tiny", "text-anchor": "middle" }, g);
    const self = this;
    function down(ev) {
      ev.preventDefault();
      if (ev.shiftKey) {
        self.keyLatched[i] = !self.keyLatched[i];
        if (self.keyLatched[i]) {
          self.setKey(i, "0");
        } else {
          self.setKey(i, "1");
        }
        return;
      }
      if (!self.keyLatched[i]) {
        self.setKey(i, "0");
      }
    }
    function up() {
      if (!self.keyLatched[i] && self.key[i] === "0") {
        self.setKey(i, "1");
      }
    }
    g.addEventListener("pointerdown", down);
    g.addEventListener("pointerup", up);
    g.addEventListener("pointerleave", up);
    return { cap: cap };
  }

  // ----------------------------------------------------------------- inputs
  setSwitch(i, v) {
    this.sw[i] = v;
    const s = this.swEls[i];
    if (v === "1") {
      s.knob.setAttribute("y", s.y + 6);
      s.knob.classList.add("on");
    } else {
      s.knob.setAttribute("y", s.y + 30);
      s.knob.classList.remove("on");
    }
    this.onInputChange();
  }

  setKey(i, v) {
    this.key[i] = v;
    const cap = this.keyEls[i].cap;
    if (v === "0") {
      cap.classList.add("pressed");
    } else {
      cap.classList.remove("pressed");
    }
    if (this.keyLatched[i]) {
      cap.classList.add("latched");
    } else {
      cap.classList.remove("latched");
    }
    this.onInputChange();
  }

  // SW17..SW0 as a string, MSB first
  swString() {
    let s = "";
    for (let i = 17; i >= 0; i--) {
      s += this.sw[i];
    }
    return s;
  }

  keyString() {
    let s = "";
    for (let i = 3; i >= 0; i--) {
      s += this.key[i];
    }
    return s;
  }

  // ---------------------------------------------------------------- outputs
  static ledClass(c) {
    if (c === "1" || c === "H") {
      return "led led-on";
    }
    if (c === "0" || c === "L") {
      return "led led-off";
    }
    if (c === "Z") {
      return "led led-z";
    }
    return "led led-x";   // U, X, W, - : undefined value, flag it
  }

  static segClass(c) {
    if (c === "0" || c === "L") {
      return "seg seg-on";
    }
    if (c === "1" || c === "H") {
      return "seg seg-off";
    }
    if (c === "Z") {
      return "seg seg-z";
    }
    return "seg seg-x";
  }

  setOutputs(bits) {
    if (!bits || bits.length < 83) {
      return;
    }
    for (let i = 0; i < 18; i++) {
      this.ledr[17 - i].setAttribute("class", Board.ledClass(bits[i]) + " red");
    }
    for (let i = 0; i < 9; i++) {
      this.ledg[8 - i].setAttribute("class", Board.ledClass(bits[18 + i]) + " green");
    }
    for (let d = 0; d < 8; d++) {
      const field = bits.substr(27 + d * 7, 7);   // bit6..bit0
      for (let s = 0; s < 7; s++) {
        this.hex[d][s].setAttribute("class", Board.segClass(field[6 - s]));
      }
    }
  }

  clearOutputs() {
    this.setOutputs("Z".repeat(83));
  }

  setClockStatus(running, text) {
    if (running) {
      this.clkLed.setAttribute("class", "led led-on green blink");
    } else {
      this.clkLed.setAttribute("class", "led led-off");
    }
    this.clkText.textContent = text;
  }
}
