//! Señalización WebRTC.
//!
//! El celular se conecta por WSS a `/ws`. El escritorio NO usa WebSocket (su
//! WebView rechazaría el certificado autofirmado); en su lugar Rust actúa de
//! puente:
//!
//! ```text
//!  celular ──WSS──▶ Rust ──evento Tauri "signal"──▶ escritorio
//!  celular ◀──WSS── Rust ◀──invoke("send_signal")── escritorio
//! ```
//!
//! Solo se admite un celular a la vez: una conexión nueva reemplaza a la anterior.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

/// Nombre del evento Tauri que recibe el escritorio.
pub const SIGNAL_EVENT: &str = "signal";

struct Peer {
    id: u64,
    tx: mpsc::UnboundedSender<String>,
}

/// Puente entre el WebSocket del celular y la ventana de escritorio.
#[derive(Clone)]
pub struct SignalingHub {
    peer: Arc<Mutex<Option<Peer>>>,
    next_id: Arc<AtomicU64>,
    app: AppHandle,
}

impl SignalingHub {
    pub fn new(app: AppHandle) -> Self {
        Self {
            peer: Arc::new(Mutex::new(None)),
            next_id: Arc::new(AtomicU64::new(1)),
            app,
        }
    }

    /// Envía un mensaje (JSON serializado) al celular conectado.
    pub fn send_to_mobile(&self, msg: String) -> Result<(), String> {
        let guard = self.peer.lock().map_err(|_| "estado de señalización corrupto")?;
        let peer = guard.as_ref().ok_or("no hay ningún celular conectado")?;
        peer.tx.send(msg).map_err(|_| "la conexión con el celular se cerró".to_string())
    }

    pub fn is_connected(&self) -> bool {
        self.peer.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    /// Reenvía un mensaje al escritorio.
    fn emit(&self, value: Value) {
        if let Err(err) = self.app.emit(SIGNAL_EVENT, value) {
            eprintln!("[signaling] no se pudo emitir al escritorio: {err}");
        }
    }

    /// Registra un nuevo celular y devuelve su id. Al soltar el `tx` anterior,
    /// la tarea escritora del celular previo termina y cierra su socket.
    fn register(&self, tx: mpsc::UnboundedSender<String>) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut guard) = self.peer.lock() {
            *guard = Some(Peer { id, tx });
        }
        id
    }

    /// Elimina el celular solo si sigue siendo el activo. Devuelve `true` si lo era.
    fn unregister(&self, id: u64) -> bool {
        let Ok(mut guard) = self.peer.lock() else { return false };
        if guard.as_ref().is_some_and(|p| p.id == id) {
            *guard = None;
            true
        } else {
            false
        }
    }
}

/// Handler de axum para `/ws`.
pub async fn ws_handler(ws: WebSocketUpgrade, State(hub): State<SignalingHub>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, hub))
}

async fn handle_socket(socket: WebSocket, hub: SignalingHub) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let id = hub.register(tx);
    hub.emit(json!({ "type": "peer-joined" }));

    // Tarea escritora: escritorio → celular.
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    // Bucle lector: celular → escritorio.
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(text) => match serde_json::from_str::<Value>(text.as_str()) {
                Ok(value) => hub.emit(value),
                Err(err) => eprintln!("[signaling] JSON inválido del celular: {err}"),
            },
            Message::Close(_) => break,
            _ => {} // ping/pong los gestiona axum
        }
    }

    if hub.unregister(id) {
        hub.emit(json!({ "type": "peer-left" }));
    }
    writer.abort();
}
