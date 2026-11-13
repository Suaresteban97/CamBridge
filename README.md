# CamBridge

Usa la cámara de tu celular como monitor en vivo en tu PC (Windows, macOS, Linux) vía red local y graba el flujo directamente a disco.

- **Tauri v2 + Rust** en el backend, **HTML/CSS/JS puro** (ES Modules) en el frontend. Sin Node, sin NPM, sin bundlers.
- **Binario portable:** el frontend del escritorio lo incrusta Tauri y la vista móvil la sirve axum desde `rust-embed`. Todo queda dentro del ejecutable.
- **Conexión por QR:** la app detecta la IP LAN, levanta un servidor HTTPS/WSS en el puerto `8443` y muestra un QR con la URL.
- **Grabación segura:** cada 3 s, MediaRecorder envía un fragmento a Rust, que lo añade al archivo y hace `fsync`. Si la app se cae, se conserva todo lo grabado hasta el último fragmento.

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

## Notas y limitaciones

- **Archivos WebM de MediaRecorder:** no incluyen duración ni índice de búsqueda. VLC, mpv y los navegadores los reproducen bien. Para un archivo con índice: `ffmpeg -i grabacion.webm -c copy fija.webm`.
- **Linux:** WebKitGTK necesita soporte de WebRTC (WebKitGTK ≥ 2.42 compilado con WebRTC y los plugins de GStreamer mencionados arriba). Algunas distribuciones lo traen deshabilitado. En ese caso la app avisa de que no hay `RTCPeerConnection`.
- **Bitrate adaptativo:** lo gestiona el control de congestión de WebRTC. El celular fija un techo de 2,5 Mbps (720p) o 6 Mbps (1080p) con `degradationPreference: balanced`.
- **Un solo celular a la vez:** una conexión nueva reemplaza a la anterior. Si el celular se reconecta durante una grabación, se continúa en un archivo nuevo.

## Estructura

```text
frontend/                 HTML/CSS/JS puro (desktop + mobile)
src-tauri/src/lib.rs      arranque, estado global y comandos
src-tauri/src/server/     http.rs · signaling.rs · network.rs · tls.rs
src-tauri/src/storage/    recorder.rs (append + fsync de fragmentos)
.github/workflows/        release.yml (Windows, macOS arm64/x64, Linux)
```
