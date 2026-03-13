"""Transcribe audio to MIDI-like notes using basic-pitch."""

# Reduce TensorFlow/ONNX log noise *before* any TF/ONNX imports
import os
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")

import logging
logging.getLogger("tensorflow").setLevel(logging.ERROR)
logging.getLogger("onnxruntime").setLevel(logging.ERROR)

from pathlib import Path
from typing import List

from basic_pitch.inference import predict


def transcribe_audio_to_notes(audio_path: Path) -> List[dict]:
    """
    Transcribe an audio file to a list of notes using basic-pitch.

    Args:
        audio_path: Path to WAV, MP3, or other audio file supported by librosa.

    Returns:
        List of dicts: [{"start": float, "end": float, "midi": int, "velocity": float}, ...]
    """
    try:
        _, _, note_events = predict(str(audio_path))
    except Exception as e:
        raise ValueError(f"basic-pitch transcription failed: {e}") from None

    notes = []
    for start_time, end_time, pitch_midi, amplitude, _ in note_events:
        velocity = min(1.0, max(0.0, amplitude))
        notes.append({
            "start": float(start_time),
            "end": float(end_time),
            "midi": int(pitch_midi),
            "velocity": velocity,
        })
    return notes
