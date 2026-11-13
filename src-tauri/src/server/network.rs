//! Detección de la IP local (LAN) y generación del código QR en SVG.

use std::net::{IpAddr, Ipv4Addr};

use qrcode::{render::svg, EcLevel, QrCode};
use serde::Serialize;

/// Una forma de llegar al servidor desde el celular.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub ip: String,
    pub interface: String,
    pub url: String,
    /// Documento SVG completo del QR que codifica `url`.
    pub qr_svg: String,
}

/// Devuelve las IPv4 utilizables de la máquina, con la IP de la ruta por
/// defecto (la del Wi-Fi/Ethernet principal) en primer lugar.
///
/// Se listan todas porque en Windows es habitual tener adaptadores virtuales
/// (Hyper-V, WSL, VPN) y la IP "por defecto" no siempre es la del Wi-Fi.
pub fn lan_ipv4_candidates() -> Vec<(String, Ipv4Addr)> {
    let primary = local_ip_address::local_ip().ok();
    let mut out: Vec<(String, Ipv4Addr)> = Vec::new();

    if let Ok(list) = local_ip_address::list_afinet_netifas() {
        for (name, ip) in list {
            let IpAddr::V4(v4) = ip else { continue };
            if v4.is_loopback() || v4.is_link_local() || v4.is_unspecified() {
                continue;
            }
            if out.iter().any(|(_, known)| *known == v4) {
                continue;
            }
            out.push((name, v4));
        }
    }

    // Orden: primero la IP por defecto, luego rangos privados (192.168/10/172.16).
    out.sort_by_key(|(_, ip)| {
        let is_primary = primary == Some(IpAddr::V4(*ip));
        (!is_primary, !ip.is_private())
    });

    if out.is_empty() {
        match primary {
            Some(IpAddr::V4(v4)) => out.push(("default".into(), v4)),
            // Sin red: dejamos loopback para que la app al menos arranque.
            _ => out.push(("loopback".into(), Ipv4Addr::LOCALHOST)),
        }
    }
    out
}

/// Construye la URL HTTPS y su QR para cada IP.
pub fn build_endpoints(ips: &[(String, Ipv4Addr)], port: u16) -> Result<Vec<Endpoint>, String> {
    ips.iter()
        .map(|(iface, ip)| {
            let url = format!("https://{ip}:{port}/");
            Ok(Endpoint {
                ip: ip.to_string(),
                interface: iface.clone(),
                qr_svg: qr_svg(&url)?,
                url,
            })
        })
        .collect()
}

/// Genera un QR en SVG (blanco/negro, con zona de silencio para lectura fiable).
pub fn qr_svg(data: &str) -> Result<String, String> {
    let code = QrCode::with_error_correction_level(data.as_bytes(), EcLevel::M)
        .map_err(|e| format!("no se pudo generar el QR: {e}"))?;
    Ok(code
        .render::<svg::Color>()
        .min_dimensions(320, 320)
        .quiet_zone(true)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .build())
}
