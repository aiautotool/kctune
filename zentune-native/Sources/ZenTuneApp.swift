import AVFoundation
import SwiftUI
import AppKit

private let ffmpegPath = "/opt/homebrew/bin/ffmpeg"
private let ffprobePath = "/opt/homebrew/bin/ffprobe"
private let supportedExtensions = Set(["mp3", "wav", "flac", "aiff", "aif", "m4a", "aac"])

enum TrackStatus: String {
    case ready = "Ready"
    case converting = "Converting"
    case converted = "Converted"
    case failed = "Failed"
}

enum OutputFormat: String, CaseIterable, Identifiable {
    case wav = "WAV"
    case mp3 = "MP3"
    case flac = "FLAC"
    case aac = "AAC"
    case aiff = "AIFF"

    var id: String { rawValue }
    var fileExtension: String { rawValue.lowercased() == "aiff" ? "aiff" : rawValue.lowercased() }
}

enum Bitrate: String, CaseIterable, Identifiable {
    case kbps128 = "128 kbps"
    case kbps192 = "192 kbps"
    case kbps320 = "320 kbps"
    case lossless = "Lossless"

    var id: String { rawValue }
    var ffmpegValue: String? {
        switch self {
        case .kbps128: return "128k"
        case .kbps192: return "192k"
        case .kbps320: return "320k"
        case .lossless: return nil
        }
    }
}

enum SampleRateChoice: String, CaseIterable, Identifiable {
    case keep = "Keep Original"
    case hz44100 = "44.1kHz"
    case hz48000 = "48kHz"
    case hz96000 = "96kHz"

    var id: String { rawValue }
    var value: Int? {
        switch self {
        case .keep: return nil
        case .hz44100: return 44100
        case .hz48000: return 48000
        case .hz96000: return 96000
        }
    }
}

struct AudioTrack: Identifiable, Equatable {
    let id = UUID()
    let url: URL
    var duration: String
    var durationSeconds: Double
    var format: String
    var sampleRate: Int
    var bitrate: String
    var isFavorite: Bool = false
    var status: TrackStatus = .ready
    var outputURL: URL?

    var fileName: String { url.lastPathComponent }
    var sampleRateText: String {
        sampleRate % 1000 == 0 ? "\(sampleRate / 1000) kHz" : String(format: "%.1f kHz", Double(sampleRate) / 1000)
    }
}

struct FFProbeOutput: Decodable {
    let streams: [FFProbeStream]
    let format: FFProbeFormat?
}

struct FFProbeStream: Decodable {
    let codec_type: String?
    let sample_rate: String?
    let bit_rate: String?
}

struct FFProbeFormat: Decodable {
    let duration: String?
    let bit_rate: String?
}

struct ProcessRunner {
    static func run(_ executable: String, _ arguments: [String]) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments

            let stdout = Pipe()
            let stderr = Pipe()
            process.standardOutput = stdout
            process.standardError = stderr

            process.terminationHandler = { process in
                let output = stdout.fileHandleForReading.readDataToEndOfFile()
                let errorData = stderr.fileHandleForReading.readDataToEndOfFile()

                if process.terminationStatus == 0 {
                    continuation.resume(returning: output)
                } else {
                    let message = String(data: errorData, encoding: .utf8) ?? "Process failed"
                    continuation.resume(throwing: NSError(domain: "ZenTune", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: message]))
                }
            }

            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }
}

@MainActor
final class ZenTuneViewModel: ObservableObject {
    @Published var tracks: [AudioTrack] = []
    @Published var selectedTrackID: AudioTrack.ID?
    @Published var libraryFilter = "All Files"
    @Published var outputFormat: OutputFormat = .wav
    @Published var bitrate: Bitrate = .kbps320
    @Published var sampleRateChoice: SampleRateChoice = .keep
    @Published var preserveMetadata = true
    @Published var normalizeLUFS = false
    @Published var outputFolder: URL?
    @Published var progress: Double = 0
    @Published var progressText = "Ready to import real audio files"
    @Published var isConverting = false
    @Published var previewMode = "Converted (432Hz)"
    @Published var alertMessage: String?

    private var player: AVPlayer?

    var selectedTrack: AudioTrack? {
        guard let selectedTrackID else { return tracks.first }
        return tracks.first(where: { $0.id == selectedTrackID })
    }

    var visibleTracks: [AudioTrack] {
        switch libraryFilter {
        case "Converted": return tracks.filter { $0.status == .converted }
        case "Processing": return tracks.filter { $0.status == .converting }
        case "Favorites": return tracks.filter { $0.isFavorite }
        default: return tracks
        }
    }

    func importFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = []
        panel.allowedFileTypes = Array(supportedExtensions)
        if panel.runModal() == .OK {
            Task { await importURLs(panel.urls) }
        }
    }

    func importFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        if panel.runModal() == .OK, let folder = panel.url {
            let urls = scanFolder(folder)
            alertMessage = "\(urls.count) audio files found\nReady to import"
            Task { await importURLs(urls) }
        }
    }

    func chooseOutputFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        if panel.runModal() == .OK {
            outputFolder = panel.url
            progressText = "Output folder selected"
        }
    }

    func revealOutputFolder() {
        if let outputFolder {
            NSWorkspace.shared.open(outputFolder)
            return
        }
        if let selectedTrack {
            NSWorkspace.shared.open(defaultOutputFolder(for: selectedTrack))
        }
    }

    func convertAll() {
        Task { await convert(tracks) }
    }

    func convertSelected() {
        guard let selectedTrack else {
            alertMessage = "Select an audio file first."
            return
        }
        Task { await convert([selectedTrack]) }
    }

    func playOriginal() {
        guard let selectedTrack else {
            alertMessage = "Select an audio file first."
            return
        }
        previewMode = "Original (440Hz)"
        player = AVPlayer(url: selectedTrack.url)
        player?.play()
        progressText = "Playing original: \(selectedTrack.fileName)"
    }

    func playConvertedPreview() {
        guard let selectedTrack else {
            alertMessage = "Select an audio file first."
            return
        }
        previewMode = "Converted (432Hz)"
        Task {
            do {
                progressText = "Preparing 432Hz preview..."
                let previewURL = try await convertedPreviewURL(for: selectedTrack)
                player = AVPlayer(url: previewURL)
                player?.play()
                progressText = "Playing 432Hz preview: \(selectedTrack.fileName)"
            } catch {
                alertMessage = "Preview failed.\n\(error.localizedDescription)"
            }
        }
    }

    func stopPlayback() {
        player?.pause()
        player = nil
        progressText = "Playback stopped"
    }

    private func scanFolder(_ folder: URL) -> [URL] {
        let keys: [URLResourceKey] = [.isRegularFileKey]
        guard let enumerator = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: keys) else { return [] }
        return enumerator.compactMap { item in
            guard let url = item as? URL else { return nil }
            return supportedExtensions.contains(url.pathExtension.lowercased()) ? url : nil
        }
    }

    private func importURLs(_ urls: [URL]) async {
        progressText = "Scanning metadata..."
        let existing = Set(tracks.map(\.url))
        var imported: [AudioTrack] = []

        for url in urls where !existing.contains(url) {
            do {
                imported.append(try await probe(url))
            } catch {
                imported.append(AudioTrack(url: url, duration: "--", durationSeconds: 0, format: url.pathExtension.uppercased(), sampleRate: 44100, bitrate: "--", status: .failed))
            }
        }

        tracks.append(contentsOf: imported)
        if selectedTrackID == nil {
            selectedTrackID = tracks.first?.id
        }
        progressText = "Imported \(imported.count) real audio file(s)"
    }

    private func probe(_ url: URL) async throws -> AudioTrack {
        let data = try await ProcessRunner.run(ffprobePath, [
            "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            url.path
        ])
        let decoded = try JSONDecoder().decode(FFProbeOutput.self, from: data)
        let audio = decoded.streams.first { $0.codec_type == "audio" }
        let seconds = Double(decoded.format?.duration ?? "0") ?? 0
        let rate = Int(audio?.sample_rate ?? "44100") ?? 44100
        let bitRateRaw = Int(audio?.bit_rate ?? decoded.format?.bit_rate ?? "0") ?? 0
        let bitrateText = bitRateRaw > 0 ? "\(Int(round(Double(bitRateRaw) / 1000))) kbps" : "--"

        return AudioTrack(
            url: url,
            duration: formatDuration(seconds),
            durationSeconds: seconds,
            format: url.pathExtension.uppercased(),
            sampleRate: rate,
            bitrate: bitrateText
        )
    }

    private func convert(_ targetTracks: [AudioTrack]) async {
        guard !targetTracks.isEmpty else {
            alertMessage = "No files to convert."
            return
        }
        isConverting = true
        progress = 0
        var success = 0

        for (index, track) in targetTracks.enumerated() {
            setStatus(track, .converting)
            progressText = "Converting \(track.fileName)"

            do {
                let outputURL = try await convertTrack(track)
                setConverted(track, outputURL)
                success += 1
            } catch {
                setStatus(track, .failed)
                alertMessage = "Conversion failed.\n\(error.localizedDescription)"
            }

            progress = Double(index + 1) / Double(targetTracks.count)
        }

        isConverting = false
        progressText = "\(success) files converted successfully"
        alertMessage = "\(success) files converted successfully"
    }

    private func convertTrack(_ track: AudioTrack) async throws -> URL {
        let folder = outputFolder ?? defaultOutputFolder(for: track)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

        let outputURL = folder.appendingPathComponent("\(track.url.deletingPathExtension().lastPathComponent)_432Hz.\(outputFormat.fileExtension)")
        let outputRate = sampleRateChoice.value ?? track.sampleRate
        let shiftedRate = Int(round(Double(track.sampleRate) * 432.0 / 440.0))

        var args = [
            "-y",
            "-i", track.url.path,
            "-map_metadata", preserveMetadata ? "0" : "-1",
            "-filter:a", "asetrate=\(shiftedRate),aresample=\(outputRate)",
            "-vn"
        ]

        switch outputFormat {
        case .wav:
            args += ["-codec:a", "pcm_s16le"]
        case .mp3:
            args += ["-codec:a", "libmp3lame"]
            if let bitrateValue = bitrate.ffmpegValue { args += ["-b:a", bitrateValue] }
        case .flac:
            args += ["-codec:a", "flac"]
        case .aac:
            args += ["-codec:a", "aac"]
            if let bitrateValue = bitrate.ffmpegValue { args += ["-b:a", bitrateValue] }
        case .aiff:
            args += ["-codec:a", "pcm_s16be"]
        }

        if normalizeLUFS {
            args += ["-af", "loudnorm=I=-14:TP=-1.5:LRA=11"]
        }

        args.append(outputURL.path)
        _ = try await ProcessRunner.run(ffmpegPath, args)
        return outputURL
    }

    private func convertedPreviewURL(for track: AudioTrack) async throws -> URL {
        let temp = FileManager.default.temporaryDirectory.appendingPathComponent("ZenTunePreview", isDirectory: true)
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        let outputURL = temp.appendingPathComponent("\(track.url.deletingPathExtension().lastPathComponent)_432Hz_preview.wav")
        let shiftedRate = Int(round(Double(track.sampleRate) * 432.0 / 440.0))

        _ = try await ProcessRunner.run(ffmpegPath, [
            "-y",
            "-i", track.url.path,
            "-filter:a", "asetrate=\(shiftedRate),aresample=\(track.sampleRate)",
            "-vn",
            "-codec:a", "pcm_s16le",
            outputURL.path
        ])

        return outputURL
    }

    private func defaultOutputFolder(for track: AudioTrack) -> URL {
        track.url.deletingLastPathComponent().appendingPathComponent("Converted_432Hz", isDirectory: true)
    }

    private func setStatus(_ track: AudioTrack, _ status: TrackStatus) {
        guard let index = tracks.firstIndex(where: { $0.id == track.id }) else { return }
        tracks[index].status = status
    }

    private func setConverted(_ track: AudioTrack, _ outputURL: URL) {
        guard let index = tracks.firstIndex(where: { $0.id == track.id }) else { return }
        tracks[index].status = .converted
        tracks[index].outputURL = outputURL
    }

    private func formatDuration(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let seconds = total % 60
        return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, seconds) : String(format: "%02d:%02d", minutes, seconds)
    }
}

@main
struct ZenTuneNativeApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .frame(minWidth: 1280, minHeight: 840)
        }
        .windowStyle(.hiddenTitleBar)
    }
}

struct ContentView: View {
    @StateObject private var model = ZenTuneViewModel()

    var body: some View {
        HStack(spacing: 0) {
            Sidebar(model: model)
                .frame(width: 236)

            VStack(spacing: 8) {
                TopToolbar(model: model)
                    .frame(height: 42)

                GeometryReader { geometry in
                    VStack(spacing: 8) {
                        HStack(spacing: 8) {
                            FileTable(model: model)
                                .frame(width: geometry.size.width * 0.60)
                            AudioPreviewPanel(model: model)
                        }
                        .frame(height: 360)

                        HStack(spacing: 8) {
                            AnalyzerPanel(model: model)
                                .frame(width: geometry.size.width * 0.55)
                            SpectrumPanel()
                        }
                        .frame(height: 300)

                        HStack(spacing: 8) {
                            BatchPanel(model: model)
                                .frame(width: geometry.size.width * 0.55)
                            OutputSettingsPanel(model: model)
                        }
                        .frame(height: 190)

                        HStack(spacing: 8) {
                            BenefitsPanel()
                            ConversionInfoPanel(model: model)
                                .frame(width: geometry.size.width * 0.42)
                        }
                        .frame(height: 86)
                    }
                }
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 8)
        }
        .background(AppColors.background)
        .foregroundStyle(AppColors.text)
        .alert("ZenTune", isPresented: Binding(get: { model.alertMessage != nil }, set: { if !$0 { model.alertMessage = nil } })) {
            Button("OK") { model.alertMessage = nil }
        } message: {
            Text(model.alertMessage ?? "")
        }
    }
}

enum AppColors {
    static let background = LinearGradient(colors: [Color(hex: 0x08090d), Color(hex: 0x111018)], startPoint: .topLeading, endPoint: .bottomTrailing)
    static let panel = Color.white.opacity(0.055)
    static let panelStrong = Color.white.opacity(0.085)
    static let stroke = Color.white.opacity(0.10)
    static let text = Color(hex: 0xf8f2fb)
    static let muted = Color(hex: 0xa7a7b3)
    static let pink = Color(hex: 0xdb5cad)
    static let purple = Color(hex: 0x7c34c6)
    static let blue = Color(hex: 0x5572ff)
    static let green = Color(hex: 0x8ee676)
}

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255
        )
    }
}

struct Card<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(18)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(AppColors.panel)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(AppColors.stroke))
            )
    }
}

struct Sidebar: View {
    @ObservedObject var model: ZenTuneViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 14) {
                SakuraLogo()
                    .frame(width: 60, height: 60)
                VStack(alignment: .leading, spacing: 2) {
                    Text("ZenTune").font(.title2.bold())
                    Text("432Hz Converter").font(.caption.bold())
                    Text("v1.0.0").font(.caption2).foregroundStyle(AppColors.muted)
                }
            }
            .padding(.top, 46)
            .onTapGesture { model.alertMessage = "ZenTune 432Hz Converter\nNative SwiftUI prototype" }

            Button("+  Add Files") { model.importFiles() }
                .buttonStyle(GradientButtonStyle())
            Button("▱  Add Folder") { model.importFolder() }
                .buttonStyle(SoftButtonStyle())

            NavSection(title: "Library", items: [("All Files", model.tracks.count), ("Converted", model.tracks.filter { $0.status == .converted }.count), ("Processing", model.tracks.filter { $0.status == .converting }.count), ("Favorites", model.tracks.filter { $0.isFavorite }.count)], selected: $model.libraryFilter)

            NavSection(title: "Tools", items: [("Batch Convert", nil), ("Frequency Analyzer", nil), ("A/B Compare", nil), ("Tag Editor", nil)], selected: $model.libraryFilter)

            NavSection(title: "Settings", items: [("Conversion Settings", nil), ("Output Settings", nil), ("Metadata", nil), ("Advanced", nil)], selected: $model.libraryFilter)

            Spacer()
            MiniPlayer(model: model)
        }
        .padding(.horizontal, 10)
        .background(Color.black.opacity(0.30).overlay(AppColors.stroke, in: Rectangle()))
    }
}

struct NavSection: View {
    let title: String
    let items: [(String, Int?)]
    @Binding var selected: String

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title.uppercased())
                .font(.caption2)
                .foregroundStyle(AppColors.muted)
                .padding(.horizontal, 8)
            ForEach(items, id: \.0) { item in
                Button {
                    selected = item.0
                } label: {
                    HStack {
                        Text(symbol(for: item.0))
                        Text(item.0)
                        Spacer()
                        if let count = item.1 { Text("\(count)").font(.caption.bold()) }
                    }
                    .padding(.horizontal, 12)
                    .frame(height: 34)
                    .background(selected == item.0 ? Color.white.opacity(0.10) : Color.clear)
                    .clipShape(RoundedRectangle(cornerRadius: 7))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func symbol(for item: String) -> String {
        switch item {
        case "Converted": return "◉"
        case "Processing": return "✺"
        case "Favorites": return "☆"
        case "Frequency Analyzer": return "♬"
        case "A/B Compare": return "⌘"
        case "Advanced": return "☼"
        default: return "▣"
        }
    }
}

struct TopToolbar: View {
    @ObservedObject var model: ZenTuneViewModel

    var body: some View {
        HStack {
            Spacer()
            Text("ZenTune 432Hz Converter").font(.headline)
            Spacer()
            Button("⚙ Settings") { model.alertMessage = "Settings panel is included in the lower Output Settings card." }
            Button("ⓘ About") { model.alertMessage = "ZenTune\nOne-click 432Hz converter for ambient creators." }
        }
        .buttonStyle(SoftButtonStyle(compact: true))
    }
}

struct FileTable: View {
    @ObservedObject var model: ZenTuneViewModel

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("\(model.libraryFilter) (\(model.visibleTracks.count))").font(.headline)
                    Spacer()
                    Button("Import") { model.importFiles() }
                    Button("⟳") { model.progressText = "Metadata refresh queued" }
                    Button("▦") { model.convertSelected() }
                }
                .buttonStyle(SoftButtonStyle(compact: true))

                Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 0) {
                    GridRow {
                        Header("#"); Header("File Name"); Header("Duration"); Header("Format"); Header("Sample Rate"); Header("Bitrate"); Header("Status")
                    }
                    Divider().gridCellColumns(7).padding(.vertical, 4)
                    ForEach(Array(model.visibleTracks.enumerated()), id: \.element.id) { index, track in
                        TrackRow(index: index + 1, track: track, isSelected: model.selectedTrackID == track.id)
                            .onTapGesture { model.selectedTrackID = track.id }
                            .onTapGesture(count: 2) { model.selectedTrackID = track.id; model.playOriginal() }
                            .contextMenu {
                                Button("Play") { model.selectedTrackID = track.id; model.playOriginal() }
                                Button("Reveal in Finder") { NSWorkspace.shared.activateFileViewerSelecting([track.url]) }
                                Button("Convert to 432Hz") { model.selectedTrackID = track.id; model.convertSelected() }
                                Button("Add to Favorites") { }
                                Button("Delete") { }
                            }
                    }
                }

                if model.tracks.isEmpty {
                    Spacer()
                    Text("No real audio files loaded\nClick Add Files or Add Folder to begin.")
                        .multilineTextAlignment(.center)
                        .foregroundStyle(AppColors.muted)
                        .frame(maxWidth: .infinity)
                    Spacer()
                }
            }
        }
    }
}

struct Header: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View { Text(text).font(.caption.bold()).foregroundStyle(AppColors.muted) }
}

struct TrackRow: View {
    let index: Int
    let track: AudioTrack
    let isSelected: Bool

    var body: some View {
        GridRow {
            Text("\(index)").foregroundStyle(AppColors.muted)
            Text("\(track.isFavorite ? "★" : "⬡")  \(track.fileName)").font(.system(size: 13, weight: .semibold))
            Text(track.duration)
            Text(track.format)
            Text(track.sampleRateText)
            Text(track.bitrate)
            Text(track.status.rawValue).foregroundStyle(colorForStatus)
        }
        .font(.system(size: 13))
        .padding(.vertical, 9)
        .background(isSelected ? LinearGradient(colors: [AppColors.purple.opacity(0.60), AppColors.pink.opacity(0.22)], startPoint: .leading, endPoint: .trailing) : LinearGradient(colors: [.clear], startPoint: .leading, endPoint: .trailing))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private var colorForStatus: Color {
        switch track.status {
        case .converted: return AppColors.green
        case .converting: return Color.yellow
        case .failed: return Color.red
        case .ready: return AppColors.text
        }
    }
}

struct AudioPreviewPanel: View {
    @ObservedObject var model: ZenTuneViewModel

    var body: some View {
        Card {
            VStack(spacing: 18) {
                HStack(spacing: 24) {
                    ArtworkView()
                        .frame(width: 190, height: 190)
                    VStack(alignment: .leading, spacing: 12) {
                        Text(model.selectedTrack?.fileName ?? "No file selected").font(.title3.bold())
                        Text(model.selectedTrack?.duration ?? "--:--")
                        Text(model.selectedTrack.map { "\($0.sampleRateText) • \($0.format)" } ?? "Import real audio")
                        Text("Status").font(.caption).foregroundStyle(AppColors.muted)
                        Text(model.selectedTrack?.status.rawValue ?? "Idle").foregroundStyle(AppColors.green).font(.headline)
                    }
                    Spacer()
                }

                HStack(spacing: 0) {
                    Button("Original (440Hz)") { model.playOriginal() }
                    Button("Converted (432Hz)") { model.playConvertedPreview() }
                }
                .buttonStyle(SegmentButtonStyle())

                HStack {
                    Text("00:00")
                    Slider(value: .constant(0.45))
                        .tint(AppColors.pink)
                    Text(model.selectedTrack?.duration ?? "--:--")
                }
                .font(.caption)

                HStack(spacing: 36) {
                    Button("ᐊ") { }
                    Button("▶") { model.previewMode.contains("Original") ? model.playOriginal() : model.playConvertedPreview() }
                        .buttonStyle(RoundPlayStyle())
                    Button("ᐅ") { }
                    Button("↻") { model.stopPlayback() }
                }
                HStack {
                    Text("⌕")
                    Slider(value: .constant(0.65)).tint(AppColors.pink)
                    Text("100%")
                }
                .font(.caption)
            }
        }
    }
}

struct AnalyzerPanel: View {
    @ObservedObject var model: ZenTuneViewModel
    @State private var tab = "Waveform"
    let tabs = ["Waveform", "Spectrum", "Spectrogram", "Loudness", "Stats"]

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("A/B Comparison").font(.headline)
                    Spacer()
                    Picker("", selection: $tab) {
                        ForEach(tabs, id: \.self) { Text($0) }
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 470)
                }
                WaveformView()
                HStack {
                    Text("0:00"); Spacer(); Text("0:15"); Spacer(); Text("0:30"); Spacer(); Text("0:45"); Spacer(); Text("1:00"); Spacer(); Text(model.selectedTrack?.duration ?? "--:--")
                }
                .font(.caption)
                .foregroundStyle(AppColors.muted)
            }
        }
    }
}

struct SpectrumPanel: View {
    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Spectrum Analyzer ?").font(.headline)
                    Spacer()
                    VStack(alignment: .leading) {
                        Text("━ Original (440Hz)").foregroundStyle(AppColors.blue)
                        Text("━ Converted (432Hz)").foregroundStyle(AppColors.pink)
                    }
                    .font(.caption)
                }
                SpectrumView()
                HStack {
                    Text("Peak Shift: -1.818%")
                    Spacer()
                    Text("Frequency Shift: 440Hz → 432Hz")
                }
                .font(.caption)
                .foregroundStyle(AppColors.muted)
            }
        }
    }
}

struct BatchPanel: View {
    @ObservedObject var model: ZenTuneViewModel
    @State private var accurate = true

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 18) {
                Text("Batch Conversion").font(.headline)
                HStack(alignment: .top, spacing: 32) {
                    VStack(alignment: .leading) {
                        Text("Conversion Mode").font(.caption.bold())
                        Toggle("Accurate (High Quality)", isOn: $accurate)
                        Toggle("Fast (Real-time)", isOn: .constant(!accurate))
                    }
                    VStack(alignment: .leading) {
                        Text("Target Frequency").font(.caption.bold())
                        Picker("", selection: .constant("432 Hz (Recommended)")) {
                            Text("432 Hz (Recommended)")
                            Text("440 Hz")
                            Text("528 Hz")
                        }
                        .frame(width: 190)
                    }
                    VStack(alignment: .leading) {
                        Text("Processing").font(.caption.bold())
                        Text("\(Int(model.progress * Double(max(model.tracks.count, 1))))/\(model.tracks.count) files")
                        ProgressView(value: model.progress)
                            .tint(AppColors.pink)
                        Text(model.progressText).font(.caption).foregroundStyle(AppColors.muted)
                    }
                    Spacer()
                    VStack {
                        Button("⟳ Convert All") { model.convertAll() }
                            .buttonStyle(GradientButtonStyle())
                        Button("Convert Selected") { model.convertSelected() }
                            .buttonStyle(SoftButtonStyle())
                    }
                    .frame(width: 170)
                }
            }
        }
    }
}

struct OutputSettingsPanel: View {
    @ObservedObject var model: ZenTuneViewModel

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                Text("Output Settings").font(.headline)
                HStack {
                    Picker("Format", selection: $model.outputFormat) { ForEach(OutputFormat.allCases) { Text($0.rawValue).tag($0) } }
                    Picker("Bitrate", selection: $model.bitrate) { ForEach(Bitrate.allCases) { Text($0.rawValue).tag($0) } }
                    Picker("Sample Rate", selection: $model.sampleRateChoice) { ForEach(SampleRateChoice.allCases) { Text($0.rawValue).tag($0) } }
                }
                HStack {
                    Text(model.outputFolder?.path ?? "Auto: Converted_432Hz beside source")
                        .lineLimit(1)
                        .foregroundStyle(AppColors.muted)
                    Spacer()
                    Button("Choose") { model.chooseOutputFolder() }
                    Button("Open") { model.revealOutputFolder() }
                }
                HStack {
                    Toggle("Preserve folder structure", isOn: .constant(true))
                    Toggle("Keep original metadata", isOn: $model.preserveMetadata)
                    Toggle("Normalize to -14 LUFS", isOn: $model.normalizeLUFS)
                }
                .font(.caption)
            }
        }
    }
}

struct BenefitsPanel: View {
    let benefits = ["More relaxing", "Better sleep", "Reduces stress", "Deep meditation", "Emotional healing", "Inner peace"]

    var body: some View {
        Card {
            VStack(alignment: .leading) {
                Text("432Hz Benefits").foregroundStyle(AppColors.pink).font(.caption.bold())
                HStack {
                    ForEach(benefits, id: \.self) { benefit in
                        VStack {
                            Text("✧").foregroundStyle(AppColors.pink)
                            Text(benefit).font(.caption2)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(8)
                        .background(Color.white.opacity(0.035))
                        .clipShape(RoundedRectangle(cornerRadius: 7))
                    }
                }
            }
        }
    }
}

struct ConversionInfoPanel: View {
    @ObservedObject var model: ZenTuneViewModel

    var body: some View {
        Card {
            HStack {
                VStack(alignment: .leading) {
                    Text("Conversion Info").font(.caption.bold())
                    Text("Files: \(model.tracks.count)")
                    Text("Converted: \(model.tracks.filter { $0.status == .converted }.count)")
                }
                Spacer()
                VStack {
                    Text("-1.818%").font(.headline)
                    Text("Pitch Shift").font(.caption)
                }
                .frame(width: 70, height: 70)
                .background(Circle().stroke(AppColors.purple, lineWidth: 5))
            }
            .font(.caption)
        }
    }
}

struct MiniPlayer: View {
    @ObservedObject var model: ZenTuneViewModel

    var body: some View {
        VStack(spacing: 10) {
            ArtworkView()
                .frame(height: 142)
            HStack {
                WaveIcon()
                    .frame(width: 34, height: 34)
                VStack(alignment: .leading) {
                    Text(model.selectedTrack?.fileName ?? "No track").font(.caption.bold()).lineLimit(1)
                    Text("Playing • \(model.previewMode)").font(.caption2).foregroundStyle(AppColors.muted)
                }
            }
            HStack {
                Text("⌕")
                Slider(value: .constant(0.8)).tint(AppColors.pink)
                Text("→")
            }
        }
        .padding(.bottom, 12)
    }
}

struct SakuraLogo: View {
    var body: some View {
        ZStack {
            ForEach(0..<5) { index in
                Capsule()
                    .fill(LinearGradient(colors: [Color(hex: 0xffb1df), AppColors.purple], startPoint: .top, endPoint: .bottom))
                    .frame(width: 22, height: 36)
                    .rotationEffect(.degrees(Double(index) * 72))
                    .offset(y: -12)
            }
        }
        .shadow(color: AppColors.pink.opacity(0.45), radius: 12)
    }
}

struct ArtworkView: View {
    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(hex: 0x1b2035), Color(hex: 0x111018)], startPoint: .top, endPoint: .bottom)
            Circle().fill(Color(hex: 0xffd8bd)).frame(width: 82, height: 82).offset(x: 26, y: -36).shadow(color: .orange.opacity(0.35), radius: 28)
            Mountain().fill(Color(hex: 0x33364b)).frame(height: 80).offset(y: 40)
            Text("禅").font(.system(size: 42, weight: .bold)).foregroundStyle(Color.black.opacity(0.72)).offset(y: 12)
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

struct Mountain: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.width * 0.22, y: rect.height * 0.28))
        path.addLine(to: CGPoint(x: rect.width * 0.38, y: rect.height * 0.68))
        path.addLine(to: CGPoint(x: rect.width * 0.58, y: rect.height * 0.12))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

struct WaveIcon: View {
    var body: some View {
        Canvas { context, size in
            for x in stride(from: 0, through: size.width, by: 3) {
                let h = (sin(x / 4) + 1.4) * size.height / 4
                context.stroke(Path { path in
                    path.move(to: CGPoint(x: x, y: size.height / 2 - h / 2))
                    path.addLine(to: CGPoint(x: x, y: size.height / 2 + h / 2))
                }, with: .color(AppColors.pink), lineWidth: 1)
            }
        }
        .background(AppColors.purple.opacity(0.20))
        .clipShape(RoundedRectangle(cornerRadius: 7))
    }
}

struct WaveformView: View {
    var body: some View {
        Canvas { context, size in
            drawWave(context: context, size: size, mid: size.height * 0.34, color: AppColors.blue, phase: 0)
            drawWave(context: context, size: size, mid: size.height * 0.72, color: AppColors.pink, phase: 1.2)
            context.draw(Text("Original (440Hz)").foregroundColor(AppColors.blue).font(.caption), at: CGPoint(x: 64, y: 20))
            context.draw(Text("Converted (432Hz)").foregroundColor(AppColors.pink).font(.caption), at: CGPoint(x: 72, y: size.height * 0.51))
        }
        .background(Color.black.opacity(0.20))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private func drawWave(context: GraphicsContext, size: CGSize, mid: CGFloat, color: Color, phase: Double) {
        for x in stride(from: CGFloat(0), through: size.width, by: 2) {
            let envelope = 0.24 + 0.42 * abs(sin(Double(x) / 55 + phase)) + 0.28 * abs(sin(Double(x) / 21))
            let h = CGFloat(envelope) * 46
            var path = Path()
            path.move(to: CGPoint(x: x, y: mid - h))
            path.addLine(to: CGPoint(x: x, y: mid + h))
            context.stroke(path, with: .color(color.opacity(0.86)), lineWidth: 1)
        }
    }
}

struct SpectrumView: View {
    var body: some View {
        Canvas { context, size in
            let plot = CGRect(x: 34, y: 16, width: size.width - 48, height: size.height - 46)
            for i in 0...8 {
                let x = plot.minX + plot.width * CGFloat(i) / 8
                context.stroke(Path { p in p.move(to: CGPoint(x: x, y: plot.minY)); p.addLine(to: CGPoint(x: x, y: plot.maxY)) }, with: .color(.white.opacity(0.08)), lineWidth: 1)
            }
            for i in 0...5 {
                let y = plot.minY + plot.height * CGFloat(i) / 5
                context.stroke(Path { p in p.move(to: CGPoint(x: plot.minX, y: y)); p.addLine(to: CGPoint(x: plot.maxX, y: y)) }, with: .color(.white.opacity(0.08)), lineWidth: 1)
            }
            drawLine(context: context, plot: plot, color: AppColors.blue, shift: 0)
            drawLine(context: context, plot: plot, color: AppColors.pink, shift: 0.5)
        }
        .background(Color.black.opacity(0.18))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private func drawLine(context: GraphicsContext, plot: CGRect, color: Color, shift: Double) {
        var path = Path()
        for i in 0...Int(plot.width) {
            let t = Double(i) / Double(plot.width)
            let base = 0.72 - 0.42 * exp(-pow((t - 0.26) * 7, 2))
            let drop = pow(t, 2.2) * 0.38
            let ripple = sin(t * 74 + shift) * 0.032 + sin(t * 191 + shift) * 0.018
            let y = plot.minY + plot.height * CGFloat(min(0.98, max(0.06, base + drop + ripple)))
            let x = plot.minX + CGFloat(i)
            if i == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
        }
        context.stroke(path, with: .color(color), lineWidth: 1.4)
    }
}

struct GradientButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity)
            .frame(height: 42)
            .background(LinearGradient(colors: [AppColors.pink, AppColors.purple], startPoint: .leading, endPoint: .trailing).opacity(configuration.isPressed ? 0.78 : 1))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .animation(.easeOut(duration: 0.14), value: configuration.isPressed)
    }
}

struct SoftButtonStyle: ButtonStyle {
    var compact = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(compact ? .caption.bold() : .subheadline.bold())
            .padding(.horizontal, compact ? 12 : 14)
            .frame(height: compact ? 28 : 38)
            .frame(maxWidth: compact ? nil : .infinity)
            .background(Color.white.opacity(configuration.isPressed ? 0.14 : 0.08))
            .clipShape(RoundedRectangle(cornerRadius: 7))
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct SegmentButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(maxWidth: .infinity)
            .frame(height: 42)
            .background(configuration.isPressed ? AppColors.pink.opacity(0.65) : Color.white.opacity(0.08))
    }
}

struct RoundPlayStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(width: 48, height: 48)
            .background(LinearGradient(colors: [AppColors.pink, AppColors.purple], startPoint: .topLeading, endPoint: .bottomTrailing))
            .clipShape(Circle())
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
    }
}
