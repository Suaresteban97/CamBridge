//! Controles de acceso del servidor embebido.
//!
//! Dos barreras independientes:
//! 1. **Solo red local**: se rechaza cualquier conexión cuya IP de origen no sea
//!    privada (192.168.x.x, 10.x.x.x, 172.16-31.x.x), loopback o link-local.
//!    Aunque alguien abriera el puerto en el router, una IP de Internet recibe 403.
//! 2. **Token de emparejamiento**: secreto aleatorio de 128 bits generado en cada
//!    arranque y codificado en el QR. Sin él no se puede abrir el WebSocket, así
//!    que otro dispositivo de la misma Wi-Fi no puede enviar video ni desplazar
//!    al celular emparejado. Al reiniciar la app, los enlaces anteriores caducan.

use std::net::IpAddr;

/// `true` si la IP pertenece a una red local (nunca a Internet).
pub fn is_local_addr(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_local_addr(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            v6.is_loopback()
                || (first & 0xfe00) == 0xfc00 // ULA fc00::/7
                || (first & 0xffc0) == 0xfe80 // link-local fe80::/10
        }
    }
}

/// Genera un token aleatorio de 128 bits en hexadecimal (32 caracteres).
pub fn generate_token() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| format!("sin fuente de aleatoriedad: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Comparación en tiempo constante (no filtra cuántos caracteres coinciden).
pub fn token_matches(expected: &str, given: &str) -> bool {
    let (a, b) = (expected.as_bytes(), given.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_vs_public() {
        for ok in ["192.168.1.6", "10.0.0.2", "172.16.5.4", "127.0.0.1", "169.254.1.1", "::1", "fe80::1", "fd00::1", "::ffff:192.168.0.10"] {
            assert!(is_local_addr(ok.parse().unwrap()), "{ok} debería ser local");
        }
        for bad in ["8.8.8.8", "181.50.20.1", "172.32.0.1", "100.64.0.1", "2001:4860::8888", "::ffff:8.8.8.8"] {
            assert!(!is_local_addr(bad.parse().unwrap()), "{bad} NO debería ser local");
        }
    }

    #[test]
    fn token() {
        let t = generate_token().unwrap();
        assert_eq!(t.len(), 32);
        assert!(token_matches(&t, &t.clone()));
        assert!(!token_matches(&t, "x"));
        assert!(!token_matches(&t, &"0".repeat(32)));
    }
}
