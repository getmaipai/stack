import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";

const KEY_BYTES = 32;
const PREFIX = "v1";

function keyPath(): string {
  const directory = join(dataDir, "keys");
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return join(directory, "channels.key");
}

function key(): Buffer {
  const path = keyPath();
  if (!existsSync(path)) writeFileSync(path, randomBytes(KEY_BYTES), { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  const value = readFileSync(path);
  if (value.byteLength !== KEY_BYTES) throw new Error("The channel key has an invalid length.");
  return value;
}

export function encryptChannelConfig(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [PREFIX, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function decryptChannelConfig<T>(value: string): T {
  const [prefix, ivText, tagText, ciphertextText] = value.split(":");
  if (prefix !== PREFIX || !ivText || !tagText || !ciphertextText) throw new Error("The channel config is not valid.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
  return JSON.parse(plaintext) as T;
}
