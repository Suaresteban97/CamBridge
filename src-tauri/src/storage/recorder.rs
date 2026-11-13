//! Grabación continua a disco (streaming to disk).
//!
//! El escritorio produce un fragmento de `MediaRecorder` cada 3 s y lo envía
//! como binario crudo (sin serializar a JSON) con `invoke("append_chunk", bytes)`.
//! Cada fragmento se añade al final del archivo y se sincroniza con el disco,
//! de modo que si la app se cierra de golpe se conserva todo lo grabado hasta
//! el último fragmento. La RAM usada es como máximo un fragmento.

use std::path::PathBuf;

use chrono::Local;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};
use tokio::fs::{self, File, OpenOptions};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

/// Grabación en curso.
struct ActiveRecording {
    file: File,
    path: PathBuf,
    bytes: u64,
}

/// Estado gestionado por Tauri. `tokio::Mutex` porque se mantiene durante `.await`.
#[derive(Default)]
pub struct RecorderState {
    active: Mutex<Option<ActiveRecording>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    pub path: String,
    pub bytes: u64,
}

/// Crea `grabacion_YYYY-MM-DD_HH-MM-SS.<ext>` en la carpeta Videos del usuario.
/// `extension` depende del formato que soporte el WebView (`webm` o `mp4`).
#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    state: State<'_, RecorderState>,
    extension: Option<String>,
) -> Result<RecordingInfo, String> {
    let ext = match extension.as_deref() {
        Some("mp4") => "mp4",
        _ => "webm",
    };

    let dir = app
        .path()
        .video_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("no se encontró la carpeta Videos: {e}"))?;
    fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;

    let name = format!("grabacion_{}.{ext}", Local::now().format("%Y-%m-%d_%H-%M-%S"));
    let path = dir.join(name);
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await
        .map_err(|e| format!("no se pudo crear {}: {e}", path.display()))?;

    let mut guard = state.active.lock().await;
    if let Some(previous) = guard.take() {
        finalize(previous).await; // por seguridad, si quedó una abierta
    }
    *guard = Some(ActiveRecording { file, path: path.clone(), bytes: 0 });

    Ok(RecordingInfo { path: path.display().to_string(), bytes: 0 })
}

/// Añade un fragmento binario al archivo activo. Devuelve el total de bytes escritos.
#[tauri::command]
pub async fn append_chunk(request: Request<'_>, state: State<'_, RecorderState>) -> Result<u64, String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("se esperaba un cuerpo binario (Uint8Array)".into());
    };

    let mut guard = state.active.lock().await;
    let rec = guard.as_mut().ok_or("no hay ninguna grabación activa")?;

    rec.file.write_all(data).await.map_err(|e| format!("error de escritura: {e}"))?;
    rec.file.flush().await.map_err(|e| e.to_string())?;
    // Fuerza los datos al disco: resistencia ante cierres inesperados o cortes de luz.
    rec.file.sync_data().await.map_err(|e| e.to_string())?;
    rec.bytes += data.len() as u64;
    Ok(rec.bytes)
}

/// Cierra la grabación activa (si la hay) y devuelve su ruta y tamaño.
#[tauri::command]
pub async fn stop_recording(state: State<'_, RecorderState>) -> Result<Option<RecordingInfo>, String> {
    let mut guard = state.active.lock().await;
    Ok(match guard.take() {
        Some(rec) => Some(finalize(rec).await),
        None => None,
    })
}

async fn finalize(mut rec: ActiveRecording) -> RecordingInfo {
    let _ = rec.file.flush().await;
    let _ = rec.file.sync_all().await;
    RecordingInfo { path: rec.path.display().to_string(), bytes: rec.bytes }
}
