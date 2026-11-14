import json, sys, types, os
from pathlib import Path
import wave
import numpy as np

# mlx-audio imports moshi only for unrelated STS models; this model does not
# use sentencepiece. Keep this dependency local to the worker process.
sys.modules.setdefault("sentencepiece", types.ModuleType("sentencepiece"))
from mlx_audio.sts.models.mossformer2_se import MossFormer2SEModel

model_dir, source, target = sys.argv[1:]
runtime_dir = Path(target).parent / "model"
runtime_dir.mkdir()
os.symlink(Path(model_dir) / "model_fp16.safetensors", runtime_dir / "model.safetensors")
(runtime_dir / "config.json").write_text(json.dumps({"quantization_config": {"bits": 16}}))
model = MossFormer2SEModel.from_pretrained(str(runtime_dir))
result = np.asarray(model.enhance(source), dtype=np.float32).reshape(-1)
pcm = (np.clip(result, -1.0, 1.0) * 32767).astype("<i2")
with wave.open(target, "wb") as output:
    output.setnchannels(1)
    output.setsampwidth(2)
    output.setframerate(48000)
    output.writeframes(pcm.tobytes())
