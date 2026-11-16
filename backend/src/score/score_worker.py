#!/usr/bin/env python3
"""Offline JSON-lines audio-to-MIDI worker for MaiPai Stack."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

MAX_SECONDS = 600
MAX_NOTES = 20_000


def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


def run(req):
    started = time.monotonic()
    source = Path(req["input"])
    output = Path(req["output_dir"])
    output.mkdir(parents=True, exist_ok=True)
    ffmpeg = req["ffmpeg"]
    probe = subprocess.run([str(Path(ffmpeg).with_name("ffprobe")), "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(source)], capture_output=True, text=True)
    if probe.returncode:
        raise ValueError("The audio file could not be read. Choose a playable audio file and try again.")
    try:
        duration = float(probe.stdout.strip())
    except ValueError:
        raise ValueError("The audio length could not be read. Choose a playable audio file and try again.")
    if duration > MAX_SECONDS:
        raise ValueError("Audio is longer than the 10 minute limit. Cut the clip to 10 minutes or less and try again.")
    if duration <= 0:
        raise ValueError("The audio file has no playable length. Choose a non-empty audio file and try again.")
    converted = output / "input.wav"
    convert = subprocess.run([ffmpeg, "-nostdin", "-v", "error", "-y", "-i", str(source), "-t", "600", "-ar", "22050", "-ac", "1", str(converted)], capture_output=True, text=True)
    if convert.returncode:
        raise ValueError("The audio file could not be converted. Choose a playable audio file and try again.")
    emit({"id": req["id"], "event": "stage", "stage": "score", "fraction": 0.15})
    from basic_pitch.inference import predict
    _, midi, _ = predict(str(converted))
    midi_path = output / (req["id"] + ".mid")
    notes_path = output / (req["id"] + ".notes.json")
    midi.write(str(midi_path))
    notes = []
    for instrument in midi.instruments:
        for note in instrument.notes:
            notes.append({"start": float(note.start), "end": float(note.end), "pitch": int(note.pitch), "velocity": int(note.velocity)})
    notes.sort(key=lambda note: (note["start"], note["pitch"], note["end"]))
    notes = notes[:MAX_NOTES]
    notes_path.write_text(json.dumps(notes, separators=(",", ":")), encoding="utf-8")
    try:
        tempo = float(midi.estimate_tempo())
    except Exception:
        tempo = 120.0
    return {"id": req["id"], "ok": True, "tempo_bpm": round(tempo, 2), "notes": len(notes), "ms": round((time.monotonic() - started) * 1000)}


def main():
    for line in sys.stdin:
        try:
            req = json.loads(line)
            try:
                emit(run(req))
            except Exception as exc:
                message = str(exc)
                if not (message.startswith("Audio is longer than") or message.startswith("The audio file")):
                    message = "The score could not be made from this audio file. Choose a playable audio file and try again."
                emit({"id": req.get("id"), "ok": False, "code": "failed", "error": message})
        except Exception:
            emit({"id": None, "ok": False, "code": "bad_request", "error": "The score request could not be read. Send it again."})


if __name__ == "__main__":
    main()
