"""
server.py - local backend for the FPGA Board Simulator.

Run:   python3 server.py        then open http://localhost:8080

Each browser tab gets one websocket. A "compile" message builds the
user's design inside a generated DE2-115 wrapper and starts the
simulator (GHDL for VHDL, Icarus Verilog for Verilog). "step" messages
then advance the clock N cycles with the current switch/button values
and the resulting LED / 7-segment changes are streamed back.
"""

import argparse
import asyncio
import json
import os
import shutil
import tempfile

from aiohttp import web, WSMsgType

import hdl

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")

COMPILE_TIMEOUT = 60        # seconds
STEP_TIMEOUT = 20           # seconds for one batch of cycles
MAX_CYCLES_PER_STEP = 5_000_000
MAX_VCD_BYTES = 40 * 1024 * 1024


def clean_bits(value, width, pad):
    """Keep only 0/1 characters, then fit the string to exactly `width` bits."""
    bits = []
    for c in str(value):
        if c == "1":
            bits.append("1")
        elif c == "0":
            bits.append("0")
    text = "".join(bits)[-width:]
    return text.rjust(width, pad)


def tool_status():
    return {
        "ghdl": shutil.which("ghdl") is not None,
        "iverilog": shutil.which("iverilog") is not None and shutil.which("vvp") is not None,
    }


async def run_tool(args, cwd):
    """Run a compiler command, return (exit_code, combined_output)."""
    proc = await asyncio.create_subprocess_exec(
        *args, cwd=cwd,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), COMPILE_TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        return 1, "Compiler timed out after %d s" % COMPILE_TIMEOUT
    return proc.returncode, out.decode(errors="replace")


class SimSession:
    def __init__(self, ws):
        self.ws = ws
        self.proc = None
        self.workdir = None
        self.lang = None
        self.record_vcd = False
        self.cycle = 0
        self.stderr_task = None

    async def send(self, **msg):
        if not self.ws.closed:
            await self.ws.send_str(json.dumps(msg))

    async def log(self, text, level="info"):
        await self.send(type="console", level=level, text=text)

    # ---------------------------------------------------------------- compile
    async def compile(self, msg):
        await self.stop(send_vcd=False)
        self.lang = msg.get("lang", "vhdl")
        self.record_vcd = bool(msg.get("vcd", False))
        code = msg.get("code", "")
        tools = tool_status()

        if self.lang == "vhdl" and not tools["ghdl"]:
            await self.send(type="compile_error", text="GHDL is not installed. See README.md.")
            return
        if self.lang == "verilog" and not tools["iverilog"]:
            await self.send(type="compile_error", text="Icarus Verilog is not installed. See README.md.")
            return

        try:
            top, ports, wrapper, warnings = hdl.build_wrapper(self.lang, code, msg.get("top", "").strip())
        except hdl.HDLError as e:
            await self.send(type="compile_error", text=str(e))
            return

        self.workdir = tempfile.mkdtemp(prefix="fpgasim_")
        await self.log("Top-level: %s" % top)
        for w in warnings:
            await self.log(w, "warn")

        if self.lang == "vhdl":
            ok = await self.compile_vhdl(code, wrapper)
        else:
            ok = await self.compile_verilog(code, wrapper)
        if not ok:
            return

        await self.start_sim()
        self.cycle = 0
        await self.send(type="ready", top=top, ports=[p.to_dict() for p in ports])

    async def compile_vhdl(self, code, wrapper):
        with open(os.path.join(self.workdir, "design.vhd"), "w") as f:
            f.write(code)
        with open(os.path.join(self.workdir, "fpgasim_tb.vhd"), "w") as f:
            f.write(wrapper)
        flags = ["--std=08", "-fsynopsys", "--workdir=" + self.workdir]
        steps = [
            ["ghdl", "-a"] + flags + ["design.vhd"],
            ["ghdl", "-a"] + flags + ["fpgasim_tb.vhd"],
            ["ghdl", "-e"] + flags + ["fpgasim_tb"],
        ]
        for i, args in enumerate(steps):
            await self.log("$ " + " ".join(args))
            rc, out = await run_tool(args, self.workdir)
            if out.strip():
                if rc != 0:
                    await self.log(out.rstrip(), "error")
                else:
                    await self.log(out.rstrip(), "info")
            if rc != 0:
                if i == 0:
                    where = "your design"
                else:
                    where = "the board wrapper (check your port types)"
                await self.send(type="compile_error", text="Compilation failed in %s." % where, output=out)
                return False
        return True

    async def compile_verilog(self, code, wrapper):
        with open(os.path.join(self.workdir, "design.sv"), "w") as f:
            f.write(code)
        with open(os.path.join(self.workdir, "fpgasim_tb.v"), "w") as f:
            f.write(wrapper)
        args = ["iverilog", "-g2012", "-s", "fpgasim_tb", "-o", "sim.vvp"]
        if self.record_vcd:
            args.append("-DFPGASIM_DUMP")
        args += ["design.sv", "fpgasim_tb.v"]
        await self.log("$ " + " ".join(args))
        rc, out = await run_tool(args, self.workdir)
        if out.strip():
            if rc != 0:
                await self.log(out.rstrip(), "error")
            else:
                await self.log(out.rstrip(), "info")
        if rc != 0:
            await self.send(type="compile_error", text="Compilation failed.", output=out)
            return False
        return True

    async def start_sim(self):
        if self.lang == "vhdl":
            args = ["ghdl", "-r", "--std=08", "-fsynopsys", "--workdir=" + self.workdir,
                    "fpgasim_tb", "--ieee-asserts=disable-at-0"]
            if self.record_vcd:
                args.append("--vcd=wave.vcd")
        else:
            args = ["vvp", "-n", "sim.vvp"]
        await self.log("$ " + " ".join(args))
        self.proc = await asyncio.create_subprocess_exec(
            *args, cwd=self.workdir,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)
        self.stderr_task = asyncio.create_task(self.pump_stderr(self.proc))
        await self.log("Simulation started. Flip switches / press keys on the board.")

    async def pump_stderr(self, proc):
        # assert/report messages from the user's design end up here
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            await self.log(line.decode(errors="replace").rstrip(), "sim")

    # ------------------------------------------------------------------- step
    async def step(self, msg):
        if self.proc is None or self.proc.returncode is not None:
            await self.send(type="sim_error", text="Simulation is not running. Compile first.")
            return
        n = max(0, min(int(msg.get("n", 1)), MAX_CYCLES_PER_STEP))
        sw = clean_bits(msg.get("sw", ""), 18, "0")
        key = clean_bits(msg.get("key", ""), 4, "1")
        try:
            self.proc.stdin.write(("S %d %s %s\n" % (n, sw, key)).encode())
            await self.proc.stdin.drain()
            changes, final = [], None
            while True:
                raw = await asyncio.wait_for(self.proc.stdout.readline(), STEP_TIMEOUT)
                if not raw:
                    raise EOFError()
                line = raw.decode(errors="replace").strip()
                if line == "D":
                    break
                parts = line.split()
                if len(parts) == 3 and parts[0] == "O":
                    changes.append([int(parts[1]), parts[2].upper()])
                elif len(parts) == 3 and parts[0] == "F":
                    final = parts[2].upper()
                elif line:
                    await self.log(line, "sim")   # $display / report output from the design
        except asyncio.TimeoutError:
            await self.send(type="sim_error",
                            text="Simulation did not respond within %d s (combinational loop or too many cycles?). "
                                 "Stopped." % STEP_TIMEOUT)
            await self.kill()
            return
        except (EOFError, BrokenPipeError, ConnectionResetError):
            await asyncio.sleep(0.2)
            await self.send(type="sim_error", text="Simulator exited unexpectedly (see console).")
            await self.kill()
            return
        base = self.cycle
        self.cycle += n
        await self.send(type="out", base=base, n=n, sw=sw, key=key, changes=changes, final=final)

    # ------------------------------------------------------------------- stop
    async def stop(self, send_vcd=True):
        if self.proc is not None and self.proc.returncode is None:
            try:
                self.proc.stdin.write(b"Q\n")
                await self.proc.stdin.drain()
                self.proc.stdin.close()
                await asyncio.wait_for(self.proc.wait(), 5)
            except Exception:
                await self.kill()
        if self.stderr_task:
            try:
                await asyncio.wait_for(self.stderr_task, 1)
            except Exception:
                pass
            self.stderr_task = None
        self.proc = None
        if send_vcd and self.record_vcd and self.workdir:
            path = os.path.join(self.workdir, "wave.vcd")
            if os.path.exists(path):
                size = os.path.getsize(path)
                if size > MAX_VCD_BYTES:
                    await self.log("VCD is %.1f MB, too large to display (limit %d MB). "
                                   "Run fewer cycles." % (size / 1e6, MAX_VCD_BYTES // 1_000_000), "warn")
                else:
                    with open(path, errors="replace") as f:
                        await self.send(type="vcd", text=f.read())
        if self.workdir:
            shutil.rmtree(self.workdir, ignore_errors=True)
            self.workdir = None
        await self.send(type="stopped")

    async def kill(self):
        if self.proc is not None and self.proc.returncode is None:
            self.proc.kill()
            try:
                await self.proc.wait()
            except Exception:
                pass
        self.proc = None


async def ws_handler(request):
    ws = web.WebSocketResponse(max_msg_size=8 * 1024 * 1024)
    await ws.prepare(request)
    session = SimSession(ws)
    await session.send(type="hello", tools=tool_status())
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            data = json.loads(msg.data)
            kind = data.get("type")
            if kind == "compile":
                await session.compile(data)
            elif kind == "step":
                await session.step(data)
            elif kind == "stop":
                await session.stop(send_vcd=True)
    finally:
        await session.kill()
        if session.workdir:
            shutil.rmtree(session.workdir, ignore_errors=True)
    return ws


async def index(request):
    return web.FileResponse(os.path.join(STATIC, "index.html"))


def main():
    parser = argparse.ArgumentParser(description="FPGA Board Simulator")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_static("/static/", STATIC)
    tools = tool_status()
    for label, key in (("GHDL (VHDL)", "ghdl"), ("Icarus Verilog", "iverilog")):
        if tools[key]:
            print("%-22s found" % label)
        else:
            print("%-22s NOT FOUND - see README.md" % label)
    host = args.host
    if host == "127.0.0.1":
        host = "localhost"
    print("Open http://%s:%d in your browser" % (host, args.port))
    web.run_app(app, host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
