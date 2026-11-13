//! Servidor HTTPS (axum + rustls) que sirve la vista móvil incrustada en el
//! binario con `rust-embed` y expone el WebSocket de señalización en `/ws`.

use std::net::TcpListener;

use axum::{
    body::Body,
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use axum_server::tls_rustls::RustlsConfig;
use rust_embed::RustEmbed;

use super::signaling::{self, SignalingHub};
use super::tls::TlsMaterial;

/// Toda la carpeta `frontend/` queda incrustada en el ejecutable en release.
/// En debug, rust-embed lee del disco: los cambios se ven sin recompilar.
#[derive(RustEmbed)]
#[folder = "../frontend/"]
struct Assets;

/// Construye el router: `/ws` para señalización y el resto para archivos estáticos.
fn router(hub: SignalingHub) -> Router {
    Router::new()
        .route("/ws", get(signaling::ws_handler))
        .fallback(static_handler)
        .with_state(hub)
}

/// Arranca el servidor HTTPS sobre un socket ya enlazado.
pub async fn serve(listener: TcpListener, tls: TlsMaterial, hub: SignalingHub) -> Result<(), String> {
    let config = RustlsConfig::from_pem(tls.cert_pem.into_bytes(), tls.key_pem.into_bytes())
        .await
        .map_err(|e| format!("certificado TLS inválido: {e}"))?;

    axum_server::from_tcp_rustls(listener, config)
        .serve(router(hub).into_make_service())
        .await
        .map_err(|e| e.to_string())
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
