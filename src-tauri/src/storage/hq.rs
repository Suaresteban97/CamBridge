//! Modo grabación HQ (alta calidad).
//!
//! El celular graba con su propio codificador por hardware (MediaRecorder,
//! 1080p30 a ~20 Mbps) y sube cada fragmento por HTTPS:
//!
//! ```text
//! POST /api/hq/start?ext=mp4&rotation=90  → { id, path }
//! POST /api/hq/chunk?id=…&seq=N  (cuerpo binario)  → { bytes }
//! POST /api/hq/stop?id=…  → { path, bytes }
//! ```
//!
//! A diferencia de WebRTC, HTTP/TCP no descarta datos: si la Wi-Fi fluctúa, el
//! fragmento solo tarda más (y el celular reintenta). El número de secuencia
//! garantiza orden estricto y hace idempotentes los reintentos.
//! El escritorio recibe el progreso con el evento Tauri `hq`.

use std::path::PathBuf;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use super::mp4;
use super::recorder::{RecorderState, RecordingInfo};
use crate::server::security;

pub const HQ_EVENT: &str = "hq";

struct Session {
    id: String,
    next_seq: u64,
    rotation: u16,
    is_mp4: bool,
}

pub struct HqRecorder {
    app: AppHandle,
    dir: PathBuf,
    file: RecorderState,
    session: Mutex<Option<Session>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HqStarted {
    pub id: String,
    pub path: String,
}

pub enum HqError {
    /// No hay sesión o el id no coincide (p. ej. ya se detuvo).
    NoSession,
    /// Llegó un fragmento adelantado; el celular debe reenviar desde `expected`.
    OutOfOrder { expected: u64 },
    Io(String),
}

impl HqRecorder {
    pub fn new(app: AppHandle, dir: PathBuf) -> Self {
        Self { app, dir, file: RecorderState::default(), session: Mutex::new(None) }
    }

    fn emit(&self, payload: serde_json::Value) {
        let _ = self.app.emit(HQ_EVENT, payload);
    }

    /// Abre un archivo nuevo. Si había otra sesión abierta, se cierra primero.
    pub async fn start(&self, extension: &str, rotation: u16) -> Result<HqStarted, HqError> {
        let mut session = self.session.lock().await;
        if session.take().is_some() {
            if let Some(info) = self.file.finish().await {
                self.emit(json!({ "state": "stopped", "path": info.path, "bytes": info.bytes }));
            }
        }

        let ext = if extension == "mp4" { "mp4" } else { "webm" };
        let info = self.file.begin(&self.dir, Some(ext)).await.map_err(HqError::Io)?;
        let id = security::generate_token().map_err(HqError::Io)?;
        *session = Some(Session {
            id: id.clone(),
            next_seq: 0,
            rotation: rotation % 360,
            is_mp4: ext == "mp4",
        });

        self.emit(json!({ "state": "started", "path": info.path }));
        Ok(HqStarted { id, path: info.path })
    }

    /// Escribe el fragmento `seq`. Reintentos de fragmentos ya escritos se aceptan sin duplicar.
    pub async fn append(&self, id: &str, seq: u64, data: &[u8]) -> Result<u64, HqError> {
        let mut guard = self.session.lock().await;
        let session = guard.as_mut().filter(|s| s.id == id).ok_or(HqError::NoSession)?;

        if seq < session.next_seq {
            // Reintento de algo que ya está en disco (se perdió la respuesta).
            return Ok(self.file.current().await.map_or(0, |i| i.bytes));
        }
        if seq > session.next_seq {
            return Err(HqError::OutOfOrder { expected: session.next_seq });
        }

        let total = if seq == 0 && session.is_mp4 && session.rotation != 0 {
            let mut first = data.to_vec();
            if !mp4::apply_rotation(&mut first, session.rotation) {
                eprintln!("[hq] no se encontró la cabecera MP4 para marcar la rotación");
            }
            self.file.append(&first).await
        } else {
            self.file.append(data).await
        }
        .map_err(HqError::Io)?;

        session.next_seq += 1;
        self.emit(json!({ "state": "progress", "bytes": total }));
        Ok(total)
    }

    /// Cierra la sesión y el archivo.
    pub async fn stop(&self, id: &str) -> Result<RecordingInfo, HqError> {
        let mut guard = self.session.lock().await;
        if !guard.as_ref().is_some_and(|s| s.id == id) {
            return Err(HqError::NoSession);
        }
        *guard = None;
        let info = self.file.finish().await.ok_or(HqError::NoSession)?;
        self.emit(json!({ "state": "stopped", "path": info.path, "bytes": info.bytes }));
        Ok(info)
    }
}
