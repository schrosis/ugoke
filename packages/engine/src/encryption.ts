import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DataConverter, Payload, PayloadCodec } from "@temporalio/common";

/** Encoding of a payload that {@link createEncryptionCodec} encrypted. */
export const encryptedEncoding = "binary/ugoke-aes-256-gcm";

/** Size of an encryption key in bytes. */
export const encryptionKeyBytes = 32;

const algorithm = "aes-256-gcm";
const nonceBytes = 12;
const tagBytes = 16;

const encodingOf = (payload: Payload): string | undefined => {
  const encoding = payload.metadata?.encoding;
  return encoding === undefined || encoding === null
    ? undefined
    : Buffer.from(encoding).toString("utf8");
};

/** Turns a payload into bytes. It keeps every metadata entry, whose values are bytes. */
const serialize = ({ data, metadata }: Payload): Buffer =>
  Buffer.from(
    JSON.stringify({
      data: Buffer.from(data ?? []).toString("base64"),
      metadata: Object.fromEntries(
        Object.entries(metadata ?? {}).map(([key, value]) => [
          key,
          Buffer.from(value).toString("base64"),
        ]),
      ),
    }),
  );

const isSerialized = (value: unknown): value is { data: string; metadata: object } =>
  typeof value === "object" &&
  value !== null &&
  "data" in value &&
  typeof value.data === "string" &&
  "metadata" in value &&
  typeof value.metadata === "object" &&
  value.metadata !== null;

const deserialize = (bytes: Buffer): Payload => {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isSerialized(value)) {
    throw new Error("The decrypted payload is malformed");
  }
  return {
    data: Buffer.from(value.data, "base64"),
    metadata: Object.fromEntries(
      Object.entries(value.metadata).map(([key, entry]) => [
        key,
        Buffer.from(String(entry), "base64"),
      ]),
    ),
  };
};

/** Options of {@link createEncryptionCodec}. */
export interface EncryptionCodecOptions {
  /**
   * Whether to pass on payloads that are not encrypted.
   *
   * A Worker must not, because a payload that it accepts can run commands. A client only shows
   * what it reads, such as the memo of a run from before payloads were encrypted.
   */
  allowPlaintext?: boolean;
  /**
   * Whether to read a value that this key cannot decrypt as `null`.
   *
   * It is for listing runs, which reads the memos of every run on the server, including the runs
   * that others started with their own keys.
   */
  nullWhenUnreadable?: boolean;
}

/**
 * Creates a codec that encrypts every value that goes through Temporal with AES-256-GCM.
 *
 * Authenticated encryption keeps the values private, and also proves that they come from someone
 * who holds the key. A Worker therefore cannot be made to run a step by someone who can reach the
 * Temporal Server but cannot read the key. A value from the history can still be sent again.
 *
 * @param key Key of {@link encryptionKeyBytes} bytes.
 */
export const createEncryptionCodec = (
  key: Uint8Array,
  { allowPlaintext = false, nullWhenUnreadable = false }: EncryptionCodecOptions = {},
): PayloadCodec => {
  if (key.length !== encryptionKeyBytes) {
    throw new Error(`An encryption key must have ${encryptionKeyBytes} bytes`);
  }

  const encrypt = (payload: Payload): Payload => {
    const nonce = randomBytes(nonceBytes);
    const cipher = createCipheriv(algorithm, key, nonce);
    const encrypted = Buffer.concat([cipher.update(serialize(payload)), cipher.final()]);
    return {
      data: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]),
      metadata: { encoding: Buffer.from(encryptedEncoding) },
    };
  };

  const decrypt = (payload: Payload): Payload => {
    if (encodingOf(payload) !== encryptedEncoding) {
      if (allowPlaintext) {
        return payload;
      }
      throw new Error("Refused a value that is not encrypted with the key of this host");
    }
    const bytes = Buffer.from(payload.data ?? []);
    const decipher = createDecipheriv(algorithm, key, bytes.subarray(0, nonceBytes));
    decipher.setAuthTag(bytes.subarray(nonceBytes, nonceBytes + tagBytes));
    try {
      return deserialize(
        Buffer.concat([decipher.update(bytes.subarray(nonceBytes + tagBytes)), decipher.final()]),
      );
    } catch (error) {
      if (nullWhenUnreadable) {
        return { data: Buffer.from("null"), metadata: { encoding: Buffer.from("json/plain") } };
      }
      throw new Error("Refused a value that cannot be decrypted with the key of this host", {
        cause: error,
      });
    }
  };

  return {
    decode: async (payloads) => payloads.map(decrypt),
    encode: async (payloads) => payloads.map(encrypt),
  };
};

const modulePath = fileURLToPath(import.meta.url);

/**
 * Path of the file that exports the failure converter. It has the extension of this file, which
 * is `.js` once built.
 */
const failureConverterPath = join(dirname(modulePath), `failure-converter${extname(modulePath)}`);

/**
 * Returns a data converter that encrypts values, and the messages and stack traces of failures,
 * with the codec.
 */
const encrypting = (codec: PayloadCodec): { dataConverter: DataConverter } => ({
  dataConverter: { failureConverterPath, payloadCodecs: [codec] },
});

/** Returns the options that make a Worker accept only values encrypted with the key. */
export const workerDataConverter = (
  key: Uint8Array | undefined,
): { dataConverter?: DataConverter } =>
  key === undefined ? {} : encrypting(createEncryptionCodec(key));

/** Returns the options that make a client encrypt with the key. */
export const clientDataConverter = (
  key: Uint8Array | undefined,
): { dataConverter?: DataConverter } =>
  key === undefined ? {} : encrypting(createEncryptionCodec(key, { allowPlaintext: true }));

/** Returns the options that make a client read the memos of runs that others started. */
export const listingDataConverter = (
  key: Uint8Array | undefined,
): { dataConverter?: DataConverter } =>
  key === undefined
    ? {}
    : encrypting(createEncryptionCodec(key, { allowPlaintext: true, nullWhenUnreadable: true }));
