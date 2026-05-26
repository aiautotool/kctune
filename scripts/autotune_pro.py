#!/usr/bin/env python3
import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

import librosa
import numpy as np
import soundfile as sf
from scipy import signal


NOTES = {
    "C": 0,
    "Db": 1,
    "D": 2,
    "Eb": 3,
    "E": 4,
    "F": 5,
    "Gb": 6,
    "G": 7,
    "Ab": 8,
    "A": 9,
    "Bb": 10,
    "B": 11,
}

SCALES = {
    "Major": [0, 2, 4, 5, 7, 9, 11],
    "Minor": [0, 2, 3, 5, 7, 8, 10],
    "Major Pentatonic": [0, 2, 4, 7, 9],
    "Minor Pentatonic": [0, 3, 5, 7, 10],
}

MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def run(args):
    completed = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "command failed")
    return completed.stdout


def decode_to_wav(ffmpeg, source, target, sample_rate):
    run([
        ffmpeg,
        "-y",
        "-i",
        source,
        "-vn",
        "-ac",
        "2",
        "-ar",
        str(sample_rate),
        "-c:a",
        "pcm_f32le",
        target,
    ])


def encode_wav(data, sample_rate, output_path):
    peak = float(np.max(np.abs(data))) if data.size else 0.0
    if peak > 0.98:
        data = data * (0.98 / peak)
    sf.write(output_path, data.astype(np.float32), sample_rate, subtype="FLOAT")


def butter_filter(samples, sample_rate, kind, freq, order=3):
    nyquist = sample_rate * 0.5
    normalized = np.clip(np.asarray(freq, dtype=float) / nyquist, 1e-5, 0.999)
    b, a = signal.butter(order, normalized, btype=kind)
    return signal.filtfilt(b, a, samples).astype(np.float32)


def vocal_center_stem(stereo, sample_rate):
    left = stereo[:, 0]
    right = stereo[:, 1]
    center = ((left + right) * 0.5).astype(np.float32)
    vocal = butter_filter(center, sample_rate, "bandpass", [95, 7600], order=3)
    vocal *= 0.88
    instrumental = stereo.copy()
    instrumental[:, 0] -= vocal * 0.62
    instrumental[:, 1] -= vocal * 0.62
    return vocal, instrumental


def detect_key(y, sample_rate, requested_key, requested_scale):
    if requested_key != "Auto":
        return requested_key, requested_scale

    chroma = librosa.feature.chroma_cqt(y=y, sr=sample_rate)
    chroma_sum = np.mean(chroma, axis=1)
    if np.max(chroma_sum) > 0:
        chroma_sum = chroma_sum / np.max(chroma_sum)

    forced_minor = "Minor" in requested_scale
    forced_major = requested_scale == "Major" or requested_scale == "Major Pentatonic"
    candidates = []
    for root_name, root in NOTES.items():
        if not forced_minor:
            profile = np.roll(MAJOR_PROFILE, root)
            candidates.append((float(np.corrcoef(chroma_sum, profile)[0, 1]), root_name, requested_scale if forced_major else "Major"))
        if not forced_major:
            profile = np.roll(MINOR_PROFILE, root)
            candidates.append((float(np.corrcoef(chroma_sum, profile)[0, 1]), root_name, requested_scale if forced_minor else "Minor"))

    candidates = [item for item in candidates if np.isfinite(item[0])]
    if not candidates:
        return "C", requested_scale
    _, key, scale = max(candidates, key=lambda item: item[0])
    return key, scale


def scale_degrees(root_name, scale_name):
    root = NOTES.get(root_name, 0)
    steps = SCALES.get(scale_name, SCALES["Major"])
    return sorted({(root + step) % 12 for step in steps})


def snap_midi(midi_value, allowed_degrees):
    octave = math.floor(midi_value / 12)
    candidates = []
    for octave_offset in (-1, 0, 1):
        for degree in allowed_degrees:
            candidates.append((octave + octave_offset) * 12 + degree)
    return min(candidates, key=lambda note: abs(note - midi_value))


def correction_curve(vocal, sample_rate, key, scale, strength):
    hop_length = 512
    frame_length = 2048
    f0, voiced, _ = librosa.pyin(
        vocal,
        fmin=librosa.note_to_hz("C2"),
        fmax=librosa.note_to_hz("C7"),
        sr=sample_rate,
        frame_length=frame_length,
        hop_length=hop_length,
    )
    allowed = scale_degrees(key, scale)
    cents = np.zeros_like(f0, dtype=np.float32)
    for index, freq in enumerate(f0):
        if not voiced[index] or not np.isfinite(freq) or freq <= 0:
            continue
        midi = librosa.hz_to_midi(float(freq))
        snapped = snap_midi(midi, allowed)
        cents[index] = np.clip((snapped - midi) * 100.0 * strength, -220.0, 220.0)

    if np.any(cents):
        cents = signal.medfilt(cents, kernel_size=5)
    times = librosa.frames_to_time(np.arange(len(cents)), sr=sample_rate, hop_length=hop_length)
    return times, cents


def shift_chunk(chunk, sample_rate, semitones):
    if abs(semitones) < 0.015 or np.max(np.abs(chunk)) < 1e-4:
        return chunk.copy()
    shifted = librosa.effects.pitch_shift(chunk.astype(np.float32), sr=sample_rate, n_steps=float(semitones), bins_per_octave=12)
    if len(shifted) < len(chunk):
        shifted = np.pad(shifted, (0, len(chunk) - len(shifted)))
    return shifted[: len(chunk)].astype(np.float32)


def frame_pitch_shift(vocal, sample_rate, times, cents, strength):
    window_seconds = 0.42 if strength < 0.75 else 0.30
    hop_seconds = window_seconds * 0.5
    window = max(1024, int(window_seconds * sample_rate))
    hop = max(512, int(hop_seconds * sample_rate))
    output = np.zeros(len(vocal) + window, dtype=np.float32)
    weights = np.zeros(len(vocal) + window, dtype=np.float32)
    envelope = signal.windows.hann(window, sym=False).astype(np.float32)
    if not np.any(envelope):
        envelope = np.ones(window, dtype=np.float32)

    for start in range(0, len(vocal), hop):
        end = min(len(vocal), start + window)
        chunk = vocal[start:end]
        if len(chunk) < window:
            chunk = np.pad(chunk, (0, window - len(chunk)))
        middle_time = (start + window * 0.5) / sample_rate
        nearest = np.abs(times - middle_time) < window_seconds * 0.65
        correction = float(np.median(cents[nearest])) if np.any(nearest) else 0.0
        shifted = shift_chunk(chunk, sample_rate, correction / 100.0)
        output[start : start + window] += shifted * envelope
        weights[start : start + window] += envelope

    valid = weights[: len(vocal)] > 1e-6
    tuned = vocal.copy()
    tuned[valid] = output[: len(vocal)][valid] / weights[: len(vocal)][valid]
    blend = np.clip(0.55 + strength * 0.45, 0.0, 1.0)
    return (tuned * blend + vocal * (1.0 - blend)).astype(np.float32)


def apply_formant_guard(tuned, original, sample_rate):
    presence = butter_filter(original, sample_rate, "bandpass", [1200, 4200], order=2)
    body = butter_filter(tuned, sample_rate, "bandpass", [120, 900], order=2)
    air = butter_filter(tuned, sample_rate, "highpass", 5200, order=2) * 0.82
    guarded = tuned * 0.78 + presence * 0.16 + body * 0.08 + air * 0.08
    return guarded.astype(np.float32)


def process(args):
    tmpdir = tempfile.mkdtemp(prefix="kctune_autotune_")
    try:
        decoded = os.path.join(tmpdir, "input.wav")
        decode_to_wav(args.ffmpeg, args.input, decoded, args.sample_rate)
        stereo, sample_rate = sf.read(decoded, dtype="float32", always_2d=True)
        if stereo.shape[1] > 2:
            stereo = stereo[:, :2]
        if stereo.shape[1] == 1:
            stereo = np.repeat(stereo, 2, axis=1)

        vocal, instrumental = vocal_center_stem(stereo, sample_rate)
        analysis = librosa.to_mono(stereo.T)
        key, scale = detect_key(analysis, sample_rate, args.key, args.scale)
        strength = np.clip(args.strength / 100.0, 0.0, 1.0)
        times, cents = correction_curve(vocal, sample_rate, key, scale, strength)
        tuned_vocal = frame_pitch_shift(vocal, sample_rate, times, cents, strength)
        tuned_vocal = apply_formant_guard(tuned_vocal, vocal, sample_rate)
        mixed = instrumental.copy()
        mixed[:, 0] += tuned_vocal * 0.92
        mixed[:, 1] += tuned_vocal * 0.92
        encode_wav(mixed, sample_rate, args.output)

        voiced = cents[np.abs(cents) > 1e-3]
        report = {
            "engine": "kctune Auto Tune Pro",
            "pitch_detector": "librosa pYIN",
            "stem": "center vocal extraction",
            "key": key,
            "scale": scale,
            "strength": args.strength,
            "frames": int(len(cents)),
            "voiced_frames": int(len(voiced)),
            "median_correction_cents": float(np.median(voiced)) if len(voiced) else 0.0,
        }
        print(json.dumps(report, ensure_ascii=False))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description="kctune Auto Tune Pro worker")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--sample-rate", type=int, default=44100)
    parser.add_argument("--key", default="Auto")
    parser.add_argument("--scale", default="Major")
    parser.add_argument("--strength", type=float, default=55)
    args = parser.parse_args()
    process(args)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
