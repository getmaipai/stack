"""The Stack's fast Look worker (LOOK-01): one long-lived process, pictures in over stdin, answers out.

Framing, both ways in memory, nothing on disk:
  request: 4 bytes header length, 4 bytes JPEG length, the JSON header, the JPEG bytes
  reply:   4 bytes length, the JSON reply
The worker logs nothing about what it sees. It exits when stdin closes (the Stack stops it when idle).
"""
from __future__ import annotations

import json
import os
import struct
import sys
import time

import cv2
import numpy as np
import onnxruntime as ort

# The Stack starts the worker with -I (isolated), which leaves its own folder off the path.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from look_core import decode, letterbox, scene  # noqa: E402

_session = None
_input_name = None


def read_exact(stream, size):
    chunks = []
    remaining = size
    while remaining:
        part = stream.read(remaining)
        if not part:
            return None
        chunks.append(part)
        remaining -= len(part)
    return b"".join(chunks)


def session_for(path):
    global _session, _input_name
    if _session is None:
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.log_severity_level = 3
        _session = ort.InferenceSession(path, options, providers=["CPUExecutionProvider"])
        _input_name = _session.get_inputs()[0].name
    return _session, _input_name


def look(header, jpeg):
    started = time.perf_counter()
    frame = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        return {"ok": False, "code": "not_jpeg"}
    height, width = frame.shape[:2]
    blob, scale = letterbox(frame)
    session, input_name = session_for(header["model"])
    raw = session.run(None, {input_name: blob})[0][0]
    light, colours, tags = scene(frame)
    return {
        "ok": True,
        "detections": decode(raw, scale, width, height),
        "light": light,
        "colours": colours,
        "tags": tags,
        "ms": (time.perf_counter() - started) * 1000,
    }


def main():
    stream = sys.stdin.buffer
    while True:
        sizes = read_exact(stream, 8)
        if sizes is None:
            return
        header_length, jpeg_length = struct.unpack(">II", sizes)
        header = read_exact(stream, header_length)
        jpeg = read_exact(stream, jpeg_length)
        if header is None or jpeg is None:
            return
        try:
            reply = look(json.loads(header), jpeg)
        except Exception:
            reply = {"ok": False, "code": "failed"}
        payload = json.dumps(reply, separators=(",", ":"), allow_nan=False).encode()
        sys.stdout.buffer.write(struct.pack(">I", len(payload)) + payload)
        sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
