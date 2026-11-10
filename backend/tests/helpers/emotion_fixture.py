"""Fixtures for the emotion_bake and pack_assemble tests: a drawn 256 px face and a tiny pack staging folder.
usage: emotion_fixture.py face <dir> | staging <dir> [big]"""
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image

EYES = ((88, 110), (168, 110))
RX, RY = 14, 7


def draw(brow_dy=(0, 0, 0), brow_dx=0):
    """The face: skin ellipse with alpha, two dark eyes and two dark brows; brow_dy moves the (inner, middle, outer) brow thirds by that many px (+ down)."""
    img = np.zeros((256, 256, 4), np.uint8)
    cv2.ellipse(img, (128, 128), (100, 120), 0, 0, 360, (205, 170, 140, 255), -1)
    for cx, cy in EYES:
        cv2.ellipse(img, (cx, cy), (RX, RY), 0, 0, 360, (250, 250, 250, 255), -1)
        cv2.circle(img, (cx, cy), 5, (30, 20, 20, 255), -1)
    for side in (-1, 1):
        for k, (a, b) in enumerate(((18, 30), (30, 46), (46, 62))):
            x0, x1 = sorted((128 + side * a - (side * brow_dx if k == 0 else 0), 128 + side * b))
            y = 88 + int(brow_dy[k])
            cv2.rectangle(img, (x0, y), (x1, y + 5), (40, 30, 30, 255), -1)
    return img


def landmarks():
    out = {}
    for name, (cx, cy) in zip(("leftEye", "rightEye"), EYES):
        out[name] = [[cx + RX * np.cos(t), cy + RY * np.sin(t)] for t in np.linspace(0, 2 * np.pi, 8, endpoint=False)]
    return out


def save(a, path):
    Image.fromarray(a, "RGBA").save(path)


def face(d):
    os.makedirs(d, exist_ok=True)
    save(draw(), f"{d}/rest.png")
    poses = {"angry": (4, 3, 1), "excited": (-5, -6, -5), "alarmed": (-6, -5, -3), "sad": (-4, 0, 2)}
    for kind, dy in poses.items():
        save(draw(dy), f"{d}/{kind}.png")
    json.dump(landmarks(), open(f"{d}/landmarks.json", "w"))


def staging(d, big=False):
    rng = np.random.default_rng(3)
    for rel in ("clips", "mouth/calm", "mouth/shout", "head", "eyes", "emotion"):
        os.makedirs(f"{d}/{rel}", exist_ok=True)
    save(draw(), f"{d}/rest.png")
    frames = 6
    for name in ("idle1", "idle2", "listen", "think", "speak"):
        writer = cv2.VideoWriter(f"{d}/clips/{name}.mp4", cv2.VideoWriter_fourcc(*"mp4v"), 24, (32, 64))
        for i in range(frames):
            writer.write(np.full((64, 32, 3), (10 + 20 * i + sum(map(ord, 'idle1' if name == 'speak' else name))) % 256, np.uint8))
        writer.release()
        json.dump({"fps": 24.0, "frames": frames, "res": [0.1] * frames, "m": [[1, 0, 0, 0, 1, 0]] * frames, "cc": [1] * frames, "low": []}, open(f"{d}/clips/{name}.track.json", "w"))
    for m in ("calm", "shout"):
        tile = (rng.random((40, 40, 4)) * 255).astype(np.uint8)
        tile[..., 3] = np.where(np.arange(40)[None, :] < 20, 255, 0)
        save(tile, f"{d}/mouth/{m}/atlas.png")
        save(tile[:8, :8].copy(), f"{d}/mouth/{m}/alpha.png")
        json.dump({"tw": 8, "th": 8, "cols": 5, "ts": [0.5], "base": 8}, open(f"{d}/mouth/{m}/meta.json", "w"))
    np.zeros(2000, np.int16).tofile(f"{d}/head/flow.bin")
    save(np.full((8, 8, 4), 200, np.uint8), f"{d}/head/weight.png")
    json.dump({"region": [0, 0, 8, 8]}, open(f"{d}/head/meta.json", "w"))
    if big:  # incompressible flow: deflate cannot shrink it
        rng.integers(-30000, 30000, 7_000_000, dtype=np.int16).tofile(f"{d}/head/flow.bin")
    for n in ("closed", "half", "ref", "ring"):
        save(np.full((8, 8, 4), 120, np.uint8), f"{d}/eyes/{n}.png")
    json.dump({"region": [0, 0, 8, 8]}, open(f"{d}/eyes/meta.json", "w"))
    kinds = {}
    for kind in ("angry", "excited", "alarmed", "sad"):
        patch = np.zeros((20, 20, 4), np.uint8)
        patch[..., :3] = 128
        patch[5:15, 5:15, 3] = 255
        save(patch, f"{d}/emotion/{kind}.png")
        np.zeros(800, np.int16).tofile(f"{d}/emotion/{kind}.flow.bin")
        kinds[kind] = {"strength": 0.65}
    json.dump({"region": [0, 0, 20, 20], "kinds": kinds}, open(f"{d}/emotion/meta.json", "w"))


if __name__ == "__main__":
    {"face": lambda: face(sys.argv[2]), "staging": lambda: staging(sys.argv[2], len(sys.argv) > 3)}[sys.argv[1]]()
