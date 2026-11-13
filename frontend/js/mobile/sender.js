/**
 * Emisor WebRTC (celular).
 *
 * - Captura la cámara con getUserMedia (requiere HTTPS → certificado de Rust).
 * - Se conecta por WSS a `/ws` y es quien crea la oferta (sendonly).
 * - Cambiar cámara o resolución NO renegocia: se usa `replaceTrack` /
 *   `applyConstraints`, así el escritorio no pierde la conexión ni la grabación.
 * - Bitrate adaptativo: WebRTC ajusta el bitrate según la congestión de la red
 *   (GCC/TWCC). Nosotros fijamos un techo (`maxBitrate`) por resolución y
 *   `degradationPreference: "balanced"` para que, si la red empeora, baje un
 *   poco la resolución y los fps en vez de congelarse.
 */

const RTC_CONFIG = { iceServers: [] };

export const QUALITIES = {
  '720p': { width: 1280, height: 720, maxBitrate: 2_500_000 },
  '1080p': { width: 1920, height: 1080, maxBitrate: 6_000_000 },
};

const RECONNECT_MS = 2000;

export class CameraSender {
  facing = 'environment'; // 'environment' (trasera) | 'user' (frontal)
  quality = '720p';
  micEnabled = true;

  /** @type {MediaStream | null} */ stream = null;
  /** @type {WebSocket | null} */ #ws = null;
  /** @type {RTCPeerConnection | null} */ #pc = null;
  /** @type {RTCRtpSender | null} */ #videoSender = null;
  #pendingCandidates = [];
  #reconnectTimer = 0;

  /**
   * @param {object} opts
   * @param {HTMLVideoElement} opts.preview
   * @param {(state: 'connecting'|'live'|'error', text: string) => void} opts.onStatus
   * @param {(w: number, h: number) => void} opts.onResolution
   */
  constructor({ preview, onStatus, onResolution }) {
    this.preview = preview;
    this.onStatus = onStatus;
    this.onResolution = onResolution;
  }

  /** Pide permisos, muestra la vista previa y abre la señalización. */
  async start() {
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
    await this.#applyBitrate();
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
    await this.#applyBitrate();
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
    this.onStatus('connecting', 'Conectando con la PC…');

    const ws = new WebSocket(`wss://${location.host}/ws`);
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
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#closePeer();
      this.onStatus('connecting', 'Sin conexión con la PC, reintentando…');
      this.#reconnectTimer = setTimeout(() => this.#connect(), RECONNECT_MS);
    };
  }

  #send(msg) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(msg));
  }

  #sendStatus() {
    this.#send({ type: 'status', facing: this.facing, quality: this.quality });
  }

  async #onSignal(msg) {
    switch (msg.type) {
      case 'answer':
        await this.#pc?.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
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
    }
  }

  /** Crea una conexión WebRTC nueva y envía la oferta al escritorio. */
  async #negotiate() {
    this.#closePeer();
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.#pc = pc;

    const video = this.#videoTrack();
    this.#videoSender = pc.addTransceiver(video, { direction: 'sendonly', streams: [this.stream] }).sender;
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
    await this.#applyBitrate();
  }

  /** Techo de bitrate según la resolución elegida; WebRTC adapta por debajo de él. */
  async #applyBitrate() {
    const sender = this.#videoSender;
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = QUALITIES[this.quality].maxBitrate;
    params.encodings[0].maxFramerate = 30;
    params.degradationPreference = 'balanced';
    await sender.setParameters(params).catch((e) => console.warn('[sender] setParameters', e));
  }

  #closePeer() {
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
