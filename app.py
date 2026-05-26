import math
import queue
import shutil
import subprocess
import tempfile
import threading
import tkinter as tk
from dataclasses import dataclass
from pathlib import Path
from tkinter import filedialog, messagebox
from typing import Optional

from pydub import AudioSegment


APP_NAME = "Aura432"
PITCH_RATIO = 432 / 440
SUPPORTED_EXTENSIONS = {".mp3", ".wav", ".flac", ".aac", ".m4a", ".aiff", ".aif"}

BG = "#111014"
PANEL = "#1a1720"
PANEL_2 = "#221d2b"
TEXT = "#f7efe7"
MUTED = "#b9aebd"
DIM = "#817687"
BORDER = "#342c3f"
ACCENT = "#e89bb4"
ACCENT_2 = "#d8a84f"
ACCENT_DARK = "#b86c87"
GREEN = "#83d6a0"
RED = "#f07878"


@dataclass
class AudioItem:
    path: Path
    duration_ms: int = 0
    sample_rate: int = 0
    channels: int = 0
    status: str = "Ready"
    output_path: Optional[Path] = None

    @property
    def duration_text(self):
        seconds = max(0, int(self.duration_ms / 1000))
        hours, remainder = divmod(seconds, 3600)
        minutes, seconds = divmod(remainder, 60)
        if hours:
            return f"{hours}:{minutes:02d}:{seconds:02d}"
        return f"{minutes}:{seconds:02d}"

    @property
    def format_text(self):
        return self.path.suffix.replace(".", "").upper()

    @property
    def sample_rate_text(self):
        if not self.sample_rate:
            return "-"
        if self.sample_rate % 1000 == 0:
            return f"{self.sample_rate // 1000}kHz"
        return f"{self.sample_rate}Hz"


class Aura432App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(f"{APP_NAME} - One-click 432Hz converter")
        self.geometry("1060x680")
        self.minsize(960, 620)
        self.configure(bg=BG)

        self.items: list[AudioItem] = []
        self.preview_process: Optional[subprocess.Popen] = None
        self.preview_temp_dir = Path(tempfile.gettempdir()) / "aura432_preview"
        self.preview_temp_dir.mkdir(exist_ok=True)

        self.output_var = tk.StringVar(value="Converted_432Hz")
        self.format_var = tk.StringVar(value="WAV")
        self.quality_var = tk.StringVar(value="Lossless")
        self.status_var = tk.StringVar(value="Drop folder workflow: add files or scan a folder to begin.")
        self.progress_var = tk.DoubleVar(value=0)
        self.message_queue = queue.Queue()
        self.worker = None

        self._build_ui()
        self.after(250, self._bring_to_front)
        self.after(120, self._drain_messages)

    def _build_ui(self):
        shell = tk.Frame(self, bg=BG, padx=22, pady=20)
        shell.pack(fill=tk.BOTH, expand=True)

        header = tk.Frame(shell, bg=BG)
        header.pack(fill=tk.X)

        brand = tk.Frame(header, bg=BG)
        brand.pack(side=tk.LEFT, fill=tk.X, expand=True)

        tk.Label(
            brand,
            text=APP_NAME,
            font=("Helvetica Neue", 30, "bold"),
            bg=BG,
            fg=TEXT,
        ).pack(anchor=tk.W)
        tk.Label(
            brand,
            text="One-click 432Hz converter for ambient creators",
            font=("Helvetica Neue", 14),
            bg=BG,
            fg=MUTED,
        ).pack(anchor=tk.W, pady=(2, 0))

        top_actions = tk.Frame(header, bg=BG)
        top_actions.pack(side=tk.RIGHT)
        self._button(top_actions, "Add Files", self.add_files).pack(side=tk.LEFT, padx=(0, 8))
        self._button(top_actions, "Scan Folder", self.scan_folder).pack(side=tk.LEFT, padx=(0, 8))
        self.convert_all_button = self._button(top_actions, "Convert All", self.convert_all, primary=True)
        self.convert_all_button.pack(side=tk.LEFT)

        body = tk.Frame(shell, bg=BG)
        body.pack(fill=tk.BOTH, expand=True, pady=(18, 0))

        left = tk.Frame(body, bg=BG)
        left.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        right = tk.Frame(body, bg=BG, width=330)
        right.pack(side=tk.RIGHT, fill=tk.Y, padx=(16, 0))
        right.pack_propagate(False)

        self._build_table(left)
        self._build_console(left)
        self._build_side_panel(right)

    def _build_table(self, parent):
        table_shell = tk.Frame(parent, bg=PANEL, highlightthickness=1, highlightbackground=BORDER)
        table_shell.pack(fill=tk.BOTH, expand=True)

        header = tk.Frame(table_shell, bg=PANEL_2)
        header.pack(fill=tk.X)

        columns = [
            ("File", 34),
            ("Fmt", 6),
            ("Duration", 10),
            ("Rate", 9),
            ("Status", 16),
        ]
        for title, width in columns:
            tk.Label(
                header,
                text=title,
                width=width,
                anchor=tk.W,
                font=("Menlo", 12, "bold"),
                bg=PANEL_2,
                fg=ACCENT_2,
                padx=8,
                pady=8,
            ).pack(side=tk.LEFT)

        list_frame = tk.Frame(table_shell, bg=PANEL)
        list_frame.pack(fill=tk.BOTH, expand=True)

        self.file_list = tk.Listbox(
            list_frame,
            selectmode=tk.EXTENDED,
            bg=PANEL,
            fg=TEXT,
            selectbackground="#493549",
            selectforeground=TEXT,
            activestyle="none",
            highlightthickness=0,
            bd=0,
            font=("Menlo", 12),
            height=15,
        )
        self.file_list.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.file_list.bind("<<ListboxSelect>>", lambda _event: self._on_selection_changed())

        scrollbar = tk.Scrollbar(list_frame, orient=tk.VERTICAL, command=self.file_list.yview)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.file_list.configure(yscrollcommand=scrollbar.set)

        footer = tk.Frame(parent, bg=BG)
        footer.pack(fill=tk.X, pady=(10, 0))
        self.convert_selected_button = self._button(footer, "Convert Selected", self.convert_selected, primary=True)
        self.convert_selected_button.pack(side=tk.LEFT)
        self._button(footer, "Clear", self.clear_items).pack(side=tk.LEFT, padx=(8, 0))

        self.progress_canvas = tk.Canvas(
            footer,
            height=14,
            bg="#2b2632",
            highlightthickness=1,
            highlightbackground=BORDER,
        )
        self.progress_canvas.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(12, 0))
        self.progress_canvas.bind("<Configure>", lambda _event: self._draw_progress())

    def _build_console(self, parent):
        console_shell = tk.Frame(parent, bg=PANEL, highlightthickness=1, highlightbackground=BORDER)
        console_shell.pack(fill=tk.X, pady=(12, 0))

        self.status_label = tk.Label(
            console_shell,
            textvariable=self.status_var,
            font=("Helvetica Neue", 12),
            bg=PANEL,
            fg=MUTED,
            anchor=tk.W,
            padx=10,
            pady=8,
        )
        self.status_label.pack(fill=tk.X)

        self.log = tk.Text(
            console_shell,
            height=5,
            wrap=tk.WORD,
            state=tk.DISABLED,
            bg="#15121a",
            fg=MUTED,
            insertbackground=TEXT,
            relief=tk.FLAT,
            bd=0,
            padx=10,
            pady=8,
            font=("Menlo", 11),
        )
        self.log.pack(fill=tk.X)

    def _build_side_panel(self, parent):
        self._panel_title(parent, "Preview A/B")

        preview = tk.Frame(parent, bg=PANEL, highlightthickness=1, highlightbackground=BORDER, padx=12, pady=12)
        preview.pack(fill=tk.X)

        self.selected_label = tk.Label(
            preview,
            text="No track selected",
            bg=PANEL,
            fg=TEXT,
            anchor=tk.W,
            justify=tk.LEFT,
            wraplength=280,
            font=("Helvetica Neue", 13, "bold"),
        )
        self.selected_label.pack(fill=tk.X)

        preview_buttons = tk.Frame(preview, bg=PANEL)
        preview_buttons.pack(fill=tk.X, pady=(12, 0))
        self._button(preview_buttons, "Original", lambda: self.preview("original")).pack(side=tk.LEFT, fill=tk.X, expand=True)
        self._button(preview_buttons, "432Hz", lambda: self.preview("converted"), primary=True).pack(
            side=tk.LEFT,
            fill=tk.X,
            expand=True,
            padx=(8, 0),
        )
        self._button(preview, "Stop Preview", self.stop_preview).pack(fill=tk.X, pady=(8, 0))

        self._panel_title(parent, "Waveform")
        wave_panel = tk.Frame(parent, bg=PANEL, highlightthickness=1, highlightbackground=BORDER, padx=10, pady=10)
        wave_panel.pack(fill=tk.X)
        self.waveform = tk.Canvas(wave_panel, height=150, bg="#15121a", highlightthickness=0)
        self.waveform.pack(fill=tk.X)
        self._draw_empty_waveform()

        self._panel_title(parent, "Output")
        output = tk.Frame(parent, bg=PANEL, highlightthickness=1, highlightbackground=BORDER, padx=12, pady=12)
        output.pack(fill=tk.X)

        self._field(output, "Folder", self.output_var)
        self._option_row(output, "Format", self.format_var, ["WAV", "MP3"])
        self._option_row(output, "Quality", self.quality_var, ["Lossless", "320kbps"])

        preset = tk.Frame(parent, bg=PANEL_2, highlightthickness=1, highlightbackground=BORDER, padx=12, pady=12)
        preset.pack(fill=tk.X, pady=(12, 0))
        tk.Label(
            preset,
            text="YouTube Zen Upload",
            bg=PANEL_2,
            fg=ACCENT_2,
            font=("Helvetica Neue", 14, "bold"),
            anchor=tk.W,
        ).pack(fill=tk.X)
        tk.Label(
            preset,
            text="432Hz tuned, creator batch workflow, ready for 48kHz export presets.",
            bg=PANEL_2,
            fg=MUTED,
            font=("Helvetica Neue", 12),
            justify=tk.LEFT,
            wraplength=280,
        ).pack(fill=tk.X, pady=(4, 0))

    def _panel_title(self, parent, text):
        tk.Label(
            parent,
            text=text,
            bg=BG,
            fg=ACCENT,
            font=("Helvetica Neue", 13, "bold"),
            anchor=tk.W,
        ).pack(fill=tk.X, pady=(0, 6) if not parent.winfo_children() else (16, 6))

    def _field(self, parent, label, variable):
        tk.Label(parent, text=label, bg=PANEL, fg=MUTED, font=("Helvetica Neue", 12), anchor=tk.W).pack(fill=tk.X)
        tk.Entry(
            parent,
            textvariable=variable,
            bg="#15121a",
            fg=TEXT,
            insertbackground=TEXT,
            relief=tk.FLAT,
            font=("Helvetica Neue", 13),
        ).pack(fill=tk.X, pady=(4, 10), ipady=7)

    def _option_row(self, parent, label, variable, options):
        row = tk.Frame(parent, bg=PANEL)
        row.pack(fill=tk.X, pady=(0, 10))
        tk.Label(row, text=label, bg=PANEL, fg=MUTED, font=("Helvetica Neue", 12), width=7, anchor=tk.W).pack(side=tk.LEFT)
        for option in options:
            tk.Radiobutton(
                row,
                text=option,
                value=option,
                variable=variable,
                bg=PANEL,
                fg=TEXT,
                selectcolor="#15121a",
                activebackground=PANEL,
                activeforeground=TEXT,
                font=("Helvetica Neue", 12),
            ).pack(side=tk.LEFT, padx=(0, 8))

    def _button(self, parent, text, command, primary=False):
        bg = ACCENT if primary else PANEL_2
        fg = "#1a1016" if primary else TEXT
        active_bg = ACCENT_DARK if primary else "#30283a"
        return tk.Button(
            parent,
            text=text,
            command=command,
            bg=bg,
            fg=fg,
            activebackground=active_bg,
            activeforeground=fg,
            relief=tk.FLAT,
            bd=0,
            padx=15,
            pady=8,
            font=("Helvetica Neue", 12, "bold"),
            cursor="pointinghand",
        )

    def add_files(self):
        paths = filedialog.askopenfilenames(
            title="Add audio files",
            filetypes=[
                ("Audio files", "*.mp3 *.wav *.flac *.aac *.m4a *.aiff *.aif"),
                ("All files", "*.*"),
            ],
        )
        self._add_paths([Path(path) for path in paths])

    def scan_folder(self):
        folder = filedialog.askdirectory(title="Scan audio folder")
        if not folder:
            return

        folder_path = Path(folder)
        paths = [path for path in folder_path.rglob("*") if path.suffix.lower() in SUPPORTED_EXTENSIONS]
        self._add_paths(paths)

    def _add_paths(self, paths):
        existing = {item.path for item in self.items}
        new_paths = sorted({path for path in paths if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS})
        new_paths = [path for path in new_paths if path not in existing]

        if not new_paths:
            self.status_var.set("No new supported audio files found.")
            return

        self.status_var.set(f"Analyzing {len(new_paths)} file(s)...")
        self._log(f"Importing {len(new_paths)} file(s).")
        self._set_busy(True)
        threading.Thread(target=self._analyze_files, args=(new_paths,), daemon=True).start()

    def _analyze_files(self, paths):
        analyzed = []
        for path in paths:
            item = AudioItem(path=path)
            try:
                audio = AudioSegment.from_file(path)
                item.duration_ms = len(audio)
                item.sample_rate = audio.frame_rate
                item.channels = audio.channels
            except Exception as exc:
                item.status = f"Analyze error: {exc}"
            analyzed.append(item)
        self.message_queue.put(("analyzed", analyzed))

    def _refresh_file_list(self):
        selected_paths = {self.items[index].path for index in self.file_list.curselection()} if self.items else set()
        self.file_list.delete(0, tk.END)
        for item in self.items:
            line = (
                f"{self._clip(item.path.name, 34):<34}"
                f"{item.format_text:<6}"
                f"{item.duration_text:<10}"
                f"{item.sample_rate_text:<9}"
                f"{self._clip(item.status, 16):<16}"
            )
            self.file_list.insert(tk.END, line)
            color = TEXT
            if item.status == "Done":
                color = GREEN
            elif "error" in item.status.lower() or item.status == "Failed":
                color = RED
            self.file_list.itemconfig(tk.END, fg=color)

        for index, item in enumerate(self.items):
            if item.path in selected_paths:
                self.file_list.selection_set(index)

    def _clip(self, text, width):
        if len(text) <= width:
            return text
        return text[: width - 1] + "…"

    def _selected_items(self):
        indexes = list(self.file_list.curselection())
        if indexes:
            return [self.items[index] for index in indexes]
        return self.items[:1]

    def _on_selection_changed(self):
        items = self._selected_items()
        if not items:
            self.selected_label.configure(text="No track selected")
            self._draw_empty_waveform()
            return

        item = items[0]
        self.selected_label.configure(text=f"{item.path.name}\n{item.duration_text} • {item.sample_rate_text}")
        self._draw_waveform_for(item)

    def convert_selected(self):
        self._start_convert(self._selected_items())

    def convert_all(self):
        self._start_convert(self.items[:])

    def _start_convert(self, items):
        if self.worker and self.worker.is_alive():
            return

        if not items:
            messagebox.showinfo(APP_NAME, "Add audio files before converting.")
            return

        if shutil.which("ffmpeg") is None:
            messagebox.showerror("Missing ffmpeg", "pydub needs ffmpeg. Install it with: brew install ffmpeg")
            return

        output_root = self._output_root_for(items)
        output_root.mkdir(parents=True, exist_ok=True)
        self.progress_var.set(0)
        self._draw_progress()
        self._set_busy(True)
        self._log(f"Converting {len(items)} file(s) to 432Hz.")
        self.worker = threading.Thread(target=self._convert_files, args=(items, output_root), daemon=True)
        self.worker.start()

    def _output_root_for(self, items):
        common_parent = items[0].path.parent
        return common_parent / (self.output_var.get().strip() or "Converted_432Hz")

    def _convert_files(self, items, output_root):
        converted = 0
        failed = 0
        output_format = self.format_var.get().lower()

        for index, item in enumerate(items, start=1):
            item.status = "Converting"
            self.message_queue.put(("refresh",))
            suffix = "mp3" if output_format == "mp3" else "wav"
            output_path = output_root / f"{item.path.stem}_432Hz.{suffix}"

            try:
                self.message_queue.put(("log", f"[{index}/{len(items)}] {item.path.name}"))
                self._export_432hz(item.path, output_path, output_format)
                item.output_path = output_path
                item.status = "Done"
                converted += 1
                self.message_queue.put(("log", f"  OK: {output_path.name}"))
            except Exception as exc:
                item.status = "Failed"
                failed += 1
                self.message_queue.put(("log", f"  Error: {exc}"))

            self.message_queue.put(("progress", index / len(items) * 100))
            self.message_queue.put(("refresh",))

        self.message_queue.put(("done", converted, failed, str(output_root)))

    def _export_432hz(self, input_path, output_path, output_format):
        audio = AudioSegment.from_file(input_path)
        shifted = self._retune(audio)
        if output_format == "mp3":
            bitrate = "320k" if self.quality_var.get() == "320kbps" else None
            shifted.export(output_path, format="mp3", bitrate=bitrate)
        else:
            shifted.export(output_path, format="wav")

    def _retune(self, audio):
        new_sample_rate = int(audio.frame_rate * PITCH_RATIO)
        return audio._spawn(audio.raw_data, overrides={"frame_rate": new_sample_rate}).set_frame_rate(audio.frame_rate)

    def preview(self, mode):
        items = self._selected_items()
        if not items:
            messagebox.showinfo(APP_NAME, "Select a track to preview.")
            return

        self.stop_preview()
        item = items[0]

        if mode == "original":
            preview_path = item.path
        else:
            preview_path = self.preview_temp_dir / f"{item.path.stem}_preview_432Hz.wav"
            try:
                self._export_432hz(item.path, preview_path, "wav")
            except Exception as exc:
                messagebox.showerror("Preview failed", str(exc))
                return

        player = shutil.which("afplay")
        if not player:
            messagebox.showerror("Preview unavailable", "macOS afplay command was not found.")
            return

        self.preview_process = subprocess.Popen([player, str(preview_path)])
        self.status_var.set(f"Previewing {mode}: {item.path.name}")

    def stop_preview(self):
        if self.preview_process and self.preview_process.poll() is None:
            self.preview_process.terminate()
        self.preview_process = None

    def clear_items(self):
        self.stop_preview()
        self.items.clear()
        self._refresh_file_list()
        self.selected_label.configure(text="No track selected")
        self.status_var.set("Cleared. Add files or scan a folder to begin.")
        self._draw_empty_waveform()
        self.progress_var.set(0)
        self._draw_progress()
        self._clear_log()

    def _draw_empty_waveform(self):
        self.waveform.delete("all")
        self.waveform.create_text(
            150,
            74,
            text="Waveform preview",
            fill=DIM,
            font=("Helvetica Neue", 13, "bold"),
        )

    def _draw_waveform_for(self, item):
        self.waveform.delete("all")
        try:
            audio = AudioSegment.from_file(item.path)
            audio = audio.set_channels(1)
            samples = audio.get_array_of_samples()
            if not samples:
                self._draw_empty_waveform()
                return

            width = max(280, self.waveform.winfo_width())
            height = max(120, self.waveform.winfo_height())
            mid_top = height * 0.30
            mid_bottom = height * 0.72
            peak = max(1, max(abs(sample) for sample in samples))
            step = max(1, int(len(samples) / width))

            self.waveform.create_text(10, 12, text="Original", fill=MUTED, anchor=tk.W, font=("Helvetica Neue", 11))
            self.waveform.create_text(10, height / 2 + 8, text="432Hz", fill=ACCENT, anchor=tk.W, font=("Helvetica Neue", 11))

            for x in range(width):
                start = x * step
                chunk = samples[start : start + step]
                if not chunk:
                    break
                rms = math.sqrt(sum(sample * sample for sample in chunk) / len(chunk)) / peak
                y1 = mid_top - rms * 38
                y2 = mid_top + rms * 38
                self.waveform.create_line(x, y1, x, y2, fill=MUTED)

                shifted_rms = min(1.0, rms * 0.94)
                y3 = mid_bottom - shifted_rms * 38
                y4 = mid_bottom + shifted_rms * 38
                self.waveform.create_line(x, y3, x, y4, fill=ACCENT)
        except Exception:
            self._draw_empty_waveform()

    def _set_busy(self, busy):
        state = tk.DISABLED if busy else tk.NORMAL
        self.convert_all_button.configure(state=state)
        self.convert_selected_button.configure(state=state)

    def _drain_messages(self):
        try:
            while True:
                message = self.message_queue.get_nowait()
                kind = message[0]

                if kind == "analyzed":
                    self.items.extend(message[1])
                    self._refresh_file_list()
                    self._set_busy(False)
                    self.status_var.set(f"Ready: {len(self.items)} track(s) loaded.")
                    self._log(f"Loaded {len(message[1])} new file(s).")
                    if self.items and not self.file_list.curselection():
                        self.file_list.selection_set(0)
                        self._on_selection_changed()
                elif kind == "refresh":
                    self._refresh_file_list()
                elif kind == "log":
                    self._log(message[1])
                elif kind == "progress":
                    self.progress_var.set(message[1])
                    self._draw_progress()
                elif kind == "done":
                    converted, failed, output_dir = message[1], message[2], message[3]
                    self._set_busy(False)
                    self.status_var.set(f"Converted {converted} file(s), failed {failed}. Output: {output_dir}")
                    self._log(f"Report: converted={converted}, failed={failed}, pitch_shift=-1.818%")
                    if failed:
                        messagebox.showwarning(APP_NAME, f"Converted {converted} file(s), failed {failed}.")
                    else:
                        messagebox.showinfo(APP_NAME, f"Converted {converted} file(s) to 432Hz.")
        except queue.Empty:
            pass

        self.after(120, self._drain_messages)

    def _log(self, text):
        self.log.configure(state=tk.NORMAL)
        self.log.insert(tk.END, text + "\n")
        self.log.see(tk.END)
        self.log.configure(state=tk.DISABLED)

    def _clear_log(self):
        self.log.configure(state=tk.NORMAL)
        self.log.delete("1.0", tk.END)
        self.log.configure(state=tk.DISABLED)

    def _draw_progress(self):
        if not hasattr(self, "progress_canvas"):
            return
        width = self.progress_canvas.winfo_width()
        height = self.progress_canvas.winfo_height()
        fill_width = width * max(0, min(self.progress_var.get(), 100)) / 100
        self.progress_canvas.delete("all")
        self.progress_canvas.create_rectangle(0, 0, fill_width, height, fill=ACCENT, outline="")

    def _bring_to_front(self):
        self.lift()
        self.focus_force()
        self.attributes("-topmost", True)
        self.after(1000, lambda: self.attributes("-topmost", False))

    def destroy(self):
        self.stop_preview()
        super().destroy()


if __name__ == "__main__":
    app = Aura432App()
    app.mainloop()
