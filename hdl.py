"""
hdl.py - parses the user's top-level entity/module and generates a
simulation wrapper ("virtual DE2-115 board") around it.

The wrapper talks to the Python server over stdin/stdout with a tiny
line protocol:

    server -> sim : "S <ncycles> <SW 18 bits> <KEY 4 bits>"
    server -> sim : "Q"                       (quit; flushes the VCD)
    sim -> server : "O <k> <83 output bits>"  (outputs changed after cycle k)
    sim -> server : "F <n> <83 output bits>"  (final state of this batch)
    sim -> server : "D"                       (batch done)

The 83 output bits are LEDR[17:0] & LEDG[8:0] & HEX0[6:0] ... HEX7[6:0].
"""

import re

# ---------------------------------------------------------------------------
# Board description (Terasic DE2-115)
# ---------------------------------------------------------------------------

# canonical name -> (direction, board width)
BOARD_PORTS = {
    "CLOCK_50": ("in", 1),
    "SW": ("in", 18),
    "KEY": ("in", 4),
    "LEDR": ("out", 18),
    "LEDG": ("out", 9),
}
for _i in range(8):
    BOARD_PORTS["HEX%d" % _i] = ("out", 7)

# alternate spellings people use for the clock
CLOCK_ALIASES = {"CLOCK_50", "CLK", "CLOCK", "CLK50", "CLK_50"}

OUTPUT_ORDER = ["LEDR", "LEDG"] + ["HEX%d" % i for i in range(8)]
OUTPUT_BITS = 18 + 9 + 8 * 7  # 83


class Port:
    def __init__(self, name, direction, width, lo, vtype):
        self.name = name            # name as written by the user
        self.direction = direction  # "in" | "out" | "inout"
        self.width = width          # number of bits (1 for scalars)
        self.lo = lo                # low index of the range
        self.vtype = vtype          # "std_logic", "slv", "unsigned", "signed", "bit", "verilog"
        self.scalar = (vtype in ("std_logic", "bit")) or (vtype == "verilog" and width == 1 and lo is None)

    def canonical(self):
        upper = self.name.upper()
        if upper in CLOCK_ALIASES:
            return "CLOCK_50"
        if upper in BOARD_PORTS:
            return upper
        return None

    def to_dict(self):
        return {
            "name": self.name,
            "dir": self.direction,
            "width": self.width,
            "board": self.canonical(),
        }


class HDLError(Exception):
    pass


# ---------------------------------------------------------------------------
# Comment stripping
# ---------------------------------------------------------------------------

def strip_vhdl_comments(src):
    src = re.sub(r"/\*.*?\*/", " ", src, flags=re.S)  # VHDL-2008 block comments
    return re.sub(r"--[^\n]*", "", src)


def strip_verilog_comments(src):
    src = re.sub(r"/\*.*?\*/", " ", src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


def matching_paren(text, open_index):
    depth = 0
    for i in range(open_index, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return i
    raise HDLError("Unbalanced parentheses in port list")


# ---------------------------------------------------------------------------
# VHDL parsing
# ---------------------------------------------------------------------------

def vhdl_entities(src):
    """Return {entity_name: [Port, ...]} for every entity in the file."""
    clean = strip_vhdl_comments(src)
    result = {}
    for m in re.finditer(r"\bentity\s+(\w+)\s+is\b(.*?)\bend\b", clean, flags=re.I | re.S):
        name = m.group(1)
        body = m.group(2)
        ports = []
        pm = re.search(r"\bport\s*\(", body, flags=re.I)
        if pm:
            start = pm.end() - 1
            # the entity body regex may stop early at an inner "end"; re-search in full text
            abs_start = m.start(2) + start
            close = matching_paren(clean, abs_start)
            port_text = clean[abs_start + 1:close]
            ports = parse_vhdl_port_text(port_text)
        result[name] = ports
    return result


def parse_vhdl_port_text(text):
    ports = []
    for decl in split_top_level(text, ";"):
        decl = decl.strip()
        if not decl or ":" not in decl:
            continue
        names_part, rest = decl.split(":", 1)
        rest = rest.strip()
        dm = re.match(r"(in|out|inout|buffer)\s+(.*)$", rest, flags=re.I | re.S)
        if not dm:
            continue
        direction = dm.group(1).lower()
        if direction == "buffer":
            direction = "out"
        type_text = dm.group(2).split(":=")[0].strip()
        width, lo, vtype = vhdl_type_info(type_text)
        for nm in names_part.split(","):
            nm = nm.strip()
            if nm:
                ports.append(Port(nm, direction, width, lo, vtype))
    return ports


def split_top_level(text, sep):
    parts, depth, cur = [], 0, []
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == sep and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    parts.append("".join(cur))
    return parts


def vhdl_type_info(type_text):
    t = type_text.lower()
    rm = re.search(r"\(\s*(\d+)\s+(downto|to)\s+(\d+)\s*\)", t)
    base = re.match(r"\s*(\w+)", t).group(1)
    if rm:
        a, b = int(rm.group(1)), int(rm.group(3))
        width = abs(a - b) + 1
        lo = min(a, b)
        if base in ("unsigned", "signed"):
            vtype = base
        elif base == "bit_vector":
            vtype = "bitvec"
        else:
            vtype = "slv"
        return width, lo, vtype
    if base == "bit":
        return 1, None, "bit"
    return 1, None, "std_logic"


# ---------------------------------------------------------------------------
# Verilog parsing
# ---------------------------------------------------------------------------

DIR_RE = r"(input|output|inout)"


def verilog_modules(src):
    """Return {module_name: [Port, ...]} for every module in the file."""
    clean = strip_verilog_comments(src)
    result = {}
    for m in re.finditer(r"\bmodule\s+(\w+)\s*(#\s*\(.*?\)\s*)?\(", clean, flags=re.S):
        name = m.group(1)
        open_index = m.end() - 1
        close = matching_paren(clean, open_index)
        header = clean[open_index + 1:close]
        end_m = re.search(r"\bendmodule\b", clean[close:])
        if end_m:
            body = clean[close:close + end_m.start()]
        else:
            body = clean[close:]
        if re.search(r"\b" + DIR_RE + r"\b", header):
            ports = parse_verilog_ansi(header)
        else:
            ports = parse_verilog_nonansi(header, body)
        result[name] = ports
    return result


def verilog_range(text):
    rm = re.search(r"\[\s*(\d+)\s*:\s*(\d+)\s*\]", text)
    if rm:
        a, b = int(rm.group(1)), int(rm.group(2))
        return abs(a - b) + 1, min(a, b)
    return 1, None


def parse_verilog_ansi(header):
    ports = []
    direction, width, lo = "in", 1, None
    for item in header.split(","):
        item = item.strip()
        if not item:
            continue
        dm = re.match(DIR_RE + r"\b(.*)$", item, flags=re.S)
        if dm:
            direction = {"input": "in", "output": "out", "inout": "inout"}[dm.group(1)]
            rest = dm.group(2)
            width, lo = verilog_range(rest)
        else:
            rest = item
            if "[" in rest:
                width, lo = verilog_range(rest)
        name_m = re.search(r"(\w+)\s*(=.*)?$", rest.strip(), flags=re.S)
        if name_m:
            ports.append(Port(name_m.group(1), direction, width, lo, "verilog"))
    return ports


def parse_verilog_nonansi(header, body):
    names = [n.strip() for n in header.split(",") if n.strip()]
    info = {}
    decl_re = DIR_RE + r"\s+(?:wire|reg|logic)?\s*(?:signed)?\s*(\[\s*\d+\s*:\s*\d+\s*\])?\s*([\w\s,]+);"
    for m in re.finditer(decl_re, body):
        direction = {"input": "in", "output": "out", "inout": "inout"}[m.group(1)]
        width, lo = verilog_range(m.group(2) or "")
        for nm in m.group(3).split(","):
            info[nm.strip()] = (direction, width, lo)
    ports = []
    for nm in names:
        if nm in info:
            d, w, lo = info[nm]
            ports.append(Port(nm, d, w, lo, "verilog"))
    return ports


# ---------------------------------------------------------------------------
# Top-level selection
# ---------------------------------------------------------------------------

def choose_top(units, requested):
    if not units:
        raise HDLError("No entity/module found in your code.")
    if requested:
        for name in units:
            if name.lower() == requested.lower():
                return name
        raise HDLError("Top-level '%s' not found. Found: %s" % (requested, ", ".join(units)))
    # pick the unit that uses the most board pins; ties go to the last one
    best, best_score = None, -1
    for name, ports in units.items():
        score = 0
        for p in ports:
            if p.canonical():
                score += 1
        if score >= best_score:
            best, best_score = name, score
    return best


# ---------------------------------------------------------------------------
# Wrapper generation
# ---------------------------------------------------------------------------

def board_signal(canon):
    if canon == "CLOCK_50":
        return "clk_i"
    if BOARD_PORTS[canon][0] == "in":
        return canon.lower() + "_i"
    return canon.lower() + "_o"


def vhdl_actual(port, canon, warnings):
    sig = board_signal(canon)
    board_dir, board_w = BOARD_PORTS[canon]
    if canon == "CLOCK_50":
        if not port.scalar:
            return "%s(0) => %s" % (port.name, sig)
        return "%s => %s" % (port.name, sig)
    w = port.width
    if w > board_w:
        warnings.append("%s is %d bits but the board only has %d; extra bits are unconnected."
                        % (port.name, w, board_w))
        w = board_w
    if port.scalar:
        actual = "%s(0)" % sig
        return "%s => %s" % (port.name, actual)
    lo = port.lo or 0
    hi = lo + w - 1
    if w == port.width:
        formal = port.name
    else:
        formal = "%s(%d downto %d)" % (port.name, hi, lo)
    actual = "%s(%d downto 0)" % (sig, w - 1)
    if port.vtype in ("unsigned", "signed"):
        if board_dir == "in":
            return "%s => %s(%s)" % (formal, port.vtype, actual)
        return "std_logic_vector(%s) => %s" % (formal, actual)
    if port.vtype == "bitvec":
        if board_dir == "in":
            return "%s => to_bitvector(%s)" % (formal, actual)
        return "to_stdlogicvector(%s) => %s" % (formal, actual)
    return "%s => %s" % (formal, actual)


def vhdl_unconnected(port, warnings):
    if port.direction == "in":
        warnings.append("Input '%s' is not a DE2-115 pin; tied to 0." % port.name)
        if port.scalar:
            return "%s => '0'" % port.name
        return "%s => (others => '0')" % port.name
    warnings.append("Output '%s' is not a DE2-115 pin; left open." % port.name)
    return "%s => open" % port.name


def gen_vhdl_wrapper(top, ports, warnings):
    maps = []
    for p in ports:
        canon = p.canonical()
        if canon and BOARD_PORTS[canon][0] != p.direction and p.direction != "inout":
            warnings.append("%s should be an '%s' port on the board." % (p.name, BOARD_PORTS[canon][0]))
            maps.append(vhdl_unconnected(p, warnings))
        elif canon:
            maps.append(vhdl_actual(p, canon, warnings))
        else:
            maps.append(vhdl_unconnected(p, warnings))
    port_map = ""
    if maps:
        port_map = " port map (\n      " + ",\n      ".join(maps) + "\n    )"
    hex_sigs = "\n".join(
        "  signal hex%d_o : std_logic_vector(6 downto 0) := (others => 'Z');" % i for i in range(8))
    concat = "ledr_o & ledg_o & " + " & ".join("hex%d_o" % i for i in range(8))
    return """-- Auto-generated by FPGA Board Simulator. Do not edit.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use std.textio.all;

entity fpgasim_tb is
end entity;

architecture sim of fpgasim_tb is
  signal clk_i  : std_logic := '0';
  signal sw_i   : std_logic_vector(17 downto 0) := (others => '0');
  signal key_i  : std_logic_vector(3 downto 0)  := (others => '1');
  signal ledr_o : std_logic_vector(17 downto 0) := (others => 'Z');
  signal ledg_o : std_logic_vector(8 downto 0)  := (others => 'Z');
%(hex_sigs)s
begin
  dut: entity work.%(top)s%(port_map)s;

  board: process
    variable l      : line;
    variable o      : line;
    variable c      : character;
    variable n      : integer;
    variable swv    : std_logic_vector(17 downto 0);
    variable keyv   : std_logic_vector(3 downto 0);
    variable cur    : std_logic_vector(%(hi)d downto 0);
    variable last   : std_logic_vector(%(hi)d downto 0) := (others => '-');
    variable count  : integer;

    procedure check(k : integer) is
    begin
      cur := %(concat)s;
      if cur /= last then
        if count < 256 then
          write(o, string'("O "));
          write(o, k);
          write(o, string'(" "));
          write(o, cur);
          writeline(output, o);
          count := count + 1;
        end if;
        last := cur;
      end if;
    end procedure;
  begin
    while not endfile(input) loop
      readline(input, l);
      if l'length > 0 then
        read(l, c);
        exit when c = 'Q';
        read(l, n);
        read(l, swv);
        read(l, keyv);
        sw_i  <= swv;
        key_i <= keyv;
        wait for 1 ns;
        count := 0;
        check(0);
        for i in 1 to n loop
          clk_i <= '1';
          wait for 10 ns;
          clk_i <= '0';
          wait for 10 ns;
          check(i);
        end loop;
        write(o, string'("F "));
        write(o, n);
        write(o, string'(" "));
        write(o, cur);
        writeline(output, o);
        write(o, string'("D"));
        writeline(output, o);
        flush(output);
      end if;
    end loop;
    std.env.finish;
  end process;
end architecture;
""" % {"hex_sigs": hex_sigs, "top": top, "port_map": port_map,
       "hi": OUTPUT_BITS - 1, "concat": concat}


def verilog_connection(port, canon, warnings):
    sig = board_signal(canon)
    board_dir, board_w = BOARD_PORTS[canon]
    if canon == "CLOCK_50":
        return ".%s(%s)" % (port.name, sig)
    w = port.width
    if w > board_w:
        warnings.append("%s is %d bits but the board only has %d; extra bits are unconnected."
                        % (port.name, w, board_w))
        w = board_w
    if w == 1:
        return ".%s(%s[0])" % (port.name, sig)
    return ".%s(%s[%d:0])" % (port.name, sig, w - 1)


def gen_verilog_wrapper(top, ports, warnings):
    conns = []
    for p in ports:
        canon = p.canonical()
        if canon and BOARD_PORTS[canon][0] != p.direction and p.direction != "inout":
            warnings.append("%s should be an '%s' port on the board." % (p.name, BOARD_PORTS[canon][0]))
            conns.append(".%s()" % p.name)
        elif canon:
            conns.append(verilog_connection(p, canon, warnings))
        elif p.direction == "in":
            warnings.append("Input '%s' is not a DE2-115 pin; tied to 0." % p.name)
            conns.append(".%s('0)" % p.name)
        else:
            warnings.append("Output '%s' is not a DE2-115 pin; left open." % p.name)
            conns.append(".%s()" % p.name)
    hex_wires = "\n".join("  wire [6:0]  hex%d_o;" % i for i in range(8))
    concat = "{ledr_o, ledg_o, " + ", ".join("hex%d_o" % i for i in range(8)) + "}"
    return """// Auto-generated by FPGA Board Simulator. Do not edit.
`timescale 1ns/1ps
module fpgasim_tb;
  reg         clk_i = 1'b0;
  reg  [17:0] sw_i  = 18'b0;
  reg  [3:0]  key_i = 4'b1111;
  wire [17:0] ledr_o;
  wire [8:0]  ledg_o;
%(hex_wires)s

  %(top)s dut (
    %(conns)s
  );

  reg [%(hi)d:0] cur;
  reg [%(hi)d:0] last;
  reg [8*256-1:0] line_buf;
  reg [7:0]   cmd;
  reg [17:0]  swv;
  reg [3:0]   keyv;
  integer n;
  integer r;
  integer i;
  integer count;

  task check(input integer k);
    begin
      cur = %(concat)s;
      if (cur !== last) begin
        if (count < 256) begin
          $display("O %%0d %%b", k, cur);
          count = count + 1;
        end
        last = cur;
      end
    end
  endtask

  initial begin
`ifdef FPGASIM_DUMP
    $dumpfile("wave.vcd");
    $dumpvars(0, fpgasim_tb);
`endif
    last = {%(bits)d{1'bx}};
    last[0] = 1'bz;
    forever begin
      r = $fgets(line_buf, 32'h8000_0000);
      if (r == 0) $finish;
      r = $sscanf(line_buf, "%%c %%d %%b %%b", cmd, n, swv, keyv);
      if (cmd == "Q") $finish;
      if (r == 4) begin
        sw_i  = swv;
        key_i = keyv;
        #1;
        count = 0;
        check(0);
        for (i = 1; i <= n; i = i + 1) begin
          clk_i = 1'b1;
          #10;
          clk_i = 1'b0;
          #10;
          check(i);
        end
        $display("F %%0d %%b", n, cur);
        $display("D");
        $fflush;
      end
    end
  end
endmodule
""" % {"hex_wires": hex_wires, "top": top, "conns": ",\n    ".join(conns),
       "hi": OUTPUT_BITS - 1, "bits": OUTPUT_BITS, "concat": concat}


def build_wrapper(lang, src, requested_top):
    """Returns (top_name, ports, wrapper_source, warnings)."""
    warnings = []
    if lang == "vhdl":
        units = vhdl_entities(src)
    else:
        units = verilog_modules(src)
    top = choose_top(units, requested_top)
    ports = units[top]
    if not any(p.canonical() for p in ports):
        warnings.append("Top-level '%s' has no DE2-115 pins (SW, KEY, LEDR, LEDG, HEX0-7, CLOCK_50). "
                        "Nothing will show on the board." % top)
    if lang == "vhdl":
        wrapper = gen_vhdl_wrapper(top, ports, warnings)
    else:
        wrapper = gen_verilog_wrapper(top, ports, warnings)
    return top, ports, wrapper, warnings
