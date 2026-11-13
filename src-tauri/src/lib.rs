//! Punto de entrada de CamBridge.
//!
//! Responsabilidades de este módulo:
//! - Instalar el proveedor criptográfico de rustls.
//! - Arrancar el servidor HTTPS/WSS embebido (módulo `server`).
//! - Registrar el estado global y los comandos Tauri (`invoke`).

mod server;
mod storage;

use server::{ServerInfo, SignalingHub};
use storage::recorder::{self, RecorderState};
use tauri::{Manager, State};

/// Estado global compartido con los comandos.
pub struct AppState {
    pub server: ServerInfo,
    pub hub: SignalingHub,
}

/// Devuelve la información del servidor (URLs + QR en SVG) para el panel de conexión.
#[tauri::command]
fn get_server_info(state: State<'_, AppState>) -> ServerInfo {
    state.server.clone()
}

/// Reenvía un mensaje de señalización WebRTC (answer / ICE) del escritorio al celular.
#[tauri::command]
fn send_signal(state: State<'_, AppState>, message: serde_json::Value) -> Result<(), String> {
    state.hub.send_to_mobile(message.to_string())
}

/// Indica si hay un celular conectado al WebSocket de señalización.
#[tauri::command]
fn mobile_connected(state: State<'_, AppState>) -> bool {
    state.hub.is_connected()
}

pub fn run() {
    // rustls 0.23 exige un proveedor criptográfico de proceso. Usamos `ring`
    // (compila sin CMake/NASM en los tres sistemas operativos).
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        .manage(RecorderState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let (info, hub) = server::start(&handle)?;
            println!("[cambridge] servidor listo en {:?}", info.endpoints.first().map(|e| &e.url));
            app.manage(AppState { server: info, hub });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_server_info,
            send_signal,
            mobile_connected,
            recorder::start_recording,
            recorder::append_chunk,
            recorder::stop_recording,
        ])
        .run(tauri::generate_context!())
        .expect("error al ejecutar CamBridge");
}
