# The bundled speech clip

`clover-two-seconds.wav`: 16 kHz, mono, 16-bit PCM, 2.13 s, one
persona-roster sentence, "Clover, the kitchen light is on." It is the
`stt` role's post-load check and readiness probe, and the suite's
fixture. Synthesized on the dev machine, never household audio.

Regenerate it with the two macOS built-ins, one command per line:

```
say -o clover.aiff "Clover, the kitchen light is on."
afconvert -f WAVE -d LEI16@16000 -c 1 clover.aiff clover-two-seconds.wav
```
