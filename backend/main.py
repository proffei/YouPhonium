"""FastAPI backend for PDF sheet music to MIDI conversion."""
import sys
import os

# Force line-buffered output so status shows in IDE terminals (Cursor, VS Code)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True)
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(line_buffering=True)
os.environ["PYTHONUNBUFFERED"] = "1"

sys.stderr.write("[YouPhonium] Booting...\n")
sys.stderr.flush()

# Set before any matplotlib import (avoids font manager hang on macOS)
import tempfile
from pathlib import Path
os.environ.setdefault("MPLBACKEND", "Agg")
os.environ.setdefault("MPLCONFIGDIR", str(Path(tempfile.gettempdir()) / "matplotlib_youphonium"))

import base64
import logging
import time
import uuid
from contextlib import asynccontextmanager
from typing import Optional

sys.stderr.write("[YouPhonium] Loading FastAPI...\n")
sys.stderr.flush()
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile

logging.basicConfig(level=logging.INFO, stream=sys.stderr)
log = logging.getLogger(__name__)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

sys.stderr.write("[YouPhonium] Loading services (converter, omr)...\n")
sys.stderr.flush()
from services.converter import musicxml_to_midi
from services.musicxml_layout import (
    get_measure_boundaries,
    get_measure_layout_positions,
    get_measures_per_first_system,
    get_measures_per_system_for_layout,
    get_system_regions,
    get_system_time_ranges,
)
from services.omr import (
    find_audiveris,
    find_homr,
    find_oemer,
    find_oemer_fast,
    image_to_musicxml,
    pdf_to_musicxml,
)
sys.stderr.write("[YouPhonium] Ready.\n")
sys.stderr.flush()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Print status banner on startup."""
    audiveris_ok = find_audiveris() is not None
    homr_ok = find_homr()
    oemer_ok = find_oemer_fast()  # Fast check, no heavy import
    banner = f"""
============================================
  YouPhonium server is running
============================================
  Local:   http://localhost:8000
  Network: http://0.0.0.0:8000
  API docs: http://localhost:8000/docs
--------------------------------------------
  OMR engines:
    HOMR:      {"✓" if homr_ok else "✗"}
    oemer:     {"✓" if oemer_ok else "✗"}
    Audiveris: {"✓" if audiveris_ok else "✗"}
--------------------------------------------
  Status: Ready. Waiting for requests...
============================================
"""
    sys.stderr.write(banner)
    sys.stderr.flush()
    yield
    sys.stderr.write("[YouPhonium] Shutting down...\n")
    sys.stderr.flush()

# In-memory job storage: job_id -> { status, message, result?, error? }
_upload_jobs: dict[str, dict] = {}

app = FastAPI(title="YouPhonium API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    """Health check endpoint."""
    audiveris_ok = find_audiveris() is not None
    homr_ok = find_homr()
    oemer_ok = find_oemer_fast()  # Fast check, no heavy import
    return {
        "status": "ok",
        "omr_audiveris": audiveris_ok,
        "omr_homr": homr_ok,
        "omr_oemer": oemer_ok,
        "audiveris_installed": audiveris_ok,
    }


def _run_upload_job(
    job_id: str, file_path: Path, filename: str, engine: Optional[str] = None, is_image: bool = False
) -> None:
    """Background task: run OMR and conversion, update job status."""
    job = _upload_jobs.get(job_id)
    if not job:
        return
    try:
        def on_progress(msg: str) -> None:
            job["message"] = msg
            job["status"] = "processing"
            log.info("[Upload %s] %s", job_id[:8], msg)

        log.info("[Upload %s] Job started for %s (engine=%s, is_image=%s)", job_id[:8], filename, engine or "auto", is_image)
        on_progress("Starting OMR…")
        if is_image:
            musicxml_path, omr_layout, omr_note_positions = image_to_musicxml(
                file_path, original_filename=filename, on_progress=on_progress, engine=engine
            )
        else:
            musicxml_path, omr_layout, omr_note_positions = pdf_to_musicxml(
                file_path, original_filename=filename, on_progress=on_progress, engine=engine
            )

        log.info("[Upload %s] OMR complete, converting to MIDI", job_id[:8])
        on_progress("Converting to MIDI…")
        midi_bytes = musicxml_to_midi(musicxml_path)

        on_progress("Preparing notation…")
        # Use raw OMR output for display; music21 normalization can sometimes produce
        # MusicXML that Verovio renders as title-only/blank (e.g. with HOMR).
        musicxml_bytes = musicxml_path.read_bytes()
        musicxml_format = "mxl" if musicxml_path.suffix.lower() == ".mxl" else "xml"
        measures_per_first_system = get_measures_per_first_system(musicxml_path)
        measures_per_line = get_measures_per_system_for_layout(musicxml_path)
        measure_boundaries = get_measure_boundaries(musicxml_path)
        system_time_ranges = get_system_time_ranges(musicxml_path)
        system_regions = get_system_regions(musicxml_path)
        # Prefer OMR layout from Audiveris .omr for precise PDF overlay; fallback to music21
        measure_layout_positions = (
            omr_layout if omr_layout else get_measure_layout_positions(musicxml_path)
        )

        omr_output_dir = Path(__file__).resolve().parent.parent / "omr_output"
        stem = Path(filename).stem
        musicxml_saved = omr_output_dir / f"{stem}.mxl"
        if not musicxml_saved.exists():
            musicxml_saved = omr_output_dir / f"{stem}.musicxml"
        if not musicxml_saved.exists():
            musicxml_saved = omr_output_dir / f"{stem}.xml"

        job["status"] = "complete"
        job["message"] = "Complete"
        job["result"] = {
            "success": True,
            "midi_base64": base64.b64encode(midi_bytes).decode("ascii"),
            "musicxml_base64": base64.b64encode(musicxml_bytes).decode("ascii"),
            "musicxml_format": musicxml_format,
            "filename": filename,
            "measures_per_first_system": measures_per_first_system,
            "measures_per_line": measures_per_line,
            "measure_boundaries": measure_boundaries,
            "system_time_ranges": system_time_ranges,
            "system_regions": system_regions,
            "measure_layout_positions": measure_layout_positions,
            "measure_note_positions": omr_note_positions if omr_note_positions else [],
            "musicxml_path": str(musicxml_saved) if musicxml_saved.exists() else str(omr_output_dir),
        }
        if musicxml_path and musicxml_path.exists():
            log.info("MusicXML kept at: %s", musicxml_path.resolve())
    except FileNotFoundError as e:
        job["status"] = "error"
        job["message"] = "Error"
        job["error"] = str(e)
    except (RuntimeError, ValueError) as e:
        msg = str(e)
        log.error("OMR failed: %s", msg)
        sys.stderr.write(f"\n*** OMR ERROR: {msg} ***\n\n")
        sys.stderr.flush()
        job["status"] = "error"
        job["message"] = "Error"
        job["error"] = msg
    except Exception as e:
        log.exception("Upload job failed")
        job["status"] = "error"
        job["message"] = "Error"
        job["error"] = str(e)
    finally:
        if file_path.exists():
            file_path.unlink(missing_ok=True)


@app.post("/upload")
async def upload_pdf(
    file: UploadFile = File(...),
    engine: Optional[str] = Form(None),
    background_tasks: BackgroundTasks = None,
):
    """
    Start PDF or image upload and OMR. Returns job_id; poll GET /upload/status/{job_id} for progress.
    engine: "homr", "oemer", or "audiveris" to force one; omit for auto (Audiveris preferred for PDF).
    Images (PNG, JPG) only support HOMR and oemer; Audiveris requires PDF.
    """
    if not file.filename:
        raise HTTPException(400, "Please upload a file")
    ext = file.filename.lower().split(".")[-1] if "." in file.filename else ""
    if ext not in ("pdf", "png", "jpg", "jpeg"):
        raise HTTPException(400, "Please upload a PDF or image file (PNG, JPG)")
    if engine and engine not in ("homr", "oemer", "audiveris"):
        raise HTTPException(400, "engine must be 'homr', 'oemer', or 'audiveris'")

    is_image = ext in ("png", "jpg", "jpeg")
    if is_image and engine == "audiveris":
        raise HTTPException(
            400,
            "Audiveris only supports PDF. Use HOMR or oemer for image files (PNG, JPG).",
        )

    job_id = str(uuid.uuid4())
    _upload_jobs[job_id] = {
        "status": "processing",
        "message": "Uploading file…",
        "result": None,
        "error": None,
        "started_at": time.time(),
    }

    suffix = f".{ext}"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        file_path = Path(tmp.name)

    _upload_jobs[job_id]["message"] = "Starting OMR…"
    background_tasks.add_task(_run_upload_job, job_id, file_path, file.filename, engine, is_image)

    return JSONResponse(content={"job_id": job_id})


@app.get("/upload/status/{job_id}")
def upload_status(job_id: str):
    """Get upload job status and result when complete."""
    job = _upload_jobs.get(job_id)
    if not job:
        raise HTTPException(
            404,
            "Job not found. The server may have restarted (jobs are in-memory). Please try uploading again.",
        )
    out = {"status": job["status"], "message": job["message"]}
    if job.get("started_at"):
        out["started_at"] = job["started_at"]
    if job["status"] == "complete" and job.get("result"):
        out["result"] = job["result"]
    if job["status"] == "error" and job.get("error"):
        out["error"] = job["error"]
    return out


@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    """
    Transcribe recorded audio to notes for practice comparison.

    Accepts WAV, MP3, or WebM audio. Returns JSON with note list.
    """
    if not file.filename:
        raise HTTPException(400, "No file provided")

    ext = Path(file.filename).suffix.lower()
    if ext not in (".wav", ".mp3", ".webm", ".ogg", ".m4a"):
        raise HTTPException(400, "Unsupported format. Use WAV, MP3, or WebM.")

    audio_path = None
    try:
        content = await file.read()
        if len(content) == 0:
            raise HTTPException(400, "Empty audio file")

        suffix = ext if ext else ".wav"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(content)
            audio_path = Path(tmp.name)

        try:
            from services.transcribe import transcribe_audio_to_notes
        except ImportError as e:
            raise HTTPException(
                503,
                "Audio transcription requires basic-pitch (pip install basic-pitch[onnx]), "
                "which needs Python 3.10–3.12. Not available on this Python version.",
            ) from e
        notes = transcribe_audio_to_notes(audio_path)
        return JSONResponse(content={"notes": notes})
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:
        raise HTTPException(500, f"Transcription failed: {e}") from None
    finally:
        if audio_path and audio_path.exists():
            audio_path.unlink(missing_ok=True)


# Serve frontend static files (must be after API routes)
_frontend_path = Path(__file__).resolve().parent.parent / "frontend"
if _frontend_path.exists():
    app.mount("/", StaticFiles(directory=str(_frontend_path), html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        log_level="info",
    )
