//! Marca la rotación de un MP4 sin recodificar.
//!
//! El celular graba los cuadros tal como los entrega la cámara. Si el teléfono
//! está en horizontal con el bloqueo de rotación activado, la imagen queda de
//! lado. En vez de girar píxeles (costoso), escribimos la matriz de
//! transformación de la pista de video (`moov/trak/tkhd`), igual que hacen las
//! cámaras y `ffmpeg -metadata:s:v rotate=…`. YouTube, VLC, los navegadores y
//! los editores la respetan.
//!
//! El segmento de inicialización (`ftyp` + `moov`) va en el PRIMER fragmento
//! que emite MediaRecorder, así que basta con parchear ese fragmento.

/// Matrices de visualización (a, b, u, c, d, v, x, y, w) en punto fijo 16.16 / 2.30.
fn rotation_matrix(degrees: u16) -> [u32; 9] {
    const ONE: u32 = 0x0001_0000;
    const NEG_ONE: u32 = 0xFFFF_0000;
    const W: u32 = 0x4000_0000;
    match degrees % 360 {
        90 => [0, ONE, 0, NEG_ONE, 0, 0, 0, 0, W],
        180 => [NEG_ONE, 0, 0, 0, NEG_ONE, 0, 0, 0, W],
        270 => [0, NEG_ONE, 0, ONE, 0, 0, 0, 0, W],
        _ => [ONE, 0, 0, 0, ONE, 0, 0, 0, W],
    }
}

/// Un box MP4: rango del payload (sin cabecera) y tipo.
struct BoxRef {
    kind: [u8; 4],
    payload_start: usize,
    end: usize,
}

/// Itera los boxes contenidos en `buf[start..end]`.
fn boxes(buf: &[u8], start: usize, end: usize) -> Vec<BoxRef> {
    let mut out = Vec::new();
    let mut pos = start;
    while pos + 8 <= end {
        let size32 = u32::from_be_bytes(buf[pos..pos + 4].try_into().unwrap()) as usize;
        let kind: [u8; 4] = buf[pos + 4..pos + 8].try_into().unwrap();
        let (header, size) = match size32 {
            0 => (8, end - pos), // hasta el final
            1 => {
                if pos + 16 > end {
                    break;
                }
                let large = u64::from_be_bytes(buf[pos + 8..pos + 16].try_into().unwrap()) as usize;
                (16, large)
            }
            n => (8, n),
        };
        if size < header || pos + size > end {
            break; // box truncado o corrupto: no seguimos
        }
        out.push(BoxRef { kind, payload_start: pos + header, end: pos + size });
        pos += size;
    }
    out
}

fn child<'a>(list: &'a [BoxRef], kind: &[u8; 4]) -> Option<&'a BoxRef> {
    list.iter().find(|b| &b.kind == kind)
}

/// Escribe la rotación en la(s) pista(s) de video. Devuelve `true` si se aplicó.
pub fn apply_rotation(buf: &mut [u8], degrees: u16) -> bool {
    let top = boxes(buf, 0, buf.len());
    let Some(moov) = child(&top, b"moov") else { return false };
    let traks: Vec<(usize, usize)> = boxes(buf, moov.payload_start, moov.end)
        .into_iter()
        .filter(|b| &b.kind == b"trak")
        .map(|b| (b.payload_start, b.end))
        .collect();

    let matrix = rotation_matrix(degrees);
    let mut applied = false;

    for (start, end) in traks {
        let trak = boxes(buf, start, end);

        // ¿Es la pista de video? mdia/hdlr: version+flags(4) pre_defined(4) handler_type(4)
        let is_video = child(&trak, b"mdia")
            .map(|mdia| boxes(buf, mdia.payload_start, mdia.end))
            .and_then(|mdia| child(&mdia, b"hdlr").map(|h| (h.payload_start, h.end)))
            .is_some_and(|(p, e)| p + 12 <= e && &buf[p + 8..p + 12] == b"vide");
        if !is_video {
            continue;
        }

        let Some(tkhd) = child(&trak, b"tkhd") else { continue };
        let p = tkhd.payload_start;
        if p >= tkhd.end {
            continue;
        }
        // tkhd v0: matriz en el byte 40 del payload; v1 (campos de 64 bits): byte 52.
        let offset = if buf[p] == 1 { 52 } else { 40 };
        let m = p + offset;
        if m + 36 > tkhd.end {
            continue;
        }
        for (i, value) in matrix.iter().enumerate() {
            buf[m + i * 4..m + i * 4 + 4].copy_from_slice(&value.to_be_bytes());
        }
        applied = true;
    }
    applied
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut v = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(kind);
        v.extend_from_slice(payload);
        v
    }

    fn tkhd_v0() -> Vec<u8> {
        let mut p = vec![0u8; 84]; // tamaño del payload de tkhd v0
        let identity = rotation_matrix(0);
        for (i, v) in identity.iter().enumerate() {
            p[40 + i * 4..44 + i * 4].copy_from_slice(&v.to_be_bytes());
        }
        make_box(b"tkhd", &p)
    }

    fn trak(handler: &[u8; 4]) -> Vec<u8> {
        let mut hdlr = vec![0u8; 8];
        hdlr.extend_from_slice(handler);
        hdlr.extend_from_slice(&[0u8; 13]);
        let mdia = make_box(b"mdia", &make_box(b"hdlr", &hdlr));
        let mut inner = tkhd_v0();
        inner.extend(mdia);
        make_box(b"trak", &inner)
    }

    fn sample() -> Vec<u8> {
        let mut moov_payload = make_box(b"mvhd", &[0u8; 100]);
        moov_payload.extend(trak(b"soun"));
        moov_payload.extend(trak(b"vide"));
        let mut file = make_box(b"ftyp", b"isom\0\0\0\0isomavc1");
        file.extend(make_box(b"moov", &moov_payload));
        file.extend(make_box(b"moof", &[0u8; 16]));
        file
    }

    fn read_matrix(buf: &[u8], handler: &[u8; 4]) -> [u32; 9] {
        let pos = buf.windows(4).position(|w| w == handler).unwrap();
        // El tkhd de esa pista está antes del mdia: buscamos hacia atrás.
        let tkhd = buf[..pos].windows(4).rposition(|w| w == b"tkhd").unwrap();
        let m = tkhd + 4 + 40;
        let mut out = [0u32; 9];
        for (i, o) in out.iter_mut().enumerate() {
            *o = u32::from_be_bytes(buf[m + i * 4..m + i * 4 + 4].try_into().unwrap());
        }
        out
    }

    #[test]
    fn rotates_only_video_track() {
        let mut buf = sample();
        assert!(apply_rotation(&mut buf, 90));
        assert_eq!(read_matrix(&buf, b"vide"), rotation_matrix(90));
        assert_eq!(read_matrix(&buf, b"soun"), rotation_matrix(0));
    }

    #[test]
    fn ignores_non_mp4_and_truncated_data() {
        let mut webm = vec![0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0, 1, 2, 3];
        assert!(!apply_rotation(&mut webm, 90));
        let mut truncated = sample();
        truncated.truncate(60);
        assert!(!apply_rotation(&mut truncated, 270));
    }
}
