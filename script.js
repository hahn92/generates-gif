(() => {
    'use strict';

    const GIF_WORKER_URL = 'vendor/gif.worker.js';
    const MAX_OUTPUT = 1024;

    const fileInput = document.getElementById('file-input');
    const dropZone = document.getElementById('drop-zone');
    const frameList = document.getElementById('frame-list');
    const frameActions = document.getElementById('frame-actions');
    const frameCount = document.getElementById('frame-count');
    const clearBtn = document.getElementById('clear-btn');

    const delayInput = document.getElementById('delay-input');
    const qualityInput = document.getElementById('quality-input');
    const qualityOutput = document.getElementById('quality-output');
    const loopInput = document.getElementById('loop-input');
    const fitInput = document.getElementById('fit-input');
    const bgInput = document.getElementById('bg-input');
    const bgControl = document.getElementById('bg-control');
    const sizeInput = document.getElementById('size-input');
    const customSizeControl = document.getElementById('custom-size-control');
    const customW = document.getElementById('custom-w');
    const customH = document.getElementById('custom-h');

    const generateBtn = document.getElementById('generate-btn');
    const statusEl = document.getElementById('status');
    const statusMessage = document.getElementById('status-message');
    const progressBar = document.getElementById('progress-bar');
    const errorEl = document.getElementById('error');

    const output = document.getElementById('output');
    const outputPreview = document.getElementById('output-preview');
    const outputSize = document.getElementById('output-size');
    const downloadLink = document.getElementById('download-link');

    const modal = document.getElementById('editor-modal');
    const editorCanvas = document.getElementById('editor-canvas');
    const editorCtx = editorCanvas.getContext('2d');
    const zoomInput = document.getElementById('zoom-input');
    const editorReset = document.getElementById('editor-reset');
    const editorSave = document.getElementById('editor-save');

    /**
     * @typedef {Object} Frame
     * @property {number} id
     * @property {File} file
     * @property {string} url
     * @property {HTMLImageElement} image
     * @property {{scale:number, dx:number, dy:number}|null} transform
     */
    /** @type {Frame[]} */
    let frames = [];
    let frameIdCounter = 0;
    let lastBlobUrl = null;

    // Editor state
    let editingFrame = null;
    let editorState = null; // { canvasW, canvasH, baseScale, scale, dx, dy, dragging, lastX, lastY, displayScale }

    // ----- UI bindings -----

    qualityInput.addEventListener('input', () => {
        qualityOutput.textContent = qualityInput.value;
    });

    fitInput.addEventListener('change', () => {
        bgControl.style.display = fitInput.value === 'contain' ? '' : 'none';
    });
    // initialize bg control visibility
    bgControl.style.display = fitInput.value === 'contain' ? '' : 'none';

    sizeInput.addEventListener('change', () => {
        customSizeControl.hidden = sizeInput.value !== 'custom';
    });

    fileInput.addEventListener('change', (e) => {
        addFiles(e.target.files);
        fileInput.value = '';
    });

    ['dragenter', 'dragover'].forEach((evt) => {
        dropZone.addEventListener(evt, (e) => {
            e.preventDefault();
            dropZone.classList.add('drop-zone--active');
        });
    });

    ['dragleave', 'drop'].forEach((evt) => {
        dropZone.addEventListener(evt, (e) => {
            e.preventDefault();
            dropZone.classList.remove('drop-zone--active');
        });
    });

    dropZone.addEventListener('drop', (e) => {
        if (e.dataTransfer && e.dataTransfer.files.length) {
            addFiles(e.dataTransfer.files);
        }
    });

    clearBtn.addEventListener('click', () => {
        frames.forEach((f) => URL.revokeObjectURL(f.url));
        frames = [];
        renderFrames();
        clearError();
    });

    generateBtn.addEventListener('click', generate);

    // ----- File handling -----

    async function addFiles(fileList) {
        clearError();
        const images = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
        if (!images.length) {
            showError('No image files were selected.');
            return;
        }

        for (const file of images) {
            const url = URL.createObjectURL(file);
            try {
                const image = await loadImage(url);
                frames.push({
                    id: frameIdCounter++,
                    file,
                    url,
                    image,
                    transform: null,
                });
            } catch (err) {
                URL.revokeObjectURL(url);
                console.warn('Failed to load image:', file.name, err);
            }
        }
        renderFrames();
    }

    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Failed to decode image'));
            img.src = src;
        });
    }

    function renderFrames() {
        frameList.replaceChildren();
        frames.forEach((frame, index) => {
            const item = document.createElement('div');
            item.className = 'frame';
            if (frame.transform) item.classList.add('frame--edited');

            const img = document.createElement('img');
            img.src = frame.url;
            img.alt = `Frame ${index + 1}: ${frame.file.name}`;
            img.title = 'Click to adjust';
            img.addEventListener('click', () => openEditor(frame.id));

            const idx = document.createElement('span');
            idx.className = 'frame__index';
            idx.textContent = String(index + 1);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'frame__remove';
            remove.setAttribute('aria-label', `Remove frame ${index + 1}`);
            remove.textContent = '×';
            remove.addEventListener('click', (e) => {
                e.stopPropagation();
                removeFrame(frame.id);
            });

            item.append(img, idx, remove);
            frameList.append(item);
        });

        const has = frames.length > 0;
        frameActions.hidden = !has;
        frameCount.textContent = `${frames.length} frame${frames.length === 1 ? '' : 's'}`;
        generateBtn.disabled = frames.length < 1;
    }

    function removeFrame(id) {
        const idx = frames.findIndex((f) => f.id === id);
        if (idx === -1) return;
        URL.revokeObjectURL(frames[idx].url);
        frames.splice(idx, 1);
        renderFrames();
    }

    function showError(message) {
        errorEl.textContent = message;
        errorEl.hidden = false;
    }

    function clearError() {
        errorEl.textContent = '';
        errorEl.hidden = true;
    }

    function setBusy(busy, message = '') {
        statusEl.hidden = !busy;
        statusMessage.textContent = message;
        if (!busy) progressBar.style.width = '0%';
        generateBtn.disabled = busy || frames.length < 1;
        clearBtn.disabled = busy;
    }

    // ----- Output sizing -----

    function computeOutputSize() {
        const mode = sizeInput.value;
        let width, height;

        if (mode === 'custom') {
            width = clamp(parseInt(customW.value, 10) || 600, 32, 2048);
            height = clamp(parseInt(customH.value, 10) || 600, 32, 2048);
            return { width, height };
        }

        // base on the largest source dimensions
        let maxW = 0, maxH = 0;
        for (const f of frames) {
            if (f.image.naturalWidth > maxW) maxW = f.image.naturalWidth;
            if (f.image.naturalHeight > maxH) maxH = f.image.naturalHeight;
        }
        if (!maxW || !maxH) { maxW = 600; maxH = 600; }

        if (mode === 'auto') {
            width = maxW;
            height = maxH;
        } else if (mode === 'square') {
            const side = Math.max(maxW, maxH);
            width = side; height = side;
        } else if (mode === 'landscape') {
            const base = Math.max(maxW, maxH);
            width = base;
            height = Math.round(base * 9 / 16);
        } else if (mode === 'portrait') {
            const base = Math.max(maxW, maxH);
            width = Math.round(base * 9 / 16);
            height = base;
        }

        // clamp to MAX_OUTPUT preserving aspect ratio
        if (width > MAX_OUTPUT || height > MAX_OUTPUT) {
            const scale = MAX_OUTPUT / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
        }
        // ensure even (some encoders prefer it)
        width = Math.max(2, width - (width % 2));
        height = Math.max(2, height - (height % 2));
        return { width, height };
    }

    // ----- Frame drawing (used by both editor and final render) -----

    function drawFrame(ctx, frame, canvasW, canvasH, fitMode, bgColor) {
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, canvasW, canvasH);

        const img = frame.image;
        const iw = img.naturalWidth;
        const ih = img.naturalHeight;

        if (frame.transform) {
            // custom transform: scale = absolute multiplier on source image
            const w = iw * frame.transform.scale;
            const h = ih * frame.transform.scale;
            const x = (canvasW - w) / 2 + frame.transform.dx;
            const y = (canvasH - h) / 2 + frame.transform.dy;
            ctx.drawImage(img, x, y, w, h);
            return;
        }

        if (fitMode === 'stretch') {
            ctx.drawImage(img, 0, 0, canvasW, canvasH);
            return;
        }

        const fit = fitMode === 'cover'
            ? Math.max(canvasW / iw, canvasH / ih)
            : Math.min(canvasW / iw, canvasH / ih);
        const w = iw * fit;
        const h = ih * fit;
        const x = (canvasW - w) / 2;
        const y = (canvasH - h) / 2;
        ctx.drawImage(img, x, y, w, h);
    }

    // ----- Editor modal -----

    function openEditor(frameId) {
        const frame = frames.find((f) => f.id === frameId);
        if (!frame) return;
        editingFrame = frame;

        const { width, height } = computeOutputSize();
        const iw = frame.image.naturalWidth;
        const ih = frame.image.naturalHeight;

        // baseScale = "cover" fit (smallest scale that still covers canvas)
        const baseScale = Math.max(width / iw, height / ih);

        let scale, dx, dy;
        if (frame.transform) {
            scale = frame.transform.scale;
            dx = frame.transform.dx;
            dy = frame.transform.dy;
        } else {
            scale = baseScale;
            dx = 0;
            dy = 0;
        }

        editorState = {
            canvasW: width,
            canvasH: height,
            baseScale,
            scale,
            dx,
            dy,
            iw,
            ih,
            dragging: false,
            lastX: 0,
            lastY: 0,
            displayScale: 1,
        };

        // size canvas to a manageable display size while preserving output aspect
        sizeEditorCanvas();
        // sync zoom slider relative to baseScale: range 0.5x..4x
        zoomInput.min = String((baseScale * 0.5).toFixed(4));
        zoomInput.max = String((baseScale * 4).toFixed(4));
        zoomInput.step = String((baseScale / 100).toFixed(4));
        zoomInput.value = String(scale);

        modal.hidden = false;
        document.body.style.overflow = 'hidden';
        drawEditor();
    }

    function sizeEditorCanvas() {
        const stage = document.getElementById('editor-stage');
        const stageRect = stage.getBoundingClientRect();
        const maxW = stageRect.width || 480;
        const maxH = stageRect.height || 480;
        const ratio = editorState.canvasW / editorState.canvasH;
        let dispW = maxW;
        let dispH = maxW / ratio;
        if (dispH > maxH) {
            dispH = maxH;
            dispW = maxH * ratio;
        }
        editorCanvas.style.width = `${dispW}px`;
        editorCanvas.style.height = `${dispH}px`;
        // backing store at output resolution (capped) for crisp preview
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        editorCanvas.width = Math.round(dispW * dpr);
        editorCanvas.height = Math.round(dispH * dpr);
        editorState.displayScale = editorCanvas.width / editorState.canvasW;
    }

    function drawEditor() {
        const s = editorState;
        if (!s || !editingFrame) return;

        editorCtx.save();
        editorCtx.scale(s.displayScale, s.displayScale);
        // bg matches what generation would render
        const fitMode = fitInput.value;
        const bgColor = fitMode === 'contain' ? bgInput.value : '#ffffff';

        editorCtx.fillStyle = bgColor;
        editorCtx.fillRect(0, 0, s.canvasW, s.canvasH);

        const w = s.iw * s.scale;
        const h = s.ih * s.scale;
        const x = (s.canvasW - w) / 2 + s.dx;
        const y = (s.canvasH - h) / 2 + s.dy;
        editorCtx.drawImage(editingFrame.image, x, y, w, h);

        // crop guide outline
        editorCtx.strokeStyle = 'rgba(91, 108, 255, 0.7)';
        editorCtx.lineWidth = 2 / s.displayScale;
        editorCtx.strokeRect(1, 1, s.canvasW - 2, s.canvasH - 2);
        editorCtx.restore();
    }

    // dragging
    editorCanvas.addEventListener('pointerdown', (e) => {
        if (!editorState) return;
        editorState.dragging = true;
        editorState.lastX = e.clientX;
        editorState.lastY = e.clientY;
        editorCanvas.setPointerCapture(e.pointerId);
    });

    editorCanvas.addEventListener('pointermove', (e) => {
        if (!editorState || !editorState.dragging) return;
        const rect = editorCanvas.getBoundingClientRect();
        const ratioX = editorState.canvasW / rect.width;
        const ratioY = editorState.canvasH / rect.height;
        editorState.dx += (e.clientX - editorState.lastX) * ratioX;
        editorState.dy += (e.clientY - editorState.lastY) * ratioY;
        editorState.lastX = e.clientX;
        editorState.lastY = e.clientY;
        drawEditor();
    });

    editorCanvas.addEventListener('pointerup', (e) => {
        if (!editorState) return;
        editorState.dragging = false;
        try { editorCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
    });

    editorCanvas.addEventListener('wheel', (e) => {
        if (!editorState) return;
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const min = parseFloat(zoomInput.min);
        const max = parseFloat(zoomInput.max);
        editorState.scale = clamp(editorState.scale * factor, min, max);
        zoomInput.value = String(editorState.scale);
        drawEditor();
    }, { passive: false });

    zoomInput.addEventListener('input', () => {
        if (!editorState) return;
        editorState.scale = parseFloat(zoomInput.value);
        drawEditor();
    });

    editorReset.addEventListener('click', () => {
        if (!editorState) return;
        editorState.scale = editorState.baseScale;
        editorState.dx = 0;
        editorState.dy = 0;
        zoomInput.value = String(editorState.baseScale);
        drawEditor();
    });

    editorSave.addEventListener('click', () => {
        if (!editingFrame || !editorState) return;
        editingFrame.transform = {
            scale: editorState.scale,
            dx: editorState.dx,
            dy: editorState.dy,
        };
        closeEditor();
        renderFrames();
    });

    modal.addEventListener('click', (e) => {
        if (e.target.dataset && 'close' in e.target.dataset) {
            closeEditor();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (!modal.hidden && e.key === 'Escape') closeEditor();
    });

    function closeEditor() {
        modal.hidden = true;
        document.body.style.overflow = '';
        editingFrame = null;
        editorState = null;
    }

    // ----- Generation -----

    function generate() {
        clearError();
        if (!frames.length) {
            showError('Please add at least one image.');
            return;
        }
        if (typeof window.GIF !== 'function') {
            showError('GIF encoder failed to load. Please refresh the page.');
            return;
        }

        const delay = clamp(parseInt(delayInput.value, 10) || 200, 20, 60000);
        const quality = clamp(parseInt(qualityInput.value, 10) || 10, 1, 30);
        const repeat = parseInt(loopInput.value, 10);
        const fitMode = fitInput.value;
        const bgColor = fitMode === 'contain' ? bgInput.value : '#ffffff';

        const { width, height } = computeOutputSize();

        if (lastBlobUrl) {
            URL.revokeObjectURL(lastBlobUrl);
            lastBlobUrl = null;
        }
        output.hidden = true;

        setBusy(true, 'Adding frames…');

        const gif = new window.GIF({
            workers: 2,
            quality,
            width,
            height,
            workerScript: GIF_WORKER_URL,
            repeat,
            transparent: null,
            background: bgColor,
        });

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');

        for (const frame of frames) {
            drawFrame(ctx, frame, width, height, fitMode, bgColor);
            gif.addFrame(ctx, { copy: true, delay });
        }

        gif.on('progress', (p) => {
            const pct = Math.round(p * 100);
            statusMessage.textContent = `Encoding GIF… ${pct}%`;
            progressBar.style.width = `${pct}%`;
        });

        gif.on('finished', (blob) => {
            const url = URL.createObjectURL(blob);
            lastBlobUrl = url;
            outputPreview.src = url;
            downloadLink.href = url;
            downloadLink.download = `animation-${Date.now()}.gif`;
            outputSize.textContent = `${width} × ${height} • ${formatBytes(blob.size)}`;
            output.hidden = false;
            setBusy(false);
            output.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });

        gif.on('abort', () => {
            setBusy(false);
            showError('GIF generation was aborted.');
        });

        try {
            statusMessage.textContent = 'Encoding GIF…';
            gif.render();
        } catch (err) {
            console.error(err);
            setBusy(false);
            showError(`Failed to start encoder: ${err.message}`);
        }
    }

    // ----- Helpers -----

    function clamp(n, min, max) {
        return Math.min(max, Math.max(min, n));
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    window.addEventListener('beforeunload', () => {
        frames.forEach((f) => URL.revokeObjectURL(f.url));
        if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
    });
})();
