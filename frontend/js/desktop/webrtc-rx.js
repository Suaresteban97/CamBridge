/**
 * Lado receptor de WebRTC (escritorio).
 *
 * El celular siempre es quien crea la oferta (sendonly). El escritorio responde
 * con una answer (recvonly). La señalización llega como eventos Tauri y se
 * envía con `invoke("send_signal")` (ver `src-tauri/src/server/signaling.rs`).
 *
 * El control de bitrate adaptativo lo hace el propio WebRTC (estimación de
 * ancho de banda por congestión + RTCP). Aquí solo medimos y lo mostramos.
 */

/** En LAN bastan los candidatos "host"; no hace falta STUN/TURN. */
const RTC_CONFIG = { iceServers: [] };

export class WebRtcReceiver {
  /** @type {RTCPeerConnection | null} */
  #pc = null;
  /** Candidatos ICE recibidos antes de tener la descripción remota. */
  #pendingCandidates = [];
  #lastStats = null;

  /**
   * @param {object} opts
   * @param {(msg: object) => Promise<void>} opts.sendSignal  envía al celular
   * @param {(stream: MediaStream) => void}  opts.onStream    hay video entrante
   * @param {(state: string) => void}        opts.onState     idle|connecting|connected|failed
   * @param {(status: object) => void}       opts.onRemoteStatus  info de cámara del celular
   */
  constructor({ sendSignal, onStream, onState, onRemoteStatus }) {
    this.sendSignal = sendSignal;
    this.onStream = onStream;
    this.onState = onState;
    this.onRemoteStatus = onRemoteStatus;
  }

  /** Procesa un mensaje de señalización proveniente del celular. */
  async handleSignal(msg) {
    switch (msg?.type) {
      case 'peer-joined':
        this.close();
        this.onState('connecting');
        break;
      case 'offer':
        await this.#acceptOffer(msg.sdp);
        break;
      case 'candidate':
        await this.#addCandidate(msg.candidate);
        break;
      case 'status':
        this.onRemoteStatus(msg);
        break;
      case 'bye':
      case 'peer-left':
        this.close();
        this.onState('idle');
        break;
      default:
        console.debug('[rx] mensaje ignorado', msg);
    }
  }

  /** Pide al celular (si ya estaba conectado) que renegocie. Útil al recargar la ventana. */
  async requestOffer() {
    try {
      await this.sendSignal({ type: 'request-offer' });
      this.onState('connecting');
    } catch {
      /* no hay celular conectado todavía: es normal */
    }
  }

  close() {
    if (this.#pc) {
      this.#pc.ontrack = null;
      this.#pc.onicecandidate = null;
      this.#pc.onconnectionstatechange = null;
      this.#pc.close();
    }
    this.#pc = null;
    this.#pendingCandidates = [];
    this.#lastStats = null;
  }

  async #acceptOffer(sdp) {
    this.close();
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.#pc = pc;
    this.onState('connecting');

    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      this.onStream(stream);
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.sendSignal({ type: 'candidate', candidate: ev.candidate.toJSON() }).catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') this.onState('connected');
      else if (s === 'failed') this.onState('failed');
      else if (s === 'disconnected') this.onState('connecting');
    };

    await pc.setRemoteDescription({ type: 'offer', sdp });

    for (const c of this.#pendingCandidates) {
      await pc.addIceCandidate(c).catch((e) => console.warn('[rx] candidato inválido', e));
    }
    this.#pendingCandidates = [];

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.sendSignal({ type: 'answer', sdp: answer.sdp });
  }

  async #addCandidate(candidate) {
    if (!candidate) return;
    if (!this.#pc || !this.#pc.remoteDescription) {
      this.#pendingCandidates.push(candidate);
      return;
    }
    await this.#pc.addIceCandidate(candidate).catch((e) => console.warn('[rx] candidato inválido', e));
  }

  /**
   * Estadísticas del video entrante: resolución, fps y bitrate (kbps)
   * calculado como delta de bytes entre dos muestras.
   */
  async getStats() {
    if (!this.#pc) return null;
    const report = await this.#pc.getStats();
    let inbound = null;
    report.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') inbound = s;
    });
    if (!inbound) return null;

    let kbps = null;
    if (this.#lastStats) {
      const dt = (inbound.timestamp - this.#lastStats.timestamp) / 1000;
      const db = inbound.bytesReceived - this.#lastStats.bytesReceived;
      if (dt > 0) kbps = (db * 8) / dt / 1000;
    }
    this.#lastStats = { timestamp: inbound.timestamp, bytesReceived: inbound.bytesReceived };

    return {
      width: inbound.frameWidth ?? null,
      height: inbound.frameHeight ?? null,
      fps: inbound.framesPerSecond ?? null,
      kbps,
    };
  }
}
