(function () {
  "use strict";

  if (typeof pdfjsLib !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  const API_URL = (window.location.protocol === "file:" || !window.location.origin || window.location.origin === "null")
    ? "http://localhost:8000"
    : "";

  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  const browseBtn = document.getElementById("browseBtn");
  const uploadSection = document.getElementById("uploadSection");
  const statusSection = document.getElementById("statusSection");
  const statusEl = document.getElementById("status");
  const playerSection = document.getElementById("playerSection");
  const trackNameEl = document.getElementById("trackName");
  const playBtn = document.getElementById("playBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const stopBtn = document.getElementById("stopBtn");
  const tempoSlider = document.getElementById("tempoSlider");
  const tempoValueEl = document.getElementById("tempoValue");
  const progressBar = document.getElementById("progressBar");
  const progressText = document.getElementById("progressText");
  const errorSection = document.getElementById("errorSection");
  const errorBox = document.getElementById("errorBox");
  const notationSection = document.getElementById("notationSection");
  const pdfCanvas = document.getElementById("pdfCanvas");
  const pdfContainer = document.getElementById("pdfContainer");
  const verovioNotation = document.getElementById("verovioNotation");
  const notationWrapper = document.getElementById("notationWrapper");
  const layoutSection = document.getElementById("layoutSection");
  const measuresPerLineSelect = document.getElementById("measuresPerLineSelect");
  const notationTitle = document.getElementById("notationTitle");
  const playlistSection = document.getElementById("playlistSection");
  const playlistEl = document.getElementById("playlist");
  const mainPlaceholder = document.getElementById("mainPlaceholder");

  const MAX_PLAYLIST_SIZE = 20;
  let playlist = [];
  let currentTrackId = null;
  let playlistIdCounter = 0;

  let audioContext = null;
  let instrument = null;
  let midiData = null;
  let notes = [];
  let totalDuration = 0;
  let playhead = 0;
  let lastPlayedIndex = 0;
  let tempo = 1;
  let startRealTime = 0;
  let rafId = null;
  let isPlaying = false;
  let verovioTk = null;
  let verovioReady = null;
  let currentNotationPage = 1;
  let pdfBlobUrl = null;
  let pdfDoc = null;
  let hasVerovioScore = false;

  verovioReady =
    typeof verovio !== "undefined"
      ? new Promise(function (resolve) {
          verovio.module.onRuntimeInitialized = function () {
            verovioTk = new verovio.toolkit();
            verovioTk.setOptions({ pageWidth: 800, scale: 50 });
            resolve();
          };
        })
      : Promise.resolve();

  function loadPdfAndGetDimensions(blobUrl) {
    if (!blobUrl || typeof pdfjsLib === "undefined") return Promise.resolve({ dims: null });
    return pdfjsLib
      .getDocument(blobUrl)
      .promise.then(function (pdf) {
        pdfDoc = pdf;
        return pdf.getPage(1);
      })
      .then(function (page) {
        var vp = page.getViewport({ scale: 1 });
        return { dims: { width: Math.round(vp.width), height: Math.round(vp.height) } };
      })
      .catch(function () {
        return { dims: null };
      });
  }

  var PDF_DISPLAY_SCALE = 1.5;
  var measuresPerLineMultiplier = 3;

  /* Match Verovio page width to PDF content area at display scale */
  var PDF_CONTENT_WIDTH_FACTOR = 0.86;
  /* Verovio tends to fit ~half the expected measures; scale up to match original layout */
  var LAYOUT_PAGE_WIDTH_FACTOR = 2;
  var currentTrackForLayout = null;

  function applyVerovioLayout() {
    if (!verovioTk) return;
    var track = currentTrackForLayout;
    var n = Math.max(1, Math.min(10, measuresPerLineMultiplier));
    var baseW = 2100;
    var baseN = n;
    if (track && track.layoutParams) {
      baseW = track.layoutParams.pageWidthVerovio;
      baseN = track.layoutParams.measuresPerLineForPageWidth;
    }
    var pageW = Math.round(baseW * (n / Math.max(1, baseN)));
    try {
      verovioTk.setOptions({
        pageWidth: pageW,
        scale: 100,
        adjustPageWidth: false,
        condense: "auto",
        spacingNonLinear: 1,
        spacingLinear: 0.03,
      });
    } catch (e) {
      verovioTk.setOptions({
        pageWidth: pageW,
        scale: 100,
        adjustPageWidth: false,
      });
    }
    if (typeof verovioTk.redoLayout === "function") {
      verovioTk.redoLayout();
    }
  }

  function renderPdfPage(pageNum, onRendered) {
    if (!pdfDoc || !pdfCanvas) return;
    pdfDoc.getPage(pageNum).then(function (page) {
      var viewport = page.getViewport({ scale: PDF_DISPLAY_SCALE });
      var ctx = pdfCanvas.getContext("2d");
      pdfCanvas.height = viewport.height;
      pdfCanvas.width = viewport.width;
      var renderTask = page.render({
        canvasContext: ctx,
        viewport: viewport,
      });
      if (renderTask && renderTask.promise && onRendered) {
        renderTask.promise.then(function () {
          requestAnimationFrame(function () {
            onRendered();
          });
        });
      } else if (onRendered) {
        requestAnimationFrame(onRendered);
      }
    });
  }

  function updateNotationView() {
    if (!hasVerovioScore || !verovioTk) return;
    var timeMs = playhead * 1000;
    var currentElements = verovioTk.getElementsAtTime(timeMs);

    if (currentElements && currentElements.page !== 0) {
      if (currentElements.page !== currentNotationPage) {
        currentNotationPage = currentElements.page;
        if (verovioNotation) {
          verovioNotation.innerHTML = verovioTk.renderToSVG(currentNotationPage);
        }
      }

      if (verovioNotation) {
        var playingNotes = verovioNotation.querySelectorAll("[data-playing]");
        for (var i = 0; i < playingNotes.length; i++) {
          var p = playingNotes[i];
          p.removeAttribute("data-playing");
          p.style.fill = "";
          p.style.stroke = "";
          var kids = p.querySelectorAll("*");
          for (var k = 0; k < kids.length; k++) {
            kids[k].style.fill = "";
            kids[k].style.stroke = "";
          }
        }
        var noteIds = currentElements.notes || [];
        var accentColor = "rgb(220, 38, 38)";
        for (var j = 0; j < noteIds.length; j++) {
          var el = verovioNotation.querySelector("#" + CSS.escape(noteIds[j])) || document.getElementById(noteIds[j]);
          if (el) {
            el.setAttribute("data-playing", "1");
            el.style.fill = accentColor;
            el.style.stroke = accentColor;
            var kids = el.querySelectorAll("*");
            for (var k = 0; k < kids.length; k++) {
              kids[k].style.fill = accentColor;
              kids[k].style.stroke = accentColor;
            }
          }
        }
      }
    }
  }

  function clearVerovioHighlights() {
    if (verovioNotation) {
      var playingNotes = verovioNotation.querySelectorAll("[data-playing]");
      for (var i = 0; i < playingNotes.length; i++) {
        var p = playingNotes[i];
        p.removeAttribute("data-playing");
        p.style.fill = "";
        p.style.stroke = "";
        var kids = p.querySelectorAll("*");
        for (var k = 0; k < kids.length; k++) {
          kids[k].style.fill = "";
          kids[k].style.stroke = "";
        }
      }
    }
  }

  function showStatus(msg, type = "") {
    statusSection.hidden = false;
    statusEl.textContent = msg;
    statusEl.className = "status " + type;
  }

  function hideStatus() {
    statusSection.hidden = true;
  }

  function showError(msg) {
    errorSection.hidden = false;
    errorBox.textContent = msg;
  }

  function hideError() {
    errorSection.hidden = true;
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function ensureAudioContext() {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioContext;
  }

  function loadInstrument() {
    if (instrument) return Promise.resolve(instrument);
    const ac = ensureAudioContext();
    return Soundfont.instrument(ac, "trombone", {
      soundfont: "FluidR3_GM",
    }).then(function (inst) {
      instrument = inst;
      return inst;
    });
  }

  function collectNotes(midi) {
    const all = [];
    midi.tracks.forEach(function (track) {
      if (track.notes && track.notes.length) {
        track.notes.forEach(function (note) {
          all.push({
            time: note.time,
            midi: note.midi,
            duration: note.duration,
            velocity: note.velocity != null ? note.velocity : 0.8,
          });
        });
      }
    });
    all.sort(function (a, b) {
      return a.time - b.time;
    });
    return all;
  }

  function tick() {
    if (!isPlaying || !instrument) return;
    const elapsed = (performance.now() - startRealTime) / 1000 * tempo;
    playhead = elapsed;

    while (lastPlayedIndex < notes.length && notes[lastPlayedIndex].time <= playhead) {
      const note = notes[lastPlayedIndex];
      const scaledDuration = note.duration / tempo;
      instrument.play(note.midi, 0, {
        duration: scaledDuration,
        gain: note.velocity,
      });
      lastPlayedIndex++;
    }

    progressBar.style.width = (playhead / totalDuration) * 100 + "%";
    progressText.textContent = formatTime(playhead) + " / " + formatTime(totalDuration);
    updateNotationView();

    if (lastPlayedIndex < notes.length) {
      rafId = requestAnimationFrame(tick);
    } else {
      isPlaying = false;
      playhead = 0;
      lastPlayedIndex = 0;
      progressBar.style.width = "0%";
      progressText.textContent = "0:00 / " + formatTime(totalDuration);
      playBtn.disabled = false;
      pauseBtn.disabled = true;
      stopBtn.disabled = true;
      clearVerovioHighlights();
    }
  }

  function play() {
    if (!instrument || !notes.length) return;
    ensureAudioContext().resume();
    hideError();
    isPlaying = true;
    playBtn.disabled = true;
    pauseBtn.disabled = false;
    stopBtn.disabled = false;
    startRealTime = performance.now() - (playhead / tempo) * 1000;
    rafId = requestAnimationFrame(tick);
  }

  function pause() {
    isPlaying = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (instrument) instrument.stop();
    playBtn.disabled = false;
    pauseBtn.disabled = true;
    stopBtn.disabled = false;
  }

  function stop() {
    pause();
    playhead = 0;
    lastPlayedIndex = 0;
    progressBar.style.width = "0%";
    progressText.textContent = "0:00 / " + formatTime(totalDuration);
    clearVerovioHighlights();
  }

  function onTempoChange() {
    tempo = parseFloat(tempoSlider.value);
    tempoValueEl.textContent = tempo.toFixed(1) + "×";
  }

  function seekTo(seconds) {
    if (!notes.length || totalDuration <= 0) return;
    var t = Math.max(0, Math.min(totalDuration, seconds));
    playhead = t;
    lastPlayedIndex = 0;
    while (lastPlayedIndex < notes.length && notes[lastPlayedIndex].time < playhead) {
      lastPlayedIndex++;
    }
    if (instrument) instrument.stop();
    progressBar.style.width = (playhead / totalDuration) * 100 + "%";
    progressText.textContent = formatTime(playhead) + " / " + formatTime(totalDuration);
    updateNotationView();
    if (isPlaying) {
      startRealTime = performance.now() - (playhead / tempo) * 1000;
    }
  }

  function handleProgressSeek(e) {
    var trackEl = document.getElementById("progressTrack");
    if (!trackEl || !notes.length) return;
    var rect = trackEl.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var ratio = Math.max(0, Math.min(1, x / rect.width));
    seekTo(ratio * totalDuration);
  }

  function setupTrackFromStoredData(track) {
    if (pdfBlobUrl) {
      URL.revokeObjectURL(pdfBlobUrl);
      pdfBlobUrl = null;
    }
    var pdfLoadPromise = Promise.resolve({ dims: null });
    if (track.file) {
      pdfBlobUrl = URL.createObjectURL(track.file);
      pdfLoadPromise = loadPdfAndGetDimensions(pdfBlobUrl);
    }
    return pdfLoadPromise.then(function (pdfResult) {
      currentTrackForLayout = track;
      var pdfDims = pdfResult && pdfResult.dims;
      var pdfWidthPt = pdfDims && pdfDims.width ? pdfDims.width : 0;
      var n = track.measuresPerLine != null ? track.measuresPerLine : track.measuresPerFirstSystem;
      if (n == null) n = 2;
      if (n != null && n > 4) n = 4;
      measuresPerLineMultiplier = Math.max(1, Math.min(10, n));
      if (measuresPerLineSelect) measuresPerLineSelect.value = String(measuresPerLineMultiplier);
      if (pdfWidthPt > 0 && n != null && n > 0) {
        var contentWidthPx = pdfWidthPt * PDF_CONTENT_WIDTH_FACTOR * PDF_DISPLAY_SCALE * LAYOUT_PAGE_WIDTH_FACTOR;
        track.layoutParams = {
          pageWidthVerovio: Math.round(contentWidthPx),
          measuresPerLineForPageWidth: n,
        };
      } else {
        track.layoutParams = null;
      }
      return verovioReady.then(function () {
        var uploadData = {
          midi_base64: track.midiBase64,
          musicxml_base64: track.musicxmlBase64 || null,
          musicxml_format: track.musicxmlFormat || null,
        };
        if (uploadData.musicxml_base64 && typeof verovio !== "undefined") {
          try {
            var binary = atob(uploadData.musicxml_base64);
            var bytes = new Uint8Array(binary.length);
            for (var i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            if (uploadData.musicxml_format === "mxl") {
              verovioTk.loadZipDataBuffer(bytes.buffer);
            } else {
              verovioTk.loadData(new TextDecoder().decode(bytes));
            }
            var verovioMidiBase64 = verovioTk.renderToMIDI();
            if (verovioMidiBase64) {
              var midiBinary = atob(verovioMidiBase64);
              var midiBytes = new Uint8Array(midiBinary.length);
              for (var j = 0; j < midiBinary.length; j++) {
                midiBytes[j] = midiBinary.charCodeAt(j);
              }
              midiData = new Midi(midiBytes.buffer);
              notes = collectNotes(midiData);
              totalDuration = midiData.duration;
              currentNotationPage = 1;
              hasVerovioScore = true;
              applyVerovioLayout();
              if (pdfContainer) pdfContainer.hidden = true;
              if (verovioNotation) {
                verovioNotation.innerHTML = verovioTk.renderToSVG(1);
                verovioNotation.hidden = false;
              }
              if (layoutSection) layoutSection.hidden = false;
              if (notationTitle) notationTitle.textContent = "Sheet Music";
              notationSection.hidden = false;
            } else {
              throw new Error("Verovio MIDI failed");
            }
          } catch (e) {
            var fallbackBinary = atob(uploadData.midi_base64);
            var fallbackBytes = new Uint8Array(fallbackBinary.length);
            for (var k = 0; k < fallbackBytes.length; k++) {
              fallbackBytes[k] = fallbackBinary.charCodeAt(k);
            }
            midiData = new Midi(fallbackBytes.buffer);
            notes = collectNotes(midiData);
            totalDuration = midiData.duration;
            currentNotationPage = 1;
            hasVerovioScore = true;
            applyVerovioLayout();
            if (pdfContainer) pdfContainer.hidden = true;
            if (verovioNotation) {
              verovioNotation.innerHTML = verovioTk.renderToSVG(1);
              verovioNotation.hidden = false;
            }
            if (layoutSection) layoutSection.hidden = false;
            if (notationTitle) notationTitle.textContent = "Sheet Music";
            notationSection.hidden = false;
          }
        } else {
          var fallbackBinary = atob(uploadData.midi_base64);
          var fallbackBytes = new Uint8Array(fallbackBinary.length);
          for (var k = 0; k < fallbackBytes.length; k++) {
            fallbackBytes[k] = fallbackBinary.charCodeAt(k);
          }
          midiData = new Midi(fallbackBytes.buffer);
          notes = collectNotes(midiData);
          totalDuration = midiData.duration;
          currentNotationPage = 1;
          hasVerovioScore = false;
          if (pdfContainer) pdfContainer.hidden = false;
          if (verovioNotation) verovioNotation.hidden = true;
          if (layoutSection) layoutSection.hidden = true;
          if (notationTitle) notationTitle.textContent = "Original Sheet Music";
          if (track.file && pdfDoc) {
            renderPdfPage(1);
          }
          notationSection.hidden = false;
        }
        return loadInstrument();
      });
    });
  }

  function renderPlaylist() {
    if (!playlistEl) return;
    playlistEl.innerHTML = "";
    playlist.forEach(function (track) {
      var li = document.createElement("li");
      li.className = "playlist-item" + (track.id === currentTrackId ? " active" : "");
      li.dataset.trackId = track.id;
      var title = document.createElement("span");
      title.className = "playlist-item-title";
      title.textContent = track.filename;
      li.appendChild(title);
      var actions = document.createElement("div");
      actions.className = "playlist-item-actions";
      var upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "btn btn-icon";
      upBtn.title = "Move up";
      upBtn.textContent = "\u2191";
      upBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        reorderTrack(track.id, -1);
      });
      var downBtn = document.createElement("button");
      downBtn.type = "button";
      downBtn.className = "btn btn-icon";
      downBtn.title = "Move down";
      downBtn.textContent = "\u2193";
      downBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        reorderTrack(track.id, 1);
      });
      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn-icon";
      delBtn.title = "Remove";
      delBtn.textContent = "\u00d7";
      delBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        deleteTrack(track.id);
      });
      actions.appendChild(upBtn);
      actions.appendChild(downBtn);
      actions.appendChild(delBtn);
      li.appendChild(actions);
      li.addEventListener("click", function (e) {
        if (!e.target.closest(".playlist-item-actions")) {
          loadTrack(track.id);
        }
      });
      playlistEl.appendChild(li);
    });
  }

  function addToPlaylist(data, file) {
    if (playlist.length >= MAX_PLAYLIST_SIZE) {
      showError("Playlist is full. Remove a track to add more.");
      return;
    }
    var id = "track-" + (++playlistIdCounter);
    var filename = file.name.replace(/\.pdf$/i, "");
    var track = {
      id: id,
      filename: filename,
      midiBase64: data.midi_base64,
      musicxmlBase64: data.musicxml_base64 || null,
      musicxmlFormat: data.musicxml_format || null,
      measuresPerFirstSystem: data.measures_per_first_system,
      measuresPerLine: data.measures_per_line,
      file: file,
    };
    playlist.push(track);
    currentTrackId = playlist[0].id;
    if (playlistSection) playlistSection.hidden = false;
    renderPlaylist();
  }

  function loadTrack(id) {
    var track = playlist.find(function (t) { return t.id === id; });
    if (!track) return;
    if (isPlaying) pause();
    currentTrackId = id;
    renderPlaylist();
    showStatus("Loading track…", "loading");
    setupTrackFromStoredData(track).then(function () {
      hideStatus();
      trackNameEl.textContent = track.filename;
      progressBar.style.width = "0%";
      progressText.textContent = "0:00 / " + formatTime(totalDuration);
      tempoSlider.value = "1";
      onTempoChange();
      playhead = 0;
      lastPlayedIndex = 0;
      playerSection.hidden = false;
      if (mainPlaceholder) mainPlaceholder.hidden = true;
    }).catch(function (err) {
      showError(err.message || "Failed to load track");
      hideStatus();
    });
  }

  function deleteTrack(id) {
    var idx = playlist.findIndex(function (t) { return t.id === id; });
    if (idx < 0) return;
    var wasCurrent = playlist[idx].id === currentTrackId;
    playlist.splice(idx, 1);
    if (wasCurrent) {
      if (playlist.length > 0) {
        var nextIdx = Math.min(idx, playlist.length - 1);
        loadTrack(playlist[nextIdx].id);
      } else {
        currentTrackId = null;
        if (playlistSection) playlistSection.hidden = true;
        playerSection.hidden = true;
        if (mainPlaceholder) mainPlaceholder.hidden = false;
        if (pdfBlobUrl) {
          URL.revokeObjectURL(pdfBlobUrl);
          pdfBlobUrl = null;
        }
        midiData = null;
        notes = [];
        totalDuration = 0;
      }
    } else {
      renderPlaylist();
    }
  }

  function reorderTrack(id, direction) {
    var idx = playlist.findIndex(function (t) { return t.id === id; });
    if (idx < 0) return;
    var newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= playlist.length) return;
    var tmp = playlist[idx];
    playlist[idx] = playlist[newIdx];
    playlist[newIdx] = tmp;
    renderPlaylist();
  }

  browseBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    fileInput.click();
  });

  dropzone.addEventListener("click", function (e) {
    if (e.target === dropzone || e.target.closest(".dropzone-content")) {
      fileInput.click();
    }
  });

  dropzone.addEventListener("dragover", function (e) {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });

  dropzone.addEventListener("dragleave", function () {
    dropzone.classList.remove("dragover");
  });

  dropzone.addEventListener("drop", function (e) {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    const files = e.dataTransfer.files;
    if (files.length) handleFile(files[0]);
  });

  fileInput.addEventListener("change", function () {
    const files = fileInput.files;
    if (files.length) handleFile(files[0]);
    fileInput.value = "";
  });

  playBtn.addEventListener("click", play);
  pauseBtn.addEventListener("click", pause);
  stopBtn.addEventListener("click", stop);
  tempoSlider.addEventListener("input", onTempoChange);

  var progressTrack = document.getElementById("progressTrack");
  if (progressTrack) {
    progressTrack.addEventListener("click", handleProgressSeek);
    progressTrack.addEventListener("mousedown", function (e) {
      e.preventDefault();
      handleProgressSeek(e);
      function onMove(ev) {
        handleProgressSeek(ev);
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  if (measuresPerLineSelect) {
    measuresPerLineSelect.addEventListener("change", function () {
      measuresPerLineMultiplier = parseInt(measuresPerLineSelect.value, 10);
      if (verovioTk && hasVerovioScore) {
        applyVerovioLayout();
        if (verovioNotation) {
          verovioNotation.innerHTML = verovioTk.renderToSVG(currentNotationPage);
        }
      }
    });
  }

  // Check backend on load (read body once to avoid "stream already read" error)
  fetch((API_URL || window.location.origin) + "/health")
    .then(function (r) { return r.text().then(function (t) { return JSON.parse(t); }); })
    .then(function (data) {
      if (!data.audiveris_installed) {
        showError("Audiveris is not installed or not found. PDF upload will fail. See README for setup.");
      }
    })
    .catch(function () {
      showError("Cannot reach the backend. Start it with: cd backend && python -m uvicorn main:app --port 8000");
    });

  function handleFile(file) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      showError("Please select a PDF file.");
      return;
    }

    if (pdfBlobUrl) {
      URL.revokeObjectURL(pdfBlobUrl);
      pdfBlobUrl = null;
    }

    hideError();
    showStatus("Uploading and processing… This can take 1–2 minutes for sheet music. Please wait.", "loading");
    playerSection.hidden = true;
    if (mainPlaceholder) mainPlaceholder.hidden = false;

    const formData = new FormData();
    formData.append("file", file);

    fetch((API_URL || window.location.origin) + "/upload", {
      method: "POST",
      body: formData,
    })
      .then(function (res) {
        return res.text().then(function (t) {
          if (!res.ok) {
            var msg = res.statusText || "Upload failed";
            try {
              var body = JSON.parse(t);
              var detail = body.detail;
              if (Array.isArray(detail) && detail[0] && detail[0].msg) {
                msg = detail[0].msg;
              } else if (typeof detail === "string") {
                msg = detail;
              } else if (detail) {
                msg = String(detail);
              } else if (t) {
                msg = t;
              }
            } catch (e) {
              if (t) msg = t;
            }
            throw new Error(msg);
          }
          var data = JSON.parse(t);
          return data;
        });
      })
      .then(function (data) {
        if (!data.success || !data.midi_base64) {
          throw new Error("Invalid response from server");
        }
        showStatus("Ready to play! Loading Euphonium sound…", "loading");
        var track = {
          id: null,
          filename: file.name.replace(/\.pdf$/i, ""),
          midiBase64: data.midi_base64,
          musicxmlBase64: data.musicxml_base64 || null,
          musicxmlFormat: data.musicxml_format || null,
          measuresPerFirstSystem: data.measures_per_first_system,
          measuresPerLine: data.measures_per_line,
          file: file,
        };
        return setupTrackFromStoredData(track).then(function () { return data; });
      })
      .then(function (data) {
        if (notes.length === 0) {
          throw new Error("No notes found in the sheet music. The PDF may not have been recognized correctly.");
        }
        addToPlaylist(data, file);
        if (playlist.length === 1) {
          hideStatus();
          trackNameEl.textContent = playlist[0].filename;
          progressBar.style.width = "0%";
          progressText.textContent = "0:00 / " + formatTime(totalDuration);
          tempoSlider.value = "1";
          onTempoChange();
          playhead = 0;
          lastPlayedIndex = 0;
          playerSection.hidden = false;
          if (mainPlaceholder) mainPlaceholder.hidden = true;
        } else {
          loadTrack(playlist[0].id);
        }
      })
      .catch(function (err) {
        if (pdfBlobUrl) {
          URL.revokeObjectURL(pdfBlobUrl);
          pdfBlobUrl = null;
        }
        let msg = err.message || "Something went wrong.";
        if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
          msg = "Could not reach the server. Make sure the backend is running (python -m uvicorn main:app --reload).";
        } else if (msg.includes("body stream already read") || msg.includes("already read")) {
          msg = "Audio loading error. Try refreshing the page, or use Chrome/Firefox. If it persists, the soundfont CDN may be blocked.";
        }
        showError(msg);
        hideStatus();
        if (playlist.length > 0) {
          playerSection.hidden = false;
          if (mainPlaceholder) mainPlaceholder.hidden = true;
        }
      });
  }
})();
