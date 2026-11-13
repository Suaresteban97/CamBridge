/**
 * Modo grabación HQ (celular).
 *
 * El celular graba con su propio codificador por hardware (MediaRecorder) a la
 * resolución completa de la cámara y sube cada fragmento a la PC por HTTPS:
 *
 *   POST /api/hq/start  → { id }
 *   POST /api/hq/chunk?id&seq   (fragmento binario, en orden estricto)
 *   POST /api/hq/stop?id
 *
 * HTTP/TCP no descarta datos: si la Wi-Fi fluctúa, la subida tarda más y los
 * fragmentos esperan en una cola (con reintentos). La calidad del archivo no
 * depende de la red, a diferencia de la vista en vivo por WebRTC.
 */

const TIMESLICE_MS = 2000;
const AUDIO_BITRATE = 192_000;
const VIDEO_BITRATE = { '720p': 10_000_000, '1080p': 20_000_000 };
const MAX_BACKOFF_MS = 5000;

const TOKEN = new URLSearchParams(location.search).get('t') ?? '';
const api = (path, params = {}) =>
  `/api/hq/${path}?${new URLSearchParams({ t: TOKEN, ...params }).toString()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** MP4/H.264 primero: hardware en Android/iOS y el formato ideal para YouTube y editores. */
const FORMATS = [
  { mimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2', ext: 'mp4' },
  { mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', ext: 'mp4' },
  { mimeType: 'video/mp4;codecs=avc1,opus', ext: 'mp4' },
  { mimeType: 'video/mp4', ext: 'mp4' },
  { mimeType: 'video/webm;codecs=h264,opus', ext: 'webm' },
  { mimeType: 'video/webm;codecs=vp9,opus', ext: 'webm' },
  { mimeType: 'video/webm;codecs=vp8,opus', ext: 'webm' },
  { mimeType: 'video/webm', ext: 'webm' },
];

export class HqRecorder {
  /** @type {MediaRecorder | null} */ #mr = null;
  #id = null;
  #seq = 0;
  /** @type {{ seq: number, blob: Blob }[]} */ #queue = [];
  #pendingBytes = 0;
  #uploadedBytes = 0;
  #uploading = false;
  #drainWaiters = [];
  #startedAt = 0;
  #ticker = 0;
  #state = 'idle'; // idle | starting | recording | finishing | error
  #finishing = null;

  /** @param {{ onState: (s: object) => void }} opts */
  constructor({ onState }) {
    this.onState = onState;
  }

  get active() {
    return this.#state === 'starting' || this.#state === 'recording' || this.#state === 'finishing';
  }

  static pickFormat() {
    if (typeof MediaRecorder === 'undefined') return null;
    return FORMATS.find((f) => MediaRecorder.isTypeSupported(f.mimeType)) ?? null;
  }

  /**
   * Empieza a grabar `stream`.
   * @param {MediaStream} stream
   * @param {{ quality: string, rotation: number }} opts  rotación a marcar en el MP4
   */
  async start(stream, { quality, rotation }) {
    if (this.active) return;
    const fmt = HqRecorder.pickFormat();
    if (!fmt) throw new Error('Este navegador no puede grabar video (MediaRecorder).');

    this.#setState('starting');
    try {
      const tracks = stream.getTracks().filter((t) => t.readyState === 'live');
      const recStream = new MediaStream(tracks);
      const hasAudio = recStream.getAudioTracks().length > 0;
      const mimeType = hasAudio ? fmt.mimeType : fmt.mimeType.replace(/,(opus|mp4a[^,]*)$/, '');

      const res = await fetch(api('start', { ext: fmt.ext, rotation: String(rotation) }), { method: 'POST' });
      if (!res.ok) throw new Error(`la PC rechazó el inicio (${res.status})`);
      const { id } = await res.json();

      this.#id = id;
      this.#seq = 0;
      this.#queue = [];
      this.#pendingBytes = 0;
      this.#uploadedBytes = 0;

      const mr = new MediaRecorder(recStream, {
        mimeType,
        videoBitsPerSecond: VIDEO_BITRATE[quality] ?? VIDEO_BITRATE['1080p'],
        audioBitsPerSecond: AUDIO_BITRATE,
      });
      this.#mr = mr;
      mr.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) this.#enqueue(ev.data);
      };
      // Si la cámara se corta (p. ej. el celular bloqueó la pantalla), se cierra limpio.
      mr.onstop = () => {
        if (this.#mr === mr && this.#state === 'recording') this.#finish();
      };
      mr.start(TIMESLICE_MS);

      this.#startedAt = Date.now();
      this.#setState('recording');
      this.#ticker = setInterval(() => this.#emit(), 1000);
    } catch (err) {
      this.#setState('error', err?.message ?? String(err));
      throw err;
    }
  }

  /** Detiene la grabación y espera a que TODO esté subido a la PC. */
  async stop() {
    const mr = this.#mr;
    if (!mr || this.#state !== 'recording') return this.#finishing;
    this.#setState('finishing');
    if (mr.state !== 'inactive') {
      await new Promise((resolve) => {
        mr.addEventListener('stop', resolve, { once: true });
        mr.stop(); // emite el último fragmento
      });
    }
    return this.#finish();
  }

  #finish() {
    this.#finishing ??= (async () => {
      this.#setState('finishing');
      this.#mr = null;
      await this.#drained();
      // Cierre del archivo (con reintentos; 404 = ya estaba cerrado).
      for (let backoff = 500; this.#id; backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)) {
        try {
          const res = await fetch(api('stop', { id: this.#id }), { method: 'POST' });
          if (res.ok || res.status === 404) break;
        } catch {
          /* red caída: reintentar */
        }
        await sleep(backoff);
      }
      this.#id = null;
      clearInterval(this.#ticker);
      this.#setState('idle');
    })().finally(() => {
      this.#finishing = null;
    });
    return this.#finishing;
  }

  // ───────────────────────── Cola de subida ─────────────────────────

  #enqueue(blob) {
    this.#queue.push({ seq: this.#seq++, blob });
    this.#pendingBytes += blob.size;
    this.#emit();
    this.#pump();
  }

  /** Sube los fragmentos de uno en uno y en orden, reintentando sin perder ninguno. */
  async #pump() {
    if (this.#uploading) return;
    this.#uploading = true;
    let backoff = 500;

    while (this.#queue.length && this.#id) {
      const item = this.#queue[0];
      try {
        const res = await fetch(api('chunk', { id: this.#id, seq: String(item.seq) }), {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: item.blob,
        });
        if (res.ok) {
          this.#queue.shift();
          this.#pendingBytes -= item.blob.size;
          this.#uploadedBytes += item.blob.size;
          backoff = 500;
          this.#emit();
          continue;
        }
        if (res.status === 409) {
          // La PC ya tenía fragmentos hasta `expected`: descartamos los repetidos.
          const { expected } = await res.json();
          while (this.#queue.length && this.#queue[0].seq < expected) {
            this.#pendingBytes -= this.#queue.shift().blob.size;
          }
          continue;
        }
        if (res.status === 404 || res.status === 403) {
          // La sesión ya no existe en la PC (se reinició la app): no hay a dónde subir.
          this.#queue = [];
          this.#pendingBytes = 0;
          this.#setState('error', 'La PC cerró la grabación (¿se reinició la app?).');
          break;
        }
        throw new Error(`HTTP ${res.status}`);
      } catch {
        await sleep(backoff); // red inestable: reintentar el mismo fragmento
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }

    this.#uploading = false;
    if (!this.#queue.length) {
      this.#drainWaiters.splice(0).forEach((resolve) => resolve());
    }
  }

  #drained() {
    if (!this.#queue.length && !this.#uploading) return Promise.resolve();
    return new Promise((resolve) => this.#drainWaiters.push(resolve));
  }

  // ───────────────────────── Estado ─────────────────────────

  #setState(state, message) {
    this.#state = state;
    this.#emit(message);
  }

  #emit(message) {
    this.onState({
      state: this.#state,
      elapsedMs: this.#startedAt && this.#state !== 'idle' ? Date.now() - this.#startedAt : 0,
      pendingBytes: this.#pendingBytes,
      uploadedBytes: this.#uploadedBytes,
      message,
    });
  }
}
