// Imagens sintéticas pequenas para os testes de upload e de remoção de metadados (ADR-0006).
// Estruturalmente válidas (segmentos/chunks com tamanhos e CRC corretos), mas com dados de
// imagem mínimos. O "EXIF" carrega um GPS falso só para os testes provarem que ele some.
import { crc32, deflateSync } from "node:zlib";

const u16be = value => { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; };
const u32be = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const u32le = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };

export const FAKE_GPS = "fake-gps -23.5505,-46.6333";

// ---- JPEG ----
export const jpegSegment = (marker, payload) =>
  Buffer.concat([Buffer.from([0xff, marker]), u16be(payload.length + 2), payload]);

export function jpeg({ metadata = true } = {}) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),                                                   // SOI
    jpegSegment(0xe0, Buffer.from("JFIF\0\x01\x02\0\0\x01\0\x01\0\0", "latin1")), // APP0/JFIF (fica)
    ...(metadata ? [
      jpegSegment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from("II*\0 " + FAKE_GPS)])), // APP1/EXIF (sai)
      jpegSegment(0xed, Buffer.from("Photoshop 3.0\0fake-iptc")),                 // APP13/IPTC (sai)
      jpegSegment(0xfe, Buffer.from("comentario do autor"))                       // COM (sai)
    ] : []),
    jpegSegment(0xe2, Buffer.from("ICC_PROFILE\0\x01\x01fake-icc")),              // APP2/ICC (fica)
    jpegSegment(0xee, Buffer.from("Adobe\0fake-adobe")),                          // APP14/Adobe (fica)
    jpegSegment(0xdb, Buffer.alloc(65, 0x10)),                                    // DQT
    jpegSegment(0xda, Buffer.from("\x01\x01\0\0\x3f\0", "latin1")),               // SOS
    Buffer.from("dados-entropicos-fake"),
    Buffer.from([0xff, 0xd9])                                                     // EOI
  ]);
}

// ---- PNG ----
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const pngChunk = (type, data) => Buffer.concat([
  u32be(data.length), Buffer.from(type, "latin1"), data,
  u32be(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])))
]);

export function png({ metadata = true } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);  // largura 1
  ihdr.writeUInt32BE(1, 4);  // altura 1
  ihdr[8] = 8; ihdr[9] = 6;  // 8 bits por canal, RGBA
  const idat = deflateSync(Buffer.from([0, 255, 0, 0, 255])); // 1 scanline (filtro 0 + RGBA)
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    ...(metadata ? [
      pngChunk("eXIf", Buffer.from("II*\0 " + FAKE_GPS)),
      pngChunk("tEXt", Buffer.from("Author\0Velejadora")),
      pngChunk("zTXt", Buffer.from("Comment\0\0comprimido-fake")),
      pngChunk("iTXt", Buffer.from("Title\0\0\0\0\0titulo")),
      pngChunk("tIME", Buffer.from([0x07, 0xea, 1, 2, 3, 4, 5]))
    ] : []),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

// ---- WebP ----
export const webpChunk = (fourcc, data) => Buffer.concat([
  Buffer.from(fourcc, "latin1"), u32le(data.length), data,
  data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0) // chunks RIFF são alinhados a 2 bytes
]);

export function webp({ metadata = true, vp8x = true } = {}) {
  const chunks = [];
  if (vp8x) {
    const flags = Buffer.alloc(10); // VP8X: 1 byte de flags + 4 reservados + 3+3 de dimensões
    flags[0] = metadata ? 0x2c : 0x20; // ICC (0x20) + EXIF (0x08) + XMP (0x04)
    chunks.push(webpChunk("VP8X", flags), webpChunk("ICCP", Buffer.from("fake-icc")));
  }
  if (metadata) {
    chunks.push(
      webpChunk("EXIF", Buffer.from("II*\0 " + FAKE_GPS)),
      webpChunk("XMP ", Buffer.from("<x:xmpmeta>" + FAKE_GPS + "</x:xmpmeta>")) // tamanho ímpar de propósito
    );
  }
  chunks.push(webpChunk("VP8 ", Buffer.from("fake-vp8-frame")));
  const payload = Buffer.concat([Buffer.from("WEBP", "latin1"), ...chunks]);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), u32le(payload.length), payload]);
}
