/**
 * Rotación del video entrante en el escritorio.
 *
 * El celular envía la cámara sin procesar (máxima fluidez) e informa cuántos
 * grados hay que girarla. Aquí se produce un MediaStream ya girado, que se usa
 * tanto para mostrar como para grabar, de modo que la grabación sale derecha.
 *
 * Dos implementaciones:
 * - "breakout" (Chromium / WebView2 en Windows): MediaStreamTrackProcessor →
 *   OffscreenCanvas → MediaStreamTrackGenerator. Funciona por cuadro, no depende
 *   del repintado de la ventana: sigue grabando aunque la app esté minimizada.
 *   Con giro 0 los cuadros pasan tal cual (coste prácticamente nulo).
 * - "canvas" (WKWebView/WebKitGTK): <canvas>.captureStream() alimentado con
 *   requestVideoFrameCallback. Solo se activa si el giro no es 0.
 */

const HAS_BREAKOUT_BOX =
  typeof window.MediaStreamTrackProcessor === 'function' &&
  typeof window.MediaStreamTrackGenerator === 'function' &&
  typeof window.OffscreenCanvas === 'function' &&
  typeof window.VideoFrame === 'function';

export class StreamRotator {
  rotation = 0;
  /** @type {MediaStream | null} */ #source = null;
  /** @type {MediaStream | null} */ #output = null;
  /** @type {AbortController | null} */ #abort = null;
  /** @type {CanvasRotator | null} */ #canvas = null;

  /** @param {(stream: MediaStream) => void} onOutputChange  el stream de salida cambió (solo modo canvas) */
  constructor(onOutputChange) {
    this.onOutputChange = onOutputChange;
  }

  /** Conecta un stream remoto y devuelve el stream (girado) a mostrar/grabar. */
  attach(source) {
    this.detach();
    this.#source = source;
    this.#output = HAS_BREAKOUT_BOX ? this.#attachBreakout(source) : this.#canvasOutput();
    return this.#output;
  }

  detach() {
    this.#abort?.abort();
    this.#abort = null;
    this.#output?.getVideoTracks().forEach((t) => t !== this.#source?.getVideoTracks()[0] && t.stop());
    this.#canvas?.stop();
    this.#canvas = null;
    this.#source = null;
    this.#output = null;
  }

  /** Cambia el giro (0/90/180/270, horario). */
  setRotation(deg) {
    const next = ((Number(deg) % 360) + 360) % 360;
    if (next === this.rotation) return;
    this.rotation = next;
    if (!HAS_BREAKOUT_BOX && this.#source) {
      // En modo canvas puede cambiar el stream de salida (directo ↔ canvas).
      this.#output = this.#canvasOutput();
      this.onOutputChange(this.#output);
    }
  }

  // ───────────────────────── Modo breakout (Windows) ─────────────────────────

  #attachBreakout(source) {
    const video = source.getVideoTracks()[0];
    if (!video) return source;

    const processor = new MediaStreamTrackProcessor({ track: video });
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    const canvas = new OffscreenCanvas(2, 2);
    const ctx = canvas.getContext('2d', { alpha: false });

    const transformer = new TransformStream({
      transform: (frame, controller) => {
        const deg = this.rotation;
        if (deg === 0) {
          controller.enqueue(frame); // sin giro: el cuadro pasa sin copiarse
          return;
        }
        const w = frame.displayWidth;
        const h = frame.displayHeight;
        const swap = deg % 180 !== 0;
        const cw = swap ? h : w;
        const ch = swap ? w : h;
        if (canvas.width !== cw || canvas.height !== ch) {
          canvas.width = cw;
          canvas.height = ch;
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.translate(cw / 2, ch / 2);
        ctx.rotate((deg * Math.PI) / 180);
        ctx.drawImage(frame, -w / 2, -h / 2, w, h);
        const rotated = new VideoFrame(canvas, { timestamp: frame.timestamp });
        frame.close();
        controller.enqueue(rotated);
      },
    });

    this.#abort = new AbortController();
    processor.readable
      .pipeThrough(transformer, { signal: this.#abort.signal })
      .pipeTo(generator.writable, { signal: this.#abort.signal })
      .catch(() => {}); // abortado al desconectar

    return new MediaStream([generator, ...source.getAudioTracks()]);
  }

  // ───────────────────────── Modo canvas (macOS / Linux) ─────────────────────────

  #canvasOutput() {
    const src = this.#source;
    if (this.rotation === 0) {
      this.#canvas?.stop();
      this.#canvas = null;
      return src;
    }
    this.#canvas ??= new CanvasRotator();
    const track = this.#canvas.start(src.getVideoTracks()[0], () => this.rotation);
    return new MediaStream([track, ...src.getAudioTracks()]);
  }
}

/** Respaldo para WebViews sin MediaStreamTrackProcessor. */
class CanvasRotator {
  #video = document.createElement('video');
  #canvas = document.createElement('canvas');
  #ctx = this.#canvas.getContext('2d', { alpha: false });
  #track = null;
  #running = false;

  start(sourceTrack, getRotation) {
    this.getRotation = getRotation;
    if (this.#video.srcObject?.getVideoTracks()[0] !== sourceTrack) {
      this.#video.muted = true;
      this.#video.playsInline = true;
      this.#video.srcObject = new MediaStream([sourceTrack]);
      this.#video.play().catch(() => {});
    }
    this.#track ??= this.#canvas.captureStream(30).getVideoTracks()[0];
    if (!this.#running) {
      this.#running = true;
      this.#loop();
    }
    return this.#track;
  }

  stop() {
    this.#running = false;
    this.#video.srcObject = null;
    this.#track?.stop();
    this.#track = null;
  }

  #loop() {
    if (!this.#running) return;
    const next = () => {
      this.#draw();
      this.#loop();
    };
    if ('requestVideoFrameCallback' in this.#video) this.#video.requestVideoFrameCallback(next);
    else requestAnimationFrame(next);
  }

  #draw() {
    const v = this.#video;
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (!w || !h) return;
    const deg = this.getRotation();
    const swap = deg % 180 !== 0;
    const cw = swap ? h : w;
    const ch = swap ? w : h;
    if (this.#canvas.width !== cw || this.#canvas.height !== ch) {
      this.#canvas.width = cw;
      this.#canvas.height = ch;
    }
    const ctx = this.#ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(v, -w / 2, -h / 2, w, h);
  }
}
