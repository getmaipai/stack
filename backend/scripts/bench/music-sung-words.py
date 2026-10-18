#!/usr/bin/env python3
"""On-demand sung-word bench against a scratch Stack, never part of the gate."""
import argparse
from collections import Counter
import json
import math
from pathlib import Path
import re
import sys
import time
from urllib.parse import quote
from urllib.request import Request, urlopen


SECTION = re.compile(r"^\[[^\[\]]+\]$")
STAMP = re.compile(r"\[(\d+):(\d{2}(?:\.\d+)?)\]")


def split_words(text):
    """Normalize words, ignoring standalone section tag lines."""
    return re.findall(r"[a-z0-9']+", "\n".join(
        line for line in text.lower().splitlines()
        if not SECTION.fullmatch(line.strip())))


def lcs_alignment(lyrics, heard):
    """Return index pairs for one longest in-order match, including repeats."""
    lengths = [[0] * (len(heard) + 1) for _ in range(len(lyrics) + 1)]
    for i in range(len(lyrics) - 1, -1, -1):
        for j in range(len(heard) - 1, -1, -1):
            lengths[i][j] = (1 + lengths[i + 1][j + 1] if lyrics[i] == heard[j]
                             else max(lengths[i + 1][j], lengths[i][j + 1]))
    pairs = []
    i = j = 0
    while i < len(lyrics) and j < len(heard):
        if lyrics[i] == heard[j]:
            pairs.append((i, j))
            i += 1
            j += 1
        elif lengths[i + 1][j] >= lengths[i][j + 1]:
            i += 1
        else:
            j += 1
    return pairs


def parse_lrc(lrc):
    """Keep timed section markers as rows, including repeated timestamps."""
    rows = []
    for line in lrc.splitlines():
        stamps = list(STAMP.finditer(line))
        if stamps:
            text = line[stamps[-1].end():].strip()
            for stamp in stamps:
                rows.append({"time": int(stamp[1]) * 60 + float(stamp[2]),
                             "text": text, "row": line})
    return sorted(rows, key=lambda row: row['time'])


def squeezed_lines(rows, seconds):
    counts = Counter(row['time'] for row in rows)
    for i, row in enumerate(rows):
        if seconds - 1.5 <= row['time'] <= seconds and counts[row['time']] > 1:
            # Include the line leading into the collapsed ending, as in MUSIC-GEN-17's fixture.
            return rows[max(0, i - 1):]
    return []


def make_report(lyrics, transcript, lrc, seconds):
    lyric_words = split_words(lyrics)
    if not lyric_words:
        raise ValueError('No lyric words found; supply sung lyrics.')
    heard = []
    for segment in transcript['segments']:
        for word in segment.get('words', []):
            heard.extend({'word': token, 'time': word['start']}
                         for token in split_words(word['word']))
    pairs = lcs_alignment(lyric_words, [word['word'] for word in heard])
    matched = {j for _, j in pairs}
    rows = parse_lrc(lrc)
    extras = []
    for j, word in enumerate(heard):
        if j in matched:
            continue
        section = None
        for row in rows:
            if row['time'] > word['time']:
                break
            if SECTION.fullmatch(row['text']):
                section = row['text']
        extras.append({**word, 'section': section})
    squeezed = squeezed_lines(rows, seconds)
    return {'lyric_words': len(lyric_words), 'heard_words': len(heard),
            'in_order_recall': len(pairs) / len(lyric_words),
            'words_not_in_lyrics': len(extras), 'extras': extras,
            'squeezed_lines': squeezed, 'pass': not squeezed}


def transcribe(path, model_dir):
    import mlx_whisper
    return mlx_whisper.transcribe(
        str(path), path_or_hf_repo=str(model_dir), language='en',
        word_timestamps=True, condition_on_previous_text=False,
        hallucination_silence_threshold=2.0, compression_ratio_threshold=2.0,
        no_speech_threshold=0.6)


def request_json(url, body=None):
    request = Request(url, data=json.dumps(body).encode() if body is not None else None,
                      headers={'Content-Type': 'application/json'})
    with urlopen(request, timeout=1900) as response:
        return json.load(response)


def save_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stack', required=True, help='Scratch Stack URL, never the live Stack')
    parser.add_argument('--lyrics', type=Path, required=True)
    parser.add_argument('--caption', required=True)
    parser.add_argument('--seconds', type=float, required=True)
    parser.add_argument('--seed', type=int)
    parser.add_argument('--quality', choices=['quick', 'detailed'], default='quick')
    parser.add_argument('--whisper', type=Path, required=True, help='Existing local whisper model directory')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    try:
        if not args.whisper.is_dir():
            raise ValueError('Whisper model directory is missing; supply an existing local model.')
        if not math.isfinite(args.seconds) or args.seconds <= 0:
            raise ValueError('Duration must be positive and finite; change --seconds.')
        lyrics = args.lyrics.read_text(encoding='utf-8')
        if not split_words(lyrics):
            raise ValueError('No lyric words found; supply sung lyrics.')
        args.out.mkdir(parents=True, exist_ok=True)
        body = dict(task='text2music', caption=args.caption, lyrics=lyrics,
                    duration_s=args.seconds, quality=args.quality)
        if args.seed is not None:
            body['seed'] = args.seed
        base = args.stack.rstrip('/') + '/v1/audio/music'
        submitted = request_json(base, body)
        save_json(args.out / 'job.json', submitted)
        job_url = base + '/' + quote(submitted['job'], safe='')
        while True:
            job = request_json(job_url)
            save_json(args.out / 'job.json', job)
            if job['state'] in ('done', 'failed', 'cancelled'):
                break
            if job['state'] not in ('queued', 'running'):
                raise ValueError(f"Unknown job state {job['state']}; inspect job.json.")
            time.sleep(2)
        if job['state'] != 'done':
            raise ValueError(f"Song {job['state']}: {job.get('error')}; inspect job.json before retrying.")
        song = job['data'][0]
        if not song.get('lrc'):
            raise ValueError('Song has no LRC; rerun with sung lyrics before checking the ending.')
        path = args.out / 'song.m4a'
        with urlopen(job_url + '/file', timeout=120) as response, path.open('wb') as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        transcript = transcribe(path, args.whisper.resolve())
        report = make_report(lyrics, transcript, song['lrc'], song['duration_s'])
        save_json(args.out / 'report.json', report)
        return 0 if report['pass'] else 1
    except Exception as error:
        print(f'Bench error: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
