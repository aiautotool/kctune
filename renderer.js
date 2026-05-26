let tracks = [];
let selectedIndex = -1;
let selectedIndices = new Set();
let lastSelectedIndex = -1;
let isConverting = false;
let outputFolder = null;
let lastOutputFolder = null;
let activePreviewMode = "converted";
let audioPlayer = null;
let isPlaying = false;
let loadedPreview = null;
let pendingSeekRatio = null;
let isSeeking = false;
let activeLibraryFilter = "All Files";
const waveformCache = new Map();
let waveformRequestToken = 0;
let waveformState = { trackId: null, loading: false, original: null, converted: null, error: null };
let blackHoleState = { status: "unknown", installed: false, deviceActive: false };
const frequencyThemes = {
  174: "Pain relief",
  285: "Healing",
  396: "Fear release",
  417: "Change",
  432: "Natural tuning",
  440: "Standard",
  528: "Love/healing",
  639: "Relationships",
  741: "Cleansing",
  852: "Intuition",
  963: "Higher consciousness"
};
const knownHealingFrequencies = Object.keys(frequencyThemes).map(Number);
let currentLanguage = localStorage.getItem("zentune-language") || "vi";
const translations = {
  vi: {
    "batch.title": "Batch Conversion",
    "batch.mode": "Chất lượng cao",
    "batch.queue": "Hàng đợi",
    "batch.convertAll": "⟳ Chuyển tất cả",
    "batch.convertSelected": "Chuyển file đã chọn",
    "output.title": "Output Settings",
    "output.choose": "Chọn thư mục xuất",
    "output.open": "Mở thư mục xuất",
    "output.sourceHz": "Hz gốc",
    "output.targetHz": "Hz đích",
    "output.customHz": "Hz tùy chỉnh",
    "output.format": "Định dạng",
    "output.bitrate": "Bitrate",
    "output.sampleRate": "Sample Rate",
    "output.gain": "Tăng âm lượng",
    "output.folder": "Thư mục xuất",
    "preset.youtubeSleep": "YouTube Sleep",
    "preset.meditation": "Thiền",
    "preset.ambient": "Ambient",
    "preset.healing": "Healing",
    "preset.lofi": "Lo-fi",
    "preset.cinematic": "Cinematic",
    "layers.title": "Sound Layers",
    "layers.frequency": "Layer 1: Tần số",
    "layers.space": "Layer 2: Không gian 3D",
    "layers.spaceDesc": "Độ rộng stereo mềm",
    "layers.motion": "Layer 3: Chuyển động 8D",
    "layers.motionDesc": "Zen orbit mượt",
    "layers.advanced": "Cài đặt layer chuyên sâu",
    "status.ready": "Sẵn sàng"
  },
  en: {
    "batch.title": "Batch Conversion",
    "batch.mode": "High Quality",
    "batch.queue": "Queue",
    "batch.convertAll": "⟳ Convert All",
    "batch.convertSelected": "Convert Selected",
    "output.title": "Output Settings",
    "output.choose": "Choose Output Folder",
    "output.open": "Open Output Folder",
    "output.sourceHz": "Source Hz",
    "output.targetHz": "Target Hz",
    "output.customHz": "Custom Hz",
    "output.format": "Format",
    "output.bitrate": "Bitrate",
    "output.sampleRate": "Sample Rate",
    "output.gain": "Output Gain",
    "output.folder": "Output Folder",
    "preset.youtubeSleep": "YouTube Sleep",
    "preset.meditation": "Meditation",
    "preset.ambient": "Ambient",
    "preset.healing": "Healing",
    "preset.lofi": "Lo-fi",
    "preset.cinematic": "Cinematic",
    "layers.title": "Sound Layers",
    "layers.frequency": "Layer 1: Frequency",
    "layers.space": "Layer 2: 3D Space",
    "layers.spaceDesc": "Soft stereo depth",
    "layers.motion": "Layer 3: 8D Motion",
    "layers.motionDesc": "Zen orbit movement",
    "layers.advanced": "Advanced Layer Settings",
    "status.ready": "Ready"
  },
  zh: {
    "batch.title": "批量转换",
    "batch.mode": "高质量",
    "batch.queue": "队列",
    "batch.convertAll": "⟳ 全部转换",
    "batch.convertSelected": "转换所选",
    "output.title": "导出设置",
    "output.choose": "选择导出文件夹",
    "output.open": "打开导出文件夹",
    "output.sourceHz": "原始 Hz",
    "output.targetHz": "目标 Hz",
    "output.customHz": "自定义 Hz",
    "output.format": "格式",
    "output.bitrate": "比特率",
    "output.sampleRate": "采样率",
    "output.gain": "输出增益",
    "output.folder": "导出文件夹",
    "preset.youtubeSleep": "YouTube 睡眠",
    "preset.meditation": "冥想",
    "preset.ambient": "氛围",
    "preset.healing": "疗愈",
    "preset.lofi": "Lo-fi",
    "preset.cinematic": "电影感",
    "layers.title": "声音层",
    "layers.frequency": "第 1 层：频率",
    "layers.space": "第 2 层：3D 空间",
    "layers.spaceDesc": "柔和立体声空间",
    "layers.motion": "第 3 层：8D 运动",
    "layers.motionDesc": "禅意环绕运动",
    "layers.advanced": "高级层设置",
    "status.ready": "就绪"
  }
};

const $ = (selector) => document.querySelector(selector);

function textFor(key) {
  return translations[currentLanguage]?.[key] || translations.en[key] || key;
}

function applyDefaultOutputSettings() {
  $("#format-select").value = "WAV";
  $("#bitrate-select").value = "lossless";
}

function selectedOutputFormat() {
  return $("#format-select")?.value || "WAV";
}

function convertedCount() {
  return tracks.filter((track) => track.status === "Converted").length;
}

function processingCount() {
  return tracks.filter((track) => track.status === "Converting").length;
}

function selectedTrack() {
  return selectedIndex >= 0 ? tracks[selectedIndex] : null;
}

function selectedTracks() {
  return [...selectedIndices]
    .sort((a, b) => a - b)
    .map((index) => tracks[index])
    .filter(Boolean);
}

function selectedCount() {
  return selectedIndices.size || (selectedTrack() ? 1 : 0);
}

function ensureSelectedSet() {
  if (!selectedIndices.size && selectedIndex >= 0) selectedIndices.add(selectedIndex);
}

function inferTrackFrequency(track) {
  const metadataText = Object.values(track?.metadata || {}).filter(Boolean).join(" ");
  const text = `${track?.name || ""} ${metadataText} ${track?.path || ""}`.toLowerCase();
  const explicit = text.match(/(^|[^0-9])([1-9]\d{2,3}(?:\.\d+)?)\s*(?:hz|hertz)\b/);
  if (explicit) {
    const hz = Number(explicit[2]);
    return Number.isFinite(hz) && hz >= 100 && hz <= 1200 ? hz : null;
  }

  for (const hz of knownHealingFrequencies) {
    const loosePattern = new RegExp(`(^|[^0-9])${hz}(?!\\s*(?:kb|kbps|kbit|mb|gb|bitrate)\\b)(?=$|[^0-9])`, "i");
    if (loosePattern.test(text)) return hz;
  }

  return null;
}

function hydrateTrackFrequency(track) {
  const inferred = inferTrackFrequency(track);
  return {
    ...track,
    sourceFrequency: Number(track.sourceFrequency || inferred || sourceInputFrequency()),
    detectedSourceFrequency: inferred,
    targetFrequency: Number(track.targetFrequency || targetFrequency())
  };
}

function renderRows() {
  const container = $("#file-rows");
  container.innerHTML = "";
  const visibleTracks = filteredTracks();

  if (!visibleTracks.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <strong>${tracks.length ? `No files in ${activeLibraryFilter}` : "No real audio files loaded"}</strong>
      <span>${tracks.length ? "Choose another library filter or import more audio." : "Click Add Files or Add Folder to import MP3, WAV, FLAC, AAC, M4A, or AIFF."}</span>
    `;
    container.appendChild(empty);
  }

  visibleTracks.forEach((track, index) => {
    const realIndex = tracks.findIndex((item) => item.id === track.id);
    const row = document.createElement("button");
    const isActive = realIndex === selectedIndex;
    const isSelected = selectedIndices.has(realIndex);
    row.className = `file-row data-row ${isActive ? "active-track" : ""} ${isSelected ? "selected" : ""}`;
    row.type = "button";
    row.innerHTML = `
      <span>${index + 1}</span>
      <span class="file-main">
        <span class="file-title"><i class="${index === 0 ? "star" : "badge-icon"}">${index === 0 ? "★" : "⬡"}</i>${escapeHtml(track.name)}</span>
        <span class="converted-detail">${summaryChips(track).map((item) => `<b>${escapeHtml(item)}</b>`).join("")}</span>
      </span>
      <span class="file-metric">${track.duration}</span>
      <span class="file-metric">${track.format}</span>
      <span class="file-metric">${track.sampleRate}</span>
      <span class="file-metric">${track.bitrate}</span>
      <span class="file-status ${statusClass(track.status)}">${track.status === "Converting" && track.progressPercent != null ? `Converting ${track.progressPercent}%` : track.status}</span>
    `;
    row.addEventListener("click", (event) => {
      selectTrackFromGrid(realIndex, {
        autoplay: true,
        additive: event.metaKey || event.ctrlKey,
        range: event.shiftKey
      });
    });
    container.appendChild(row);
  });

  $("#file-total").textContent = tracks.length;
  $("#all-count").textContent = tracks.length;
  $("#total-count").textContent = tracks.length;
  $("#info-files").textContent = tracks.length;
  $("#converted-count").textContent = convertedCount();
  $("#processing-count").textContent = processingCount();
  $("#convert-selected").textContent = `${textFor("batch.convertSelected")} (${selectedCount()})`;
  updateLayerSummary();
}

function filteredTracks() {
  if (activeLibraryFilter === "Converted") return tracks.filter((track) => track.status === "Converted");
  if (activeLibraryFilter === "Processing") return tracks.filter((track) => track.status === "Converting" || track.status === "Queued");
  if (activeLibraryFilter === "Favorites") return tracks.filter((track, index) => index === 0 || track.favorite);
  return tracks;
}

function statusClass(status) {
  if (status === "Converted") return "status-converted";
  if (status === "Failed" || status === "Probe Failed") return "status-failed";
  if (status === "Converting") return "status-processing";
  return "status-ready";
}

function convertedSummary(track) {
  if (track.convertedInfo) {
    const info = track.convertedInfo;
    const layers = info.layers?.length ? ` • layers: ${info.layers.join(", ")}` : "";
    return `${info.sourceFrequency}Hz → ${info.targetFrequency}Hz • ${info.format} • ${info.sampleRate} • ${info.bitrate} • ${info.codec}${layers}`;
  }
  if (track.status === "Converted" && track.outputPath) {
    return `${track.format} ${track.sampleRate} ${track.bitrate} → ${targetFrequency()}Hz • ${track.outputPath}`;
  }
  const format = selectedOutputFormat();
  const bitrate = $("#bitrate-select")?.value === "lossless" ? "Lossless" : $("#bitrate-select")?.value || "320k";
  const sampleRate = $("#sample-rate-select")?.value === "keep" ? "Keep sample rate" : formatClockSampleRate($("#sample-rate-select")?.value);
  return `${sourceFrequency(track)}Hz → ${targetFrequency()}Hz pending • output ${format} • ${bitrate} • ${sampleRate}`;
}

function summaryChips(track) {
  if (track.convertedInfo) {
    const info = track.convertedInfo;
    const layers = info.layers?.length ? [`Layers: ${info.layers.join(", ")}`] : [];
    return [
      `${info.sourceFrequency}Hz → ${info.targetFrequency}Hz`,
      `${info.format} ${info.sampleRate}`,
      info.bitrate,
      info.codec,
      ...layers
    ].filter(Boolean);
  }

  if (track.status === "Converted" && track.outputPath) {
    return [
      `${sourceFrequency(track)}Hz → ${targetFrequency()}Hz`,
      `${track.format} ${track.sampleRate}`,
      track.bitrate,
      shortPath(track.outputPath)
    ].filter(Boolean);
  }

  const format = selectedOutputFormat();
  const bitrate = $("#bitrate-select")?.value === "lossless" ? "Lossless" : $("#bitrate-select")?.value || "320k";
  const sampleRate = $("#sample-rate-select")?.value === "keep" ? "Keep sample rate" : formatClockSampleRate($("#sample-rate-select")?.value);
  return [
    `${sourceFrequency(track)}Hz → ${targetFrequency()}Hz pending`,
    `Output: ${format}`,
    bitrate,
    sampleRate
  ].filter(Boolean);
}

function shortPath(filePath) {
  if (!filePath) return "";
  const parts = filePath.split(/[\\/]/);
  if (parts.length <= 2) return filePath;
  return `Saved: .../${parts.slice(-2).join("/")}`;
}

function formatClockSampleRate(value) {
  const sampleRate = Number(value);
  if (!sampleRate) return "Keep sample rate";
  return sampleRate >= 1000 ? `${sampleRate / 1000} kHz` : `${sampleRate} Hz`;
}

function clearLoadedPreview() {
  if (audioPlayer) {
    audioPlayer.pause();
    audioPlayer.currentTime = 0;
    audioPlayer = null;
  }
  loadedPreview = null;
  pendingSeekRatio = null;
  setPlayingState(false);
  $("#seek-current").textContent = "00:00";
  $("#seek-fill").style.width = "0%";
}

async function selectTrackFromGrid(realIndex, options = {}) {
  const changedTrack = realIndex !== selectedIndex;
  if (changedTrack) clearLoadedPreview();

  if (options.range && lastSelectedIndex >= 0) {
    const start = Math.min(lastSelectedIndex, realIndex);
    const end = Math.max(lastSelectedIndex, realIndex);
    selectedIndices = new Set();
    for (let index = start; index <= end; index += 1) selectedIndices.add(index);
  } else if (options.additive) {
    if (selectedIndices.has(realIndex) && selectedIndices.size > 1) {
      selectedIndices.delete(realIndex);
    } else {
      selectedIndices.add(realIndex);
    }
  } else {
    selectedIndices = new Set([realIndex]);
  }

  selectedIndex = realIndex;
  lastSelectedIndex = realIndex;
  ensureSelectedSet();
  updateSelection();
  const track = selectedTrack();
  if (track) {
    const count = selectedCount();
    setProgress(count > 1 ? `Loaded playlist: ${count} selected tracks` : `Loaded in player: ${track.name}`, 0);
    if (options.autoplay) {
      await preview(activePreviewMode);
    }
  }
}

function updateSelection() {
  renderRows();
  const track = selectedTrack();
  if (!track) {
    $("#track-title").textContent = "No file selected";
    $("#track-duration").textContent = "--:--";
    $("#track-meta").textContent = "Import real audio to begin";
    $("#track-status").textContent = "Idle";
    $("#seek-current").textContent = "00:00";
    $("#seek-fill").style.width = "0%";
    $("#seek-duration").textContent = "--:--";
    renderWaveformTimeline(null);
    waveformState = { trackId: null, loading: false, original: null, converted: null, error: null };
    updateArtwork(null);
    updateMiniPlayer(null);
    drawWaveform();
    drawSpectrum();
    return;
  }

  const inferredHz = inferTrackFrequency(track);
  if (inferredHz && (!track.sourceFrequency || track.sourceFrequency === 440 || track.sourceFrequency === track.detectedSourceFrequency)) {
    track.sourceFrequency = inferredHz;
    track.detectedSourceFrequency = inferredHz;
  }
  if (!track.sourceFrequency) track.sourceFrequency = sourceInputFrequency();
  if (!track.targetFrequency) track.targetFrequency = targetFrequency();
  syncInputsFromTrack(track);

  $("#track-title").textContent = displayTitle(track);
  $("#track-duration").textContent = track.duration;
  $("#track-meta").textContent = `${track.sampleRate} • ${track.format} • ${sourceFrequency(track)}Hz → ${targetFrequency()}Hz`;
  $("#track-status").textContent = track.status;
  $("#track-status").style.color = track.status === "Converted" ? "var(--green)" : "var(--text)";
  $("#seek-current").textContent = "00:00";
  $("#seek-fill").style.width = "0%";
  $("#seek-duration").textContent = track.duration;
  renderWaveformTimeline(track);
  updateArtwork(track);
  updateMiniPlayer(track);
  requestWaveform(track);
  drawSpectrum();
  syncFrequencyControls("track");
}

function updateMiniPlayer(track) {
  $("#mini-title").textContent = track ? displayTitle(track) : "No track";
  $("#mini-status").textContent = track ? `${track.status} • ${activePreviewMode === "converted" ? `${targetFrequency()}Hz` : `${sourceFrequency()}Hz`}` : "Idle";
  $("#mini-time").textContent = track?.duration || "00:00";
  const mini = $("#mini-artwork");
  mini.classList.remove("has-artwork");
  mini.style.backgroundImage = "";
  if (track?.artworkPath) {
    mini.classList.add("has-artwork");
    mini.style.backgroundImage = `url("${pathToFileURL(track.artworkPath)}")`;
  }
}

function displayTitle(track) {
  return track?.metadata?.title || track?.name || "No file selected";
}

function updateArtwork(track) {
  const cover = document.querySelector(".cover-art");
  cover.classList.remove("has-artwork", "generated");
  cover.style.backgroundImage = "";
  if (track?.artworkPath) {
    cover.classList.add("has-artwork");
    cover.style.backgroundImage = `url("${pathToFileURL(track.artworkPath)}")`;
    return;
  }

  if (track) {
    const theme = coverTheme(track.name);
    cover.classList.add("generated");
    cover.style.setProperty("--cover-a", theme.a);
    cover.style.setProperty("--cover-b", theme.b);
    cover.style.setProperty("--cover-accent", theme.accent);
    cover.style.setProperty("--cover-x", `${theme.x}%`);
    cover.style.setProperty("--cover-y", `${theme.y}%`);
  }
}

function coverTheme(seed) {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const palettes = [
    ["#1a1d2e", "#25152b", "rgba(217,91,170,.42)"],
    ["#10202a", "#1d2438", "rgba(85,114,255,.42)"],
    ["#20172c", "#2b1f35", "rgba(216,168,79,.36)"],
    ["#141d1c", "#202034", "rgba(131,214,160,.34)"],
    ["#211822", "#161a2c", "rgba(239,149,210,.38)"]
  ];
  const palette = palettes[hash % palettes.length];
  return {
    a: palette[0],
    b: palette[1],
    accent: palette[2],
    x: 18 + (hash % 36),
    y: 12 + ((hash >> 4) % 26)
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function waveformCacheKey(track) {
  return `${track?.path || ""}|${track?.outputPath || ""}|${track?.durationSeconds || 0}`;
}

async function requestWaveform(track) {
  const token = ++waveformRequestToken;
  if (!track?.path || !window.zenTune?.analyzeWaveform) {
    waveformState = { trackId: null, loading: false, original: null, converted: null, error: null };
    drawWaveform();
    return;
  }

  const key = waveformCacheKey(track);
  if (waveformCache.has(key)) {
    waveformState = { trackId: track.id, loading: false, ...waveformCache.get(key), error: null };
    drawWaveform();
    return;
  }

  waveformState = { trackId: track.id, loading: true, original: null, converted: null, error: null };
  drawWaveform();

  try {
    const result = await window.zenTune.analyzeWaveform({
      originalPath: track.path,
      convertedPath: track.outputPath || null,
      durationSeconds: track.durationSeconds,
      bucketCount: 900
    });
    if (token !== waveformRequestToken || selectedTrack()?.id !== track.id) return;
    waveformCache.set(key, result);
    waveformState = { trackId: track.id, loading: false, ...result, error: null };
    drawWaveform();
  } catch (error) {
    if (token !== waveformRequestToken) return;
    waveformState = { trackId: track.id, loading: false, original: null, converted: null, error: error.message };
    drawWaveform();
  }
}

function drawWaveform() {
  const canvas = $("#waveform-canvas");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const width = rect.width;
  const height = rect.height;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(255,255,255,0.02)";
  ctx.fillRect(0, 0, width, height);

  if (!tracks.length) {
    ctx.fillStyle = "#737783";
    ctx.font = "14px Inter, sans-serif";
    ctx.fillText("Waveform appears after importing real audio files", 24, height / 2);
    return;
  }

  if (waveformState.loading) {
    ctx.fillStyle = "#aeb1bd";
    ctx.font = "14px Inter, sans-serif";
    ctx.fillText("Loading real waveform...", 24, height / 2);
  } else if (waveformState.error) {
    ctx.fillStyle = "#ff7a9d";
    ctx.font = "14px Inter, sans-serif";
    ctx.fillText(`Waveform failed: ${waveformState.error}`, 24, height / 2);
  } else {
    drawWavePeaks(ctx, waveformState.original?.peaks, width, 72, 46, "#5572ff");
    if (waveformState.converted?.peaks) {
      drawWavePeaks(ctx, waveformState.converted.peaks, width, 174, 46, "#df78ca");
    } else {
      drawEmptyWave(ctx, width, 174, 46, "#df78ca", "Converted waveform appears after conversion");
    }
  }

  ctx.fillStyle = "#5572ff";
  ctx.font = "12px Inter, sans-serif";
  ctx.fillText(`Original (${sourceFrequency()}Hz)`, 0, 22);
  ctx.fillStyle = "#df78ca";
  ctx.fillText(`Converted (${targetFrequency()}Hz)`, 0, 126);
  drawPlayhead(ctx, width, height);
}

function waveformProgressRatio() {
  if (audioPlayer && Number.isFinite(audioPlayer.duration) && audioPlayer.duration > 0) {
    return Math.max(0, Math.min(1, audioPlayer.currentTime / audioPlayer.duration));
  }
  if (Number.isFinite(pendingSeekRatio)) {
    return Math.max(0, Math.min(1, pendingSeekRatio));
  }
  return 0;
}

function drawPlayhead(ctx, width, height) {
  const ratio = waveformProgressRatio();
  const x = Math.max(0, Math.min(width, ratio * width));
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.82)";
  ctx.lineWidth = 1;
  ctx.shadowColor = "#df78ca";
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(x, 12);
  ctx.lineTo(x, height - 8);
  ctx.stroke();
  ctx.fillStyle = "#df78ca";
  ctx.beginPath();
  ctx.arc(x, 12, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function renderWaveformTimeline(track) {
  const timeline = $(".timeline");
  if (!timeline) return;
  const duration = Number(track?.durationSeconds) || 0;
  const points = duration > 0
    ? [0, 0.25, 0.5, 0.75, 0.9, 1].map((ratio) => formatClock(duration * ratio))
    : ["0:00", "0:15", "0:30", "0:45", "1:00", "--:--"];
  timeline.innerHTML = points.map((time) => `<span>${time}</span>`).join("");
}

function drawWave(ctx, width, mid, amp, color, phase) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  for (let x = 0; x < width; x += 2) {
    const envelope =
      0.22 +
      0.42 * Math.abs(Math.sin(x / 58 + phase)) +
      0.28 * Math.abs(Math.sin(x / 21 + phase * 2));
    const jitter = Math.sin(x * 0.82 + phase) * 0.38 + Math.sin(x * 1.7) * 0.18;
    const h = amp * envelope * (0.64 + Math.abs(jitter));
    ctx.beginPath();
    ctx.moveTo(x, mid - h);
    ctx.lineTo(x, mid + h);
    ctx.stroke();
  }
  ctx.restore();
}

function drawWavePeaks(ctx, peaks, width, mid, amp, color) {
  if (!Array.isArray(peaks) || !peaks.length) {
    drawEmptyWave(ctx, width, mid, amp, color, "No waveform data");
    return;
  }
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  const step = width / peaks.length;
  for (let i = 0; i < peaks.length; i += 1) {
    const x = i * step;
    const h = Math.max(1, Math.min(amp, peaks[i] * amp * 1.28));
    ctx.beginPath();
    ctx.moveTo(x, mid - h);
    ctx.lineTo(x, mid + h);
    ctx.stroke();
  }
  ctx.restore();
}

function drawEmptyWave(ctx, width, mid, amp, color, label) {
  ctx.save();
  ctx.strokeStyle = `${color}55`;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 7]);
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(width, mid);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#8f93a0";
  ctx.font = "12px Inter, sans-serif";
  ctx.fillText(label, 12, mid + amp + 18);
  ctx.restore();
}

function drawSpectrum() {
  const canvas = $("#spectrum-canvas");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const width = rect.width;
  const height = rect.height;
  const plot = { x: 32, y: 18, w: width - 44, h: height - 54 };

  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;

  for (let i = 0; i <= 8; i++) {
    const x = plot.x + (plot.w / 8) * i;
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
    ctx.stroke();
  }
  for (let i = 0; i <= 5; i++) {
    const y = plot.y + (plot.h / 5) * i;
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
  }

  ctx.fillStyle = "#aeb1bd";
  ctx.font = "11px Inter, sans-serif";
  ["20", "50", "100", "200", "500", "1k", "2k", "5k", "10k", "20k"].forEach((label, i) => {
    const x = plot.x + (plot.w / 9) * i;
    ctx.fillText(label, x - 7, plot.y + plot.h + 22);
  });
  ["-20", "-40", "-60", "-80", "-100", "-120"].forEach((label, i) => {
    const y = plot.y + (plot.h / 5) * i + 4;
    ctx.fillText(label, 0, y);
  });
  ctx.fillText("Hz", plot.x + plot.w / 2, height - 6);

  if (!tracks.length) return;
  drawSpectrumLine(ctx, plot, "#5572ff", selectedIndex * 0.12, true);
  drawSpectrumLine(ctx, plot, "#df78ca", selectedIndex * 0.12 + 0.45, false);
}

function drawSpectrumLine(ctx, plot, color, shift, fill) {
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i <= plot.w; i++) {
    const t = i / plot.w;
    const base = 0.72 - 0.42 * Math.exp(-Math.pow((t - 0.26) * 7, 2));
    const highDrop = Math.pow(t, 2.2) * 0.38;
    const ripple = Math.sin(t * 74 + shift) * 0.032 + Math.sin(t * 191 + shift) * 0.018;
    const y = plot.y + plot.h * Math.min(0.98, Math.max(0.06, base + highDrop + ripple));
    const x = plot.x + i;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.stroke();
  if (fill) {
    ctx.lineTo(plot.x + plot.w, plot.y + plot.h);
    ctx.lineTo(plot.x, plot.y + plot.h);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
    gradient.addColorStop(0, `${color}33`);
    gradient.addColorStop(1, `${color}00`);
    ctx.fillStyle = gradient;
    ctx.fill();
  }
  ctx.restore();
}

async function importFiles() {
  if (!ensureBridge() || isConverting) return;
  try {
    console.log("Add Files clicked");
    setProgress("Reading selected audio files...", 0);
    const imported = await window.zenTune.pickFiles();
    addTracks(imported);
  } catch (error) {
    setProgress(`Import failed: ${error.message}`, 0);
  }
}

async function importFolder() {
  if (!ensureBridge() || isConverting) return;
  try {
    console.log("Add Folder clicked");
    setProgress("Scanning folder and subfolders...", 0);
    const imported = await window.zenTune.pickFolder();
    addTracks(imported);
  } catch (error) {
    setProgress(`Folder scan failed: ${error.message}`, 0);
  }
}

function droppedFilePaths(event) {
  return [...(event.dataTransfer?.files || [])]
    .map((file) => file.path || window.zenTune?.filePathForDrop?.(file))
    .filter(Boolean);
}

function setDropOverlay(visible) {
  $("#drop-overlay")?.classList.toggle("is-visible", visible);
}

async function importDroppedFiles(event) {
  event.preventDefault();
  setDropOverlay(false);
  if (!ensureBridge() || isConverting) return;
  const paths = droppedFilePaths(event);
  if (!paths.length) {
    setProgress("No local audio file path found in drop.", 0);
    return;
  }

  try {
    setProgress(`Importing dropped item(s): ${paths.length}`, 0);
    const imported = await window.zenTune.importDroppedPaths(paths);
    addTracks(imported);
  } catch (error) {
    setProgress(`Drop import failed: ${error.message}`, 0);
  }
}

function addTracks(imported) {
  if (!Array.isArray(imported)) {
    showMessage("Import failed: app did not receive a file list.");
    return;
  }
  const existing = new Set(tracks.map((track) => track.path));
  const next = imported.filter((track) => !existing.has(track.path)).map(hydrateTrackFrequency);
  tracks = [...tracks, ...next];
  if (tracks.length && selectedIndex === -1) {
    selectedIndex = 0;
    selectedIndices = new Set([0]);
    lastSelectedIndex = 0;
  }
  if (next.length) {
    const nextIndices = next.map((track) => tracks.findIndex((item) => item.path === track.path)).filter((index) => index >= 0);
    selectedIndex = nextIndices[0];
    selectedIndices = new Set(nextIndices);
    lastSelectedIndex = selectedIndex;
    setProgress(`Loaded ${next.length} real audio file(s). Auto converting...`, 0);
  } else {
    setProgress("No new supported audio files found.", 0);
  }
  updateSelection();
  if (next.length) {
    convertTracks(next, { auto: true });
  }
}

async function convertTracks(targetTracks, options = {}) {
  if (!ensureBridge()) return;
  if (!targetTracks.length || isConverting) {
    showMessage("Nothing to convert. Add files first, then select a track.");
    return;
  }
  isConverting = true;
  setButtonsDisabled(true);
  setProgress(`Converting ${targetTracks.length} file(s)...`, 0);
  let playedConvertedAfterConvert = false;

  targetTracks.forEach((target) => {
    const track = tracks.find((item) => item.id === target.id);
    if (track) track.status = "Queued";
  });
  renderRows();

  try {
    const result = await window.zenTune.convertTracks(targetTracks, {
      outputFolder,
      format: selectedOutputFormat(),
      bitrate: $("#bitrate-select").value,
      sampleRate: $("#sample-rate-select").value,
      outputGainDb: Number($("#output-gain-select")?.value || 0),
      sourceFrequency: sourceFrequency(),
      targetFrequency: targetFrequency(),
      brainwave: $("#brainwave-select")?.value || "none",
      binauralEnabled: $("#binaural-toggle")?.checked || false,
      binauralBeat: Number($("#binaural-beat")?.value || 0),
      drone528Enabled: $("#layer-528-toggle")?.checked || false,
      natureLayerEnabled: $("#nature-layer-toggle")?.checked || false,
      autoTuneEnabled: $("#auto-tune-toggle")?.checked || false,
      autoTuneKey: $("#auto-tune-key")?.value || "Auto",
      autoTuneScale: $("#auto-tune-scale")?.value || "Major",
      autoTuneStrength: Number($("#auto-tune-strength")?.value || 55),
      bassEnhanceEnabled: $("#bass-enhance-toggle")?.checked !== false,
      bassBoostDb: Number($("#bass-boost-select")?.value || 3),
      export8dEnabled: $("#export-8d-toggle")?.checked || false,
      export8dSpeed: Number($("#export-8d-speed")?.value || 0.055),
      export8dDepth: Number($("#export-8d-depth")?.value || 0.68)
    });

    const byId = new Map([...result.converted, ...result.failed].map((track) => [track.id, track]));
    tracks = tracks.map((track) => byId.get(track.id) || track);
    lastOutputFolder = outputFolder || outputFolderFor(targetTracks[0]);
    setProgress(`Done: ${result.converted.length} converted, ${result.failed.length} failed.`, 100);
    if (result.converted.length) {
      await playConvertedResult(result.converted[0]);
      playedConvertedAfterConvert = true;
    }
    if (!options.auto && !result.converted.length) {
      const firstError = result.failed[0]?.error || "No files were converted.";
      showMessage(`Converted 0 file(s).\nFailed: ${result.failed.length}\n${firstError}`);
    }
  } catch (error) {
    setProgress(`Convert failed: ${error.message}`, 0);
    showMessage(`Convert failed:\n${error.message}`);
  } finally {
    isConverting = false;
    setButtonsDisabled(false);
    if (playedConvertedAfterConvert) {
      renderRows();
    } else {
      updateSelection();
    }
  }
}

async function playConvertedResult(convertedTrack) {
  if (!convertedTrack?.outputPath) return;
  const convertedIndex = tracks.findIndex((track) => track.id === convertedTrack.id);
  if (convertedIndex >= 0) {
    selectedIndex = convertedIndex;
    selectedIndices = new Set([convertedIndex]);
    lastSelectedIndex = convertedIndex;
    activePreviewMode = "converted";
    clearLoadedPreview();
    updateSelection();
  }
  const track = convertedIndex >= 0 ? tracks[convertedIndex] : convertedTrack;
  $("#preview-original").classList.toggle("active", false);
  $("#preview-converted").classList.toggle("active", true);
  setProgress(`Playing converted file: ${track.name}`, 100);
  playFile(convertedTrack.outputPath, "converted", track);
}

function outputFolderFor(track) {
  if (!track?.path) return null;
  const separator = track.path.includes("\\") ? "\\" : "/";
  const parts = track.path.split(/[\\/]/);
  parts.pop();
  return `${parts.join(separator)}${separator}Converted_${targetFrequency()}Hz`;
}

function showMessage(message) {
  console.log(message);
  window.alert(message);
}

function setProgress(label, percent) {
  $("#progress-label").textContent = label;
  $("#small-progress").style.width = `${Math.max(0, Math.min(100, percent))}%`;
  $("#processed-count").textContent = Math.round((percent / 100) * (tracks.length || 0));
}

function setButtonsDisabled(disabled) {
  ["#add-files", "#add-folder", "#import-button", "#convert-all", "#convert-selected"].forEach((selector) => {
    $(selector).disabled = disabled;
  });
  $("#format-select").disabled = disabled;
  $("#bitrate-select").disabled = disabled;
  $("#sample-rate-select").disabled = disabled;
  $("#output-folder").disabled = disabled;
  $("#choose-output").disabled = disabled;
  $("#open-output").disabled = disabled;
  $("#target-frequency-select").disabled = disabled;
  $("#custom-frequency").disabled = disabled;
  $("#source-frequency").disabled = disabled;
  $("#layer-528-toggle").disabled = disabled;
  $("#binaural-toggle").disabled = disabled;
  $("#binaural-beat").disabled = disabled;
  $("#brainwave-select").disabled = disabled;
  $("#nature-layer-toggle").disabled = disabled;
  $("#auto-tune-toggle").disabled = disabled;
  $("#auto-tune-key").disabled = disabled;
  $("#auto-tune-scale").disabled = disabled;
  $("#auto-tune-strength").disabled = disabled;
  $("#bass-enhance-toggle").disabled = disabled;
  $("#bass-boost-select").disabled = disabled;
  $("#export-8d-toggle").disabled = disabled;
  $("#export-8d-speed").disabled = disabled;
  $("#export-8d-depth").disabled = disabled;
}

async function chooseOutputFolder() {
  if (!ensureBridge() || isConverting) return;
  try {
    const folder = await window.zenTune.pickOutputFolder();
    if (!folder) return;
    outputFolder = folder;
    lastOutputFolder = folder;
    $("#output-path").textContent = folder;
    setProgress("Output folder selected.", 0);
  } catch (error) {
    setProgress(`Output folder failed: ${error.message}`, 0);
    showMessage(`Output folder failed:\n${error.message}`);
  }
}

async function openOutputFolder() {
  const target = lastOutputFolder || outputFolder || outputFolderFor(selectedTrack());
  if (!target) {
    showMessage("No output folder yet. Convert a file or choose output folder first.");
    return;
  }

  try {
    await window.zenTune.openPath(target);
  } catch (error) {
    showMessage(`Could not open output folder:\n${error.message}`);
  }
}

async function preview(mode) {
  const track = selectedTrack();
  if (!ensureBridge()) return;
  if (!track) {
    showMessage("Select a real audio file before previewing.");
    return;
  }

  try {
    activePreviewMode = mode;
    if (track) {
      track.previewSourceFrequency = sourceFrequency();
      track.sourceFrequency = sourceFrequency();
      track.previewTargetFrequency = targetFrequency();
      track.targetFrequency = targetFrequency();
      track.previewBlendOptions = {
        drone528Enabled: $("#layer-528-toggle")?.checked || false,
        binauralEnabled: $("#binaural-toggle")?.checked || false,
        binauralBeat: Number($("#binaural-beat")?.value || 0),
        brainwave: $("#brainwave-select")?.value || "none",
        natureLayerEnabled: $("#nature-layer-toggle")?.checked || false,
        autoTuneEnabled: $("#auto-tune-toggle")?.checked || false,
        autoTuneKey: $("#auto-tune-key")?.value || "Auto",
        autoTuneScale: $("#auto-tune-scale")?.value || "Major",
        autoTuneStrength: Number($("#auto-tune-strength")?.value || 55),
        bassEnhanceEnabled: $("#bass-enhance-toggle")?.checked !== false,
        bassBoostDb: Number($("#bass-boost-select")?.value || 3),
        export8dEnabled: $("#export-8d-toggle")?.checked || false,
        export8dSpeed: Number($("#export-8d-speed")?.value || 0.055),
        export8dDepth: Number($("#export-8d-depth")?.value || 0.68),
        outputGainDb: Number($("#output-gain-select")?.value || 0)
      };
    }
    $("#preview-original").classList.toggle("active", mode === "original");
    $("#preview-converted").classList.toggle("active", mode === "converted");
    setProgress(`Preparing ${mode === "converted" ? `${targetFrequency()}Hz` : "original"} preview...`, 0);
    const result = await window.zenTune.previewTrack(track, mode);
    playFile(result.previewPath, mode, track);
    setProgress(`Playing ${mode === "converted" ? `Converted (${targetFrequency()}Hz)` : `Original (${sourceFrequency()}Hz)`}: ${track.name}`, 0);
  } catch (error) {
    setProgress(`Preview failed: ${error.message}`, 0);
    showMessage(`Preview failed:\n${error.message}`);
  }
}

async function stopPreview() {
  if (!ensureBridge()) return;
  try {
    if (audioPlayer) {
      audioPlayer.pause();
      audioPlayer.currentTime = 0;
      audioPlayer = null;
    }
    loadedPreview = null;
    pendingSeekRatio = null;
    setPlayingState(false);
    $("#seek-current").textContent = "00:00";
    $("#seek-fill").style.width = "0%";
    const track = selectedTrack();
    if (track) {
      $("#track-status").textContent = track.status;
      $("#track-status").style.color = track.status === "Converted" ? "var(--green)" : "var(--text)";
      updateMiniPlayer(track);
    }
    await window.zenTune?.stopPreview();
    setProgress("Preview stopped.", 0);
  } catch (error) {
    setProgress(`Stop preview failed: ${error.message}`, 0);
  }
}

function playFile(filePath, mode, track) {
  if (!filePath) {
    throw new Error("Audio file was not created.");
  }
  if (audioPlayer) {
    audioPlayer.pause();
  }
  audioPlayer = new Audio(pathToFileURL(filePath));
  loadedPreview = { filePath, mode, trackId: track.id };
  const shouldSeekBeforePlay = Number.isFinite(pendingSeekRatio);
  const startPlayback = () => {
    const playPromise = audioPlayer.play();
    setPlayingState(true);
    $("#track-status").textContent = mode === "converted" ? `Playing ${targetFrequency()}Hz` : `Playing ${sourceFrequency()}Hz`;
    $("#track-status").style.color = "var(--pink)";
    $("#mini-status").textContent = mode === "converted" ? `Playing • ${targetFrequency()}Hz` : `Playing • ${sourceFrequency()}Hz`;
    if (playPromise) {
      playPromise.catch((error) => {
        setPlayingState(false);
        showMessage(`Playback failed:\n${error.message}`);
      });
    }
  };
  audioPlayer.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(pendingSeekRatio) && Number.isFinite(audioPlayer.duration) && audioPlayer.duration > 0) {
      audioPlayer.currentTime = Math.max(0, Math.min(audioPlayer.duration, audioPlayer.duration * pendingSeekRatio));
      pendingSeekRatio = null;
    }
    updatePlaybackUI();
    if (shouldSeekBeforePlay) startPlayback();
  });
  audioPlayer.addEventListener("timeupdate", updatePlaybackUI);
  audioPlayer.addEventListener("ended", () => {
    setPlayingState(false);
    updatePlaybackUI();
    $("#track-status").textContent = track.status;
    $("#track-status").style.color = track.status === "Converted" ? "var(--green)" : "var(--text)";
    playNextInSelection();
  });
  audioPlayer.onerror = () => {
    setPlayingState(false);
    showMessage("Playback failed. The audio file was created, but Electron could not play it.");
  };
  if (!shouldSeekBeforePlay) startPlayback();
}

async function playNextInSelection() {
  const playlist = selectedTracks();
  if (playlist.length <= 1) return;
  const currentPosition = playlist.findIndex((track) => track.id === selectedTrack()?.id);
  const nextTrack = playlist[currentPosition + 1];
  if (!nextTrack) {
    setProgress("Playlist finished.", 0);
    return;
  }
  const nextIndex = tracks.findIndex((track) => track.id === nextTrack.id);
  if (nextIndex < 0) return;
  selectedIndex = nextIndex;
  updateSelection();
  await preview(activePreviewMode);
}

async function togglePlayPause() {
  if (!audioPlayer) {
    await preview(activePreviewMode);
    return;
  }

  if (audioPlayer.paused) {
    try {
      await audioPlayer.play();
      setPlayingState(true);
      const track = selectedTrack();
      if (track) {
        $("#track-status").textContent = loadedPreview?.mode === "original" ? `Playing ${sourceFrequency()}Hz` : `Playing ${targetFrequency()}Hz`;
        $("#track-status").style.color = "var(--pink)";
        $("#mini-status").textContent = loadedPreview?.mode === "original" ? `Playing • ${sourceFrequency()}Hz` : `Playing • ${targetFrequency()}Hz`;
      }
      setProgress("Playback resumed.", 0);
    } catch (error) {
      showMessage(`Playback failed:\n${error.message}`);
    }
  } else {
    audioPlayer.pause();
    setPlayingState(false);
    const track = selectedTrack();
    if (track) {
      $("#track-status").textContent = "Paused";
      $("#track-status").style.color = "var(--gold)";
      $("#mini-status").textContent = "Paused";
    }
    setProgress("Playback paused.", 0);
  }
}

function setPlayingState(nextIsPlaying) {
  isPlaying = nextIsPlaying;
  const button = $("#play-preview");
  button.textContent = isPlaying ? "⏸" : "▶";
  button.classList.toggle("is-playing", isPlaying);
}

function updatePlaybackUI() {
  if (!audioPlayer) return;
  const current = Number.isFinite(audioPlayer.currentTime) ? audioPlayer.currentTime : 0;
  const duration = Number.isFinite(audioPlayer.duration) ? audioPlayer.duration : selectedTrack()?.durationSeconds || 0;
  const percent = duration > 0 ? (current / duration) * 100 : 0;
  $("#seek-current").textContent = formatClock(current);
  $("#seek-duration").textContent = formatClock(duration);
  $("#seek-fill").style.width = `${Math.max(0, Math.min(100, percent))}%`;
  drawWaveform();
}

async function seekPreviewToRatio(ratio) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const track = selectedTrack();
  if (!track) {
    showMessage("Select a file before seeking.");
    return;
  }

  pendingSeekRatio = clamped;
  drawWaveform();

  if (audioPlayer && Number.isFinite(audioPlayer.duration) && audioPlayer.duration > 0) {
    audioPlayer.currentTime = audioPlayer.duration * clamped;
    updatePlaybackUI();
    if (audioPlayer.paused) {
      try {
        await audioPlayer.play();
        setPlayingState(true);
      } catch (error) {
        showMessage(`Playback failed:\n${error.message}`);
      }
    }
    return;
  }

  await preview(activePreviewMode);
}

function seekRatioFromPointer(event, element) {
  const rect = element.getBoundingClientRect();
  if (!rect.width) return 0;
  return (event.clientX - rect.left) / rect.width;
}

function previewSeekPosition(ratio) {
  const clamped = Math.max(0, Math.min(1, ratio));
  pendingSeekRatio = clamped;
  const duration = Number.isFinite(audioPlayer?.duration) && audioPlayer.duration > 0
    ? audioPlayer.duration
    : selectedTrack()?.durationSeconds || 0;
  $("#seek-current").textContent = formatClock(duration * clamped);
  $("#seek-fill").style.width = `${clamped * 100}%`;
  drawWaveform();
}

function attachSeekDrag() {
  const seekBar = $("#seek-bar");
  seekBar.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    isSeeking = true;
    seekBar.classList.add("dragging");
    seekBar.setPointerCapture?.(event.pointerId);
    previewSeekPosition(seekRatioFromPointer(event, seekBar));
  });

  seekBar.addEventListener("pointermove", (event) => {
    if (!isSeeking) return;
    previewSeekPosition(seekRatioFromPointer(event, seekBar));
  });

  const finishSeek = async (event) => {
    if (!isSeeking) return;
    isSeeking = false;
    seekBar.classList.remove("dragging");
    seekBar.releasePointerCapture?.(event.pointerId);
    await seekPreviewToRatio(seekRatioFromPointer(event, seekBar));
  };

  seekBar.addEventListener("pointerup", finishSeek);
  seekBar.addEventListener("pointercancel", finishSeek);
}

function formatClock(secondsValue) {
  const total = Math.max(0, Math.floor(secondsValue || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function pathToFileURL(filePath) {
  const normalized = filePath.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
  return `file://${normalized.startsWith("/") ? "" : "/"}${normalized}`;
}

function ensureBridge() {
  if (window.zenTune) return true;
  showMessage("Electron bridge is not available. Close this window and run ./launch_zentune.command again.");
  return false;
}

async function refreshBlackHoleStatus() {
  const card = $("#blackhole-card");
  const statusLabel = $("#blackhole-status");
  const enable = $("#blackhole-enable");
  const install = $("#blackhole-install");
  if (!card || !statusLabel || !enable || !install) return;

  if (!window.zenTune?.blackHoleStatus) {
    statusLabel.textContent = "BlackHole check is unavailable in this runtime.";
    enable.disabled = true;
    install.hidden = false;
    return;
  }

  statusLabel.textContent = "Checking BlackHole 2ch...";
  enable.disabled = true;
  card.classList.remove("is-ready", "needs-install", "needs-reboot");

  try {
    blackHoleState = await window.zenTune.blackHoleStatus();
    if (blackHoleState.status === "ready") {
      card.classList.add("is-ready");
      statusLabel.textContent = "Ready: BlackHole 2ch is active.";
      enable.disabled = false;
      install.hidden = true;
      $("#blackhole-help").textContent = "Enable this when routing system audio into kctune via BlackHole 2ch.";
    } else if (blackHoleState.status === "needs-reboot") {
      card.classList.add("needs-reboot");
      statusLabel.textContent = "Installed, but not active. Restart macOS to finish BlackHole setup.";
      enable.checked = false;
      enable.disabled = true;
      install.hidden = true;
      $("#blackhole-help").textContent = "Driver package is installed. Reboot is required before kctune can use it.";
    } else {
      card.classList.add("needs-install");
      statusLabel.textContent = "Not installed. Install BlackHole 2ch to enable realtime routing.";
      enable.checked = false;
      enable.disabled = true;
      install.hidden = false;
      install.classList.add("primary");
      $("#blackhole-help").textContent = "Install BlackHole 2ch first, then restart macOS if requested.";
    }
  } catch (error) {
    statusLabel.textContent = `BlackHole check failed: ${error.message}`;
    enable.checked = false;
    enable.disabled = true;
    install.hidden = false;
  }
}

async function openBlackHoleInstaller() {
  if (!ensureBridge()) return;
  try {
    await window.zenTune.openBlackHoleInstaller();
    setProgress("BlackHole installer opened. Complete install, then refresh status.", 0);
  } catch (error) {
    showMessage(`Could not open BlackHole installer:\n${error.message}`);
  }
}

function toggleBlackHoleMode() {
  const enabled = $("#blackhole-enable")?.checked || false;
  if (enabled && blackHoleState.status !== "ready") {
    $("#blackhole-enable").checked = false;
    showMessage("BlackHole 2ch is not active yet. Install it and restart macOS first.");
    return;
  }
  setProgress(enabled ? "BlackHole realtime input enabled." : "BlackHole realtime input disabled.", 0);
}

function targetFrequency() {
  const custom = Number($("#custom-frequency")?.value);
  if (Number.isFinite(custom) && custom > 0) return custom;
  return Number($("#target-frequency-select")?.value || 432);
}

function sourceInputFrequency() {
  const source = Number($("#source-frequency")?.value);
  return Number.isFinite(source) && source > 0 ? source : 440;
}

function sourceFrequency(track = selectedTrack()) {
  const inferredHz = inferTrackFrequency(track);
  const savedHz = Number(track?.sourceFrequency || track?.previewSourceFrequency);
  const trackHz = inferredHz && (!savedHz || savedHz === 440 || savedHz === Number(track?.detectedSourceFrequency))
    ? inferredHz
    : savedHz;
  return Number.isFinite(trackHz) && trackHz > 0 ? trackHz : sourceInputFrequency();
}

function pitchShiftPercent() {
  return (((targetFrequency() / sourceFrequency()) - 1) * 100).toFixed(3);
}

function syncInputsFromTrack(track) {
  if (!track) return;
  const inferredHz = inferTrackFrequency(track);
  if (inferredHz && (!track.sourceFrequency || track.sourceFrequency === 440 || track.sourceFrequency === track.detectedSourceFrequency)) {
    track.sourceFrequency = inferredHz;
    track.detectedSourceFrequency = inferredHz;
  }
  const sourceHz = Number(track.sourceFrequency || inferredHz);
  const targetHz = Number(track.targetFrequency);
  if (Number.isFinite(sourceHz) && sourceHz > 0) {
    $("#source-frequency").value = String(sourceHz);
  }
  if (Number.isFinite(targetHz) && targetHz > 0) {
    $("#target-frequency-select").value = String(targetHz);
    $("#custom-frequency").value = String(targetHz);
  }
}

function applyFrequencyToTracks(scope = "selected") {
  const targetTracks = scope === "all" ? tracks : [selectedTrack()].filter(Boolean);
  targetTracks.forEach((track) => {
    track.sourceFrequency = sourceInputFrequency();
    track.targetFrequency = targetFrequency();
    track.previewSourceFrequency = sourceInputFrequency();
    track.previewTargetFrequency = targetFrequency();
  });
}

function resetLoadedPreviewForFrequencyChange() {
  if (!audioPlayer && !loadedPreview) return;
  clearLoadedPreview();
  const track = selectedTrack();
  if (track) {
    $("#track-status").textContent = track.status;
    $("#track-status").style.color = track.status === "Converted" ? "var(--green)" : "var(--text)";
    updateMiniPlayer(track);
  }
}

function syncFrequencyControls(source = "select") {
  if (source === "select") {
    $("#custom-frequency").value = $("#target-frequency-select").value;
  }
  if (source !== "track") {
    applyFrequencyToTracks(source === "source" ? "selected" : "all");
  }
  const hz = targetFrequency();
  const sourceHz = source === "source" ? sourceInputFrequency() : sourceFrequency();
  const theme = frequencyThemes[hz] || "Custom frequency";
  $("#preview-original").textContent = `Original (${sourceHz}Hz)`;
  $("#preview-converted").textContent = `Converted (${hz}Hz)`;
  document.querySelector(".blue").textContent = `Original (${sourceHz}Hz)`;
  document.querySelector(".pink").textContent = `Converted (${hz}Hz)`;
  document.querySelector(".spectrum-card footer span:first-child").textContent = `Peak Shift: ${pitchShiftPercent()}%`;
  document.querySelector(".spectrum-card footer span:last-child").textContent = `Frequency Shift: ${sourceHz}Hz → ${hz}Hz`;
  document.querySelector(".benefits-card h3").textContent = `${hz}Hz Benefits`;
  const track = selectedTrack();
  if (track) {
    $("#track-meta").textContent = `${track.sampleRate} • ${track.format} • ${sourceHz}Hz → ${hz}Hz`;
  }
  updateLayerSummary();
  drawWaveform();
  drawSpectrum();
  setProgress(`${sourceHz}Hz → ${hz}Hz selected • ${theme}`, 0);
}

function updateLayerSummary() {
  const summary = $("#layer-frequency-summary");
  if (summary) summary.textContent = `${sourceFrequency()}Hz → ${targetFrequency()}Hz`;
}

function applyLanguage(language) {
  currentLanguage = language;
  localStorage.setItem("zentune-language", language);
  document.documentElement.lang = language === "zh" ? "zh" : language;
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = textFor(node.dataset.i18n);
  });
  $("#convert-all").textContent = textFor("batch.convertAll");
  $("#convert-selected").textContent = `${textFor("batch.convertSelected")} (${selectedCount()})`;
  if ($("#progress-label")?.textContent === "Ready to convert") {
    $("#progress-label").textContent = textFor("status.ready");
  }
  updateLayerSummary();
}

function handleFrequencyChange(source) {
  syncFrequencyControls(source);
  resetLoadedPreviewForFrequencyChange();
}

function syncOutputQualityForFormat() {
  const format = selectedOutputFormat();
  const bitrate = $("#bitrate-select");
  if (["FLAC", "WAV", "AIFF"].includes(format)) {
    bitrate.value = "lossless";
  } else if (format === "MP3" && (bitrate.value === "512k" || bitrate.value === "lossless")) {
    bitrate.value = "320k";
  } else if (format === "AAC" && bitrate.value === "lossless") {
    bitrate.value = "512k";
  }
  renderRows();
}

function applyStudioPreset(preset) {
  const presets = {
    "youtube-sleep": { hz: 432, format: "AAC", bitrate: "320k", sampleRate: "48000", gain: 3, brainwave: "delta", beat: 2.5, binaural: true, drone: false, nature: true, autoTune: false, key: "Auto", scale: "Major", strength: 25, bass: true, bassDb: 3, export8d: false, speed: 0.035, depth: 0.45, label: "YouTube Sleep" },
    "meditation": { hz: 528, format: "MP3", bitrate: "320k", sampleRate: "keep", gain: 4.5, brainwave: "theta", beat: 6, binaural: true, drone: true, nature: false, autoTune: false, key: "Auto", scale: "Major", strength: 25, bass: true, bassDb: 3, export8d: false, speed: 0.055, depth: 0.68, label: "Meditation" },
    "ambient-producer": { hz: 432, format: "FLAC", bitrate: "lossless", sampleRate: "keep", gain: 0, brainwave: "theta", beat: 6, binaural: true, drone: true, nature: false, autoTune: false, key: "Auto", scale: "Major", strength: 55, bass: true, bassDb: 3, export8d: true, speed: 0.055, depth: 0.68, label: "Ambient Producer" },
    "healing-frequency": { hz: 528, format: "MP3", bitrate: "320k", sampleRate: "48000", gain: 4.5, brainwave: "theta", beat: 6, binaural: false, drone: true, nature: false, autoTune: false, key: "Auto", scale: "Major", strength: 55, bass: true, bassDb: 3, export8d: false, speed: 0.055, depth: 0.45, label: "Healing Frequency" },
    "lofi-chill": { hz: 432, format: "MP3", bitrate: "320k", sampleRate: "keep", gain: 3, brainwave: "alpha", beat: 10, binaural: true, drone: false, nature: false, autoTune: false, key: "Auto", scale: "Minor", strength: 25, bass: true, bassDb: 6, export8d: false, speed: 0.035, depth: 0.45, label: "Lo-fi / Chill" },
    "cinematic-trailer": { hz: 440, format: "WAV", bitrate: "lossless", sampleRate: "48000", gain: 0, brainwave: "theta", beat: 7.5, binaural: true, drone: false, nature: false, autoTune: false, key: "Auto", scale: "Major", strength: 55, bass: true, bassDb: 6, export8d: true, speed: 0.085, depth: 0.85, label: "Cinematic / Trailer" }
  };
  const next = presets[preset];
  if (!next) return;
  $("#target-frequency-select").value = String(next.hz);
  $("#custom-frequency").value = String(next.hz);
  $("#format-select").value = next.format;
  $("#bitrate-select").value = next.bitrate;
  $("#sample-rate-select").value = next.sampleRate;
  $("#output-gain-select").value = String(next.gain);
  $("#brainwave-select").value = next.brainwave;
  $("#binaural-toggle").checked = next.binaural;
  $("#binaural-beat").value = String(next.beat);
  $("#layer-528-toggle").checked = next.drone;
  $("#nature-layer-toggle").checked = next.nature;
  $("#auto-tune-toggle").checked = next.autoTune;
  $("#auto-tune-key").value = next.key;
  $("#auto-tune-scale").value = next.scale;
  $("#auto-tune-strength").value = String(next.strength);
  $("#bass-enhance-toggle").checked = next.bass;
  $("#bass-boost-select").value = String(next.bassDb);
  $("#export-8d-toggle").checked = next.export8d;
  $("#export-8d-speed").value = String(next.speed);
  $("#export-8d-depth").value = String(next.depth);
  syncFrequencyControls("select");
  setProgress(`${next.label} preset applied: ${next.hz}Hz + ${next.brainwave} layer`, 0);
}

window.zenTune?.onConvertProgress((payload) => {
  const track = tracks.find((item) => item.id === payload.id);
  if (track) {
    track.status = payload.status;
    track.progressPercent = Number.isFinite(Number(payload.filePercent)) ? Math.round(Number(payload.filePercent)) : track.progressPercent;
    if (payload.outputPath) track.outputPath = payload.outputPath;
    if (payload.convertedInfo) track.convertedInfo = payload.convertedInfo;
    if (payload.error) track.error = payload.error;
    if (payload.status === "Converted" || payload.status === "Failed") {
      track.progressPercent = null;
    }
  }
  const percent = Number.isFinite(Number(payload.overallPercent))
    ? Number(payload.overallPercent)
    : (payload.total ? (payload.index / payload.total) * 100 : 0);
  const filePercent = Number.isFinite(Number(payload.filePercent)) ? Math.round(Number(payload.filePercent)) : Math.round(percent);
  const phase = payload.phase || payload.status;
  setProgress(`${phase}: ${track?.name || "track"} • ${filePercent}%`, percent);
  renderRows();
});

window.addEventListener("resize", () => {
  drawWaveform();
  drawSpectrum();
});

$("#add-files").addEventListener("click", importFiles);
$("#add-folder").addEventListener("click", importFolder);
$("#import-button").addEventListener("click", importFiles);
$("#refresh-button").addEventListener("click", () => {
  renderRows();
  setProgress("File list refreshed.", 0);
});
$("#output-folder").addEventListener("click", chooseOutputFolder);
$("#choose-output").addEventListener("click", chooseOutputFolder);
$("#open-output").addEventListener("click", openOutputFolder);
$("#source-frequency").addEventListener("input", () => handleFrequencyChange("source"));
$("#target-frequency-select").addEventListener("change", () => handleFrequencyChange("select"));
$("#custom-frequency").addEventListener("input", () => handleFrequencyChange("custom"));
$("#format-select").addEventListener("change", syncOutputQualityForFormat);
$("#bitrate-select").addEventListener("change", syncOutputQualityForFormat);
$("#sample-rate-select").addEventListener("change", renderRows);
$("#output-gain-select").addEventListener("change", renderRows);
$("#language-select").value = currentLanguage;
$("#language-select").addEventListener("change", (event) => applyLanguage(event.target.value));
["#binaural-toggle", "#export-8d-toggle", "#layer-528-toggle", "#nature-layer-toggle", "#auto-tune-toggle", "#auto-tune-key", "#auto-tune-scale", "#auto-tune-strength", "#bass-enhance-toggle", "#bass-boost-select", "#brainwave-select", "#binaural-beat", "#export-8d-speed", "#export-8d-depth"].forEach((selector) => {
  $(selector)?.addEventListener("change", () => {
    renderRows();
    resetLoadedPreviewForFrequencyChange();
  });
});
document.querySelectorAll(".studio-presets button").forEach((button) => {
  button.addEventListener("click", () => applyStudioPreset(button.dataset.preset));
});
$("#preview-original").addEventListener("click", () => preview("original"));
$("#preview-converted").addEventListener("click", () => preview("converted"));
$("#play-preview").addEventListener("click", togglePlayPause);
$("#stop-preview").addEventListener("click", stopPreview);
attachSeekDrag();
$("#waveform-canvas").addEventListener("click", (event) => {
  const rect = event.currentTarget.getBoundingClientRect();
  const ratio = (event.clientX - rect.left) / rect.width;
  seekPreviewToRatio(ratio);
});
$("#convert-all").addEventListener("click", () => convertTracks(tracks));
$("#convert-selected").addEventListener("click", () => {
  const selection = selectedTracks();
  if (selection.length) convertTracks(selection);
  else showMessage("Select a file before converting selected.");
});

document.querySelectorAll(".tabs button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    setProgress(`${button.textContent.trim()} view selected.`, 0);
    drawWaveform();
    drawSpectrum();
  });
});

document.querySelectorAll(".nav-section a").forEach((link) => {
  link.addEventListener("click", () => {
    document.querySelectorAll(".nav-section a").forEach((item) => item.classList.remove("active"));
    link.classList.add("active");
    const label = navLabel(link);
    routeTo(label);
  });
});

document.querySelectorAll(".title-actions button").forEach((button) => {
  button.addEventListener("click", () => {
    setProgress(`${button.textContent.trim()} panel is not built yet. Core import/convert controls are active.`, 0);
  });
});

$("#blackhole-refresh")?.addEventListener("click", refreshBlackHoleStatus);
$("#blackhole-install")?.addEventListener("click", openBlackHoleInstaller);
$("#blackhole-enable")?.addEventListener("change", toggleBlackHoleMode);

let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  event.preventDefault();
  dragDepth += 1;
  setDropOverlay(true);
});
window.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) setDropOverlay(false);
});
window.addEventListener("drop", (event) => {
  dragDepth = 0;
  importDroppedFiles(event);
});

applyDefaultOutputSettings();
applyLanguage(currentLanguage);
renderRows();
updateSelection();
syncFrequencyControls("select");
refreshBlackHoleStatus();

function navLabel(link) {
  const clone = link.cloneNode(true);
  clone.querySelector("b")?.remove();
  return clone.textContent.replace(/[▣◉✺☆▦♬⌘◇⚙☼▱◴]/g, "").replace(/\s+/g, " ").trim();
}

function routeTo(label) {
  const libraryRoutes = new Set(["All Files", "Converted", "Processing", "Favorites"]);
  if (libraryRoutes.has(label)) {
    activeLibraryFilter = label;
    hideRoute();
    renderRows();
    setProgress(`${label} selected.`, 0);
    return;
  }

  showRoute(label);
  setProgress(`${label} opened.`, 0);
}

function hideRoute() {
  $(".dashboard").classList.remove("route-active");
  $("#route-card").hidden = true;
}

function showRoute(label) {
  const route = routeContent(label);
  $("#route-kicker").textContent = route.kicker;
  $("#route-title").textContent = label;
  $("#route-body").innerHTML = route.html;
  $("#route-card").hidden = false;
  $(".dashboard").classList.add("route-active");
  attachRouteActions(label);
  if (label === "Frequency Analyzer") {
    requestAnimationFrame(drawRouteSpectrum);
  }
}

function attachRouteActions(label) {
  $("#route-import-files")?.addEventListener("click", importFiles);
  $("#route-import-folder")?.addEventListener("click", importFolder);
  $("#route-convert-all")?.addEventListener("click", () => convertTracks(tracks));
  $("#route-convert-selected")?.addEventListener("click", () => {
    const selection = selectedTracks();
    if (selection.length) convertTracks(selection);
    else showMessage("Select a file before converting selected.");
  });
  $("#route-output-folder")?.addEventListener("click", chooseOutputFolder);
  $("#route-open-output")?.addEventListener("click", openOutputFolder);
  $("#route-play-original")?.addEventListener("click", () => preview("original"));
  $("#route-play-converted")?.addEventListener("click", () => preview("converted"));
  $("#route-stop")?.addEventListener("click", stopPreview);
  $("#route-choose-artwork")?.addEventListener("click", chooseRouteArtwork);
  $("#route-save-metadata")?.addEventListener("click", saveRouteMetadata);
}

async function chooseRouteArtwork() {
  if (!ensureBridge()) return;
  const selection = selectedTracks();
  if (!selection.length) {
    showMessage("Select one or more tracks before choosing artwork.");
    return;
  }

  try {
    const artworkPath = await window.zenTune.pickArtwork();
    if (!artworkPath) return;
    selection.forEach((track) => {
      track.artworkPath = artworkPath;
      track.customArtworkPath = artworkPath;
    });
    updateSelection();
    showRoute("Tag Editor");
    setProgress(`Artwork replaced for ${selection.length} selected track(s).`, 0);
  } catch (error) {
    showMessage(`Artwork pick failed:\n${error.message}`);
  }
}

function saveRouteMetadata() {
  const selection = selectedTracks();
  if (!selection.length) {
    showMessage("Select one or more tracks before saving metadata.");
    return;
  }

  const nextMetadata = {
    title: $("#meta-title")?.value.trim(),
    artist: $("#meta-artist")?.value.trim(),
    album: $("#meta-album")?.value.trim(),
    genre: $("#meta-genre")?.value.trim()
  };

  selection.forEach((track) => {
    track.metadata = { ...(track.metadata || {}) };
    for (const [key, value] of Object.entries(nextMetadata)) {
      if (value) track.metadata[key] = value;
    }
  });

  updateSelection();
  showRoute("Tag Editor");
  setProgress(`Metadata updated for ${selection.length} selected track(s).`, 0);
}

$("#route-back").addEventListener("click", () => {
  activeLibraryFilter = "All Files";
  document.querySelectorAll(".nav-section a").forEach((item) => item.classList.remove("active"));
  document.querySelector(".nav-section a")?.classList.add("active");
  hideRoute();
  renderRows();
});

function routeContent(label) {
  const selected = selectedTrack();
  const selection = selectedTracks();
  const hasMultiSelection = selection.length > 1;
  const commonTrack = selected ? `${escapeHtml(selected.name)} • ${selected.sampleRate} • ${selected.format}` : "No track selected";
  const sourceHz = sourceFrequency();
  const targetHz = targetFrequency();
  const shift = pitchShiftPercent();
  const routes = {
    "Batch Convert": {
      kicker: "Tools",
      html: `
        <section class="route-panel wide">
          <h3>Queue Manager</h3>
          <p>${tracks.length} imported file(s), ${convertedCount()} converted. Auto-convert is enabled after import.</p>
          <button class="route-action" id="route-import-files">Import Files</button>
          <button class="route-action" id="route-import-folder">Import Folder</button>
          <button class="route-action" id="route-convert-all">Convert All</button>
          <button class="route-action" id="route-convert-selected">Convert Selected</button>
        </section>
        <section class="route-panel">
          <h3>Conversion Mode</h3>
          <div class="route-control">
            <label>Accurate <input type="radio" checked></label>
            <label>Fast <input type="radio"></label>
          </div>
        </section>
        <section class="route-panel">
          <h3>Progress</h3>
          <p>${$("#progress-label").textContent}</p>
        </section>`
    },
    "Frequency Analyzer": {
      kicker: "Tools",
      html: `
        <section class="route-panel wide">
          <h3>FFT Graph</h3>
          <canvas id="route-spectrum" height="280"></canvas>
        </section>
        <section class="route-panel">
          <h3>Harmonic Analysis</h3>
          <ul><li>Peak Shift: ${shift}%</li><li>Frequency Shift: ${sourceHz}Hz → ${targetHz}Hz</li><li>Track: ${commonTrack}</li></ul>
        </section>
        <section class="route-panel">
          <h3>Resonance Peaks</h3>
          <p>Current theme: ${frequencyThemes[targetHz] || "Custom frequency"}. Import and select a track, then use Original/Converted preview to compare harmonics.</p>
        </section>`
    },
    "A/B Compare": {
      kicker: "Tools",
      html: `
        <section class="route-panel wide">
          <h3>Realtime A/B Preview</h3>
          <p>${commonTrack}</p>
          <button class="route-action" id="route-play-original">Play ${sourceHz}Hz Original</button>
          <button class="route-action" id="route-play-converted">Play ${targetHz}Hz Converted</button>
          <button class="route-action" id="route-stop">Stop</button>
        </section>
        <section class="route-panel wide">
          <h3>Waveform Compare</h3>
          <p>Synced waveform is shown on the dashboard A/B panel. This route focuses playback controls.</p>
        </section>`
    },
    "Tag Editor": {
      kicker: "Tools",
      html: `
        <section class="route-panel wide">
          <h3>Metadata Editor</h3>
          <p>${hasMultiSelection ? `Editing ${selection.length} selected tracks. Blank fields stay unchanged.` : selected ? `Editing: ${escapeHtml(selected.name)}` : "Select one or more tracks from All Files before editing metadata."}</p>
          <div class="artwork-editor">
            <div class="artwork-preview ${selected?.artworkPath ? "has-artwork" : ""}" style="${selected?.artworkPath ? `background-image:url('${pathToFileURL(selected.artworkPath)}')` : ""}"></div>
            <div>
              <strong>${selected?.artworkPath ? "Artwork ready" : "No embedded artwork"}</strong>
              <p>${hasMultiSelection ? `Choose one image to apply to ${selection.length} selected files.` : "Choose an image to replace this track artwork."}</p>
              <button class="route-action" id="route-choose-artwork">Choose Artwork Image</button>
            </div>
          </div>
          <div class="route-control">
            <label>Title <input id="meta-title" value="${hasMultiSelection ? "" : escapeHtml(selected?.metadata?.title || selected?.name?.replace(/\.[^.]+$/, "") || "")}" placeholder="${hasMultiSelection ? "Leave blank to keep titles" : "Title"}"></label>
            <label>Artist <input id="meta-artist" value="${hasMultiSelection ? "" : escapeHtml(selected?.metadata?.artist || "")}" placeholder="Artist"></label>
            <label>Album <input id="meta-album" value="${hasMultiSelection ? "" : escapeHtml(selected?.metadata?.album || "")}" placeholder="Album"></label>
            <label>Genre <input id="meta-genre" value="${hasMultiSelection ? "" : escapeHtml(selected?.metadata?.genre || "")}" placeholder="Ambient / Meditation"></label>
          </div>
          <button class="route-action" id="route-save-metadata">Save Metadata${hasMultiSelection ? ` to ${selection.length} Files` : ""}</button>
          <p>Metadata saved here is used for converted exports. Original source files are not overwritten.</p>
        </section>`
    },
    "Conversion Settings": {
      kicker: "Settings",
      html: `
        <section class="route-panel">
          <h3>Conversion Mode</h3>
          <div class="route-control">
            <label>Mode <select><option>Accurate (High Quality)</option><option>Fast (Realtime)</option></select></label>
            <label>Source Frequency <input type="number" min="100" max="1200" value="${sourceHz}" readonly></label>
            <label>Target Frequency <input type="number" min="100" max="1200" value="${targetHz}" readonly></label>
          </div>
        </section>
        <section class="route-panel">
          <h3>Pitch Shift</h3>
          <p>Current shift: ${shift}%. Current route: ${sourceHz}Hz → ${targetHz}Hz. Current theme: ${frequencyThemes[targetHz] || "Custom frequency"}.</p>
        </section>
        <section class="route-panel wide">
          <h3>Solfeggio Presets</h3>
          <p>174 Pain relief • 285 Healing • 396 Fear release • 417 Change • 528 Love/healing • 639 Relationships • 741 Cleansing • 852 Intuition • 963 Higher consciousness.</p>
        </section>
        <section class="route-panel wide">
          <h3>Binaural / Brainwave</h3>
          <p>Delta 0.5–4Hz deep sleep • Theta 4–8Hz meditation/dreaming • Alpha 8–12Hz relaxation/focus • Beta 13–30Hz concentration.</p>
        </section>`
    },
    "Output Settings": {
      kicker: "Settings",
      html: `
        <section class="route-panel wide">
          <h3>Export Preferences</h3>
          <p>Current output: ${escapeHtml($("#output-path").textContent)}</p>
          <button class="route-action" id="route-output-folder">Choose Output Folder</button>
          <button class="route-action" id="route-open-output">Open Output Folder</button>
        </section>
        <section class="route-panel">
          <h3>Format</h3>
          <div class="route-control">
            <label>Format <select><option>MP3</option><option>FLAC Lossless</option><option>WAV Lossless</option><option>AAC</option><option>AIFF Lossless</option></select></label>
            <label>Bitrate <select><option>320 kbps</option><option>512 kbps (AAC)</option><option>256 kbps</option><option>192 kbps</option><option>128 kbps</option><option>Lossless</option></select></label>
            <label>Sample Rate <select><option>Keep Original</option><option>44.1 kHz</option><option>48 kHz</option><option>96 kHz</option></select></label>
          </div>
        </section>
        <section class="route-panel">
          <h3>Options</h3>
          <div class="route-control">
            <label>Preserve Metadata <input type="checkbox" checked></label>
            <label>Normalize -14 LUFS <input type="checkbox"></label>
          </div>
        </section>`
    },
    Metadata: {
      kicker: "Settings",
      html: `
        <section class="route-panel wide">
          <h3>Bulk Metadata</h3>
          <p>Edit title, artist, album, artwork, and genre for selected tracks. Metadata preservation is active during convert.</p>
        </section>`
    },
    Advanced: {
      kicker: "Settings",
      html: `
        <section class="route-panel">
          <h3>DSP Settings</h3>
          <div class="route-control">
            <label>Stereo Width <input type="range"></label>
            <label>Harmonic Warmth <input type="range"></label>
            <label>Soft Limiter <input type="checkbox"></label>
            <label>Tape Saturation <input type="checkbox"></label>
            <label>Ambient Enhancer <input type="checkbox"></label>
          </div>
        </section>`
    }
  };
  return routes[label] || { kicker: "kctune", html: `<section class="route-panel wide"><h3>${escapeHtml(label)}</h3><p>This screen is ready.</p></section>` };
}

function drawRouteSpectrum() {
  const canvas = $("#route-spectrum");
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const plot = { x: 36, y: 18, w: rect.width - 54, h: rect.height - 44 };
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  for (let i = 0; i <= 8; i++) {
    const x = plot.x + (plot.w / 8) * i;
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
    ctx.stroke();
  }
  for (let i = 0; i <= 5; i++) {
    const y = plot.y + (plot.h / 5) * i;
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
  }
  drawSpectrumLine(ctx, plot, "#5572ff", 0, true);
  drawSpectrumLine(ctx, plot, "#df78ca", 0.45, false);
}
