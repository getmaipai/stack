"""The pure, in-memory pieces of the Stack's fast Look worker (LOOK-01).

YOLOX-nano (Apache-2.0) names the household things in one picture. Nothing here reads or writes a
file, and nothing here logs: the caller gets labels, scores and boxes and decides what to keep.
The decode follows the bot's `vision/objects.py` (letterbox to 416 padded with 114, raw BGR
float32, grid and stride decode, per-class NMS) and the colour naming follows its
`vision/scene_tags.py`.
"""
from __future__ import annotations

import colorsys

import cv2
import numpy as np

INPUT = 416
STRIDES = (8, 16, 32)
SCORE_THRESHOLD = 0.35
NMS_THRESHOLD = 0.45

COCO = (
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
    "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog",
    "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella",
    "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite",
    "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle",
    "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant",
    "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone",
    "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors",
    "teddy bear", "hair drier", "toothbrush",
)
# The 42 classes worth naming in a home (the spec's look-vocabulary `detector_classes`).
HOUSEHOLD = (
    "person", "chair", "couch", "potted plant", "bed", "dining table", "tv", "laptop", "cell phone",
    "book", "bottle", "cup", "clock", "vase", "cat", "dog", "backpack", "handbag", "umbrella",
    "bowl", "refrigerator", "microwave", "oven", "sink", "toaster", "keyboard", "mouse", "remote",
    "scissors", "teddy bear", "bench", "suitcase", "wine glass", "fork", "knife", "spoon", "banana",
    "apple", "orange", "sandwich", "pizza", "cake",
)
HOUSEHOLD_IDS = np.array(sorted(COCO.index(name) for name in HOUSEHOLD))


def letterbox(frame):
    """Scale the picture into a 416 square, padded with 114; returns (1, 3, 416, 416) and the scale."""
    height, width = frame.shape[:2]
    scale = min(INPUT / height, INPUT / width)
    new_h, new_w = max(1, round(height * scale)), max(1, round(width * scale))
    rows = np.minimum((np.arange(new_h) / scale).astype(np.int32), height - 1)
    cols = np.minimum((np.arange(new_w) / scale).astype(np.int32), width - 1)
    canvas = np.full((INPUT, INPUT, 3), 114, dtype=np.float32)
    canvas[:new_h, :new_w] = frame[rows][:, cols]
    return canvas.transpose(2, 0, 1)[None], scale


def grids():
    """The cell corners and strides of the three YOLOX output scales, flattened in model order."""
    cells, strides = [], []
    for stride in STRIDES:
        size = INPUT // stride
        yy, xx = np.meshgrid(np.arange(size), np.arange(size), indexing="ij")
        cells.append(np.stack([xx, yy], axis=-1).reshape(-1, 2))
        strides.append(np.full((size * size, 1), stride))
    return np.concatenate(cells).astype(np.float32), np.concatenate(strides).astype(np.float32)


_GRID, _STRIDE = grids()


def nms(boxes, scores, threshold):
    """Greedy non-maximum suppression over (x, y, w, h) boxes; the kept indexes, best score first."""
    if not boxes:
        return []
    array = np.asarray(boxes, dtype=np.float32)
    x1, y1 = array[:, 0], array[:, 1]
    x2, y2 = x1 + array[:, 2], y1 + array[:, 3]
    areas = array[:, 2] * array[:, 3]
    order = np.argsort(np.asarray(scores))[::-1]
    kept = []
    while order.size:
        best = int(order[0])
        kept.append(best)
        rest = order[1:]
        inter_w = np.maximum(0, np.minimum(x2[best], x2[rest]) - np.maximum(x1[best], x1[rest]))
        inter_h = np.maximum(0, np.minimum(y2[best], y2[rest]) - np.maximum(y1[best], y1[rest]))
        inter = inter_w * inter_h
        overlap = inter / np.maximum(areas[best] + areas[rest] - inter, 1e-8)
        order = rest[overlap <= threshold]
    return kept


def decode(raw, scale, width, height):
    """Household detections from the model output: label, score and a box as fractions of the picture."""
    xy = (raw[:, :2] + _GRID) * _STRIDE
    wh = np.exp(raw[:, 2:4]) * _STRIDE
    class_scores = raw[:, 4:5] * raw[:, 5:]
    best_class = class_scores.argmax(axis=1)
    score = class_scores[np.arange(len(best_class)), best_class]
    keep = np.flatnonzero((score >= SCORE_THRESHOLD) & np.isin(best_class, HOUSEHOLD_IDS))
    results = []
    for cls in np.unique(best_class[keep]):
        indexes = keep[best_class[keep] == cls]
        boxes = [
            (float(xy[i, 0] - wh[i, 0] / 2), float(xy[i, 1] - wh[i, 1] / 2), float(wh[i, 0]), float(wh[i, 1]))
            for i in indexes
        ]
        for chosen in nms(boxes, [float(score[i]) for i in indexes], NMS_THRESHOLD):
            x, y, w, h = boxes[chosen]
            left = max(0.0, min(width, x / scale))
            top = max(0.0, min(height, y / scale))
            right = max(left, min(width, (x + w) / scale))
            bottom = max(top, min(height, (y + h) / scale))
            results.append({
                "label": COCO[int(cls)],
                "score": float(score[indexes[chosen]]),
                "box": [left / width, top / height, (right - left) / width, (bottom - top) / height],
            })
    return sorted(results, key=lambda item: -item["score"])


def color_name(b, g, r):
    """One of thirteen colour names for a mean BGR colour (0 to 255)."""
    h, s, v = colorsys.rgb_to_hsv(*(max(0.0, min(255.0, c)) / 255.0 for c in (r, g, b)))
    h *= 360
    if v < 0.15:
        return "black"
    if s < 0.12:
        return "white" if v >= 0.78 else "gray"
    if h < 15 or h >= 345:
        return "pink" if s < 0.45 and v >= 0.7 else "red"
    if h < 45:
        if s < 0.45 and v >= 0.55:
            return "beige"
        return "brown" if v < 0.55 else "orange"
    if h < 70:
        return "yellow"
    if h < 160:
        return "green"
    if h < 200:
        return "teal"
    if h < 260:
        return "blue"
    return "purple" if h < 300 else "pink"


def scene(frame):
    """(light bucket, wall colour tags, scene tags) from the picture's brightness and its upper row."""
    gray = float(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).mean())
    light = "dark" if gray < 35 else "dim" if gray < 85 else "bright"
    height, width = frame.shape[:2]
    rows = np.linspace(0, height, 3, dtype=int)
    cols = np.linspace(0, width, 4, dtype=int)
    names = []
    for col in range(3):
        cell = frame[rows[0]:rows[1], cols[col]:cols[col + 1]]
        if cell.size:
            names.append(color_name(*map(float, cell.mean(axis=(0, 1)))))
    wall = next((name for name in names if names.count(name) >= 2), None)
    words = {"bright": ["bright", "lights on"], "dark": ["dark", "lights off"], "dim": ["dim"]}[light]
    tags = [{"label": word, "score": 1.0} for word in words]
    colours = []
    if wall:
        colours = [f"{wall} wall"]
        tags.append({"label": colours[0], "score": 1.0})
    return light, colours, tags
