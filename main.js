const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".flac", ".aac", ".m4a", ".aiff", ".aif", ".webm"]);
const ARTWORK_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
let previewProcess = null;

function binaryPath(name) {
  const candidates = [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    name
  ];
  return candidates.find((candidate) => {
    try {
      require("node:fs").accessSync(candidate);
      return true;
    } catch {
      return candidate === name;
    }
  });
}

const FFMPEG = binaryPath("ffmpeg");
const FFPROBE = binaryPath("ffprobe");
const AFPLAY = binaryPath("afplay");
const PYTHON3 = binaryPath("python3");

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 * 12 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function runOptional(command, args) {
  try {
    return await run(command, args);
  } catch (error) {
    return error.stderr || error.message || "";
  }
}

async function blackHoleStatus() {
  const pkgutil = await runOptional("/usr/sbin/pkgutil", ["--pkgs"]);
  const systemAudio = await runOptional("/usr/sbin/system_profiler", ["SPAudioDataType"]);
  const driverPath = "/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver";
  const pkgInstalled = /audio\.existential\.BlackHole2ch/i.test(pkgutil);
  const driverInstalled = await pathExists(driverPath);
  const deviceActive = /BlackHole\s*2ch|BlackHole2ch/i.test(systemAudio);
  const installed = pkgInstalled || driverInstalled;

  return {
    installed,
    pkgInstalled,
    driverInstalled,
    deviceActive,
    driverPath,
    status: deviceActive ? "ready" : installed ? "needs-reboot" : "not-installed",
    message: deviceActive
      ? "BlackHole 2ch is active."
      : installed
        ? "BlackHole 2ch is installed but not active yet. Restart macOS."
        : "BlackHole 2ch is not installed."
  };
}

async function openBlackHoleInstaller() {
  const localPkg = "/opt/homebrew/Caskroom/blackhole-2ch/0.6.1/BlackHole2ch-0.6.1.pkg";
  if (await pathExists(localPkg)) {
    const result = await shell.openPath(localPkg);
    if (result) throw new Error(result);
    return { opened: "pkg", target: localPkg };
  }
  await shell.openExternal("https://existential.audio/blackhole/");
  return { opened: "url", target: "https://existential.audio/blackhole/" };
}

function runFfmpegWithProgress(args, durationSeconds, onProgress) {
  return new Promise((resolve, reject) => {
    const progressArgs = ["-nostats", "-progress", "pipe:2", ...args];
    const child = spawn(FFMPEG, progressArgs);
    let stderr = "";
    let buffer = "";
    const duration = Math.max(0.1, Number(durationSeconds) || 0.1);

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > 1024 * 1024 * 4) {
        stderr = stderr.slice(-1024 * 1024 * 4);
      }
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        const [key, value] = line.split("=");
        if (key === "out_time_ms" || key === "out_time_us") {
          const seconds = Number(value) / 1000000;
          if (Number.isFinite(seconds)) {
            onProgress?.(Math.max(0, Math.min(99, (seconds / duration) * 100)));
          }
        } else if (key === "out_time") {
          const parts = value.split(":").map(Number);
          if (parts.length === 3 && parts.every(Number.isFinite)) {
            const seconds = (parts[0] * 3600) + (parts[1] * 60) + parts[2];
            onProgress?.(Math.max(0, Math.min(99, (seconds / duration) * 100)));
          }
        } else if (key === "progress" && value === "end") {
          onProgress?.(100);
        }
      }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        onProgress?.(100);
        resolve();
      } else {
        const error = new Error(`ffmpeg exited with code ${code}`);
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

function analyzeWaveformFile(filePath, durationSeconds, bucketCount = 900) {
  return new Promise((resolve, reject) => {
    if (!filePath) {
      resolve(null);
      return;
    }

    const sampleRate = 4000;
    const duration = Math.max(0.1, Number(durationSeconds) || 0.1);
    const totalSamples = Math.max(1, Math.round(duration * sampleRate));
    const buckets = Math.max(120, Math.min(1600, Number(bucketCount) || 900));
    const peaks = new Float32Array(buckets);
    const sums = new Float64Array(buckets);
    const counts = new Uint32Array(buckets);
    let sampleIndex = 0;
    let leftover = Buffer.alloc(0);
    let stderr = "";

    const child = spawn(FFMPEG, [
      "-hide_banner",
      "-v", "error",
      "-i", filePath,
      "-vn",
      "-ac", "1",
      "-ar", String(sampleRate),
      "-f", "s16le",
      "pipe:1"
    ]);

    child.stdout.on("data", (chunk) => {
      const buffer = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      const usableLength = buffer.length - (buffer.length % 2);
      leftover = usableLength < buffer.length ? buffer.subarray(usableLength) : Buffer.alloc(0);

      for (let offset = 0; offset < usableLength; offset += 2) {
        const value = Math.abs(buffer.readInt16LE(offset)) / 32768;
        const bucket = Math.min(buckets - 1, Math.floor((sampleIndex / totalSamples) * buckets));
        if (value > peaks[bucket]) peaks[bucket] = value;
        sums[bucket] += value * value;
        counts[bucket] += 1;
        sampleIndex += 1;
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 1024 * 512) stderr = stderr.slice(-1024 * 512);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const error = new Error(`Waveform analysis failed with code ${code}`);
        error.stderr = stderr;
        reject(error);
        return;
      }

      const normalized = Array.from(peaks, (peak, index) => {
        const rms = counts[index] ? Math.sqrt(sums[index] / counts[index]) : 0;
        return Number(Math.max(peak * 0.72, rms * 1.9).toFixed(4));
      });
      resolve({
        path: filePath,
        durationSeconds: sampleIndex / sampleRate,
        sampleRate,
        peaks: normalized
      });
    });
  });
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function firstExistingPath(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    if (candidate.includes(".asar/")) continue;
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

function externalResourcePath(...parts) {
  if (typeof process.resourcesPath !== "string") return null;
  return path.join(process.resourcesPath, ...parts);
}

function localProjectPath(...parts) {
  if (__dirname.includes(".asar")) return null;
  return path.join(__dirname, ...parts);
}

function autotuneScriptCandidates() {
  return [
    externalResourcePath("scripts", "autotune_pro.py"),
    externalResourcePath("app.asar.unpacked", "scripts", "autotune_pro.py"),
    localProjectPath("scripts", "autotune_pro.py")
  ];
}

async function ensureAutoTunePython() {
  const localPython = path.join(__dirname, ".venv-autotune", "bin", "python");
  if (await pathExists(localPython)) return localPython;

  const userData = app.isReady() ? app.getPath("userData") : path.join(os.homedir(), "Library", "Application Support", "kctune");
  const venvRoot = path.join(userData, "autotune-python");
  const venvPython = path.join(venvRoot, "bin", "python");
  const marker = path.join(venvRoot, ".kctune-autotune-ready");
  if (await pathExists(venvPython) && await pathExists(marker)) return venvPython;

  const requirements = await firstExistingPath([
    externalResourcePath("scripts", "autotune_requirements.txt"),
    externalResourcePath("app.asar.unpacked", "scripts", "autotune_requirements.txt"),
    localProjectPath("scripts", "autotune_requirements.txt")
  ]);
  if (!requirements) {
    throw new Error("Auto Tune Pro requirements file is missing.");
  }

  await fs.mkdir(venvRoot, { recursive: true });
  if (!(await pathExists(venvPython))) {
    await run(PYTHON3, ["-m", "venv", venvRoot]);
  }
  await run(venvPython, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"]);
  await run(venvPython, ["-m", "pip", "install", "--quiet", "-r", requirements]);
  await fs.writeFile(marker, new Date().toISOString());
  return venvPython;
}

async function createAutoTunedInput(track, options, outputSampleRate, onProgress) {
  const scriptPath = await firstExistingPath(autotuneScriptCandidates());
  if (!scriptPath) {
    throw new Error("Auto Tune Pro worker is missing from the app bundle.");
  }
  onProgress?.(2, "Preparing Auto Tune Pro");
  const python = await ensureAutoTunePython();
  onProgress?.(5, "Detecting vocal pitch");
  const tempFolder = path.join(os.tmpdir(), "kctune_autotune_inputs");
  await fs.mkdir(tempFolder, { recursive: true });
  const hash = crypto.createHash("sha1").update(`${track.path}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 18);
  const outputPath = path.join(tempFolder, `${hash}_autotune_pro.wav`);
  const stdout = await run(python, [
    scriptPath,
    "--input", track.path,
    "--output", outputPath,
    "--ffmpeg", FFMPEG,
    "--sample-rate", String(outputSampleRate),
    "--key", options.autoTuneKey || "Auto",
    "--scale", options.autoTuneScale || "Major",
    "--strength", String(numberInRange(options.autoTuneStrength, 55, 0, 100))
  ]);
  let report = null;
  try {
    report = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop() || "{}");
  } catch {
    report = { engine: "kctune Auto Tune Pro" };
  }
  onProgress?.(22, "Auto Tune Pro ready");
  return { inputPath: outputPath, report };
}

function isAudioFile(filePath) {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isArtworkFile(filePath) {
  return ARTWORK_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function walkAudioFiles(folderPath) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkAudioFiles(fullPath));
    } else if (entry.isFile() && isAudioFile(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function formatDuration(secondsValue) {
  const total = Math.max(0, Math.round(Number(secondsValue) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatSampleRate(value) {
  const sampleRate = Number(value) || 0;
  if (!sampleRate) return "--";
  if (sampleRate % 1000 === 0) return `${sampleRate / 1000} kHz`;
  if (sampleRate % 100 === 0) return `${(sampleRate / 1000).toFixed(1)} kHz`;
  return `${sampleRate} Hz`;
}

function formatBitrate(value) {
  const bitrate = Number(value) || 0;
  if (!bitrate) return "--";
  return `${Math.round(bitrate / 1000)} kbps`;
}

function autoTuneFilter(enabled, options = {}) {
  if (!enabled) return "";
  const strength = numberInRange(options.autoTuneStrength, 55, 0, 100);
  const clarity = (0.6 + (strength / 100) * 1.0).toFixed(1);
  const air = (0.4 + (strength / 100) * 0.8).toFixed(1);
  const compressionRatio = (1.35 + (strength / 100) * 0.95).toFixed(2);
  return [
    "adeclick",
    "deesser=i=0.22:m=0.45:f=0.55",
    "equalizer=f=260:t=q:w=1.1:g=-1.2",
    "equalizer=f=1200:t=q:w=1.0:g=0.8",
    `equalizer=f=3200:t=q:w=1.0:g=${clarity}`,
    `equalizer=f=8500:t=q:w=1.1:g=${air}`,
    `acompressor=threshold=0.72:ratio=${compressionRatio}:attack=8:release=160`
  ].map((filter) => `,${filter}`).join("");
}

function autoTuneLabel(options = {}) {
  if (!options.autoTuneEnabled) return null;
  if (options.autoTuneReport) {
    const report = options.autoTuneReport;
    const key = report.key || options.autoTuneKey || "Auto";
    const scale = report.scale || options.autoTuneScale || "Major";
    const correction = Number(report.median_correction_cents);
    const correctionLabel = Number.isFinite(correction) && Math.abs(correction) > 0.1
      ? `, median ${correction.toFixed(0)} cents`
      : "";
    return `Auto Tune Pro ${key} ${scale}${correctionLabel}`;
  }
  const key = options.autoTuneKey || "Auto";
  const scale = options.autoTuneScale || "Major";
  const strength = numberInRange(options.autoTuneStrength, 55, 0, 100);
  return `Auto Tune Pro ${key} ${scale} ${strength}%`;
}

function bassDrumEnhanceFilter(options = {}) {
  if (options.bassEnhanceEnabled === false) return "";
  const boost = numberInRange(options.bassBoostDb, 3, 0, 9);
  const sub = Math.min(1.8, boost * 0.22).toFixed(1);
  const punch = Math.min(2.2, boost * 0.34).toFixed(1);
  return [
    "highpass=f=28",
    `equalizer=f=55:t=q:w=1.1:g=${sub}`,
    `equalizer=f=92:t=q:w=1.0:g=${punch}`,
    "equalizer=f=175:t=q:w=1.0:g=-1.6",
    "equalizer=f=255:t=q:w=1.0:g=-2.8",
    "equalizer=f=340:t=q:w=1.1:g=-1.8",
    "equalizer=f=2800:t=q:w=1.3:g=0.8"
  ].map((filter) => `,${filter}`).join("");
}

function masteringProfile(options = {}) {
  const explicit = String(options.masteringPreset || "").toLowerCase();
  const brainwave = String(options.brainwave || "").toLowerCase();
  const targetFrequencyValue = Number(options.targetFrequency);
  const use8d = Boolean(options.export8dEnabled);

  let preset = explicit || "chill";
  if (!explicit && (brainwave === "theta" || brainwave === "delta" || targetFrequencyValue === 528)) preset = "zen";
  if (!explicit && use8d) preset = "ambient-cinematic";

  const profiles = {
    chill: {
      lufs: -13.5, lra: 9, truePeak: -1.3, subTrim: -1.2, mudCut: -2.6, warmth: 0.4, air: 1.1, width: 0.08, clip: 0.94
    },
    zen: {
      lufs: -16, lra: 11, truePeak: -1.8, subTrim: -2.4, mudCut: -3.0, warmth: 0.2, air: 0.7, width: 0.05, clip: 0.96
    },
    "ambient-cinematic": {
      lufs: -12, lra: 10, truePeak: -1.2, subTrim: -0.8, mudCut: -2.8, warmth: 0.8, air: 1.4, width: 0.12, clip: 0.93
    },
    lofi: {
      lufs: -14, lra: 8, truePeak: -1.5, subTrim: -1.4, mudCut: -2.2, warmth: 1.0, air: -0.2, width: 0.04, clip: 0.92
    },
    "trap-rap": {
      lufs: -10.5, lra: 7, truePeak: -1.0, subTrim: -0.4, mudCut: -2.4, warmth: 0.2, air: 0.8, width: 0.04, clip: 0.91
    },
    rock: {
      lufs: -11.5, lra: 7, truePeak: -1.1, subTrim: -1.0, mudCut: -2.1, warmth: 0.1, air: 0.9, width: 0.03, clip: 0.91
    }
  };

  return { name: preset, ...(profiles[preset] || profiles.chill) };
}

function outputGainDb(value) {
  const gain = Number(value);
  if (!Number.isFinite(gain)) return 0;
  return Math.max(-6, Math.min(18, gain));
}

function outputGainFilter(value) {
  const gain = outputGainDb(value);
  return gain ? `,volume=${gain}dB` : "";
}

function outputGainStage(value) {
  const gain = outputGainDb(value);
  return gain ? `volume=${gain}dB` : "anull";
}

function gainLabel(value) {
  const gain = outputGainDb(value);
  if (!gain) return null;
  return `${gain > 0 ? "+" : ""}${gain}dB gain`;
}

function finalizeAudioFilter(inputLabel, outputLabel, gainDb, limit = 0.98) {
  return `[${inputLabel}]${outputGainStage(gainDb)},alimiter=limit=${limit}[${outputLabel}]`;
}

function professionalMasteringFilter(inputLabel, outputLabel, options = {}, gainDb = 0) {
  const profile = masteringProfile(options);
  const gainStage = outputGainStage(gainDb);
  const width = profile.width.toFixed(2);
  const subVolume = Math.pow(10, profile.subTrim / 20).toFixed(3);
  const warm = profile.warmth.toFixed(1);
  const air = profile.air.toFixed(1);
  const mudCut = profile.mudCut.toFixed(1);
  const clip = profile.clip.toFixed(2);

  return [
    // Linear-style corrective EQ: remove unstable sub rumble, mud and harshness before dynamics.
    `[${inputLabel}]aformat=channel_layouts=stereo,highpass=f=27,equalizer=f=155:t=q:w=1.0:g=-1.4,equalizer=f=245:t=q:w=1.05:g=${mudCut},equalizer=f=335:t=q:w=1.1:g=-1.8,equalizer=f=1150:t=q:w=1.2:g=${warm},equalizer=f=3800:t=q:w=1.5:g=0.8,deesser=i=0.16:m=0.36:f=0.44[${inputLabel}tone]`,
    // Frequency-aware bus split: keep sub mono, control low-mid body, and process air separately.
    `[${inputLabel}tone]asplit=3[${inputLabel}subsrc][${inputLabel}midsrc][${inputLabel}airsrc]`,
    // Mono sub below 120Hz with gentle compression. This stabilizes headphones, mobile and YouTube playback.
    `[${inputLabel}subsrc]lowpass=f=120,pan=stereo|FL=0.5*c0+0.5*c1|FR=0.5*c0+0.5*c1,volume=${subVolume},acompressor=threshold=0.50:ratio=3.2:attack=28:release=210:makeup=1[${inputLabel}sub]`,
    // Mid band remains mostly centered and clean. This is where vocals, pads and ambience need room.
    `[${inputLabel}midsrc]highpass=f=120,lowpass=f=6500,acompressor=threshold=0.62:ratio=1.55:attack=18:release=180:makeup=1[${inputLabel}mid]`,
    // Air band adds openness without harshness; widening is only above the mud/vocal range.
    `[${inputLabel}airsrc]highpass=f=6500,equalizer=f=12000:t=q:w=0.8:g=${air},acompressor=threshold=0.70:ratio=1.28:attack=4:release=120:makeup=1,stereowiden=delay=8:feedback=0.05:crossfeed=0.18:drymix=${(0.82 + Number(width)).toFixed(2)}[${inputLabel}air]`,
    // Master bus: controlled recombine, soft saturation, loudness target, final soft clip and limiter.
    `[${inputLabel}sub][${inputLabel}mid][${inputLabel}air]amix=inputs=3:duration=first:normalize=0,asoftclip=type=tanh:threshold=${clip}:output=0.98:oversample=2,loudnorm=I=${profile.lufs}:LRA=${profile.lra}:TP=${profile.truePeak}:linear=true,${gainStage},asoftclip=type=atan:threshold=0.98:output=0.98:oversample=2,alimiter=limit=0.97:attack=5:release=80[${outputLabel}]`
  ];
}

function numberInRange(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function spatial8dFilter(inputLabel, outputLabel, options = {}) {
  const speed = numberInRange(options.export8dSpeed, 0.055, 0.015, 0.18);
  const depth = numberInRange(options.export8dDepth, 0.68, 0.2, 1);
  const highDepth = Math.min(0.82, depth + 0.12);
  const period = (1 / speed).toFixed(4);
  const highPeriod = (1 / (speed * 1.35)).toFixed(4);
  const safeDepth = Math.min(0.82, depth);
  const leftGain = (amount, cyclePeriod) => `(1-${amount})+${amount}*sqrt((1-cos(6.283185307*max(t\\,0)/${cyclePeriod}))/2)`;
  const rightGain = (amount, cyclePeriod) => `(1-${amount})+${amount}*sqrt((1+cos(6.283185307*max(t\\,0)/${cyclePeriod}))/2)`;
  const midLeft = leftGain(safeDepth.toFixed(3), period);
  const midRight = rightGain(safeDepth.toFixed(3), period);
  const highLeft = rightGain(highDepth.toFixed(3), highPeriod);
  const highRight = leftGain(highDepth.toFixed(3), highPeriod);
  const haasDelay = Math.round(6 + (depth * 16));
  const roomDelayA = Math.round(42 + (depth * 36));
  const roomDelayB = Math.round(96 + (depth * 58));
  const roomDecayA = (0.08 + (depth * 0.12)).toFixed(3);
  const roomDecayB = (0.045 + (depth * 0.08)).toFixed(3);

  return [
    `[${inputLabel}]aformat=channel_layouts=stereo,asplit=3[${inputLabel}low][${inputLabel}mid][${inputLabel}high]`,
    `[${inputLabel}low]lowpass=f=170,pan=stereo|FL=0.54*c0+0.46*c1|FR=0.46*c0+0.54*c1,volume=0.94[${inputLabel}low8d]`,
    `[${inputLabel}mid]highpass=f=170,lowpass=f=4200,channelsplit=channel_layout=stereo[${inputLabel}midL][${inputLabel}midR]`,
    `[${inputLabel}midL]volume='${midLeft}':eval=frame[${inputLabel}midLp]`,
    `[${inputLabel}midR]volume='${midRight}':eval=frame[${inputLabel}midRp]`,
    `[${inputLabel}midLp][${inputLabel}midRp]join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR,aecho=0.80:0.18:${roomDelayA}|${roomDelayB}:${roomDecayA}|${roomDecayB},acompressor=threshold=0.62:ratio=1.8:attack=18:release=220:makeup=1,volume=0.86[${inputLabel}mid8d]`,
    `[${inputLabel}high]highpass=f=4200,adelay=0|${haasDelay},channelsplit=channel_layout=stereo[${inputLabel}highL][${inputLabel}highR]`,
    `[${inputLabel}highL]volume='${highLeft}':eval=frame[${inputLabel}highLp]`,
    `[${inputLabel}highR]volume='${highRight}':eval=frame[${inputLabel}highRp]`,
    `[${inputLabel}highLp][${inputLabel}highRp]join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR,acompressor=threshold=0.66:ratio=1.6:attack=8:release=140:makeup=1,volume=0.66[${inputLabel}high8d]`,
    `[${inputLabel}low8d][${inputLabel}mid8d][${inputLabel}high8d]amix=inputs=3:duration=first:normalize=0,acompressor=threshold=0.56:ratio=2.8:attack=24:release=300:makeup=1,dynaudnorm=f=250:g=7:p=0.84:m=8,alimiter=limit=0.94:attack=8:release=120[${outputLabel}]`
  ];
}

function metadataFromTags(tags = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(tags || {})) {
    normalized[key.toLowerCase()] = String(value);
  }
  return {
    title: normalized.title || "",
    artist: normalized.artist || "",
    album: normalized.album || "",
    genre: normalized.genre || "",
    comment: normalized.comment || normalized.description || normalized.synopsis || ""
  };
}

async function extractArtwork(filePath, info) {
  const hasArtwork = (info.streams || []).some((stream) => {
    return stream.codec_type === "video" && stream.disposition && stream.disposition.attached_pic === 1;
  });
  if (!hasArtwork) return null;

  const artworkDir = path.join(os.tmpdir(), "zentune_artwork");
  await fs.mkdir(artworkDir, { recursive: true });
  const hash = crypto.createHash("sha1").update(filePath).digest("hex").slice(0, 16);
  const artworkPath = path.join(artworkDir, `${hash}.jpg`);

  try {
    await run(FFMPEG, [
      "-y",
      "-i", filePath,
      "-an",
      "-vcodec", "mjpeg",
      "-frames:v", "1",
      artworkPath
    ]);
    return artworkPath;
  } catch {
    return null;
  }
}

async function probeAudio(filePath) {
  const raw = await run(FFPROBE, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath
  ]);
  const info = JSON.parse(raw);
  const audioStream = (info.streams || []).find((stream) => stream.codec_type === "audio") || {};
  const format = info.format || {};
  const metadata = metadataFromTags({ ...(format.tags || {}), ...(audioStream.tags || {}) });
  const artworkPath = await extractArtwork(filePath, info);

  return {
    id: filePath,
    path: filePath,
    name: path.basename(filePath),
    duration: formatDuration(format.duration),
    durationSeconds: Number(format.duration) || 0,
    format: path.extname(filePath).replace(".", "").toUpperCase(),
    sampleRate: formatSampleRate(audioStream.sample_rate),
    sampleRateRaw: Number(audioStream.sample_rate) || 44100,
    bitrate: formatBitrate(audioStream.bit_rate || format.bit_rate),
    metadata,
    artworkPath,
    status: "Ready",
    outputPath: null
  };
}

async function analyzePaths(paths) {
  const uniquePaths = [...new Set(paths)].filter(isAudioFile);
  const tracks = [];
  for (const filePath of uniquePaths) {
    try {
      tracks.push(await probeAudio(filePath));
    } catch (error) {
      tracks.push({
        id: filePath,
        path: filePath,
        name: path.basename(filePath),
        duration: "--",
        durationSeconds: 0,
        format: path.extname(filePath).replace(".", "").toUpperCase(),
        sampleRate: "--",
        sampleRateRaw: 44100,
        bitrate: "--",
        metadata: { title: "", artist: "", album: "", genre: "" },
        artworkPath: null,
        status: "Probe Failed",
        error: error.stderr || error.message,
        outputPath: null
      });
    }
  }
  return tracks;
}

async function expandDroppedPaths(paths) {
  const files = [];
  for (const droppedPath of [...new Set(paths || [])]) {
    try {
      const stat = await fs.stat(droppedPath);
      if (stat.isDirectory()) {
        files.push(...await walkAudioFiles(droppedPath));
      } else if (stat.isFile() && isAudioFile(droppedPath)) {
        files.push(droppedPath);
      }
    } catch {
      // Ignore unavailable drag/drop items.
    }
  }
  return files;
}

async function convertTrack(track, options, onProgress) {
  const sourceFrequency = Number(track.sourceFrequency || options.sourceFrequency) || 440;
  const targetFrequency = Number(track.targetFrequency || options.targetFrequency) || 432;
  const outputFolder = options.outputFolder || path.join(path.dirname(track.path), `Converted_${targetFrequency}Hz`);
  await fs.mkdir(outputFolder, { recursive: true });

  const outputFormat = String(options.format || "WAV").toLowerCase();
  const extensionByFormat = {
    mp3: "mp3",
    flac: "flac",
    wav: "wav",
    aac: "m4a",
    aiff: "aiff"
  };
  const outputExt = extensionByFormat[outputFormat] || "wav";
  let outputPath = path.join(outputFolder, `${path.parse(track.path).name}_${targetFrequency}Hz.${outputExt}`);
  const sampleRate = Number(track.sampleRateRaw) || 44100;
  const outputSampleRate = options.sampleRate && options.sampleRate !== "keep" ? Number(options.sampleRate) : sampleRate;
  const shiftedRate = Math.round(outputSampleRate * targetFrequency / sourceFrequency);
  const artworkPath = track.artworkPath && isArtworkFile(track.artworkPath) ? track.artworkPath : null;
  const embedsArtwork = artworkPath && ["mp3", "flac", "aac"].includes(outputFormat);
  const duration = Math.max(1, Number(track.durationSeconds) || 3600);
  const layerInputs = [];
  const useDrone528 = Boolean(options.drone528Enabled);
  const useBinaural = Boolean(options.binauralEnabled && Number(options.binauralBeat) > 0);
  const useNature = Boolean(options.natureLayerEnabled);
  const useAutoTune = Boolean(options.autoTuneEnabled);
  const use8d = Boolean(options.export8dEnabled);
  const gainDb = outputGainDb(options.outputGainDb);
  const layerSuffix = [useDrone528 ? "528Drone" : null, useBinaural ? "ThetaMotion" : null, useNature ? "Nature" : null, use8d ? "8D" : null, useAutoTune ? "AutoTune" : null].filter(Boolean).join("_");
  if (layerSuffix) {
    outputPath = path.join(outputFolder, `${path.parse(track.path).name}_${targetFrequency}Hz_${layerSuffix}.${outputExt}`);
  }
  let conversionInputPath = track.path;
  let temporaryAutoTuneInput = null;
  let autoTuneReport = null;
  if (useAutoTune) {
    const prepared = await createAutoTunedInput(track, options, outputSampleRate, onProgress);
    conversionInputPath = prepared.inputPath;
    temporaryAutoTuneInput = prepared.inputPath;
    autoTuneReport = prepared.report;
  }
  const ffmpegStartPercent = useAutoTune ? 22 : 1;
  onProgress?.(ffmpegStartPercent, "Rendering audio");
  const args = [
    "-y",
    "-i", conversionInputPath
  ];

  if (embedsArtwork) {
    args.push("-i", artworkPath);
  }

  if (useDrone528) {
    layerInputs.push({ type: "drone", index: (embedsArtwork ? 2 : 1) + layerInputs.length });
    args.push("-f", "lavfi", "-i", `sine=frequency=528:sample_rate=${outputSampleRate}:duration=${duration}`);
  }

  if (useBinaural) {
    const beat = Number(options.binauralBeat) || 6;
    const base = 220;
    layerInputs.push({ type: "binaural-left", index: (embedsArtwork ? 2 : 1) + layerInputs.length });
    args.push("-f", "lavfi", "-i", `sine=frequency=${base}:sample_rate=${outputSampleRate}:duration=${duration}`);
    layerInputs.push({ type: "binaural-right", index: (embedsArtwork ? 2 : 1) + layerInputs.length });
    args.push("-f", "lavfi", "-i", `sine=frequency=${base + beat}:sample_rate=${outputSampleRate}:duration=${duration}`);
  }

  if (useNature) {
    layerInputs.push({ type: "nature", index: (embedsArtwork ? 2 : 1) + layerInputs.length });
    args.push("-f", "lavfi", "-i", `anoisesrc=color=brown:sample_rate=${outputSampleRate}:duration=${duration}`);
  }

  args.push("-map_metadata", "0");

  const usesBlend = useDrone528 || useBinaural || useNature;
  if (usesBlend) {
    const filterParts = [`[0:a]asetrate=${shiftedRate},aresample=${outputSampleRate},aformat=channel_layouts=stereo,apulsator=mode=sine:hz=0.055:amount=1:offset_l=0:offset_r=0.5,volume=0.64[base]`];
    const mixLabels = ["[base]"];
    const drone = layerInputs.find((input) => input.type === "drone");
    if (drone) {
      filterParts.push(`[${drone.index}:a]aformat=channel_layouts=stereo,apulsator=mode=sine:hz=0.055:amount=1:offset_l=0:offset_r=0.5,volume=0.22[drone]`);
      mixLabels.push("[drone]");
    }
    const binauralLeft = layerInputs.find((input) => input.type === "binaural-left");
    const binauralRight = layerInputs.find((input) => input.type === "binaural-right");
    if (binauralLeft && binauralRight) {
      filterParts.push(`[${binauralLeft.index}:a]volume=0.26,pan=stereo|FL=c0|FR=0*c0[thetaL]`);
      filterParts.push(`[${binauralRight.index}:a]volume=0.26,pan=stereo|FL=0*c0|FR=c0[thetaR]`);
      filterParts.push(`[thetaL][thetaR]amix=inputs=2:duration=first:normalize=0,apulsator=mode=sine:hz=0.055:amount=1:offset_l=0:offset_r=0.5[theta]`);
      mixLabels.push("[theta]");
    }
    const nature = layerInputs.find((input) => input.type === "nature");
    if (nature) {
      filterParts.push(`[${nature.index}:a]aformat=channel_layouts=stereo,highpass=f=80,lowpass=f=1800,apulsator=mode=sine:hz=0.035:amount=0.75:offset_l=0:offset_r=0.5,volume=0.035[nature]`);
      mixLabels.push("[nature]");
    }
    filterParts.push(`${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=2${autoTuneFilter(useAutoTune, options)}${bassDrumEnhanceFilter(options)},acompressor=threshold=0.65:ratio=2.2:attack=18:release=220[premaster]`);
    if (use8d) {
      filterParts.push(...spatial8dFilter("premaster", "spatial", options));
      filterParts.push(...professionalMasteringFilter("spatial", "aout", options, gainDb));
    } else {
      filterParts.push(...professionalMasteringFilter("premaster", "aout", options, gainDb));
    }
    args.push("-filter_complex", filterParts.join(";"), "-map", "[aout]");
  } else if (use8d) {
    const filterParts = [
      `[0:a]asetrate=${shiftedRate},aresample=${outputSampleRate},aformat=channel_layouts=stereo${autoTuneFilter(useAutoTune, options)}${bassDrumEnhanceFilter(options)},acompressor=threshold=0.65:ratio=2.2:attack=18:release=220[premaster]`,
      ...spatial8dFilter("premaster", "spatial", options),
      ...professionalMasteringFilter("spatial", "aout", options, gainDb)
    ];
    args.push("-filter_complex", filterParts.join(";"), "-map", "[aout]");
  } else {
    const filterParts = [
      `[0:a]asetrate=${shiftedRate},aresample=${outputSampleRate},aformat=channel_layouts=stereo${autoTuneFilter(useAutoTune, options)}${bassDrumEnhanceFilter(options)},acompressor=threshold=0.65:ratio=1.65:attack=18:release=180[premaster]`,
      ...professionalMasteringFilter("premaster", "aout", options, gainDb)
    ];
    args.push("-filter_complex", filterParts.join(";"), "-map", "[aout]");
  }

  if (embedsArtwork) {
    args.push("-map", "1:v:0");
  } else {
    args.push("-vn");
  }

  const metadata = track.metadata || {};
  for (const key of ["title", "artist", "album", "genre"]) {
    if (metadata[key]) {
      args.push("-metadata", `${key}=${metadata[key]}`);
    }
  }

  const requestedBitrate = options.bitrate || "320k";
  let codec = "pcm_s24le";
  let outputBitrate = "Lossless";

  if (outputFormat === "mp3") {
    codec = "libmp3lame";
    outputBitrate = requestedBitrate === "lossless" ? "320k" : requestedBitrate;
    if (Number.parseInt(outputBitrate, 10) > 320) outputBitrate = "320k";
    args.push("-codec:a", codec, "-b:a", outputBitrate);
  } else if (outputFormat === "aac") {
    codec = "aac";
    outputBitrate = requestedBitrate === "lossless" ? "512k" : requestedBitrate;
    args.push("-codec:a", codec, "-b:a", outputBitrate);
  } else if (outputFormat === "flac") {
    codec = "flac";
    args.push("-codec:a", codec, "-compression_level", "8");
  } else if (outputFormat === "aiff") {
    codec = "pcm_s24be";
    args.push("-codec:a", codec);
  } else {
    codec = "pcm_s24le";
    args.push("-codec:a", codec);
  }

  if (embedsArtwork) {
    args.push(
      "-codec:v", "mjpeg",
      "-disposition:v", "attached_pic",
      "-metadata:s:v", "title=Album cover",
      "-metadata:s:v", "comment=Cover (front)"
    );
  }

  args.push(outputPath);
  try {
    await runFfmpegWithProgress(args, duration, (ffmpegPercent) => {
      const mapped = ffmpegStartPercent + ((Math.max(0, Math.min(100, ffmpegPercent)) / 100) * (98 - ffmpegStartPercent));
      onProgress?.(mapped, "Rendering audio");
    });
  } finally {
    if (temporaryAutoTuneInput) {
      fs.unlink(temporaryAutoTuneInput).catch(() => {});
    }
  }
  const outputProbe = await probeAudio(outputPath);
  onProgress?.(99, "Reading output info");
  return {
    outputPath,
    convertedInfo: {
      sourceFrequency,
      targetFrequency,
      format: outputProbe.format,
      sampleRate: outputProbe.sampleRate,
      bitrate: outputFormat === "mp3" || outputFormat === "aac" ? formatBitrate(Number.parseInt(outputBitrate, 10) * 1000) : "Lossless",
      codec,
      layers: [
        useDrone528 ? "528Hz drone" : null,
        useBinaural ? `${options.brainwave || "binaural"} ${Number(options.binauralBeat) || 0}Hz hard-pan beat` : null,
        useNature ? "nature ambience" : null,
        options.bassEnhanceEnabled === false ? null : `bass/drum punch +${numberInRange(options.bassBoostDb, 6, 0, 12)}dB`,
        `mastering ${masteringProfile(options).name} ${masteringProfile(options).lufs} LUFS`,
        use8d ? `8D spatial orbit depth ${numberInRange(options.export8dDepth, 0.68, 0.2, 1)}` : null,
        autoTuneLabel({ ...options, autoTuneEnabled: useAutoTune, autoTuneReport }),
        gainLabel(gainDb)
      ].filter(Boolean),
      duration: outputProbe.duration,
      path: outputPath
    }
  };
}

async function createPreview(track, mode) {
  const tempFolder = path.join(os.tmpdir(), "zentune_preview");
  await fs.mkdir(tempFolder, { recursive: true });

  const sampleRate = Number(track.sampleRateRaw) || 44100;
  const outputPath = path.join(tempFolder, `${path.parse(track.path).name}_${mode}_preview.wav`);
  const args = ["-y", "-i", track.path];

  if (mode === "converted") {
    const sourceFrequency = Number(track.previewSourceFrequency || track.sourceFrequency) || 440;
    const targetFrequency = Number(track.previewTargetFrequency || track.targetFrequency) || 432;
    const shiftedRate = Math.round(sampleRate * targetFrequency / sourceFrequency);
    const blend = track.previewBlendOptions || {};
    const duration = Math.max(1, Number(track.durationSeconds) || 3600);
    const useDrone528 = Boolean(blend.drone528Enabled);
    const useBinaural = Boolean(blend.binauralEnabled && Number(blend.binauralBeat) > 0);
    const useNature = Boolean(blend.natureLayerEnabled);
    const useAutoTune = Boolean(blend.autoTuneEnabled);
    const use8d = Boolean(blend.export8dEnabled);
    const gainDb = outputGainDb(blend.outputGainDb);
    const layerInputs = [];

    if (useDrone528) {
      layerInputs.push({ type: "drone", index: 1 + layerInputs.length });
      args.push("-f", "lavfi", "-i", `sine=frequency=528:sample_rate=${sampleRate}:duration=${duration}`);
    }
    if (useBinaural) {
      const beat = Number(blend.binauralBeat) || 6;
      const base = 220;
      layerInputs.push({ type: "binaural-left", index: 1 + layerInputs.length });
      args.push("-f", "lavfi", "-i", `sine=frequency=${base}:sample_rate=${sampleRate}:duration=${duration}`);
      layerInputs.push({ type: "binaural-right", index: 1 + layerInputs.length });
      args.push("-f", "lavfi", "-i", `sine=frequency=${base + beat}:sample_rate=${sampleRate}:duration=${duration}`);
    }
    if (useNature) {
      layerInputs.push({ type: "nature", index: 1 + layerInputs.length });
    args.push("-f", "lavfi", "-i", `anoisesrc=color=brown:sample_rate=${sampleRate}:duration=${duration}`);
    }

    if (useDrone528 || useBinaural || useNature) {
      const filterParts = [`[0:a]asetrate=${shiftedRate},aresample=${sampleRate},aformat=channel_layouts=stereo,apulsator=mode=sine:hz=0.055:amount=1:offset_l=0:offset_r=0.5,volume=0.64[base]`];
      const mixLabels = ["[base]"];
      const drone = layerInputs.find((input) => input.type === "drone");
      if (drone) {
        filterParts.push(`[${drone.index}:a]aformat=channel_layouts=stereo,apulsator=mode=sine:hz=0.055:amount=1:offset_l=0:offset_r=0.5,volume=0.22[drone]`);
        mixLabels.push("[drone]");
      }
      const binauralLeft = layerInputs.find((input) => input.type === "binaural-left");
      const binauralRight = layerInputs.find((input) => input.type === "binaural-right");
      if (binauralLeft && binauralRight) {
        filterParts.push(`[${binauralLeft.index}:a]volume=0.26,pan=stereo|FL=c0|FR=0*c0[thetaL]`);
        filterParts.push(`[${binauralRight.index}:a]volume=0.26,pan=stereo|FL=0*c0|FR=c0[thetaR]`);
        filterParts.push(`[thetaL][thetaR]amix=inputs=2:duration=first:normalize=0,apulsator=mode=sine:hz=0.055:amount=1:offset_l=0:offset_r=0.5[theta]`);
        mixLabels.push("[theta]");
      }
      const nature = layerInputs.find((input) => input.type === "nature");
      if (nature) {
        filterParts.push(`[${nature.index}:a]aformat=channel_layouts=stereo,highpass=f=80,lowpass=f=1800,apulsator=mode=sine:hz=0.035:amount=0.75:offset_l=0:offset_r=0.5,volume=0.035[nature]`);
        mixLabels.push("[nature]");
      }
      filterParts.push(`${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=2${autoTuneFilter(useAutoTune, blend)}${bassDrumEnhanceFilter(blend)},acompressor=threshold=0.65:ratio=2.2:attack=18:release=220[premaster]`);
      if (use8d) {
        filterParts.push(...spatial8dFilter("premaster", "spatial", blend));
        filterParts.push(...professionalMasteringFilter("spatial", "aout", blend, gainDb));
      } else {
        filterParts.push(...professionalMasteringFilter("premaster", "aout", blend, gainDb));
      }
      args.push("-filter_complex", filterParts.join(";"), "-map", "[aout]");
    } else if (use8d) {
      const filterParts = [
        `[0:a]asetrate=${shiftedRate},aresample=${sampleRate},aformat=channel_layouts=stereo${autoTuneFilter(useAutoTune, blend)}${bassDrumEnhanceFilter(blend)},acompressor=threshold=0.65:ratio=2.2:attack=18:release=220[premaster]`,
        ...spatial8dFilter("premaster", "spatial", blend),
        ...professionalMasteringFilter("spatial", "aout", blend, gainDb)
      ];
      args.push("-filter_complex", filterParts.join(";"), "-map", "[aout]");
    } else {
      const filterParts = [
        `[0:a]asetrate=${shiftedRate},aresample=${sampleRate},aformat=channel_layouts=stereo${autoTuneFilter(useAutoTune, blend)}${bassDrumEnhanceFilter(blend)},acompressor=threshold=0.65:ratio=1.65:attack=18:release=180[premaster]`,
        ...professionalMasteringFilter("premaster", "aout", blend, gainDb)
      ];
      args.push("-filter_complex", filterParts.join(";"), "-map", "[aout]");
    }
  }

  args.push("-vn", "-codec:a", "pcm_s16le", outputPath);
  await run(FFMPEG, args);
  return outputPath;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1512,
    height: 982,
    minWidth: 1280,
    minHeight: 820,
    title: "kctune",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#08090d",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile("index.html");
  win.webContents.on("console-message", (_event, level, message) => {
    console.log(`[renderer:${level}] ${message}`);
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("pick-files", async (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(parent, {
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Audio", extensions: ["mp3", "wav", "flac", "aac", "m4a", "aiff", "aif", "webm"] }
    ]
  });

  return result.canceled ? [] : await analyzePaths(result.filePaths);
});

ipcMain.handle("pick-folder", async (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(parent, {
    properties: ["openDirectory"]
  });

  if (result.canceled || !result.filePaths.length) return [];
  const files = await walkAudioFiles(result.filePaths[0]);
  return analyzePaths(files);
});

ipcMain.handle("import-dropped-paths", async (_event, paths = []) => {
  const files = await expandDroppedPaths(paths);
  return analyzePaths(files);
});

ipcMain.handle("pick-output-folder", async (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(parent, {
    properties: ["openDirectory", "createDirectory"]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("blackhole-status", async () => {
  return blackHoleStatus();
});

ipcMain.handle("open-blackhole-installer", async () => {
  return openBlackHoleInstaller();
});

ipcMain.handle("pick-artwork", async (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(parent, {
    properties: ["openFile"],
    filters: [
      { name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("convert-tracks", async (event, tracks, options = {}) => {
  const converted = [];
  const failed = [];
  const sendProgress = (track, index, status, filePercent = 0, extra = {}) => {
    const safeFilePercent = Math.max(0, Math.min(100, Number(filePercent) || 0));
    const overallPercent = ((index + (safeFilePercent / 100)) / Math.max(1, tracks.length)) * 100;
    event.sender.send("convert-progress", {
      id: track.id,
      index,
      total: tracks.length,
      status,
      filePercent: safeFilePercent,
      overallPercent,
      ...extra
    });
  };

  for (const [index, track] of tracks.entries()) {
    sendProgress(track, index, "Converting", 0);

    try {
      const result = await convertTrack(track, options, (filePercent, phase) => {
        sendProgress(track, index, "Converting", filePercent, { phase: phase || "Converting" });
      });
      converted.push({ ...track, status: "Converted", outputPath: result.outputPath, convertedInfo: result.convertedInfo });
      sendProgress(track, index, "Converted", 100, {
        index: index + 1,
        outputPath: result.outputPath,
        convertedInfo: result.convertedInfo
      });
    } catch (error) {
      failed.push({ ...track, status: "Failed", error: error.stderr || error.message });
      sendProgress(track, index, "Failed", 100, {
        index: index + 1,
        error: error.stderr || error.message
      });
    }
  }

  return { converted, failed };
});

ipcMain.handle("preview-track", async (_event, track, mode) => {
  if (!track?.path) {
    throw new Error("No track selected.");
  }

  const previewPath = await createPreview(track, mode);
  return { previewPath };
});

ipcMain.handle("analyze-waveform", async (_event, payload = {}) => {
  const bucketCount = Number(payload.bucketCount) || 900;
  const duration = Number(payload.durationSeconds) || 0;
  const [original, converted] = await Promise.all([
    analyzeWaveformFile(payload.originalPath, duration, bucketCount),
    payload.convertedPath ? analyzeWaveformFile(payload.convertedPath, duration, bucketCount) : Promise.resolve(null)
  ]);
  return { original, converted };
});

ipcMain.handle("stop-preview", async () => {
  previewProcess = null;
  return true;
});

ipcMain.handle("open-path", async (_event, targetPath) => {
  if (!targetPath) return false;
  const result = await shell.openPath(targetPath);
  if (result) throw new Error(result);
  return true;
});
