/**
 * Grabación continua a disco.
 *
 * MediaRecorder emite un fragmento cada 3 s (`timeslice: 3000`). Cada fragmento
 * se manda a Rust como binario crudo (`invoke("append_chunk", Uint8Array)`),
 * que lo añade al archivo y lo sincroniza con el disco. Los envíos se
 * encadenan en una cola de promesas para garantizar el orden de los bytes.
 * Nunca se acumula el video completo en memoria.
 */

const TIMESLICE_MS = 3000;
/** 16 Mbps: holgado para 1080p30 (YouTube recomienda 8-12 Mbps para subir 1080p). */
const VIDEO_BITRATE = 16_000_000;
const AUDIO_BITRATE = 192_000;

/**
 * Formatos en orden de preferencia.
 * 1. MP4/H.264: lo que mejor aceptan YouTube y los editores (Premiere, DaVinci,
 *    CapCut), y Chromium lo codifica por hardware en Windows. Se escribe como MP4
 *    fragmentado, así que también sobrevive a un cierre inesperado.
 * 2. WebM (VP9/VP8) como respaldo si el WebView no soporta MP4.
 */
const FORMATS = [
  { mimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2', ext: 'mp4' },
  { mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', ext: 'mp4' },
  { mimeType: 'video/mp4;codecs=avc1,opus', ext: 'mp4' },
  { mimeType: 'video/webm;codecs=vp9,opus', ext: 'webm' },
  { mimeType: 'video/webm;codecs=vp8,opus', ext: 'webm' },
  { mimeType: 'video/webm;codecs=vp9', ext: 'webm' },
  { mimeType: 'video/webm;codecs=vp8', ext: 'webm' },
  { mimeType: 'video/webm', ext: 'webm' },
  { mimeType: 'video/mp4;codecs=avc1', ext: 'mp4' },
  { mimeType: 'video/mp4', ext: 'mp4' },
];

export class StreamRecorder {
  /** @type {MediaRecorder | null} */
  #mr = null;
  #queue = Promise.resolve();
  #stopping = false;

  /**
   * @param {object} opts
   * @param {(cmd: string, args?: any, options?: any) => Promise<any>} opts.invoke
   * @param {(bytes: number) => void} opts.onProgress  bytes escritos en disco
   * @param {(info: object|null) => void} opts.onStopped  la grabación terminó (por el usuario o porque el stream se cortó)
   * @param {(err: unknown) => void} opts.onError
   */
  constructor({ invoke, onProgress, onStopped, onError }) {
    this.invoke = invoke;
    this.onProgress = onProgress;
    this.onStopped = onStopped;
    this.onError = onError;
  }

  static isSupported() {
    return typeof MediaRecorder !== 'undefined' && StreamRecorder.pickFormat() !== null;
  }

  static pickFormat() {
    if (typeof MediaRecorder === 'undefined') return null;
    return FORMATS.find((f) => MediaRecorder.isTypeSupported(f.mimeType)) ?? null;
  }

  get isRecording() {
    return this.#mr !== null;
  }

  /** Crea el archivo en disco y empieza a grabar. Devuelve `{ path, bytes }`. */
  async start(stream) {
    if (this.#mr) throw new Error('Ya hay una grabación en curso');
    const fmt = StreamRecorder.pickFormat();
    if (!fmt) throw new Error('Este sistema no soporta MediaRecorder');

    // Graba solo pistas vivas; si el celular no envía audio, solo video.
    const tracks = stream.getTracks().filter((t) => t.readyState === 'live');
    const recStream = new MediaStream(tracks);
    // Sin audio: se quita el códec de audio del mimeType.
    const mimeType = recStream.getAudioTracks().length
      ? fmt.mimeType
      : fmt.mimeType.replace(/,(opus|mp4a[^,]*)$/, '');

    const info = await this.invoke('start_recording', { extension: fmt.ext });

    const mr = new MediaRecorder(recStream, {
      mimeType,
      videoBitsPerSecond: VIDEO_BITRATE,
      audioBitsPerSecond: AUDIO_BITRATE,
    });
    this.#mr = mr;
    this.#queue = Promise.resolve();
    this.#stopping = false;

    mr.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) this.#enqueue(ev.data);
    };
    mr.onerror = (ev) => this.onError(ev.error ?? ev);
    // Si el stream se corta (el celular se desconecta) MediaRecorder se detiene solo.
    // (Se comprueba que `mr` siga siendo el activo para no cerrar una grabación posterior.)
    mr.onstop = () => {
      if (!this.#stopping && this.#mr === mr) this.#finish().catch((e) => this.onError(e));
    };

    mr.start(TIMESLICE_MS);
    return info;
  }

  /** Detiene la grabación, espera a que el último fragmento llegue a disco y cierra el archivo. */
  async stop() {
    const mr = this.#mr;
    if (!mr) return null;
    this.#stopping = true;
    if (mr.state !== 'inactive') {
      await new Promise((resolve) => {
        mr.addEventListener('stop', resolve, { once: true });
        mr.stop(); // dispara un último `dataavailable` antes de `stop`
      });
    }
    return this.#finish();
  }

  async #finish() {
    this.#mr = null;
    await this.#queue; // vacía la cola de escritura
    const info = await this.invoke('stop_recording');
    this.onStopped(info);
    return info;
  }

  /** Encola el envío de un fragmento manteniendo el orden estricto. */
  #enqueue(blob) {
    this.#queue = this.#queue
      .then(async () => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const total = await this.invoke('append_chunk', bytes);
        this.onProgress(total);
      })
      .catch((err) => this.onError(err));
  }
}
