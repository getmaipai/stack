"""A true streaming generator for VoxCPM2 (mlx-audio 0.6.x returns the whole clip in one piece).

`stream_patches(model, text, prep, ...)` repeats the model's own generate() loop (same inputs, same
sampler, same stop head) but decodes after every few audio patches and yields each piece as soon as
it exists. One patch is 4 latent frames, 160 ms of audio at 48 kHz. Pieces are decoded with a few
earlier patches in front (the model's streaming_prefix_len idea) so the borders do not click.

Modes (`mode`):
    cont   continuation: the reference transcript goes in front of the text and the reference
           audio is the start of the sentence being spoken (the model continues it)
    ref    reference cloning: the clip is a voice sample only, no transcript
    both   reference clip as a sample plus the same clip as the continuation
"""
import mlx.core as mx
import numpy as np


def encode_reference(model, path):
    """(prompt_feat, ref_feat) latent patches of a 24 kHz wav file: left padded for continuation,
    right padded for reference cloning, exactly as generate() does it."""
    prompt = model._encode_wav(path, padding_mode="left")
    ref = model._encode_wav(path, padding_mode="right")
    mx.eval(prompt, ref)
    return prompt, ref


def _inputs(model, text, prep, mode, sep=""):
    P, D = model.patch_size, model.audio_vae.latent_dim
    prompt_text = prep["text"]
    if mode in ("cont", "both"):
        ids = model._tokenize(prompt_text + sep + text)
    else:
        ids = model._tokenize(text)
    text_token = mx.array(ids + [model.audio_start_token], dtype=mx.int32)
    n = text_token.shape[0]
    pad = mx.zeros((n, P, D))
    tok, feat, tm, am = [], [], [], []
    if mode in ("ref", "both"):
        rt, rf, rtm, ram = model._make_ref_prefix(prep["ref_feat"])
        tok.append(rt), feat.append(rf), tm.append(rtm), am.append(ram)
    tok.append(text_token), feat.append(pad)
    tm.append(mx.ones(n, dtype=mx.float32)), am.append(mx.zeros(n, dtype=mx.float32))
    if mode in ("cont", "both"):
        pf = prep["prompt_feat"]
        k = pf.shape[0]
        tok.append(mx.zeros(k, dtype=mx.int32)), feat.append(pf)
        tm.append(mx.zeros(k, dtype=mx.float32)), am.append(mx.ones(k, dtype=mx.float32))
    return (mx.concatenate(tok), mx.concatenate(feat, axis=0), mx.concatenate(tm), mx.concatenate(am), len(ids))


def stream_patches(model, text, prep, mode="cont", cfg_value=2.0, timesteps=10, noise=1.0,
                   seed=None, schedule=(1, 2, 4), prefix=4, max_patches=600, min_patches=2, sep=""):
    """Yield float32 mono audio pieces at model.sample_rate. `schedule` is the number of patches in
    the first pieces (the last value repeats). Closing the generator stops the work at once."""
    import mlx.nn as nn
    if seed is not None:
        mx.random.seed(seed)
    P = model.patch_size
    scale_emb = model.args.lm_config.scale_emb if model.args.lm_config.use_mup else 1.0
    text_token, audio_feat, text_mask, audio_mask, _ = _inputs(model, text, prep, mode, sep)
    text_token = text_token[None, :]
    audio_feat = audio_feat[None]
    text_embed = model.base_lm.embed_tokens(text_token) * scale_emb
    dtype = text_embed.dtype
    text_mask = text_mask[None, :].astype(dtype)
    audio_mask = audio_mask[None, :].astype(dtype)
    feat_embed = model.enc_to_lm_proj(model.feat_encoder(audio_feat.astype(dtype)))
    comb = text_mask[:, :, None] * text_embed + audio_mask[:, :, None] * feat_embed
    prefix_cond = audio_feat[:, -1, :, :]
    enc, lm_cache = model.base_lm(comb)
    enc = model.fsq_layer(enc) * audio_mask[:, :, None] + enc * text_mask[:, :, None]
    lm_hidden = enc[:, -1, :]
    res_in = model.fusion_concat_proj(mx.concatenate([enc, audio_mask[:, :, None] * feat_embed], axis=-1))
    res_out, res_cache = model.residual_lm(res_in)
    res_hidden = res_out[:, -1, :]

    # context patches in front of the first piece: the last prompt patches (continuation) or none
    seq = []
    if mode in ("cont", "both"):
        seq = [audio_feat[:, i, :, :][:, None] for i in range(audio_feat.shape[1] - min(3, prep["prompt_feat"].shape[0]),
                                                              audio_feat.shape[1])]
    n_ctx = len(seq)
    per_patch = P * model.audio_vae.decode_chunk_size
    done = n_ctx           # patches already emitted (the context counts as emitted)
    sched_i = 0
    want = schedule[0]

    def decode(n_new):
        win = seq[-(prefix + n_new):]
        x = mx.concatenate(win, axis=1)
        a = model.audio_vae.decode(x.reshape(1, -1, model.feat_dim)).reshape(-1)
        mx.eval(a)
        return np.asarray(a, dtype=np.float32)[-n_new * per_patch:]

    for i in range(max_patches):
        dit_h = mx.concatenate([model.lm_to_dit_proj(lm_hidden), model.res_to_dit_proj(res_hidden)], axis=-1)
        pred = model.feat_decoder.sample(mu=dit_h, n_timesteps=timesteps, patch_size=P,
                                         cond=prefix_cond.transpose(0, 2, 1), temperature=noise, cfg_value=cfg_value)
        pred = pred.transpose(0, 2, 1)
        seq.append(pred[:, None, :, :])
        curr = model.enc_to_lm_proj(model.feat_encoder(pred[:, None, :, :].astype(dtype)))
        stop = mx.argmax(model.stop_head(nn.silu(model.stop_proj(lm_hidden))), axis=-1).item()
        if len(seq) - done >= want:
            n_new = len(seq) - done
            yield decode(n_new)
            done += n_new
            sched_i += 1
            want = schedule[min(sched_i, len(schedule) - 1)]
        if i > min_patches and stop == 1:
            break
        out, lm_cache = model.base_lm(inputs_embeds=curr, cache=lm_cache)
        lm_hidden = model.fsq_layer(out[:, -1, :])
        r_in = model.fusion_concat_proj(mx.concatenate([lm_hidden[:, None, :], curr], axis=-1))
        r_out, res_cache = model.residual_lm(inputs_embeds=r_in, cache=res_cache)
        res_hidden = r_out[:, -1, :]
        prefix_cond = pred
    if len(seq) > done:
        yield decode(len(seq) - done)
