/**
 * ═══════════════════════════════════════════════════════════════════
 *  JOSEPAN 360 · OMNI · [1003] ALMACÉN Y MERMAS
 *  js/scanner.js — Cámara nativa: escaneo QR y captura de evidencia
 *
 *  • scanQR(videoEl)      → Promise<string>  (BarcodeDetector nativo;
 *    fallback a entrada manual si el navegador no lo soporta).
 *  • capturePhoto(videoEl)→ Promise<string>  (JPEG base64 comprimido).
 *  • Sound.alarm()        → tono grave de contingencia (parada de emergencia).
 * ═══════════════════════════════════════════════════════════════════
 */
'use strict';

const Scanner = (() => {

  async function _openCamera(videoEl) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }, audio: false,
    });
    videoEl.srcObject = stream;
    videoEl.setAttribute('playsinline', 'true');
    await videoEl.play();
    return stream;
  }
  function _stop(stream) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  }

  /** Lectura de QR con BarcodeDetector; si no existe, pide código manual. */
  async function scanQR(videoEl) {
    if (!('BarcodeDetector' in window)) {
      const manual = prompt('Lector QR no disponible. Introduce el código de ubicación:');
      if (!manual) throw new Error('Escaneo cancelado.');
      return manual.trim();
    }
    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    let stream;
    try {
      stream = await _openCamera(videoEl);
      videoEl.parentElement.classList.remove('hidden');
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { stop(); reject(new Error('Tiempo agotado.')); }, 30000);
        const stop = () => { clearTimeout(timeout); cancelAnimationFrame(raf); _stop(stream); videoEl.parentElement.classList.add('hidden'); };
        let raf;
        const tick = async () => {
          try {
            const codes = await detector.detect(videoEl);
            if (codes.length) { const v = codes[0].rawValue; stop(); resolve(v); return; }
          } catch (_) { /* frame sin código */ }
          raf = requestAnimationFrame(tick);
        };
        tick();
      });
    } catch (e) {
      _stop(stream);
      throw e;
    }
  }

  /** Captura un fotograma como JPEG base64 comprimido (lado cliente). */
  async function capturePhoto(videoEl, maxW = 1024, quality = 0.7) {
    let stream;
    try {
      stream = await _openCamera(videoEl);
      videoEl.parentElement.classList.remove('hidden');
      await new Promise((r) => setTimeout(r, 600)); // estabilizar enfoque
      const scale = Math.min(1, maxW / (videoEl.videoWidth || maxW));
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round((videoEl.videoWidth  || maxW) * scale);
      canvas.height = Math.round((videoEl.videoHeight || maxW) * scale);
      canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', quality);
    } finally {
      _stop(stream);
      videoEl.parentElement.classList.add('hidden');
    }
  }

  /* Captura interactiva: abre la cámara y muestra el recuadro en vivo hasta que
     se llama al snapshot() devuelto. cancel() cierra sin capturar. */
  async function startCamera(videoEl) {
    const stream = await _openCamera(videoEl);
    videoEl.parentElement.classList.remove('hidden');
    const close = () => { _stop(stream); videoEl.parentElement.classList.add('hidden'); };
    return {
      snapshot(maxW = 1024, quality = 0.7) {
        const scale = Math.min(1, maxW / (videoEl.videoWidth || maxW));
        const canvas = document.createElement('canvas');
        canvas.width  = Math.round((videoEl.videoWidth  || maxW) * scale);
        canvas.height = Math.round((videoEl.videoHeight || maxW) * scale);
        canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL('image/jpeg', quality);
        close();
        return data;
      },
      cancel: close,
    };
  }

  /* Comprime una imagen de archivo a JPEG base64 (misma escala que la cámara). */
  function compressFile(file, maxW = 1024, quality = 0.7) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Imagen no válida.'));
        img.onload = () => {
          const scale = Math.min(1, maxW / (img.width || maxW));
          const canvas = document.createElement('canvas');
          canvas.width  = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  return { scanQR, capturePhoto, startCamera, compressFile };
})();

const Sound = (() => {
  /** Tono grave sostenido para parada de emergencia. */
  function alarm() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = 110;            // grave
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.6);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 1.6);
    } catch (_) { /* audio bloqueado por política del navegador */ }
  }
  return { alarm };
})();
