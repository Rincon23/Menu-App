// Senha do login guardada só como hash (scrypt): quem ler o .env não descobre
// a senha. Formato: "scrypt:<sal>:<hash>" — sem "$", que o docker compose
// tentaria ler como variável.
//
// Rodando direto, lê a senha da entrada padrão e imprime a linha do .env
// (quem chama é o ../definir-senha.sh):
//   printf %s "senha" | node password.js

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const scryptAsync = promisify(scrypt);
const KEYLEN = 32;
const MIN_LENGTH = 12;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN);
  return `scrypt:${salt.toString("base64url")}:${hash.toString("base64url")}`;
}

// Hash do .env -> { salt, hash }; null se estiver mal formado.
export function parseHash(str) {
  const [kind, salt, hash, extra] = str.split(":");
  if (kind !== "scrypt" || !salt || !hash || extra !== undefined) return null;
  const parsed = { salt: Buffer.from(salt, "base64url"), hash: Buffer.from(hash, "base64url") };
  return parsed.salt.length >= 16 && parsed.hash.length === KEYLEN ? parsed : null;
}

export async function verifyPassword(parsed, password) {
  const hash = await scryptAsync(String(password), parsed.salt, KEYLEN);
  return timingSafeEqual(hash, parsed.hash);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  const password = input.replace(/\r?\n$/, "");
  if (password.length < MIN_LENGTH) {
    console.error(`Senha curta demais: use pelo menos ${MIN_LENGTH} caracteres.`);
    process.exit(1);
  }
  console.log(`ADMIN_PASSWORD_HASH=${await hashPassword(password)}`);
}
