// Remoção de metadados das fotos de perfil (ADR-0006) em JavaScript puro, sem dependência
// nativa: fotos de celular trazem GPS no EXIF e nada disso pode ser servido aos demais
// jogadores. Remove apenas segmentos/chunks independentes — os dados da imagem ficam byte a
// byte iguais. Arquivo malformado lança MalformedImageError e a API responde 400.
//
// - JPEG: descarta APP1 (EXIF/XMP), APP13 (IPTC/Photoshop) e COM; mantém APP0/JFIF, APP2/ICC,
//   APP14/Adobe e todo o resto. A orientação EXIF se perde junto (o cliente gira a foto antes
//   do envio; consequência registrada no ADR).
// - PNG: descarta os chunks eXIf, tEXt, iTXt, zTXt e tIME. Cada chunk carrega o próprio CRC,
//   então remover um chunk não exige recalcular nada.
// - WebP: descarta os chunks EXIF e "XMP ", desliga as flags correspondentes no VP8X e
//   reescreve o tamanho do RIFF.

export class MalformedImageError extends Error {
  constructor(detail) {
    super(`Imagem malformada: ${detail}`);
    this.name = "MalformedImageError";
  }
}

const JPEG_DROP = new Set([0xe1, 0xed, 0xfe]); // APP1, APP13, COM
const JPEG_SOS = 0xda;
const JPEG_EOI = 0xd9;
// Marcadores sem campo de tamanho: SOI, EOI, TEM e RST0–RST7.
const jpegStandalone = marker => marker === 0xd8 || marker === JPEG_EOI || marker === 0x01 ||
  (marker >= 0xd0 && marker <= 0xd7);

function stripJpeg(bytes) {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new MalformedImageError("JPEG sem SOI");
  const out = [Buffer.from([0xff, 0xd8])];
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw new MalformedImageError(`JPEG: esperado marcador em ${offset}`);
    while (offset + 1 < bytes.length && bytes[offset + 1] === 0xff) offset++; // bytes de preenchimento
    if (offset + 1 >= bytes.length) throw new MalformedImageError("JPEG truncado no marcador");
    const marker = bytes[offset + 1];
    if (marker === JPEG_SOS) { // cabeçalho do scan + dados entropicos + EOI: copia até o fim
      const length = bytes.readUInt16BE(offset + 2);
      if (offset + 4 > bytes.length || offset + 2 + length > bytes.length) {
        throw new MalformedImageError("JPEG: cabeçalho de scan truncado");
      }
      out.push(bytes.subarray(offset));
      return Buffer.concat(out);
    }
    if (jpegStandalone(marker)) {
      out.push(bytes.subarray(offset, offset + 2));
      offset += 2;
      if (marker === JPEG_EOI) return Buffer.concat(out);
      continue;
    }
    if (offset + 4 > bytes.length) throw new MalformedImageError("JPEG: tamanho de segmento truncado");
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) {
      throw new MalformedImageError("JPEG: tamanho de segmento inválido");
    }
    if (!JPEG_DROP.has(marker)) out.push(bytes.subarray(offset, offset + 2 + length));
    offset += 2 + length;
  }
  throw new MalformedImageError("JPEG sem scan nem EOI");
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME"]);
const PNG_TYPE = /^[A-Za-z]{4}$/;

function stripPng(bytes) {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new MalformedImageError("PNG sem assinatura");
  }
  const out = [PNG_SIGNATURE];
  let offset = 8;
  let first = true;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new MalformedImageError("PNG: cabeçalho de chunk truncado");
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (!PNG_TYPE.test(type)) throw new MalformedImageError(`PNG: tipo de chunk inválido (${JSON.stringify(type)})`);
    if (first && type !== "IHDR") throw new MalformedImageError("PNG: primeiro chunk não é IHDR");
    first = false;
    const end = offset + 12 + length;
    if (end > bytes.length) throw new MalformedImageError(`PNG: chunk ${type} além do fim do arquivo`);
    if (!PNG_DROP.has(type)) out.push(bytes.subarray(offset, end)); // CRC vai junto, sem recálculo
    if (type === "IEND") return Buffer.concat(out);
    offset = end;
  }
  throw new MalformedImageError("PNG sem IEND");
}

// Flags do primeiro byte do VP8X: ICC 0x20, alpha 0x10, EXIF 0x08, XMP 0x04, animação 0x02.
const VP8X_DROP_FLAGS = 0x0c;
const WEBP_IMAGE_CHUNKS = new Set(["VP8 ", "VP8L", "ANMF"]);

function stripWebp(bytes) {
  if (bytes.length < 12 ||
      bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WEBP") {
    throw new MalformedImageError("WebP sem contêiner RIFF/WEBP");
  }
  if (bytes.readUInt32LE(4) !== bytes.length - 8) throw new MalformedImageError("WebP: tamanho do RIFF não confere");
  const kept = [];
  let hasImage = false;
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new MalformedImageError("WebP: cabeçalho de chunk truncado");
    const fourcc = bytes.toString("latin1", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size % 2); // chunks RIFF são alinhados a 2 bytes
    if (end > bytes.length) throw new MalformedImageError(`WebP: chunk ${JSON.stringify(fourcc)} além do fim`);
    if (fourcc !== "EXIF" && fourcc !== "XMP ") {
      let chunk = bytes.subarray(offset, end);
      if (fourcc === "VP8X") {
        if (size < 10) throw new MalformedImageError("WebP: VP8X curto demais");
        chunk = Buffer.from(chunk); // cópia: o buffer de entrada não é modificado
        chunk[8] &= ~VP8X_DROP_FLAGS;
      }
      if (WEBP_IMAGE_CHUNKS.has(fourcc)) hasImage = true;
      kept.push(chunk);
    }
    offset = end;
  }
  if (!hasImage) throw new MalformedImageError("WebP sem dados de imagem");
  const payload = Buffer.concat([Buffer.from("WEBP", "latin1"), ...kept]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

const STRIPPERS = new Map([
  ["image/jpeg", stripJpeg],
  ["image/png", stripPng],
  ["image/webp", stripWebp]
]);

// Devolve uma cópia da imagem sem metadados; lança MalformedImageError se o arquivo não
// estiver estruturalmente íntegro. Nunca modifica o buffer de entrada.
export function stripImageMetadata(bytes, contentType) {
  const strip = STRIPPERS.get(contentType);
  if (!strip) throw new MalformedImageError(`formato não suportado: ${contentType}`);
  return strip(bytes);
}
