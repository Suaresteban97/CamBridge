//! Persistencia en disco de las grabaciones.
//!
//! - `recorder` → grabación del stream WebRTC hecha en la PC (comandos Tauri).
//! - `hq`       → modo alta calidad: el celular graba y sube fragmentos por HTTPS.
//! - `mp4`      → marca la rotación en la cabecera de un MP4 (sin recodificar).

pub mod hq;
pub mod mp4;
pub mod recorder;

use std::path::PathBuf;

use chrono::Local;
use tauri::{AppHandle, Manager};

/// Carpeta donde se guardan las grabaciones: Videos del usuario (o su home).
pub fn recordings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .video_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("no se encontró la carpeta Videos: {e}"))
}

/// `grabacion_YYYY-MM-DD_HH-MM-SS.<ext>` (solo `mp4` o `webm`).
pub fn recording_file_name(extension: Option<&str>) -> String {
    let ext = match extension {
        Some("mp4") => "mp4",
        _ => "webm",
    };
    format!("grabacion_{}.{ext}", Local::now().format("%Y-%m-%d_%H-%M-%S"))
}
