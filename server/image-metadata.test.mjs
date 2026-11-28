// Testes da remoção de metadados (EXIF/GPS, XMP, IPTC, comentários) das fotos de perfil
// (ADR-0006). Arquivos sintéticos gerados em scripts/test-images.mjs; nenhum banco envolvido.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, inflateSync } from "node:zlib";
import { stripImageMetadata, MalformedImageError } from "./image-metadata.mjs";
import { jpeg, png, webp, PNG_SIGNATURE, FAKE_GPS } from "../scripts/test-images.mjs";

const malformed = fn => assert.throws(fn, MalformedImageError);

// Percorre os segmentos de um JPEG validando a estrutura; devolve os marcadores e o byte
// onde começa o SOS (dali até o fim os dados são opacos).
function jpegMarkers(buf) {
  assert.deepEqual([...buf.subarray(0, 2)], [0xff, 0xd8], "SOI");
  const markers = [];
  let offset = 2;
  while (offset < buf.length) {
    assert.equal(buf[offset], 0xff, `marcador em ${offset}`);
    const marker = buf[offset + 1];
    markers.push(marker);
    if (marker === 0xda) return { markers, sos: offset };
    const length = buf.readUInt16BE(offset + 2);
    assert.ok(length >= 2, "tamanho de segmento válido");
    offset += 2 + length;
  }
  return { markers, sos: -1 };
}

// Percorre os chunks de um PNG conferindo o CRC de cada um; devolve os tipos.
function pngTypes(buf) {
  assert.deepEqual(buf.subarray(0, 8), PNG_SIGNATURE, "assinatura PNG");
  const types = [];
  let offset = 8;
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const body = buf.subarray(offset + 4, offset + 8 + length); // tipo + dados
    assert.equal(buf.readUInt32BE(offset + 8 + length), crc32(body), `CRC do chunk ${types.length}`);
    types.push(buf.toString("latin1", offset + 4, offset + 8));
    offset += 12 + length;
  }
  assert.equal(offset, buf.length, "sem sobras no fim");
  return types;
}

// Percorre os chunks de um WebP validando o contêiner RIFF; devolve um Map fourcc → dados.
function webpChunks(buf) {
  assert.equal(buf.toString("latin1", 0, 4), "RIFF");
  assert.equal(buf.toString("latin1", 8, 12), "WEBP");
  assert.equal(buf.readUInt32LE(4), buf.length - 8, "tamanho do RIFF consistente");
  const chunks = new Map();
  let offset = 12;
  while (offset < buf.length) {
    const fourcc = buf.toString("latin1", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    chunks.set(fourcc, buf.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  assert.equal(offset, buf.length, "sem sobras no fim");
  return chunks;
}

test("jpeg: remove APP1/APP13/COM (EXIF com GPS, IPTC, comentário) e mantém o resto", () => {
  const original = jpeg();
  const clean = stripImageMetadata(original, "image/jpeg");
  const { markers, sos } = jpegMarkers(clean);
  for (const gone of [0xe1, 0xed, 0xfe]) assert.ok(!markers.includes(gone), `marcador ${gone.toString(16)} removido`);
  for (const kept of [0xe0, 0xe2, 0xee, 0xdb]) assert.ok(markers.includes(kept), `marcador ${kept.toString(16)} mantido`);
  assert.ok(sos > 0, "SOS presente");
  assert.ok(clean.subarray(sos).equals(original.subarray(jpegMarkers(original).sos)), "dados da imagem intactos");
  assert.ok(!clean.includes(Buffer.from(FAKE_GPS)) && !clean.includes(Buffer.from("Exif")), "GPS sumiu");
  assert.deepEqual([...clean.subarray(-2)], [0xff, 0xd9], "termina em EOI");
});

test("jpeg sem metadados passa inalterado", () => {
  const original = jpeg({ metadata: false });
  assert.deepEqual(stripImageMetadata(original, "image/jpeg"), original);
});

test("jpeg malformado é recusado (nunca exceção genérica)", () => {
  malformed(() => stripImageMetadata(Buffer.alloc(0), "image/jpeg"));
  malformed(() => stripImageMetadata(Buffer.from([0xff, 0xd8, 0x00, 0x11]), "image/jpeg")); // byte que não é marcador
  malformed(() => stripImageMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), "image/jpeg")); // tamanho truncado
  malformed(() => stripImageMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]), "image/jpeg")); // tamanho < 2
  malformed(() => stripImageMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x40, 0x01]), "image/jpeg")); // segmento além do fim
  malformed(() => stripImageMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]), "image/jpeg")); // acaba sem SOS/EOI
  // Sem EOI depois do SOS não há como detectar sem decodificar o scan: os dados são opacos
  // e vão até o fim do arquivo (limitação registrada no ADR-0006).
});

test("png: remove eXIf/tEXt/iTXt/zTXt/tIME e mantém IHDR/IDAT/IEND com CRCs válidos", () => {
  const original = png();
  const clean = stripImageMetadata(original, "image/png");
  assert.deepEqual(pngTypes(clean), ["IHDR", "IDAT", "IEND"]);
  assert.deepEqual(pngTypes(original), ["IHDR", "eXIf", "tEXt", "zTXt", "iTXt", "tIME", "IDAT", "IEND"]);
  assert.ok(!clean.includes(Buffer.from(FAKE_GPS)), "GPS sumiu");
  // A imagem continua decodificável: o IDAT mantém o deflate da scanline original.
  const idatAt = clean.indexOf(Buffer.from("IDAT"));
  const idatLength = clean.readUInt32BE(idatAt - 4);
  assert.deepEqual(inflateSync(clean.subarray(idatAt + 4, idatAt + 4 + idatLength)), Buffer.from([0, 255, 0, 0, 255]));
});

test("png sem metadados passa inalterado", () => {
  const original = png({ metadata: false });
  assert.deepEqual(stripImageMetadata(original, "image/png"), original);
});

test("png malformado é recusado", () => {
  malformed(() => stripImageMetadata(Buffer.alloc(0), "image/png"));
  malformed(() => stripImageMetadata(Buffer.from("não é png, nem de longe........"), "image/png"));
  malformed(() => stripImageMetadata(png().subarray(0, 20), "image/png")); // cabeçalho de chunk truncado
  malformed(() => stripImageMetadata(png().subarray(0, -10), "image/png")); // chunk além do fim
  const semIhdr = Buffer.concat([PNG_SIGNATURE, png().subarray(8 + 33)]); // primeiro chunk não é IHDR
  malformed(() => stripImageMetadata(semIhdr, "image/png"));
  const semIend = png({ metadata: false }).subarray(0, -12); // remove o IEND
  malformed(() => stripImageMetadata(semIend, "image/png"));
  const tipoRuim = Buffer.concat([PNG_SIGNATURE, Buffer.from([0, 0, 0, 0]), Buffer.from("ab 1"), Buffer.alloc(4)]);
  malformed(() => stripImageMetadata(tipoRuim, "image/png")); // tipo de chunk inválido
});

test("webp: remove EXIF/XMP, limpa as flags do VP8X e ajusta o tamanho do RIFF", () => {
  const original = webp();
  const clean = stripImageMetadata(original, "image/webp");
  const chunks = webpChunks(clean); // já valida o tamanho do RIFF
  assert.ok(!chunks.has("EXIF") && !chunks.has("XMP "), "chunks de metadados removidos");
  assert.deepEqual([...chunks.keys()], ["VP8X", "ICCP", "VP8 "]);
  const flags = chunks.get("VP8X")[0];
  assert.equal(flags & 0x0c, 0, "flags EXIF e XMP desligadas");
  assert.equal(flags & 0x20, 0x20, "flag de ICC mantida");
  assert.ok(chunks.get("ICCP").equals(Buffer.from("fake-icc")), "perfil ICC preservado");
  assert.ok(chunks.get("VP8 ").equals(Buffer.from("fake-vp8-frame")), "dados da imagem intactos");
  assert.ok(!clean.includes(Buffer.from(FAKE_GPS)), "GPS sumiu");
});

test("webp sem VP8X também perde o EXIF; chunk de tamanho ímpar mantém o alinhamento", () => {
  const clean = stripImageMetadata(webp({ vp8x: false }), "image/webp");
  const chunks = webpChunks(clean);
  assert.deepEqual([...chunks.keys()], ["VP8 "]);
  const limpo = stripImageMetadata(webp(), "image/webp");
  assert.equal(limpo.length % 2, 0, "arquivo continua alinhado");
});

test("webp sem metadados passa inalterado", () => {
  const original = webp({ metadata: false });
  assert.deepEqual(stripImageMetadata(original, "image/webp"), original);
});

test("webp malformado é recusado", () => {
  malformed(() => stripImageMetadata(Buffer.alloc(0), "image/webp"));
  malformed(() => stripImageMetadata(Buffer.from("RIFF\x00\x00\x00\x00WAVE........", "latin1"), "image/webp"));
  const tamanhoErrado = Buffer.from(webp()); // tamanho do RIFF não bate com o arquivo
  tamanhoErrado.writeUInt32LE(4, 4);
  malformed(() => stripImageMetadata(tamanhoErrado, "image/webp"));
  malformed(() => stripImageMetadata(webp().subarray(0, -3), "image/webp")); // chunk truncado
  const curto = Buffer.from(webp({ metadata: false }));
  curto.writeUInt32LE(4, 16); // tamanho do chunk VP8X (em 12) declarado como 4 (< 10)
  malformed(() => stripImageMetadata(curto, "image/webp"));
  const semImagem = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), webpChunkFake()]);
  semImagem.writeUInt32LE(semImagem.length - 8, 4);
  malformed(() => stripImageMetadata(semImagem, "image/webp")); // sem VP8/VP8L/ANMF
});

test("formato desconhecido é recusado", () => {
  malformed(() => stripImageMetadata(Buffer.from("GIF89a"), "image/gif"));
});

// Chunk solto para montar um WebP estruturalmente correto porém sem dados de imagem.
function webpChunkFake() {
  const data = Buffer.from("sem-imagem");
  const head = Buffer.alloc(8);
  head.write("JUNK", 0, "latin1");
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
