# kctune DSP Pipeline

This document describes the production audio chain used by kctune for the current FFmpeg implementation and the matching design for future realtime engines.

## Sound Target

- deep but controlled low end
- mono-compatible sub bass
- reduced 150-350 Hz mud
- warm but not boomy body
- clean vocal/ambience range
- gentle 10-16 kHz air
- wide ambience above the bass range
- low listener fatigue
- stable output for YouTube, Spotify normalization, headphones and mobile playback

## Current FFmpeg Chain

The production chain lives in `main.js`:

- `bassDrumEnhanceFilter()`
- `masteringProfile()`
- `professionalMasteringFilter()`
- `spatial8dFilter()`

### 1. Frequency Retune

Input audio is retuned by changing the effective sample rate:

```text
asetrate = outputSampleRate * targetFrequency / sourceFrequency
aresample = outputSampleRate
```

This keeps the workflow deterministic and fast for batch conversion.

### 2. Corrective Low-End EQ

The chain starts with:

```text
highpass=f=27
155 Hz cut
245 Hz mud cut
335 Hz low-mid cut
```

Purpose:

- remove unstable sub rumble
- reduce low-mid buildup
- prevent bass from masking vocals/pads
- preserve warmth without boominess

Recommended ranges:

| Band | Purpose | Range |
|---|---|---|
| 24-32 Hz high-pass | remove rumble | 24-32 Hz |
| 150-180 Hz cut | reduce box/bass overlap | -1 to -2 dB |
| 220-280 Hz cut | reduce mud | -2 to -4 dB |
| 320-380 Hz cut | clean warmth | -1 to -2 dB |

### 3. Sub / Mid / Air Split

The bus is split into three processing bands:

```text
Sub:  <120 Hz
Mid:  120 Hz - 6.5 kHz
Air:  >6.5 kHz
```

Purpose:

- sub stays mono and stable
- vocal/body range remains controlled
- stereo widening only affects safe upper bands

### 4. Mono Sub Bass

Sub band:

```text
lowpass=f=120
pan=stereo|FL=0.5L+0.5R|FR=0.5L+0.5R
acompressor ratio 3.2
```

Purpose:

- prevent phasey sub bass
- improve headphone translation
- keep mobile/YouTube output stable
- avoid 8D movement destroying low-end punch

### 5. Mid-Band Control

Mid band:

```text
highpass=f=120
lowpass=f=6500
acompressor ratio 1.55
```

Purpose:

- light glue compression
- avoid overcompression
- keep vocals, pads and ambience clean

### 6. Air Band

Air band:

```text
highpass=f=6500
12 kHz shelf-style boost
light compression
stereowiden
```

Purpose:

- add openness around 10-16 kHz
- avoid harsh 3-5 kHz fatigue
- keep stereo width away from the low end

### 7. Saturation / Soft Clip

The master bus uses soft clipping before final limiting:

```text
asoftclip=tanh
asoftclip=atan
```

Purpose:

- catch transients smoothly
- add harmonic density
- avoid hard digital clipping
- keep output emotionally warm rather than brittle

### 8. Loudness Target

Single-pass FFmpeg `loudnorm` is used with preset targets:

| Preset | LUFS | LRA | True Peak |
|---|---:|---:|---:|
| Chill | -13.5 | 9 | -1.3 |
| Zen meditation | -16 | 11 | -1.8 |
| Ambient cinematic | -12 | 10 | -1.2 |
| Lofi | -14 | 8 | -1.5 |
| Trap/Rap | -10.5 | 7 | -1.0 |
| Rock | -11.5 | 7 | -1.1 |

For final release-grade mastering, a two-pass loudnorm implementation can be added later.

### 9. Final Limiter

Final stage:

```text
alimiter=limit=0.97:attack=5:release=80
```

Purpose:

- prevent true output overs
- keep peaks controlled after optional gain
- reduce listener fatigue

## Presets

### Chill

- LUFS: -14 to -12
- sub trim: moderate
- air: gentle
- width: soft
- use for chill, soft electronic, casual listening

### Zen Meditation

- LUFS: -18 to -14
- sub trim: stronger
- air: subtle
- width: restrained
- use for sleep, meditation, healing-frequency music

### Ambient Cinematic

- LUFS: -12 to -10
- sub: deep but limited
- air: open
- width: wider above 6.5 kHz
- use for cinematic relaxation and ambient soundscapes

### Lofi

- LUFS: around -14
- warm low mids
- reduced air
- softer clipping
- use for lofi/chillhop

### Trap/Rap

- LUFS: around -10.5
- tighter sub
- restrained width
- louder limiter target
- use only when punch and loudness are more important than meditation comfort

### Rock

- LUFS: around -11.5
- controlled low mids
- stable center
- less width
- use for denser music where guitars/vocals need center clarity

## Spatial / 8D Module

The 8D module uses frequency-aware motion:

- low band remains centered
- mid/high bands orbit via cosine gain movement
- high band gets a small Haas-style delay
- echo/reverb is applied only after low cutting the moving band

This prevents low-frequency wash and keeps the perceived motion clean.

## WebAudio API Design

A future realtime WebAudio implementation should use:

```text
MediaStreamAudioSourceNode
  -> high-pass biquad
  -> sub/mid/high crossover
  -> mono sub merger
  -> dynamics compressor per band
  -> high-band stereo widener / delay
  -> waveshaper soft saturation
  -> limiter AudioWorklet
  -> output device
```

Use an `AudioWorkletProcessor` for:

- true peak limiter
- cosine 8D panning
- metering
- lookahead buffers

Avoid ScriptProcessorNode; it is deprecated and not stable enough for production.

## Node.js Realtime DSP Design

For realtime BlackHole processing:

```text
BlackHole input
  -> native/CoreAudio or PortAudio binding
  -> Float32 ring buffer
  -> DSP worker thread
  -> output device stream
```

Requirements:

- 128-512 sample buffers
- lock-free ring buffer
- no allocations inside the audio callback
- precomputed filter coefficients
- optional SIMD/native module for limiter and crossovers

## VST-Style Chain

Equivalent plugin chain:

```text
Linear EQ
Multiband compressor
Dynamic EQ around 180-350 Hz
Harmonic saturation
Mid/Side stereo imager
Soft clipper
Loudness/true peak limiter
```

Recommended ordering:

1. corrective EQ
2. resonance control
3. multiband compression
4. saturation
5. imaging
6. loudness normalization
7. final limiter

