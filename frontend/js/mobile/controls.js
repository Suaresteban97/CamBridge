/**
 * Controles táctiles del celular: inicio, cambio de cámara, resolución,
 * micrófono, giro y grabación HQ. También mantiene la pantalla encendida
 * (Wake Lock): si el celular se bloquea, la cámara se detiene.
 */
import { CameraSender } from './sender.js';
import { OrientationWatcher } from './orientation.js';
import { HqRecorder } from './hq-recorder.js';

const $ = (id) => document.getElementById(id);
const ui = {
  preview: $('preview'),
  intro: $('intro'),
  introError: $('intro-error'),
  btnStart: $('btn-start'),
  topbar: $('topbar'),
  status: $('status'),
  resChip: $('res-chip'),
  controls: $('controls'),
  btnFlip: $('btn-flip'),
  btnRotate: $('btn-rotate'),
  rotateLabel: $('rotate-label'),
  btnMic: $('btn-mic'),
  micIcon: $('mic-icon'),
  btnRec: $('btn-rec'),
  qualityButtons: [...document.querySelectorAll('[data-quality]')],
};

const sender = new CameraSender({
  preview: ui.preview,
  onStatus: (state, text) => {
    ui.status.dataset.state = state;
    ui.status.textContent = text;
  },
  onResolution: (w, h) => {
    // Resolución que entrega la cámara (hasta que lleguen las estadísticas de envío).
    if (!ui.resChip.dataset.live) ui.resChip.textContent = `${w}×${h}`;
  },
  onStats: (s) => {
    // Lo que realmente sale hacia la PC.
    if (!s.width) return;
    ui.resChip.dataset.live = '1';
    const mbps = s.kbps != null ? ` · ${(s.kbps / 1000).toFixed(1)} Mbps` : '';
    const warn = s.limit && s.limit !== 'none' ? ' ⚠' : '';
    ui.resChip.textContent = `${s.width}×${s.height}${mbps}${warn}`;
  },
  // La PC pide iniciar/detener la grabación HQ.
  onCommand: (msg) => {
    if (msg.type === 'hq-start') startHq();
    else if (msg.type === 'hq-stop') stopHq();
  },
});

// ───────────────────────── Grabación HQ ─────────────────────────

const fmtMB = (b) => `${(b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB`;
const fmtClock = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const hq = new HqRecorder({
  onState: (s) => {
    ui.btnRec.dataset.state = s.state;
    ui.btnRec.textContent =
      s.state === 'recording'
        ? `■ ${fmtClock(s.elapsedMs)}${s.pendingBytes > 4e6 ? ` · ↑${fmtMB(s.pendingBytes)}` : ''}`
        : s.state === 'finishing'
          ? `Subiendo ${fmtMB(s.pendingBytes)}…`
          : s.state === 'starting'
            ? 'Iniciando…'
            : '● HQ';
    if (s.state === 'error' && s.message) {
      ui.status.dataset.state = 'error';
      ui.status.textContent = s.message;
    }
    // Mientras graba no se puede cambiar de cámara ni de resolución (cortaría el archivo).
    const locked = hq.active;
    [ui.btnFlip, ...ui.qualityButtons].forEach((b) => (b.disabled = locked));
    // Se informa a la PC (pendiente de subir, errores…).
    sender.notify({ type: 'hq', ...s });
  },
});

async function startHq() {
  if (hq.active || !sender.stream) return;
  try {
    await hq.start(sender.stream, { quality: sender.quality, rotation: sender.rotation });
    await sender.setPreviewLight(true);
  } catch (err) {
    sender.notify({ type: 'hq', state: 'error', message: err?.message ?? String(err) });
  }
}

async function stopHq() {
  await hq.stop();
  await sender.setPreviewLight(false);
}

ui.btnRec.onclick = () => (hq.active ? stopHq() : startHq());

// ───────────────────────── Wake Lock ─────────────────────────

let wakeLock = null;
async function keepScreenOn() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    /* no soportado o denegado: no es crítico */
  }
}
// El wake lock se libera al pasar a segundo plano; se pide de nuevo al volver.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLock?.released !== false) keepScreenOn();
});

// ───────────────────────── Acciones ─────────────────────────

/** Desactiva controles mientras una operación de cámara está en curso. */
async function busy(fn) {
  const all = [ui.btnFlip, ui.btnRotate, ui.btnMic, ...ui.qualityButtons];
  all.forEach((b) => (b.disabled = true));
  try {
    await fn();
  } catch (err) {
    ui.status.dataset.state = 'error';
    ui.status.textContent = err?.message ?? String(err);
  } finally {
    all.forEach((b) => (b.disabled = false));
    ui.btnMic.disabled = !sender.hasAudio;
    if (hq.active) [ui.btnFlip, ...ui.qualityButtons].forEach((b) => (b.disabled = true));
  }
}

const orientation = new OrientationWatcher((correction) => sender.setDeviceCorrection(correction));

ui.btnStart.onclick = async () => {
  // Debe pedirse antes de cualquier `await` para que iOS lo asocie al toque del usuario.
  const motionPermission = OrientationWatcher.requestPermission();
  ui.btnStart.disabled = true;
  ui.introError.hidden = true;
  try {
    if (await motionPermission) orientation.start();
    await sender.start();
    ui.intro.hidden = true;
    ui.topbar.hidden = false;
    ui.controls.hidden = false;
    ui.btnMic.disabled = !sender.hasAudio;
    if (!sender.hasAudio) ui.btnMic.classList.add('off');
    keepScreenOn();
  } catch (err) {
    ui.introError.textContent = describeError(err);
    ui.introError.hidden = false;
    ui.btnStart.disabled = false;
  }
};

ui.btnFlip.onclick = () => busy(() => sender.toggleFacing());

// Giro manual: útil con el bloqueo de rotación activado o si el automático no acierta.
ui.btnRotate.onclick = () => {
  const deg = sender.rotateManually();
  ui.rotateLabel.textContent = `${deg}°`;
  ui.btnRotate.classList.toggle('active', deg !== 0);
};

ui.btnMic.onclick = () => {
  const on = !sender.micEnabled;
  sender.setMic(on);
  ui.btnMic.classList.toggle('off', !on);
  ui.micIcon.textContent = on ? '🎙️' : '🔇';
};

for (const btn of ui.qualityButtons) {
  btn.onclick = () =>
    busy(async () => {
      await sender.setQuality(btn.dataset.quality);
      ui.qualityButtons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.quality === sender.quality)));
    });
}

function describeError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
      return 'Permiso de cámara denegado. Habilítalo en los ajustes del navegador y recarga.';
    case 'NotFoundError':
      return 'No se encontró ninguna cámara.';
    case 'NotReadableError':
      return 'La cámara está en uso por otra aplicación.';
    default:
      return err?.message ?? String(err);
  }
}
