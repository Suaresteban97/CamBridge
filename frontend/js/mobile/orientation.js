/**
 * Orientación física del celular.
 *
 * Problema: el navegador entrega los cuadros de la cámara alineados con la
 * PANTALLA, no con el TELÉFONO. Si el usuario tiene el bloqueo de rotación
 * activado (o el navegador no rota la página), al inclinar el celular la
 * pantalla sigue en vertical y el video sigue siendo 9:16 con la escena de lado.
 *
 * Solución:
 * - `OrientationWatcher` lee el acelerómetro (gravedad) para saber cómo está
 *   girado físicamente el teléfono y calcula la corrección respecto a la pantalla.
 * - El celular NO procesa los cuadros (eso restaba fluidez): solo informa los
 *   grados al escritorio, que gira la imagen (ver `js/desktop/rotation.js`).
 * Si el navegador ya rotó la pantalla, la corrección es 0.
 */

const IS_IOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** m/s² mínimos sobre un eje para considerarlo "hacia abajo" (evita ruido con el teléfono plano). */
const GRAVITY_THRESHOLD = 5;
/** Tiempo que la nueva orientación debe mantenerse antes de aplicarse (anti-parpadeo). */
const STABLE_MS = 350;

const screenAngle = () => {
  const a = screen.orientation?.angle ?? window.orientation ?? 0;
  return ((a % 360) + 360) % 360;
};

export class OrientationWatcher {
  /** Ángulo físico del teléfono: 0 vertical, 90 girado a la izquierda, 180 invertido, 270 a la derecha. */
  deviceAngle = 0;
  #candidate = 0;
  #candidateSince = 0;
  #lastCorrection = 0;

  /** @param {(correction: number) => void} onChange recibe 0 | 90 | 180 | 270 */
  constructor(onChange) {
    this.onChange = onChange;
  }

  /**
   * iOS 13+ exige pedir permiso al acelerómetro dentro de un gesto del usuario.
   * Hay que llamarlo de forma síncrona en el `click` (antes de cualquier `await`).
   */
  static requestPermission() {
    const DME = window.DeviceMotionEvent;
    if (DME && typeof DME.requestPermission === 'function') {
      return DME.requestPermission().then((r) => r === 'granted').catch(() => false);
    }
    return Promise.resolve(true);
  }

  start() {
    window.addEventListener('devicemotion', this.#onMotion);
    screen.orientation?.addEventListener('change', this.#emitIfChanged);
    window.addEventListener('orientationchange', this.#emitIfChanged);
  }

  /** Grados que hay que girar la imagen respecto a la pantalla para que quede derecha. */
  get correction() {
    return (((this.deviceAngle - screenAngle()) % 360) + 360) % 360;
  }

  #onMotion = (ev) => {
    const g = ev.accelerationIncludingGravity;
    if (!g || g.x == null || g.y == null) return;
    // iOS reporta la gravedad con el signo invertido respecto a Android.
    const x = IS_IOS ? -g.x : g.x;
    const y = IS_IOS ? -g.y : g.y;
    const ax = Math.abs(x);
    const ay = Math.abs(y);

    let angle = null;
    if (ay > GRAVITY_THRESHOLD && ay > ax * 1.5) angle = y > 0 ? 0 : 180;
    else if (ax > GRAVITY_THRESHOLD && ax > ay * 1.5) angle = x > 0 ? 90 : 270;
    if (angle === null) return; // teléfono plano o en diagonal: mantener la anterior

    const now = performance.now();
    if (angle !== this.#candidate) {
      this.#candidate = angle;
      this.#candidateSince = now;
    } else if (angle !== this.deviceAngle && now - this.#candidateSince >= STABLE_MS) {
      this.deviceAngle = angle;
      this.#emitIfChanged();
    }
  };

  #emitIfChanged = () => {
    const c = this.correction;
    if (c !== this.#lastCorrection) {
      this.#lastCorrection = c;
      this.onChange(c);
    }
  };
}
