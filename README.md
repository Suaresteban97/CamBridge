# CamBridge

Usa la cámara de tu celular como monitor en vivo en tu PC (Windows, macOS, Linux) vía red local y graba el flujo directamente a disco.

- **Tauri v2 + Rust** en el backend, **HTML/CSS/JS puro** (ES Modules) en el frontend. Sin Node, sin NPM, sin bundlers.
- **Binario portable:** el frontend del escritorio lo incrusta Tauri y la vista móvil la sirve axum desde `rust-embed`. Todo queda dentro del ejecutable.
- **Conexión por QR:** la app detecta la IP LAN, levanta un servidor HTTPS/WSS en el puerto `8443` y muestra un QR con la URL.
- **Grabación en alta calidad (modo HQ, por defecto):** el celular graba con su codificador por hardware (MP4/H.264, 1080p30, ~20 Mbps) y sube un fragmento cada 2 s por HTTPS. Rust los escribe en orden estricto (número de secuencia, reintentos idempotentes) y hace `fsync`. La calidad del archivo no depende de la red: si la Wi-Fi fluctúa, la subida solo se retrasa. Si el teléfono está girado, la rotación se marca en la cabecera del MP4, sin recodificar.
- **Grabación de la transmisión (modo alternativo):** la PC graba lo que llega por WebRTC, en fragmentos de 3 s que se escriben y sincronizan a disco. Su calidad es la de la vista en vivo.

## Arquitectura

```text
 Celular (navegador)                         PC (CamBridge)
 ┌───────────────────┐  HTTPS  mobile.html   ┌──────────────────────────────┐
 │ getUserMedia      │◀──────────────────────│ axum + rustls + rust-embed   │
 │ RTCPeerConnection │  WSS /ws  (SDP/ICE)   │ signaling.rs ──evento "signal"──▶ WebView
 │ (sendonly)        │◀─────────────────────▶│              ◀─invoke send_signal─ │
 └─────────┬─────────┘                       └──────────────────────────────┘
           │            WebRTC (SRTP, P2P en LAN)          ▲
           └───────────────────────────────────────────────┘ WebView: <video> + MediaRecorder
                                                             └─invoke append_chunk (binario)─▶ Videos/grabacion_*.webm
```

El escritorio **no** abre un WebSocket. Su WebView rechazaría el certificado autofirmado, así que Rust hace de puente entre el WSS del celular y los eventos/comandos de Tauri.

## Requisitos

| SO | Requisitos |
| --- | --- |
| Todos | Rust estable (`rustup`), `cargo install tauri-cli --version "^2" --locked` |
| Windows | Microsoft C++ Build Tools y WebView2 (ya viene en Windows 10/11) |
| macOS | Xcode Command Line Tools (`xcode-select --install`) |
| Linux | `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-nice` |

## Comandos

```bash
# 1. Instalar la CLI de Tauri (una sola vez, sin npm)
cargo install tauri-cli --version "^2" --locked

# 2. Desarrollo: compila y abre la app. En debug, rust-embed lee frontend/ del disco,
#    así que basta recargar la página del celular para ver los cambios del lado móvil.
cargo tauri dev

# 3. Build local de producción (instaladores en src-tauri/target/release/bundle/)
cargo tauri build

#    Solo el ejecutable portable, sin instaladores:
cargo tauri build --no-bundle      # → src-tauri/target/release/cambridge(.exe)

# 4. (Opcional) Regenerar iconos a partir del SVG
cargo tauri icon src-tauri/app-icon.svg -o src-tauri/icons

# 5. Publicar un release multiplataforma con GitHub Actions
git tag v0.1.0 && git push origin v0.1.0
```

## Uso

1. Abre CamBridge en la PC. Si el firewall pregunta, **permite el acceso en redes privadas**.
2. Con el celular en la misma red Wi-Fi, escanea el QR.
3. La primera vez aparece la advertencia de certificado: es el certificado autofirmado de tu PC.
   - **Chrome Android:** «Configuración avanzada» → «Acceder a 192.168.x.x (no seguro)».
   - **Safari iOS:** «Mostrar detalles» → «visitar este sitio web» → «Visitar sitio web».
4. Toca **Iniciar cámara** y acepta el permiso. Desde el celular puedes cambiar de cámara (⟲), alternar entre 720p y 1080p y silenciar el micrófono.
5. En la PC, pulsa **Grabar**. Los archivos se guardan como `~/Videos/grabacion_YYYY-MM-DD_HH-MM-SS.webm` (`.mp4` en macOS).

Si la PC tiene varias interfaces (WSL, VirtualBox, VPN), elige la del Wi-Fi en «Interfaz de red».

### Sobre HTTPS

`getUserMedia` solo funciona en contextos seguros. Al arrancar, `server/tls.rs` genera con **rcgen** un certificado ECDSA válido por 365 días (requisito de iOS: menos de 825 días y EKU `serverAuth`), con todas las IPs LAN como SAN. Se guarda en la carpeta de datos de la app (`%APPDATA%\io.cambridge.desktop\tls` en Windows) y solo se regenera si cambian las IPs o se acerca la caducidad. Como el puerto es fijo (8443), el navegador recuerda la excepción entre sesiones.

## Seguridad

CamBridge está pensado para usarse **solo dentro de tu red local**:

| Capa | Qué protege |
| --- | --- |
| **Filtro de IP de origen** (`server/security.rs`) | Se rechaza con 403 cualquier IP que no sea privada (192.168.x, 10.x, 172.16–31.x), loopback o link-local. Aunque se abriera el puerto en el router, nadie desde Internet puede usar la app. |
| **Token de emparejamiento** | Al arrancar se genera un secreto aleatorio de 128 bits que va dentro del QR. Sin él no se puede abrir el WebSocket, así que otro dispositivo conectado a tu Wi-Fi no puede enviar video ni desconectar tu celular. Al reiniciar la app, los enlaces anteriores dejan de funcionar. |
| **Cifrado** | La página y la señalización van por HTTPS/WSS (TLS). El video viaja por WebRTC con DTLS-SRTP, siempre cifrado. |
| **Sin servidores externos** | No se usan STUN ni TURN: el video va directo del celular a la PC sin salir de la red. |
| **Cabeceras** | CSP estricta, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` (el token no se filtra) y límite de 64 KB por mensaje de señalización. |

Recomendaciones:
- Cuando el Firewall de Windows pregunte, permite el acceso **solo en redes privadas**. En una Wi-Fi pública (cafeterías, hoteles) Windows bloqueará el puerto.
- No hagas *port forwarding* del puerto 8443 en el router. El filtro de IP lo bloquearía de todos modos, pero no tiene sentido exponerlo.
- El certificado es autofirmado. La primera vez, comprueba que la IP de la advertencia sea la de tu PC.

## Notas y limitaciones

- **Archivos WebM de MediaRecorder:** no incluyen duración ni índice de búsqueda. VLC, mpv y los navegadores los reproducen bien. Para un archivo con índice: `ffmpeg -i grabacion.webm -c copy fija.webm`.
- **Linux:** WebKitGTK necesita soporte de WebRTC (WebKitGTK ≥ 2.42 compilado con WebRTC y los plugins de GStreamer mencionados arriba). Algunas distribuciones lo traen deshabilitado. En ese caso la app avisa de que no hay `RTCPeerConnection`.
- **Bitrate adaptativo:** lo gestiona el control de congestión de WebRTC. El celular fija un techo de 2,5 Mbps (720p) o 6 Mbps (1080p) y prioriza mantener los fps (`degradationPreference: maintain-framerate`).
- **Giro:** el celular envía la cámara sin procesar y solo informa los grados (automático por acelerómetro o manual con ↻). La PC gira los cuadros (`js/desktop/rotation.js`). En Windows usa `MediaStreamTrackProcessor`, que sigue grabando aunque la app esté minimizada; en macOS y Linux usa un canvas.
- **Un solo celular a la vez:** una conexión nueva reemplaza a la anterior. Si el celular se reconecta durante una grabación, se continúa en un archivo nuevo.

## Estructura

```text
frontend/                 HTML/CSS/JS puro (desktop + mobile)
src-tauri/src/lib.rs      arranque, estado global y comandos
src-tauri/src/server/     http.rs · signaling.rs · network.rs · tls.rs · security.rs
src-tauri/src/storage/    recorder.rs (append + fsync de fragmentos)
.github/workflows/        release.yml (Windows, macOS arm64/x64, Linux)
```
