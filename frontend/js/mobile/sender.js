/**
 * Emisor WebRTC (celular).
 *
 * - Captura la cámara con getUserMedia (requiere HTTPS → certificado de Rust).
 * - Se conecta por WSS a `/ws?t=<token>` (token de emparejamiento del QR) y es
 *   quien crea la oferta (sendonly).
 * - Cambiar cámara o resolución NO renegocia: se usa `replaceTrack` /
 *   `applyConstraints`, así el escritorio no pierde la conexión ni la grabación.
 * - La pista de la cámara se envía SIN procesar (ruta directa al codificador por
 *   hardware = máxima fluidez). El giro (automático o manual) solo se informa
 *   al escritorio, que es quien rota la imagen.
 * - Bitrate adaptativo: WebRTC ajusta el bitrate según la congestión de la red
 *   (GCC/TWCC). Arrancamos en bitrate alto (SDP `x-google-*`), con techo de
 *   10 Mbps en 1080p y `degradationPreference: "balanced"`.
 */

const RTC_CONFIG = { iceServers: [] };

/**
 * Perfiles de calidad. `maxBitrate` es el techo; `startKbps` se
 * inyectan en el SDP para que WebRTC arranque alto (por defecto empieza en
 * ~300 kbps y tarda en subir, y mientras tanto reduce la resolución).
 */
export const QUALITIES = {
  '720p': { width: 1280, height: 720, maxBitrate: 5_000_000, startKbps: 2500 },
  '1080p': { width: 1920, height: 1080, maxBitrate: 10_000_000, startKbps: 4000 },
};

const RECONNECT_MS = 2000;
const STATS_INTERVAL_MS = 2000;

/**
 * Añade a la sección de video del SDP el bitrate inicial y máximo de Chrome
 * (`x-google-*`) y la línea `b=AS`, para no arrancar en ~300 kbps.
 * (No se fija un mínimo: si la Wi-Fi no lo sostiene, provoca pérdidas y el
 * control de congestión se hunde, que es peor.)
 */
function boostVideoBitrate(sdp, q) {
  const maxKbps = Math.round(q.maxBitrate / 1000);
  const params = `x-google-start-bitrate=${q.startKbps};x-google-max-bitrate=${maxKbps}`;
  const lines = sdp.split('\r\n');
  const out = [];
  let inVideo = false;
  const fmtpSeen = new Set();
  const videoPts = [];

  for (const line of lines) {
    if (line.startsWith('m=')) inVideo = line.startsWith('m=video');
    if (inVideo) {
      const rtp = /^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)\//i.exec(line);
      if (rtp) videoPts.push(rtp[1]);
      const fmtp = /^a=fmtp:(\d+) /.exec(line);
      if (fmtp && videoPts.includes(fmtp[1])) {
        fmtpSeen.add(fmtp[1]);
        out.push(line.includes('x-google-') ? line : `${line};${params}`);
        continue;
      }
    }
    out.push(line);
    if (inVideo && line.startsWith('c=')) out.push(`b=AS:${maxKbps}`);
  }

  // Códecs sin línea fmtp (p. ej. VP8): se añade una justo tras su rtpmap.
  return out
    .flatMap((line) => {
      const rtp = /^a=rtpmap:(\d+) /.exec(line);
      if (rtp && videoPts.includes(rtp[1]) && !fmtpSeen.has(rtp[1])) {
        return [line, `a=fmtp:${rtp[1]} ${params}`];
      }
      return [line];
    })
    .join('\r\n');
}

/** Token de emparejamiento incluido en la URL del QR. */
const TOKEN = new URLSearchParams(location.search).get('t') ?? '';

export class CameraSender {
  facing = 'environment'; // 'environment' (trasera) | 'user' (frontal)
  quality = '1080p';
  micEnabled = true;
  /** Giro manual extra (horario) elegido con el botón ↻: 0/90/180/270. */
  manualRotation = 0;

  /** @type {MediaStream | null} */ stream = null;
  /** @type {WebSocket | null} */ #ws = null;
  /** @type {RTCPeerConnection | null} */ #pc = null;
  /** @type {RTCRtpSender | null} */ #videoSender = null;
  #pendingCandidates = [];
  #reconnectTimer = 0;
  #stopped = false;
  #statsTimer = 0;
  #lastOutbound = null;
  /** Corrección de orientación física (0/90/180/270) calculada por OrientationWatcher. */
  #correction = 0;
  /** Vista previa ligera (mientras el modo HQ graba, la vista en vivo solo sirve para encuadrar). */
  #light = false;

  /**
   * @param {object} opts
   * @param {HTMLVideoElement} opts.preview
   * @param {(state: 'connecting'|'live'|'error', text: string) => void} opts.onStatus
   * @param {(w: number, h: number) => void} opts.onResolution
   * @param {(stats: object) => void} [opts.onStats]  lo que realmente se está enviando
   * @param {(msg: object) => void} [opts.onCommand]  órdenes de la PC (hq-start / hq-stop)
   */
  constructor({ preview, onStatus, onResolution, onStats = () => {}, onCommand = () => {} }) {
    this.preview = preview;
    this.onStatus = onStatus;
    this.onResolution = onResolution;
    this.onStats = onStats;
    this.onCommand = onCommand;
  }

  /** Envía un mensaje a la PC por la señalización (si hay conexión). */
  notify(msg) {
    this.#send(msg);
  }

  /** Giro actual (horario) que necesita la imagen para quedar derecha. */
  get rotation() {
    return this.#rotationDeg();
  }

  /**
   * Durante la grabación HQ, la vista en vivo se aligera (720p, ≤2,5 Mbps) para
   * dejarle todo el codificador y la Wi-Fi a la grabación.
   */
  async setPreviewLight(on) {
    this.#light = on;
    await this.#applyEncoding();
  }

  /** Pide permisos, muestra la vista previa y abre la señalización. */
  async start() {
    if (!TOKEN) {
      throw new Error('Falta el código de emparejamiento. Abre la página escaneando el QR de la PC.');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        window.isSecureContext
          ? 'Este navegador no permite acceder a la cámara.'
          : 'La página no está en HTTPS: abre la URL https:// del QR.',
      );
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: this.#videoConstraints(),
      audio: { echoCancellation: true, noiseSuppression: true },
    }).catch(() =>
      // Sin micrófono (o permiso denegado): seguimos solo con video.
      navigator.mediaDevices.getUserMedia({ video: this.#videoConstraints(), audio: false }),
    );
    this.#attachPreview();
    this.#connect();
  }

  // ───────────────────────── Controles ─────────────────────────

  /** El teléfono cambió de orientación física respecto a la pantalla. */
  setDeviceCorrection(correction) {
    this.#correction = correction;
    this.#sendStatus();
  }

  /** Gira 90° más la imagen (botón ↻). Devuelve el giro manual resultante. */
  rotateManually() {
    this.manualRotation = (this.manualRotation + 90) % 360;
    this.#sendStatus();
    return this.manualRotation;
  }

  /** Alterna entre cámara trasera y frontal sin renegociar. */
  async toggleFacing() {
    const next = this.facing === 'environment' ? 'user' : 'environment';
    const previous = this.facing;
    this.facing = next;
    try {
      await this.#reacquireVideo();
    } catch (err) {
      this.facing = previous;
      await this.#reacquireVideo().catch(() => {});
      throw err;
    }
  }

  /** Cambia entre 720p y 1080p. */
  async setQuality(quality) {
    if (!QUALITIES[quality] || quality === this.quality) return;
    const previous = this.quality;
    this.quality = quality;
    const track = this.#videoTrack();
    try {
      // Rápido: muchos dispositivos cambian la resolución en caliente.
      await track.applyConstraints(this.#videoConstraints());
      const s = track.getSettings();
      const q = QUALITIES[quality];
      // Si el driver ignoró la petición, reabrimos la cámara.
      if (Math.max(s.width ?? 0, s.height ?? 0) < Math.min(q.width, q.height)) {
        await this.#reacquireVideo();
      }
    } catch {
      try {
        await this.#reacquireVideo();
      } catch (err) {
        this.quality = previous;
        throw err;
      }
    }
    await this.#applyEncoding();
    this.#reportResolution();
    this.#sendStatus();
  }

  setMic(enabled) {
    this.micEnabled = enabled;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = enabled));
  }

  get hasAudio() {
    return (this.stream?.getAudioTracks().length ?? 0) > 0;
  }

  // ───────────────────────── Cámara ─────────────────────────

  #videoConstraints() {
    const q = QUALITIES[this.quality];
    return {
      facingMode: { ideal: this.facing },
      width: { ideal: q.width },
      height: { ideal: q.height },
      frameRate: { ideal: 30, max: 30 },
    };
  }

  #videoTrack() {
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  /**
   * Grados (horario) que el escritorio debe girar la imagen: corrección
   * automática (acelerómetro) + giro manual. La cámara frontal entrega la
   * imagen sin espejo, así que el sentido de la corrección automática se invierte.
   */
  #rotationDeg() {
    const sign = this.facing === 'user' ? 1 : -1;
    return (((sign * this.#correction + this.manualRotation) % 360) + 360) % 360;
  }

  /**
   * Reabre la cámara con las restricciones actuales. Se detiene primero la
   * pista anterior porque muchos celulares no pueden abrir dos cámaras a la vez.
   */
  async #reacquireVideo() {
    const old = this.#videoTrack();
    if (old) {
      old.stop();
      this.stream.removeTrack(old);
    }
    const fresh = await navigator.mediaDevices.getUserMedia({ video: this.#videoConstraints(), audio: false });
    const track = fresh.getVideoTracks()[0];
    track.contentHint = 'motion';
    this.stream.addTrack(track);
    if (this.#videoSender) await this.#videoSender.replaceTrack(track);
    this.#attachPreview();
    await this.#applyEncoding();
    this.#sendStatus();
  }

  #attachPreview() {
    const track = this.#videoTrack();
    if (track) track.contentHint = 'motion';
    // Solo video en la vista previa local (evita eco).
    this.preview.srcObject = new MediaStream(track ? [track] : []);
    this.preview.classList.toggle('mirror', this.facing === 'user');
    this.preview.onloadedmetadata = () => this.#reportResolution();
    this.preview.onresize = () => this.#reportResolution();
    this.preview.play().catch(() => {});
  }

  #reportResolution() {
    const { videoWidth: w, videoHeight: h } = this.preview;
    if (w && h) this.onResolution(w, h);
  }

  // ───────────────────────── Señalización ─────────────────────────

  #connect() {
    clearTimeout(this.#reconnectTimer);
    if (this.#stopped) return;
    this.onStatus('connecting', 'Conectando con la PC…');

    const ws = new WebSocket(`wss://${location.host}/ws?t=${encodeURIComponent(TOKEN)}`);
    this.#ws = ws;

    ws.onopen = () => this.#negotiate().catch((e) => this.#fail(e));
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.#onSignal(msg).catch((e) => this.#fail(e));
    };
    ws.onclose = async () => {
      if (this.#ws !== ws) return;
      this.#closePeer();
      // ¿El token sigue siendo válido? Si la app de la PC se reinició, no.
      if (!(await this.#tokenStillValid())) {
        this.#stopped = true;
        this.onStatus('error', 'Este enlace expiró. Escanea de nuevo el QR de la PC.');
        return;
      }
      this.onStatus('connecting', 'Sin conexión con la PC, reintentando…');
      this.#reconnectTimer = setTimeout(() => this.#connect(), RECONNECT_MS);
    };
  }

  /** `true` si el servidor sigue aceptando el token (o si no responde: se reintenta). */
  async #tokenStillValid() {
    try {
      const res = await fetch(`/api/check?t=${encodeURIComponent(TOKEN)}`, { cache: 'no-store' });
      return res.status !== 403;
    } catch {
      return true; // PC apagada o fuera de alcance: seguir reintentando
    }
  }

  #send(msg) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(msg));
  }

  #sendStatus() {
    this.#send({ type: 'status', facing: this.facing, quality: this.quality, rotation: this.#rotationDeg() });
  }

  async #onSignal(msg) {
    switch (msg.type) {
      case 'answer':
        await this.#pc?.setRemoteDescription({
          type: 'answer',
          sdp: boostVideoBitrate(msg.sdp, QUALITIES[this.quality]),
        });
        for (const c of this.#pendingCandidates) await this.#pc?.addIceCandidate(c).catch(() => {});
        this.#pendingCandidates = [];
        break;
      case 'candidate':
        if (!msg.candidate) break;
        if (this.#pc?.remoteDescription) await this.#pc.addIceCandidate(msg.candidate).catch(() => {});
        else this.#pendingCandidates.push(msg.candidate);
        break;
      case 'request-offer':
        await this.#negotiate();
        break;
      case 'hq-start':
      case 'hq-stop':
        this.onCommand(msg);
        break;
    }
  }

  /** Crea una conexión WebRTC nueva y envía la oferta al escritorio. */
  async #negotiate() {
    this.#closePeer();
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.#pc = pc;

    const video = this.#videoTrack();
    // Códec: el que elija el navegador (VP8 en Chrome), que en tu celular dio 30 fps.
    this.#videoSender = pc.addTransceiver(video, {
      direction: 'sendonly',
      streams: [this.stream],
      sendEncodings: [{ maxBitrate: QUALITIES[this.quality].maxBitrate, maxFramerate: 30, scaleResolutionDownBy: 1 }],
    }).sender;
    for (const audio of this.stream.getAudioTracks()) {
      pc.addTransceiver(audio, { direction: 'sendonly', streams: [this.stream] });
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.#send({ type: 'candidate', candidate: ev.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      switch (pc.connectionState) {
        case 'connected':
          this.onStatus('live', 'En vivo');
          this.#sendStatus();
          break;
        case 'disconnected':
          this.onStatus('connecting', 'Señal inestable…');
          break;
        case 'failed':
          this.onStatus('error', 'Conexión fallida, reintentando…');
          setTimeout(() => this.#pc === pc && this.#negotiate().catch((e) => this.#fail(e)), RECONNECT_MS);
          break;
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.#send({ type: 'offer', sdp: offer.sdp });
    this.#sendStatus();
    await this.#applyEncoding();
    this.#startStats(pc);
  }

  /**
   * Cada 2 s lee lo que el codificador está enviando DE VERDAD (resolución,
   * fps, bitrate, códec y por qué se limita) y lo comparte con la PC.
   */
  #startStats(pc) {
    clearInterval(this.#statsTimer);
    this.#lastOutbound = null;
    this.#statsTimer = setInterval(async () => {
      if (this.#pc !== pc) return clearInterval(this.#statsTimer);
      const report = await pc.getStats(this.#videoSender?.track ?? null).catch(() => null);
      if (!report) return;
      let out = null;
      let source = null;
      let pair = null;
      const codecs = new Map();
      report.forEach((s) => {
        if (s.type === 'outbound-rtp' && s.kind === 'video') out = s;
        if (s.type === 'media-source' && s.kind === 'video') source = s;
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
        if (s.type === 'codec') codecs.set(s.id, s.mimeType);
      });
      if (!out) return;
      // El candidate-pair y los candidatos están en el informe completo.
      const full = await pc.getStats().catch(() => null);
      let lossPct = null;
      full?.forEach((s) => {
        if (!pair && s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
        if (s.type === 'remote-inbound-rtp' && s.kind === 'video' && s.fractionLost != null) {
          lossPct = s.fractionLost * 100;
        }
      });
      // Transporte: UDP directo es lo ideal; TCP o "prflx" lento explican un bitrate bajo.
      const local = pair && full?.get(pair.localCandidateId);
      const remote = pair && full?.get(pair.remoteCandidateId);
      const transport = local
        ? `${(local.protocol ?? '?').toUpperCase()} ${local.candidateType ?? ''}→${remote?.candidateType ?? '?'}`
        : null;

      let kbps = null;
      if (this.#lastOutbound) {
        const dt = (out.timestamp - this.#lastOutbound.timestamp) / 1000;
        if (dt > 0) kbps = ((out.bytesSent - this.#lastOutbound.bytesSent) * 8) / dt / 1000;
      }
      this.#lastOutbound = { timestamp: out.timestamp, bytesSent: out.bytesSent };

      const stats = {
        type: 'stats',
        width: out.frameWidth ?? null,
        height: out.frameHeight ?? null,
        fps: out.framesPerSecond ?? null,
        kbps,
        codec: (codecs.get(out.codecId) ?? '').replace('video/', ''),
        encoder: out.encoderImplementation ?? '',
        limit: out.qualityLimitationReason ?? 'none', // none | bandwidth | cpu | other
        // fps que entrega la cámara (si es bajo, el problema es la cámara/luz, no la red).
        cameraFps: source?.framesPerSecond ?? this.#videoTrack()?.getSettings().frameRate ?? null,
        // Ancho de banda que WebRTC estima disponible hacia la PC.
        availableKbps: pair?.availableOutgoingBitrate ? pair.availableOutgoingBitrate / 1000 : null,
        transport,
        rttMs: pair?.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
        lossPct,
      };
      this.onStats(stats);
      this.#send(stats);
    }, STATS_INTERVAL_MS);
  }

  /**
   * Parámetros del codificador: techo de bitrate según la resolución (WebRTC
   * adapta por debajo de él) y `balanced`: si la red o la CPU no dan para todo,
   * reparte el recorte entre resolución y fps. (`maintain-resolution` llegó a
   * dejar 1080p a 2 fps cuando el ancho de banda estimado cayó.)
   */
  async #applyEncoding() {
    const sender = this.#videoSender;
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    const q = QUALITIES[this.quality];
    params.encodings[0].maxBitrate = this.#light ? Math.min(q.maxBitrate, 2_500_000) : q.maxBitrate;
    params.encodings[0].maxFramerate = 30;
    params.encodings[0].scaleResolutionDownBy = this.#light && q.width > 1280 ? q.width / 1280 : 1;
    params.encodings[0].networkPriority = 'high';
    params.encodings[0].priority = 'high';
    params.degradationPreference = 'balanced';
    await sender.setParameters(params).catch((e) => console.warn('[sender] setParameters', e));
  }

  #closePeer() {
    clearInterval(this.#statsTimer);
    if (this.#pc) {
      this.#pc.onconnectionstatechange = null;
      this.#pc.onicecandidate = null;
      this.#pc.close();
    }
    this.#pc = null;
    this.#videoSender = null;
    this.#pendingCandidates = [];
  }

  #fail(err) {
    console.error('[sender]', err);
    this.onStatus('error', `Error: ${err?.message ?? err}`);
  }
}
