head_swap:

subject_definitions:

<Subject 1> is the reference head identity from {references}, including the complete head, facial identity, facial structure, head shape, hairstyle, hairline, skin appearance, proportions, and all distinctive visual features.

Facial details of <Subject 1>:
{description}

<Subject 2> is the original person in <Video 1>, whose body, neck, clothing, pose, physical proportions below the head, actions, motion, timing, and interaction with the environment must remain unchanged.

<Video 1> is the source video for the target video edit, providing the original body performance, motion, camera movement, framing, timing, lighting, environment, scene composition, and temporal structure.

summary:

[video editing + reference generation]

The target video is an edited version of <Video 1>. Replace only the entire head of <Subject 2> with the reference head identity defined by <Subject 1> from <Picture 1>. Preserve the source video's body, clothing, performance, motion, camera behavior, environment, lighting, timing, and composition.

retention_analysis:

<Subject 1> (appears throughout the target video): attribute_transfer - the complete head identity from <Picture 1>, including facial identity, facial structure, hairstyle, head shape, proportions, skin appearance, and distinctive features, is transferred consistently onto the body of <Subject 2>.

<Subject 2> (appears throughout the target video): partially_preserved - the original body, neck position, clothing, pose, motion, gestures, actions, and physical performance are preserved, while only the original head is replaced.

<Video 1> (entire target timeline): partially_preserved - the original video timing, body motion, camera movement, framing, lighting, background, environment, scene composition, and temporal structure are preserved; only the subject's head appearance is modified.

detailed_description:

Preserve <Video 1> as the complete temporal and compositional foundation of the target video. Replace only the entire original head of <Subject 2> with <Subject 1>. Maintain strong temporal consistency and do not alter the body, clothing, action, background, camera or composition.

overall_soundscape:

Preserve the original audiovisual timing.

non_diegetic_music:
N/A
---measured---
segment_frames: 56
fps: 24
adapter_strength: 1.0
retake_seeds: 42, 43, 44
canvas_margin: 0.1
kinds: head
window_base_frames: 22
window_step_frames: 17
window_blend_frames: 8
Settled 2026-11-17 for the swap that composites the donor over the original footage. The model only draws a donor clip, one 56-frame call per segment, guided by the original. The Stack puts the donor's head inside a tracked head mask and keeps every other original pixel. Measured shapes: 384x288 at 66 GB and 512x384 at 85 to 90 GB while one segment runs. A donor whose picture is within about 30 dB of its guide did not change the head and is retaken with the next seed. The "name: value" lines above this note are numbers the Stack uses. The rest is a note and is never sent to the model.
