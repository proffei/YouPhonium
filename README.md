# YouPhonium

Upload a PDF sheet music file and play it in Euphonium sound (approximated by trombone) in your browser.

## Prerequisites

1. **Python 3.9+** – for the backend
2. **Audiveris** – Optical Music Recognition (OMR) for converting PDF to MusicXML
   - Download from [audiveris.com](https://audiveris.com/) or [GitHub](https://github.com/Audiveris/audiveris)
   - Install and add the `audiveris` (or `Audiveris`) executable to your PATH

## Setup

1. Create a virtual environment and install dependencies:

   ```bash
   cd sheet-music-player/backend
   python3 -m venv venv
   source venv/bin/activate   # On Windows: venv\Scripts\activate
   pip install -r requirements.txt
   ```

2. Ensure Audiveris is installed and in your PATH. Test with:

   ```bash
   audiveris -batch -help
   ```

## Run

From the `backend` directory:

```bash
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Then open [http://localhost:8000](http://localhost:8000) in your browser.

## Usage

1. Drag and drop a PDF sheet music file onto the upload area, or click to browse.
2. Wait for processing (OMR can take 30–60 seconds for complex scores).
3. Use Play, Pause, Stop and the Tempo slider to control playback.

## Limitations

- **OMR accuracy** varies: clean digital PDFs work best; handwritten or low-quality scans may fail.
- **Complex scores** (many staves, dense notation) may have recognition errors.
- **Euphonium sound** is approximated by trombone (General MIDI has no Euphonium). A custom Euphonium soundfont can be added later.
- **Multi-page PDFs** produce one MusicXML per page; the first page is used for playback.

## Project Structure

```
sheet-music-player/
├── backend/
│   ├── main.py           # FastAPI app, upload endpoint, static file serving
│   ├── requirements.txt
│   └── services/
│       ├── omr.py        # Audiveris CLI integration
│       └── converter.py  # MusicXML → MIDI via music21
├── frontend/
│   ├── index.html
│   ├── app.js            # Upload, MIDI playback, controls
│   └── styles.css
└── README.md
```
