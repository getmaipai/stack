"""Offline JSON-lines worker for SoulX-Singer SVC."""
import json, os, select, subprocess, sys, time, wave
from pathlib import Path

IDLE_SECONDS = 60

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n"); sys.stdout.flush()

def run(request):
    import traceback
    import numpy as np
    import soundfile as sf
    import torch
    from omegaconf import OmegaConf
    from torchaudio import functional as AF

    started = time.time(); work = Path(request["workDir"]); work.mkdir(parents=True, exist_ok=True)
    source_wav, prompt_wav = work / "source.wav", work / "reference.wav"
    output_wav = Path(request["outputWav"])
    def decode(path, target):
        subprocess.run(["/usr/bin/afconvert", "-f", "WAVE", "-d", "LEI16@44100", str(path), str(target)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # WAV inputs can be length-checked without decoding; other containers are probed by afinfo.
    decode(request["source"], source_wav); decode(request["reference"], prompt_wav)
    source, sr_source = sf.read(source_wav, dtype="float32", always_2d=True)
    prompt, sr_prompt = sf.read(prompt_wav, dtype="float32", always_2d=True)
    source_duration = len(source) / sr_source; prompt_duration = len(prompt) / sr_prompt
    if not 6 <= prompt_duration <= 30: raise RuntimeError("The reference clip must be 6 to 30 seconds long.")
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    config = OmegaConf.load(request["config"])
    os.environ["HF_HUB_OFFLINE"] = "1"
    # Hugging Face reads the verified local-only snapshot and cannot resolve a remote id.
    os.environ["HF_HOME"] = str(Path(request["whisper"]).parents[5])
    from transformers import WhisperFeatureExtractor, WhisperModel
    pinned_whisper = request["whisper"]
    original_feature_extractor = WhisperFeatureExtractor.from_pretrained
    original_whisper_model = WhisperModel.from_pretrained
    WhisperFeatureExtractor.from_pretrained = classmethod(lambda cls, *args, **kwargs: original_feature_extractor(pinned_whisper, **kwargs))
    WhisperModel.from_pretrained = classmethod(lambda cls, *args, **kwargs: original_whisper_model(pinned_whisper, **kwargs))
    from soulxsinger.models.soulxsinger_svc import SoulXSingerSVC
    from preprocess.tools.f0_extraction import F0Extractor
    model = SoulXSingerSVC(config).to(device)
    checkpoint = torch.load(request["checkpoint"], weights_only=False, map_location="cpu")
    model.load_state_dict(checkpoint["state_dict"], strict=True); model.eval().to(device)
    emit({"id": request["id"], "event": "stage", "stage": "pitch", "fraction": .2})
    extractor = F0Extractor(request["rmvpe"], device="cpu", verbose=False)
    # RMVPE f0 arrays are explicitly float32: Apple MPS has no float64 support.
    source_f0 = extractor.process(str(source_wav), verbose=False).astype(np.float32)
    prompt_f0 = extractor.process(str(prompt_wav), verbose=False).astype(np.float32)
    np.save(work / "source_f0.npy", source_f0); np.save(work / "prompt_f0.npy", prompt_f0)
    def load_audio(path):
        wave, rate = sf.read(path, dtype="float32", always_2d=True)
        tensor = torch.from_numpy(wave.T.copy())
        if rate != config.audio.sample_rate: tensor = AF.resample(tensor, rate, config.audio.sample_rate)
        if tensor.shape[0] > 1: tensor = tensor.mean(dim=0, keepdim=True)
        return tensor.to(device)
    source_tensor = load_audio(source_wav)
    prompt_tensor = load_audio(prompt_wav)
    pt_f0 = torch.from_numpy(prompt_f0).unsqueeze(0).to(device)
    gt_f0 = torch.from_numpy(source_f0).unsqueeze(0).to(device)
    emit({"id": request["id"], "event": "stage", "stage": "converting", "fraction": .35})
    with torch.inference_mode():
        converted, _ = model.infer(pt_wav=prompt_tensor, gt_wav=source_tensor, pt_f0=pt_f0, gt_f0=gt_f0, auto_shift=request["auto_shift"], pitch_shift=request["pitch_shift"], n_steps=32, cfg=config.infer.cfg, use_fp16=False)
    audio = converted.squeeze().float().cpu().numpy()
    # Match the original sample count so the returned vocal has the source duration.
    target_frames = round(source_duration * config.audio.sample_rate)
    audio = audio[:target_frames] if len(audio) >= target_frames else np.pad(audio, (0, target_frames-len(audio)))
    sf.write(output_wav, audio, config.audio.sample_rate, subtype="PCM_16")
    out_m4a = Path(request["output"])
    subprocess.run(["/usr/bin/afconvert", "-f", "m4af", "-d", "0", "-b", "192000", str(output_wav), str(out_m4a)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"ms": int((time.time()-started)*1000), "source_seconds": source_duration, "reference_seconds": prompt_duration}

def main():
    emit({"ready": True}); last = time.monotonic()
    while True:
        ready, _, _ = select.select([sys.stdin], [], [], max(0, IDLE_SECONDS-(time.monotonic()-last)))
        if not ready: break
        line = sys.stdin.readline()
        if not line: break
        try:
            req = json.loads(line); emit({"id":req["id"],"event":"stage","stage":"loading","fraction":.05})
            result=run(req); emit({"id":req["id"],"ok":True,**result})
        except Exception:
            emit({"id":req.get("id",""),"ok":False,"error":"The voice conversion failed. Check the audio and try again."})
        last=time.monotonic()

if __name__ == "__main__": main()
