#!/bin/zsh
cd "$(dirname "$0")"

if ! command -v ffmpeg >/dev/null 2>&1; then
  osascript -e 'display dialog "Thieu ffmpeg. Vui long cai bang lenh: brew install ffmpeg" buttons {"OK"} default button "OK"'
  exit 1
fi

PYTHON_BIN="python3"
if /usr/bin/python3 - <<'PY' >/dev/null 2>&1
import tkinter
PY
then
  PYTHON_BIN="/usr/bin/python3"
fi

if [ ! -d ".venv-macos" ]; then
  "$PYTHON_BIN" -m venv .venv-macos
fi

. .venv-macos/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python app.py
