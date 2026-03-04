"""FastAPI backend for PDF sheet music to MIDI conversion."""

import base64
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from services.converter import musicxml_to_midi
from services.musicxml_layout import (
    get_measures_per_first_system,
    get_measures_per_system_for_layout,
)
from services.omr import find_audiveris, pdf_to_musicxml

app = FastAPI(title="YouPhonium API")

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
    return {
        "status": "ok",
        "audiveris_installed": audiveris_ok,
    }


@app.post("/upload")
async def upload_pdf(file: UploadFile = File(...)):
    """
    Upload a PDF sheet music file, run OMR, convert to MIDI, and return it.

    Returns JSON with base64-encoded MIDI data.
    """
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Please upload a PDF file")

    pdf_path = None
    musicxml_path = None

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
            content = await file.read()
            tmp.write(content)
            pdf_path = Path(tmp.name)

        musicxml_path = pdf_to_musicxml(pdf_path)
        midi_bytes = musicxml_to_midi(musicxml_path)

        musicxml_bytes = musicxml_path.read_bytes()
        musicxml_base64 = base64.b64encode(musicxml_bytes).decode("ascii")
        musicxml_format = "mxl" if musicxml_path.suffix.lower() == ".mxl" else "xml"
        measures_per_first_system = get_measures_per_first_system(musicxml_path)
        measures_per_line = get_measures_per_system_for_layout(musicxml_path)

        return JSONResponse(
            content={
                "success": True,
                "midi_base64": base64.b64encode(midi_bytes).decode("ascii"),
                "musicxml_base64": musicxml_base64,
                "musicxml_format": musicxml_format,
                "filename": file.filename,
                "measures_per_first_system": measures_per_first_system,
                "measures_per_line": measures_per_line,
            }
        )

    except FileNotFoundError as e:
        raise HTTPException(503, str(e))
    except RuntimeError as e:
        raise HTTPException(422, f"OMR failed: {e}")
    except ValueError as e:
        raise HTTPException(422, str(e))
    finally:
        if pdf_path and pdf_path.exists():
            pdf_path.unlink(missing_ok=True)
        if musicxml_path and musicxml_path.exists():
            musicxml_path.unlink(missing_ok=True)


# Serve frontend static files (must be after API routes)
_frontend_path = Path(__file__).resolve().parent.parent / "frontend"
if _frontend_path.exists():
    app.mount("/", StaticFiles(directory=str(_frontend_path), html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
