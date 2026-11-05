#!/usr/bin/env python3
"""Small labeled ONNX object-detection bench. See docs/design/detector-2026-11-04.md.

One process = one (model, provider) pair, so peak RSS is per run. Weights and
images stay outside git. Adapters (explicit; unknown layouts fail):
  yolox   official Megvii ONNX: [1,3,640,640] BGR 0..255 letterbox (pad 114, top-left),
          raw [1,8400,85] grid-decoded here (strides 8/16/32), score = obj*cls, NMS.
  yolov8  Ultralytics export (yolov8/yolo11): [1,84,8400] cxcywh pixels, RGB 0..1
          letterbox (centered), no objectness, NMS.
  rtdetr  HF/Optimum ONNX: pixel_values RGB 0..1 direct resize 640x640,
          logits [1,300,80] (sigmoid) + pred_boxes normalized cxcywh, no NMS.

Manifest: {"images":[{"path":..., "gt":[{"label":"dog","box":[x0,y0,x1,y1] fractions,
"crowd":false}], "tag":"dog"}]}. Use --make-manifest to build one from a COCO
instances_val2017.json, a directory of 000000NNNNNN.jpg files and a selection JSON
{"<image id>": "<tag>"}. Hand-labelled extra images can be appended to the manifest.
Metrics at --threshold (default 0.4): label hit (class present in GT and detected),
IoU hit (same class, IoU>=0.5 with a GT box), label false positive (detected class
absent from GT labels), box false positive (detection with no same-class GT IoU>=0.5).
"""
import argparse, json, resource, sys, time
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
    import onnxruntime as ort
except ImportError as exc:
    raise SystemExit(f"Missing bench dependency: {exc}. Install Pillow, numpy, onnxruntime.")

COCO = ["person","bicycle","car","motorcycle","airplane","bus","train","truck","boat","traffic light","fire hydrant","stop sign","parking meter","bench","bird","cat","dog","horse","sheep","cow","elephant","bear","zebra","giraffe","backpack","umbrella","handbag","tie","suitcase","frisbee","skis","snowboard","sports ball","kite","baseball bat","baseball glove","skateboard","surfboard","tennis racket","bottle","wine glass","cup","fork","knife","spoon","bowl","banana","apple","sandwich","orange","broccoli","carrot","hot dog","pizza","donut","cake","chair","couch","potted plant","bed","dining table","toilet","tv","laptop","mouse","remote","keyboard","cell phone","microwave","oven","toaster","sink","refrigerator","book","clock","vase","scissors","teddy bear","hair drier","toothbrush"]
assert len(COCO) == 80


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0])); iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    i = ix * iy; u = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - i
    return i / u if u > 0 else 0.0


def nms(dets, thr=0.45):
    """Per-class NMS on dicts with label, score, box."""
    out = []
    for d in sorted(dets, key=lambda d: -d["score"]):
        if all(o["label"] != d["label"] or iou(o["box"], d["box"]) < thr for o in out):
            out.append(d)
    return out


def letterbox(im, size, centered, pad=114):
    ow, oh = im.size; s = min(size/ow, size/oh); nw, nh = round(ow*s), round(oh*s)
    canvas = Image.new("RGB", (size, size), (pad,)*3)
    off = ((size-nw)//2, (size-nh)//2) if centered else (0, 0)
    canvas.paste(im.resize((nw, nh), Image.BILINEAR), off)
    return canvas, s, off


def to_frac(x0, y0, x1, y1, s, off, ow, oh):
    c = lambda v: float(min(1.0, max(0.0, v)))
    return [c((x0-off[0])/s/ow), c((y0-off[1])/s/oh), c((x1-off[0])/s/ow), c((y1-off[1])/s/oh)]


def prep_and_decode(adapter, sess, im, size, thr):
    ow, oh = im.size; name = sess.get_inputs()[0].name
    if adapter == "rtdetr":
        x = np.asarray(im.resize((size, size), Image.BILINEAR), dtype=np.float32)/255.
        feed = np.transpose(x, (2, 0, 1))[None]
    elif adapter == "yolov8":
        canvas, s, off = letterbox(im, size, True)
        feed = np.transpose(np.asarray(canvas, dtype=np.float32)/255., (2, 0, 1))[None]
    elif adapter == "yolox":
        canvas, s, off = letterbox(im, size, False)
        feed = np.transpose(np.asarray(canvas, dtype=np.float32)[:, :, ::-1], (2, 0, 1))[None]  # BGR 0..255
    else:
        raise SystemExit(f"Unknown adapter {adapter}")
    t = time.perf_counter(); out = sess.run(None, {name: np.ascontiguousarray(feed)}); ms = (time.perf_counter()-t)*1000
    dets = []
    if adapter == "rtdetr":
        logits = out[0][0]; boxes = out[1][0]
        if logits.shape[1] != 80 or boxes.shape[1] != 4: raise SystemExit(f"Unsupported rtdetr output {logits.shape} {boxes.shape}")
        p = 1/(1+np.exp(-logits)); ci = p.argmax(1); sc = p.max(1)
        for i in np.where(sc >= thr)[0]:
            cx, cy, w, h = boxes[i]
            dets.append({"label": COCO[ci[i]], "score": float(sc[i]), "box": [float(max(0, cx-w/2)), float(max(0, cy-h/2)), float(min(1, cx+w/2)), float(min(1, cy+h/2))]})
    elif adapter == "yolov8":
        a = out[0][0]
        if a.shape[0] != 84: raise SystemExit(f"Unsupported yolov8 output {a.shape}")
        a = a.T; sc = a[:, 4:].max(1); ci = a[:, 4:].argmax(1)
        for i in np.where(sc >= thr)[0]:
            cx, cy, w, h = a[i, :4]
            dets.append({"label": COCO[ci[i]], "score": float(sc[i]), "box": to_frac(cx-w/2, cy-h/2, cx+w/2, cy+h/2, s, off, ow, oh)})
        dets = nms(dets)
    else:
        a = out[0][0].copy()
        if a.shape != (8400, 85): raise SystemExit(f"Unsupported yolox output {a.shape}")
        grids, strides = [], []
        for st in (8, 16, 32):
            n = size // st; gy, gx = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
            grids.append(np.stack([gx, gy], -1).reshape(-1, 2)); strides.append(np.full((n*n, 1), st))
        grids = np.concatenate(grids).astype(np.float32); strides = np.concatenate(strides).astype(np.float32)
        a[:, :2] = (a[:, :2] + grids) * strides; a[:, 2:4] = np.exp(a[:, 2:4]) * strides
        sc_all = a[:, 4:5] * a[:, 5:]; ci = sc_all.argmax(1); sc = sc_all.max(1)
        for i in np.where(sc >= thr)[0]:
            cx, cy, w, h = a[i, :4]
            dets.append({"label": COCO[ci[i]], "score": float(sc[i]), "box": to_frac(cx-w/2, cy-h/2, cx+w/2, cy+h/2, s, off, ow, oh)})
        dets = nms(dets)
    return dets, ms


def make_manifest(ann_path, img_dir, sel_path, out):
    ann = json.load(open(ann_path)); cats = {c["id"]: c["name"] for c in ann["categories"]}
    imgs = {i["id"]: i for i in ann["images"]}; sel = json.load(open(sel_path)); items = []
    for iid, tag in sel.items():
        iid = int(iid); W, H = imgs[iid]["width"], imgs[iid]["height"]
        gt = [{"label": cats[a["category_id"]], "crowd": bool(a["iscrowd"]),
               "box": [a["bbox"][0]/W, a["bbox"][1]/H, (a["bbox"][0]+a["bbox"][2])/W, (a["bbox"][1]+a["bbox"][3])/H]}
              for a in ann["annotations"] if a["image_id"] == iid]
        items.append({"path": str(Path(img_dir)/f"{iid:012d}.jpg"), "tag": tag, "gt": gt})
    Path(out).write_text(json.dumps({"images": items}, indent=1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model"); ap.add_argument("--manifest")
    ap.add_argument("--adapter", choices=["yolox", "yolov8", "rtdetr"])
    ap.add_argument("--providers", default="CoreMLExecutionProvider,CPUExecutionProvider")
    ap.add_argument("--size", type=int, default=640); ap.add_argument("--threshold", type=float, default=0.4)
    ap.add_argument("--warmup", type=int, default=3); ap.add_argument("--repeats", type=int, default=5)
    ap.add_argument("--make-manifest", nargs=4, metavar=("ANN", "IMGDIR", "SEL", "OUT"))
    args = ap.parse_args()
    if args.make_manifest: return make_manifest(*args.make_manifest)
    if not (args.model and args.manifest and args.adapter): ap.error("--model, --manifest, --adapter required")
    available = ort.get_available_providers(); requested = args.providers.split(",")
    providers = [p for p in requested if p in available]
    if not providers: raise SystemExit(f"No requested provider available; available={available}")
    t0 = time.perf_counter(); sess = ort.InferenceSession(args.model, providers=providers); load_s = time.perf_counter()-t0
    manifest = json.loads(Path(args.manifest).read_text()); rows = []; lat = []; first = None
    for item in manifest["images"]:
        im = Image.open(item["path"]).convert("RGB")
        if first is None:  # cold first run, then warmup
            _, first = prep_and_decode(args.adapter, sess, im, args.size, args.threshold)
            for _ in range(args.warmup): prep_and_decode(args.adapter, sess, im, args.size, args.threshold)
        ms_list = []
        for _ in range(args.repeats):
            dets, ms = prep_and_decode(args.adapter, sess, im, args.size, args.threshold); ms_list.append(ms)
        lat.append(float(np.median(ms_list)))
        allgt = item.get("gt", []); gt = [g for g in allgt if not g["crowd"]]
        gl = {g["label"] for g in gt}; dl = {d["label"] for d in dets}
        iou_hit = sorted({g["label"] for g in gt if any(d["label"] == g["label"] and iou(d["box"], g["box"]) >= .5 for d in dets)})
        box_fp = [d for d in dets if not any(g["label"] == d["label"] and iou(d["box"], g["box"]) >= .5 for g in allgt)]
        rows.append({"image": item["path"], "tag": item.get("tag"), "gt_labels": sorted(gl), "detections": dets,
                     "label_hit": sorted(gl & dl), "label_miss": sorted(gl - dl), "iou_hit": iou_hit,
                     "label_fp": sorted(dl - gl), "box_fp": [{"label": d["label"], "score": round(d["score"], 2)} for d in box_fp]})
    agg = {}
    for r in rows:
        for c in r["gt_labels"]:
            e = agg.setdefault(c, {"images": 0, "label_hit": 0, "iou_hit": 0}); e["images"] += 1
            e["label_hit"] += c in r["label_hit"]; e["iou_hit"] += c in r["iou_hit"]
    report = {"model": str(Path(args.model).resolve()), "adapter": args.adapter, "providers_requested": requested,
              "providers_actual": sess.get_providers(), "threshold": args.threshold, "session_load_s": round(load_s, 2),
              "first_run_ms": round(first, 1), "latency_ms": {"median": float(np.median(lat)), "p95": float(np.percentile(lat, 95)), "mean": float(np.mean(lat))},
              "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/(1024*1024 if sys.platform == "darwin" else 1024), 1),
              "per_class": agg, "label_fp_images": sum(bool(r["label_fp"]) for r in rows),
              "box_fp_total": sum(len(r["box_fp"]) for r in rows), "images": rows}
    print(json.dumps(report))


if __name__ == "__main__": main()
