/**
 * Controlador principal del escritorio:
 * - Pinta el QR y la URL que entrega Rust.
 * - Conecta el receptor WebRTC con los eventos de señalización de Tauri.
 * - Adapta el escenario a la orientación del video entrante.
 * - Controla la grabación a disco.
 */
import { WebRtcReceiver } from './webrtc-rx.js';
import { StreamRecorder } from './recorder.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const el = {
  shell: document.querySelector('.shell'),
  qr: $('qr'),
  url: $('url'),
  ifaceField: $('iface-field'),
  iface: $('iface'),
  conn: $('conn-state'),
  res: $('stat-res'),
  orient: $('stat-orient'),
  fps: $('stat-fps'),
  bitrate: $('stat-bitrate'),
  camera: $('stat-camera'),
  stage: $('stage'),
  video: $('video'),
  badgeOrient: $('badge-orient'),
  badgeRec: $('badge-rec'),
  recBtn: $('rec-btn'),
  recTime: $('rec-time'),
  recSize: $('rec-size'),
  recPath: $('rec-path'),
  btnAudio: $('btn-audio'),
  btnPanel: $('btn-panel'),
  btnFull: $('btn-full'),
  toast: $('toast'),
};

/** @type {MediaStream | null} */
let currentStream = null;
let recStartedAt = 0;
let recTimer = 0;
/** Si la grabación se cortó porque cambió el stream, se reanuda en un archivo nuevo. */
let resumeRecording = false;

// ───────────────────────── Utilidades UI ─────────────────────────

let toastTimer = 0;
function toast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle('error', isError);
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), isError ? 6000 : 3500);
}

const fmtBytes = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000);
  return [s / 3600, (s % 3600) / 60, s % 60].map((n) => String(Math.floor(n)).padStart(2, '0')).join(':');
};

const CONN_LABELS = {
  idle: 'Esperando celular',
  connecting: 'Conectando…',
  connected: 'En vivo',
  failed: 'Falló la conexión',
};

function setConnState(state) {
  el.conn.dataset.state = state;
  el.conn.textContent = CONN_LABELS[state] ?? state;
  if (state === 'idle' || state === 'failed') setLive(false);
}

function setLive(live) {
  el.stage.classList.toggle('live', live);
  el.recBtn.disabled = !live && !recorder.isRecording;
  if (!live) {
    el.video.srcObject = null;
    currentStream = null;
    el.badgeOrient.hidden = true;
    for (const k of ['res', 'orient', 'fps', 'bitrate']) el[k].textContent = '—';
  }
}

// ───────────────────────── QR / servidor ─────────────────────────

function showEndpoint(ep) {
  el.qr.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(ep.qrSvg)}`;
  el.url.textContent = ep.url;
}

async function initServerInfo() {
  const info = await invoke('get_server_info');
  const eps = info.endpoints;
  showEndpoint(eps[0]);

  if (eps.length > 1) {
    el.ifaceField.hidden = false;
    el.iface.innerHTML = '';
    eps.forEach((ep, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${ep.ip} · ${ep.interface}`;
      el.iface.append(opt);
    });
    el.iface.onchange = () => showEndpoint(eps[Number(el.iface.value)]);
  }

  el.url.onclick = async () => {
    try {
      await navigator.clipboard.writeText(el.url.textContent);
      toast('URL copiada');
    } catch {
      /* portapapeles no disponible */
    }
  };
}

// ───────────────────────── Orientación ─────────────────────────

/** Se dispara cuando cambian las dimensiones intrínsecas del video (p. ej. al rotar el celular). */
function onVideoResize() {
  const { videoWidth: w, videoHeight: h } = el.video;
  if (!w || !h) return;

  const orientation = h > w ? 'portrait' : 'landscape';
  if (el.stage.dataset.orientation !== orientation) {
    el.stage.dataset.orientation = orientation;
    // Breve fundido para que el cambio 9:16 ⇄ 16:9 no sea brusco.
    el.stage.classList.add('reflow');
    setTimeout(() => el.stage.classList.remove('reflow'), 160);
  }

  const label = orientation === 'portrait' ? 'Vertical 9:16' : 'Horizontal 16:9';
  el.orient.textContent = label;
  el.res.textContent = `${w}×${h}`;
  el.badgeOrient.textContent = `${w}×${h}`;
  el.badgeOrient.hidden = false;
}

// ───────────────────────── WebRTC ─────────────────────────

const receiver = new WebRtcReceiver({
  sendSignal: (message) => invoke('send_signal', { message }),
  onState: setConnState,
  onRemoteStatus: (s) => {
    const cam = s.facing === 'user' ? 'Frontal' : 'Trasera';
    el.camera.textContent = `${cam} · ${s.quality ?? ''}`;
  },
  onStream: (stream) => {
    if (currentStream === stream) return;
    const wasRecording = recorder.isRecording;
    currentStream = stream;
    el.video.srcObject = stream;
    el.video.play().catch(() => {});
    setLive(true);

    // Si el celular se reconectó durante una grabación, se continúa en un archivo nuevo.
    if (wasRecording || resumeRecording) {
      resumeRecording = false;
      restartRecording();
    }
  },
});

/** Muestreo periódico de estadísticas. */
setInterval(async () => {
  const s = await receiver.getStats().catch(() => null);
  if (!s) return;
  if (s.fps != null) el.fps.textContent = Math.round(s.fps).toString();
  if (s.kbps != null) {
    el.bitrate.textContent = s.kbps >= 1000 ? `${(s.kbps / 1000).toFixed(1)} Mbps` : `${Math.round(s.kbps)} kbps`;
  }
}, 1000);

// ───────────────────────── Grabación ─────────────────────────

const recorder = new StreamRecorder({
  invoke,
  onProgress: (bytes) => {
    el.recSize.textContent = fmtBytes(bytes);
  },
  onStopped: (info) => {
    setRecordingUi(false);
    if (info) {
      el.recPath.textContent = `Guardado: ${info.path}`;
      toast(`Grabación guardada (${fmtBytes(info.bytes)})`);
    }
    // Si el stream se cortó (no fue el usuario), intentar reanudar al volver.
    if (!userStopped) resumeRecording = true;
  },
  onError: (err) => {
    console.error('[recorder]', err);
    toast(`Error de grabación: ${err?.message ?? err}`, true);
  },
});
let userStopped = false;

function setRecordingUi(on) {
  el.recBtn.classList.toggle('recording', on);
  el.recBtn.querySelector('.rec-label').textContent = on ? 'Detener' : 'Grabar';
  el.badgeRec.hidden = !on;
  clearInterval(recTimer);
  if (on) {
    recStartedAt = Date.now();
    el.recTime.textContent = '00:00:00';
    el.recSize.textContent = '0 MB';
    recTimer = setInterval(() => (el.recTime.textContent = fmtTime(Date.now() - recStartedAt)), 500);
  }
  el.recBtn.disabled = !on && !currentStream;
}

async function startRecording() {
  if (!currentStream) return;
  userStopped = false;
  try {
    const info = await recorder.start(currentStream);
    el.recPath.textContent = `Grabando en: ${info.path}`;
    setRecordingUi(true);
  } catch (err) {
    toast(`No se pudo iniciar la grabación: ${err?.message ?? err}`, true);
  }
}

async function stopRecording() {
  userStopped = true;
  resumeRecording = false;
  el.recBtn.disabled = true;
  try {
    await recorder.stop();
  } catch (err) {
    toast(`Error al detener: ${err?.message ?? err}`, true);
  } finally {
    setRecordingUi(false);
  }
}

async function restartRecording() {
  if (recorder.isRecording) {
    userStopped = false;
    await recorder.stop().catch(() => {});
  }
  await startRecording();
}

el.recBtn.onclick = () => (recorder.isRecording ? stopRecording() : startRecording());

// ───────────────────────── Barra de herramientas ─────────────────────────

el.btnAudio.onclick = () => {
  el.video.muted = !el.video.muted;
  el.btnAudio.textContent = el.video.muted ? '🔇' : '🔊';
};

el.btnPanel.onclick = () => {
  const hidden = el.shell.classList.toggle('panel-hidden');
  el.btnPanel.textContent = hidden ? '⇥' : '⇤';
};

el.btnFull.onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else el.stage.requestFullscreen().catch(() => {});
};
el.stage.ondblclick = el.btnFull.onclick;

el.video.addEventListener('resize', onVideoResize);
el.video.addEventListener('loadedmetadata', onVideoResize);

// ───────────────────────── Arranque ─────────────────────────

async function main() {
  if (!StreamRecorder.isSupported()) {
    el.recPath.textContent = 'Este WebView no soporta MediaRecorder: la grabación no está disponible.';
  }
  if (typeof RTCPeerConnection === 'undefined') {
    toast('Este WebView no soporta WebRTC. En Linux necesitas WebKitGTK con WebRTC habilitado.', true);
  }

  try {
    await initServerInfo();
  } catch (err) {
    toast(`No se pudo obtener la información del servidor: ${err}`, true);
  }

  await listen('signal', (event) => {
    receiver.handleSignal(event.payload).catch((err) => {
      console.error('[signal]', err);
      setConnState('failed');
    });
  });

  // Si la ventana se recargó con un celular ya conectado, pedimos una oferta nueva.
  if (await invoke('mobile_connected')) await receiver.requestOffer();
}

main();
