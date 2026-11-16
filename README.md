# FPGASim: a virtual DE2-115 board

Write VHDL or Verilog in the browser, hit **Compile & Load**, and watch it run on an
animated DE2-115: slide switches, push buttons, red/green LEDs and eight 7-segment
displays. It also has a live waveform viewer and a full internal-signal recorder for debugging.

```
browser (editor + board + waveform)  <--websocket-->  server.py  <--stdin/stdout-->  GHDL / Icarus
```

Your design is compiled by real simulators (GHDL for VHDL, Icarus Verilog for
Verilog), so the language support is complete. You aren't limited to a toy subset.
`hdl.py` wraps your top-level entity in a generated "board" testbench that maps
the DE2-115 pins to the UI.

## 1. Install

You need **Python 3.9+** plus the simulators.

| OS | Command |
|---|---|
| Ubuntu / Debian | `sudo apt install ghdl iverilog` |
| macOS | `brew install icarus-verilog` and GHDL from https://github.com/ghdl/ghdl/releases (or try `brew install ghdl`) |
| Windows | Use WSL (Ubuntu), then the Ubuntu line above |

Then:

```bash
cd fpga-sim
python3 -m venv .venv && source .venv/bin/activate     # optional
pip install -r requirements.txt
python3 server.py
```

Open **http://localhost:8080**. The server prints whether it found GHDL and Icarus.
You only need the one for the language you use.

## 2. Use it

1. Pick **VHDL** or **Verilog / SV**. The counter demo loads automatically.
2. **Compile & Load** (Ctrl+Enter). The simulation starts running right away.
3. Click switches to flip them. Click and hold a KEY to press it. **Shift-click** a KEY to latch it down.
4. **Clock** sets how fast `CLOCK_50` ticks. **Pause** / **Step** single-steps cycles.
5. **Waveform** tab: scroll to zoom, drag to pan, click to place a cursor (values show
   in the second column), click a bus name to expand it into bits.
6. For internal signals (counters, state registers, etc.), tick **Record internal signals**
   before compiling. When you press **Stop**, every signal in your design shows up in the
   waveform (use **Signals...** to pick them), and you can download the `.vcd` for GTKWave.

Compile errors highlight the line in the editor. Click an error in the Console to jump to it.
`report` / `$display` output from your design also shows in the Console.

## 3. Pin names

Name your top-level ports like the DE2-115 pin assignments. Any you leave out are just not connected.

| Port | Dir | Width | Notes |
|---|---|---|---|
| `CLOCK_50` (or `CLK`) | in | 1 | Ticks at the speed you pick |
| `SW` | in | up to 18 | Switch up = `1` |
| `KEY` | in | up to 4 | **Active low**: `0` while pressed |
| `LEDR` | out | up to 18 | `1` = on |
| `LEDG` | out | up to 9 | `1` = on |
| `HEX0`..`HEX7` | out | 7 | **Active low**, bit 0 = segment a ... bit 6 = segment g |

Smaller widths work (e.g. `SW(9 downto 0)` from a DE10-Lite lab). `std_logic_vector`,
`unsigned`, `signed` and `bit_vector` ports are all handled. The top-level is auto-detected
(the entity using the most board pins). Type a name in **Top** to override.

Undefined values are flagged on the board: a **yellow** LED/segment means `X`/`U`
(uninitialized or conflicting), and a dashed gray LED means the pin isn't driven (`Z`).

## 4. Things to know

- **Speed.** The simulator does roughly 200-300k cycles/second, not 50 MHz. A design that
  divides 50,000,000 cycles down to 1 Hz will look frozen. Use a small divider constant
  in simulation (the demo uses 25) and switch it back for real hardware.
- **Icarus + `always @(*)`.** Icarus doesn't run `always @(*)` blocks at time 0, so a
  combinational block whose inputs never change can stay `X`. Use `always_comb`
  (SystemVerilog mode is on) or `assign`.
- Recording internal signals at high clock speeds makes huge VCD files. Displays are capped
  at 40 MB, so record short runs.
- When a batch has more than 256 output changes (very fast clocks), the live waveform skips
  some and shades that region red. Slow the clock down or use the VCD recording for exact timing.
- Put all your entities/modules in the one editor buffer for now.

## 5. Project layout

```
server.py            aiohttp web + websocket server, runs the compilers/simulator
hdl.py               parses your ports, generates the board testbench wrapper
static/index.html    page layout
static/app.js        editor, run loop, websocket protocol, live waveform data
static/board.js      SVG DE2-115 drawing + switch/key input
static/wave.js       canvas waveform viewer + VCD parser
static/style.css
static/examples/     counter / blank templates (VHDL + Verilog)
```

Simulator protocol (one line each, see `hdl.py`):
`S <cycles> <SW bits> <KEY bits>` in; `O <cycle> <83 output bits>` for each change,
`F <cycles> <bits>` final state, then `D` out. `Q` quits and flushes the VCD.

## 6. Turning it into a website

Right now the server runs your code with your own user account, which is fine locally but
**not safe on a public server**. Two paths:

1. **Server-side (closest to what exists).** Run each compile+sim inside a throwaway
   container (Docker with `--network none`, CPU/memory/time limits, read-only FS), put
   it behind a login and rate limits, and deploy to a VM (Fly.io, Render, a small EC2).
   The front end doesn't change.
2. **Fully in the browser.** Compile Icarus or Verilator to WebAssembly (or use Yosys
   compiled to WASM to synthesize to a netlist and simulate that netlist in JS). It's free to
   host as a static site and needs no sandboxing, but it takes more engineering.

Good next features: multiple files/tabs, a pin-planner for other boards (DE10-Lite,
DE1-SoC), VGA output, a UART terminal, and saving projects to an account.
