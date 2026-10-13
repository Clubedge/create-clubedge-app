"""Records a command in a real terminal (a pty) as an asciicast v2 file, for the showcase.

    python3 scripts/record-session.py <cols> <rows> <output.cast> <command> [args...]

Output is kept byte for byte with its timing, so the player shows exactly what the terminal
showed. A command marks a chapter by printing OSC 1337 "Marker=<label>" (BEL-terminated); the
sequence becomes an asciicast marker and is not part of the output. Exits with the command's status.
"""
import codecs
import fcntl
import json
import os
import pty
import re
import struct
import sys
import termios
import time

cols, rows, output, command = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4:]
MARKER = re.compile(r"\x1b\]1337;Marker=([^\x07]*)\x07")
PARTIAL = "\x1b]1337;"

pid, fd = pty.fork()
if pid == 0:
    # The child sees a terminal of exactly this size from its first read.
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.environ.update(TERM="xterm-256color", COLORTERM="truecolor")
    os.execvp(command[0], command)

start = time.monotonic()
decoder = codecs.getincrementaldecoder("utf-8")("replace")
pending = ""

with open(output, "w", encoding="utf-8") as cast:
    header = {
        "version": 2,
        "width": cols,
        "height": rows,
        "timestamp": int(time.time()),
        "env": {"TERM": "xterm-256color", "SHELL": "/bin/bash"},
    }
    cast.write(json.dumps(header) + "\n")

    def emit(kind, data):
        if data:
            cast.write(json.dumps([round(time.monotonic() - start, 6), kind, data]) + "\n")

    while True:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
        sys.stdout.flush()
        pending += decoder.decode(chunk)
        while (match := MARKER.search(pending)) is not None:
            emit("o", pending[: match.start()])
            emit("m", match.group(1))
            pending = pending[match.end() :]
        # Hold back a marker that is still arriving; emit everything else now.
        cut = pending.find(PARTIAL)
        if cut == -1:
            emit("o", pending)
            pending = ""
        else:
            emit("o", pending[:cut])
            pending = pending[cut:]
    emit("o", pending + decoder.decode(b"", final=True))

_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
