//! Servidor HTTPS (axum + rustls) que sirve la vista móvil incrustada en el
//! binario con `rust-embed` y expone el WebSocket de señalización en `/ws`.
//!
//! Toda petición pasa primero por `local_only` (rechaza IPs de Internet).
//! `/ws` y `/api/check` exigen además el token de emparejamiento del QR.

use std::collections::HashMap;
use std::net::{SocketAddr, TcpListener};
use std::sync::Arc;

use axum::{
    body::{Body, Bytes},
    extract::{ConnectInfo, DefaultBodyLimit, Query, Request, State},
    http::{header, HeaderValue, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use axum_server::tls_rustls::RustlsConfig;
use rust_embed::RustEmbed;
use serde_json::json;

use super::security;
use super::signaling::{self, SignalingHub};
use super::tls::TlsMaterial;
use crate::storage::hq::{HqError, HqRecorder};

/// Tamaño máximo de un fragmento HQ (2 s a 20 Mbps ≈ 5 MB; margen amplio).
const MAX_CHUNK_BYTES: usize = 256 * 1024 * 1024;

/// Toda la carpeta `frontend/` queda incrustada en el ejecutable en release.
/// En debug, rust-embed lee del disco: los cambios se ven sin recompilar.
#[derive(RustEmbed)]
#[folder = "../frontend/"]
struct Assets;

/// Estado compartido por los handlers.
#[derive(Clone)]
pub struct ServerState {
    pub hub: SignalingHub,
    pub token: Arc<str>,
    pub hq: Arc<HqRecorder>,
}

impl ServerState {
    /// Valida `?t=<token>` de la query.
    pub fn authorized(&self, query: &HashMap<String, String>) -> bool {
        query
            .get("t")
            .is_some_and(|given| security::token_matches(&self.token, given))
    }
}

/// Construye el router: `/ws` para señalización, `/api/check` y archivos estáticos.
fn router(state: ServerState) -> Router {
    Router::new()
        .route("/ws", get(signaling::ws_handler))
        .route("/api/check", get(check_token))
        .route("/api/hq/start", post(hq_start))
        .route("/api/hq/chunk", post(hq_chunk).layer(DefaultBodyLimit::max(MAX_CHUNK_BYTES)))
        .route("/api/hq/stop", post(hq_stop))
        .fallback(static_handler)
        .layer(middleware::from_fn(security_headers))
        .layer(middleware::from_fn(local_only))
        .with_state(state)
}

/// Arranca el servidor HTTPS sobre un socket ya enlazado.
pub async fn serve(listener: TcpListener, tls: TlsMaterial, state: ServerState) -> Result<(), String> {
    let config = RustlsConfig::from_pem(tls.cert_pem.into_bytes(), tls.key_pem.into_bytes())
        .await
        .map_err(|e| format!("certificado TLS inválido: {e}"))?;

    axum_server::from_tcp_rustls(listener, config)
        // ConnectInfo expone la IP de origen a `local_only`.
        .serve(router(state).into_make_service_with_connect_info::<SocketAddr>())
        .await
        .map_err(|e| e.to_string())
}

/// Barrera 1: solo dispositivos de la red local.
async fn local_only(ConnectInfo(addr): ConnectInfo<SocketAddr>, req: Request, next: Next) -> Response {
    if security::is_local_addr(addr.ip()) {
        next.run(req).await
    } else {
        eprintln!("[security] rechazada conexión externa desde {addr}");
        (StatusCode::FORBIDDEN, "403 · solo red local").into_response()
    }
}

/// Cabeceras defensivas: sin incrustar en iframes, sin sniffing, sin referrer
/// (el token va en la URL y no debe filtrarse) y la cámara solo para este origen.
async fn security_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert(
        "permissions-policy",
        HeaderValue::from_static("camera=(self), microphone=(self), accelerometer=(self), geolocation=()"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; \
             media-src 'self' blob: mediastream:; connect-src 'self' wss:; frame-ancestors 'none'",
        ),
    );
    res
}

/// Permite al celular saber si su token sigue vigente (p. ej. tras reiniciar la app).
async fn check_token(State(state): State<ServerState>, Query(q): Query<HashMap<String, String>>) -> StatusCode {
    if state.authorized(&q) {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::FORBIDDEN
    }
}

// ───────────────────────── Modo HQ ─────────────────────────

type Q = Query<HashMap<String, String>>;

fn hq_error(err: HqError) -> Response {
    match err {
        HqError::NoSession => (StatusCode::NOT_FOUND, Json(json!({ "error": "no-session" }))).into_response(),
        HqError::OutOfOrder { expected } => {
            (StatusCode::CONFLICT, Json(json!({ "error": "out-of-order", "expected": expected }))).into_response()
        }
        HqError::Io(msg) => {
            eprintln!("[hq] {msg}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": msg }))).into_response()
        }
    }
}

/// `POST /api/hq/start?t=&ext=mp4|webm&rotation=0|90|180|270`
async fn hq_start(State(state): State<ServerState>, Query(q): Q) -> Response {
    if !state.authorized(&q) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let ext = q.get("ext").map(String::as_str).unwrap_or("mp4");
    let rotation = q.get("rotation").and_then(|r| r.parse::<u16>().ok()).unwrap_or(0);
    match state.hq.start(ext, rotation).await {
        Ok(started) => Json(started).into_response(),
        Err(e) => hq_error(e),
    }
}

/// `POST /api/hq/chunk?t=&id=&seq=` con el fragmento como cuerpo binario.
async fn hq_chunk(State(state): State<ServerState>, Query(q): Q, body: Bytes) -> Response {
    if !state.authorized(&q) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let (Some(id), Some(seq)) = (q.get("id"), q.get("seq").and_then(|s| s.parse::<u64>().ok())) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match state.hq.append(id, seq, &body).await {
        Ok(bytes) => Json(json!({ "bytes": bytes })).into_response(),
        Err(e) => hq_error(e),
    }
}

/// `POST /api/hq/stop?t=&id=`
async fn hq_stop(State(state): State<ServerState>, Query(q): Q) -> Response {
    if !state.authorized(&q) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(id) = q.get("id") else { return StatusCode::BAD_REQUEST.into_response() };
    match state.hq.stop(id).await {
        Ok(info) => Json(info).into_response(),
        Err(e) => hq_error(e),
    }
}

/// Sirve archivos de `frontend/`. La raíz `/` entrega la vista del celular.
async fn static_handler(uri: Uri) -> Response {
    let path = match uri.path().trim_start_matches('/') {
        "" => "mobile.html",
        p => p,
    };

    match Assets::get(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            Response::builder()
                .header(header::CONTENT_TYPE, mime.as_ref())
                // Sin caché: tras actualizar la app, el celular recibe siempre la última versión.
                .header(header::CACHE_CONTROL, "no-cache")
                .body(Body::from(file.data.into_owned()))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        None => (StatusCode::NOT_FOUND, "404 · recurso no encontrado").into_response(),
    }
}
