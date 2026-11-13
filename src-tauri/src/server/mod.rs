//! Servidor embebido que atiende al celular:
//! - `network`   → detección de IPs LAN y generación de QR (SVG).
//! - `tls`       → certificado autofirmado (rcgen) para servir en HTTPS.
//! - `http`      → servidor axum + rust-embed (sirve `mobile.html` y sus assets).
//! - `signaling` → WebSocket para intercambiar SDP/ICE entre celular y escritorio.

pub mod http;
pub mod network;
pub mod signaling;
pub mod tls;

use std::net::{SocketAddr, TcpListener};

use serde::Serialize;
use tauri::{AppHandle, Manager};

pub use network::Endpoint;
pub use signaling::SignalingHub;

/// Puerto preferido. Se mantiene fijo para que el navegador del celular
/// recuerde la excepción del certificado entre sesiones.
const PREFERRED_PORT: u16 = 8443;

/// Información expuesta al frontend de escritorio.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub port: u16,
    /// Una entrada por interfaz de red; la primera es la recomendada.
    pub endpoints: Vec<Endpoint>,
}

/// Prepara certificado, socket y QR de forma síncrona (rápido) y lanza el
/// servidor en el runtime async de Tauri.
pub fn start(app: &AppHandle) -> Result<(ServerInfo, SignalingHub), Box<dyn std::error::Error>> {
    // 1) IPs de la LAN.
    let ips = network::lan_ipv4_candidates();

    // 2) Certificado autofirmado (persistido en la carpeta de datos de la app).
    let tls_dir = app.path().app_data_dir()?.join("tls");
    let tls = tls::load_or_create(&tls_dir, &ips)?;

    // 3) Socket TCP: puerto fijo o, si está ocupado, uno libre.
    let listener = TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], PREFERRED_PORT)))
        .or_else(|_| TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], 0))))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();

    // 4) URLs + QR por cada interfaz.
    let endpoints = network::build_endpoints(&ips, port)?;

    // 5) Hub de señalización y arranque del servidor.
    let hub = SignalingHub::new(app.clone());
    let server_hub = hub.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = http::serve(listener, tls, server_hub).await {
            eprintln!("[cambridge] el servidor HTTPS se detuvo: {err}");
        }
    });

    Ok((ServerInfo { port, endpoints }, hub))
}
