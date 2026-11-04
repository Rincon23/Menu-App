// Autenticação de 2 fatores (TOTP, RFC 6238) — o código de 6 dígitos que
// muda a cada 30s no Google Authenticator / Aegis / Vaultwarden etc.
// Sem dependências: é um HMAC-SHA1 do "minuto de 30s" atual com a chave.
//
// Rodando direto, gera uma chave nova:
//   node totp.js                                            (qualquer máquina com Node)
//   docker compose exec rincon-menu-checker node totp.js    (no Orange Pi)

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_MS = 30000;

function encodeBase32(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// Chave em base32 (como os apps mostram) -> bytes; null se for inválida.
export function decodeBase32(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of str.toUpperCase().replace(/[\s=-]/g, "")) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) return null;
    value = ((value << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return out.length >= 10 ? Buffer.from(out) : null;
}

function codeAt(key, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", key).update(msg).digest();
  const offset = h[h.length - 1] & 15;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, "0");
}

// Aceita o código atual e o vizinho de cada lado (relógio do celular meio
// adiantado/atrasado). Devolve o passo que bateu — quem chama recusa um passo
// já usado, pra um código visto por alguém não servir de novo — ou null.
export function verifyTotp(key, code, now = Date.now()) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / STEP_MS);
  for (const s of [step - 1, step, step + 1]) {
    if (timingSafeEqual(Buffer.from(codeAt(key, s)), Buffer.from(code))) return s;
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = encodeBase32(randomBytes(20));
  const label = encodeURIComponent("Rincon Menu");
  console.log(`Chave nova de 2 fatores. Coloque no .env do Orange Pi:

  ADMIN_TOTP_SECRET=${secret}

No app autenticador, adicione uma conta "manualmente / inserir chave" com
essa chave (baseada em tempo, 6 dígitos). Ou cole este link num app que
aceite (o Vaultwarden aceita no campo "Chave do autenticador"):

  otpauth://totp/${label}:admin?secret=${secret}&issuer=${label}

Depois rode ./update.sh. Não mande essa chave pra ninguém.`);
}
