//! Certificado TLS autofirmado para servir en HTTPS dentro de la LAN.
//!
//! `navigator.mediaDevices.getUserMedia` solo está disponible en contextos
//! seguros (HTTPS o localhost). Como el celular accede por IP, necesitamos
//! HTTPS. Generamos un certificado con `rcgen` cuyas SAN incluyen todas las
//! IPs LAN detectadas y lo persistimos para que el navegador del celular solo
//! tenga que aceptar la advertencia una vez (mientras no cambie la IP).

use std::fs;
use std::net::Ipv4Addr;
use std::path::Path;

use chrono::{Datelike, Local};
use rcgen::{
    date_time_ymd, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, KeyPair,
};

/// Material PEM listo para rustls.
pub struct TlsMaterial {
    pub cert_pem: String,
    pub key_pem: String,
}

const CERT_FILE: &str = "cert.pem";
const KEY_FILE: &str = "key.pem";
const META_FILE: &str = "meta.txt";
/// Se regenera antes de caducar (el certificado dura 365 días).
const MAX_AGE_DAYS: i64 = 300;

/// Carga el certificado guardado si sigue siendo válido para las IPs actuales;
/// si no, genera uno nuevo y lo guarda.
pub fn load_or_create(dir: &Path, ips: &[(String, Ipv4Addr)]) -> Result<TlsMaterial, String> {
    let mut sans: Vec<String> = ips.iter().map(|(_, ip)| ip.to_string()).collect();
    sans.push("localhost".into());
    sans.sort();
    sans.dedup();
    let fingerprint = sans.join(",");

    if let Some(existing) = load_existing(dir, &fingerprint) {
        return Ok(existing);
    }

    let material = generate(sans)?;
    fs::create_dir_all(dir).map_err(|e| format!("no se pudo crear {dir:?}: {e}"))?;
    let today = Local::now().date_naive();
    fs::write(dir.join(CERT_FILE), &material.cert_pem).map_err(|e| e.to_string())?;
    fs::write(dir.join(KEY_FILE), &material.key_pem).map_err(|e| e.to_string())?;
    fs::write(dir.join(META_FILE), format!("{fingerprint}\n{today}")).map_err(|e| e.to_string())?;
    Ok(material)
}

fn load_existing(dir: &Path, fingerprint: &str) -> Option<TlsMaterial> {
    let meta = fs::read_to_string(dir.join(META_FILE)).ok()?;
    let mut lines = meta.lines();
    if lines.next()? != fingerprint {
        return None; // cambiaron las IPs → nuevo certificado
    }
    let created = chrono::NaiveDate::parse_from_str(lines.next()?, "%Y-%m-%d").ok()?;
    if (Local::now().date_naive() - created).num_days() > MAX_AGE_DAYS {
        return None;
    }
    Some(TlsMaterial {
        cert_pem: fs::read_to_string(dir.join(CERT_FILE)).ok()?,
        key_pem: fs::read_to_string(dir.join(KEY_FILE)).ok()?,
    })
}

fn generate(sans: Vec<String>) -> Result<TlsMaterial, String> {
    // rcgen interpreta automáticamente las cadenas que son IPs como SAN de tipo IP.
    let mut params = CertificateParams::new(sans).map_err(|e| e.to_string())?;

    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "CamBridge Local");
    dn.push(DnType::OrganizationName, "CamBridge");
    params.distinguished_name = dn;

    // iOS/macOS rechazan certificados de servidor sin serverAuth o con validez > 825 días.
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let now = Local::now();
    let yesterday = now - chrono::Duration::days(1);
    params.not_before = date_time_ymd(yesterday.year(), yesterday.month() as u8, yesterday.day() as u8);
    let expiry = now + chrono::Duration::days(365);
    params.not_after = date_time_ymd(expiry.year(), expiry.month() as u8, expiry.day() as u8);

    let key_pair = KeyPair::generate().map_err(|e| e.to_string())?;
    let cert = params.self_signed(&key_pair).map_err(|e| e.to_string())?;

    Ok(TlsMaterial {
        cert_pem: cert.pem(),
        key_pem: key_pair.serialize_pem(),
    })
}
