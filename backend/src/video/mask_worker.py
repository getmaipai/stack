import json, os, sys, time
from pathlib import Path

def segment(req, predictor):
    import numpy as np
    from PIL import Image
    source = Path(req["input"])
    frame_path = Path(req["frames_dir"]) / "00000.jpg"
    with Image.open(source) as original:
        original_size = original.size
        original.convert("RGB").save(frame_path, "JPEG", quality=98)
    frame = sorted(Path(req["frames_dir"]).glob("*.jpg"))[0]
    state = predictor.init_state(video_path=req["frames_dir"])
    prompt = req["prompt"]
    kwargs = {}
    if prompt.get("box"):
        kwargs["box"] = np.array(prompt["box"], dtype=np.float32)
    points = prompt.get("points") or []
    if points:
        kwargs["points"] = np.array([[p["x"], p["y"]] for p in points], dtype=np.float32)
        kwargs["labels"] = np.array([p["label"] for p in points], dtype=np.int32)
    _, _, logits = predictor.add_new_points_or_box(state, frame_idx=0, obj_id=1, **kwargs)
    mask = (logits[0, 0] > 0).detach().cpu().numpy().astype("uint8") * 255
    Image.fromarray(mask, mode="L").resize(original_size, Image.Resampling.NEAREST).save(Path(req["out_dir"]) / "00000.png")
    emit({"id": req["id"], "ok": True, "total": 1})

def emit(value):
    print(json.dumps(value), flush=True)

def main(req):
    import torch
    from PIL import Image
    from sam2.build_sam import build_sam2_video_predictor
    import numpy as np
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    predictor = build_sam2_video_predictor(req["config"], req["model"], device=device)
    if req.get("op") == "segment":
        from PIL import Image
        frame_dir = Path(req["frames_dir"])
        frame_dir.mkdir(parents=True, exist_ok=True)
        (Path(req["out_dir"])).mkdir(parents=True, exist_ok=True)
        segment(req, predictor)
        return
    frames = sorted(Path(req["frames_dir"]).glob("*.jpg"))
    state = predictor.init_state(video_path=req["frames_dir"])
    prompt = req["prompt"]
    points = prompt.get("points")
    kwargs = {}
    if prompt.get("box"):
        kwargs["box"] = prompt["box"]
    if points:
        kwargs["points"] = np.array([[p["x"], p["y"]] for p in points], dtype=np.float32)
        kwargs["labels"] = np.array([p["label"] for p in points], dtype=np.int32)
    if kwargs:
        predictor.add_new_points_or_box(state, frame_idx=prompt["frame"], obj_id=1, **kwargs)
    total = len(frames)
    for idx, _, logits in predictor.propagate_in_video(state):
        mask = (logits[0, 0] > 0).detach().cpu().numpy().astype("uint8") * 255
        Image.fromarray(mask).save(Path(req["out_dir"]) / f"{idx:05d}.png")
        emit({"id": req["id"], "progress": idx + 1, "total": total})
    emit({"id": req["id"], "ok": True, "total": total})

for line in sys.stdin:
    try:
        main(json.loads(line))
    except Exception as exc:
        emit({"id": None, "ok": False, "error": str(exc)})
