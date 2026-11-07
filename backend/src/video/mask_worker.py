import json, os, sys, time
from pathlib import Path

def emit(value):
    print(json.dumps(value), flush=True)

def main(req):
    import torch
    from PIL import Image
    from sam2.build_sam import build_sam2_video_predictor
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    predictor = build_sam2_video_predictor(req["config"], req["model"], device=device)
    frames = sorted(Path(req["frames_dir"]).glob("*.jpg"))
    state = predictor.init_state(video_path=req["frames_dir"])
    prompt = req["prompt"]
    points = prompt.get("points")
    if not points and prompt.get("box"):
        box = prompt["box"]
        predictor.add_new_points_or_box(state, frame_idx=prompt["frame"], obj_id=1, box=box)
    elif points:
        import numpy as np
        predictor.add_new_points_or_box(state, frame_idx=prompt["frame"], obj_id=1, points=np.array([[p["x"], p["y"]] for p in points], dtype=np.float32), labels=np.array([p["label"] for p in points], dtype=np.int32))
    total = len(frames)
    for idx, _, logits in predictor.propagate_in_video(state):
        mask = (logits[0] > 0).detach().cpu().numpy().astype("uint8") * 255
        Image.fromarray(mask).save(Path(req["out_dir"]) / f"{idx:05d}.png")
        emit({"id": req["id"], "progress": idx + 1, "total": total})
    emit({"id": req["id"], "ok": True, "total": total})

for line in sys.stdin:
    try:
        main(json.loads(line))
    except Exception as exc:
        emit({"id": None, "ok": False, "error": str(exc)})
