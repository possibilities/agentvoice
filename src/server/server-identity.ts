/** Creation and validation of the Server's stable self-signed TLS identity. */

import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, type KeyObject, X509Certificate } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { serverIdFromCertificate } from "../core/pairing.ts";

const SERVER_NAME = "agentvoice";
const MAX_PEM_BYTES = 64 * 1024;

export interface ServerIdentity {
  serverId: string;
  serverName: typeof SERVER_NAME;
  certificate: string;
  privateKey: string;
}

export function ensureServerIdentity(directory: string): ServerIdentity {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (directoryStat.mode & 0o077) !== 0
  ) {
    throw new Error(`Server identity directory is not private: ${directory}`);
  }
  const keyPath = join(directory, "identity-key.pem");
  const certificatePath = join(directory, "identity-cert.pem");
  const hasKey = existsSync(keyPath);
  const hasCertificate = existsSync(certificatePath);
  if (hasKey !== hasCertificate) {
    throw new Error(
      "partial Server identity found; restore or remove both identity files together",
    );
  }
  if (!hasKey) generateIdentity(directory, keyPath, certificatePath);
  const privateKey = readPrivateFile(keyPath);
  const certificate = readBoundedFile(certificatePath);
  validateIdentity(privateKey, certificate);
  return {
    serverId: serverIdFromCertificate(certificate),
    serverName: SERVER_NAME,
    certificate,
    privateKey,
  };
}

function generateIdentity(directory: string, keyPath: string, certificatePath: string): void {
  const scratch = mkdtempSync(join(directory, ".identity-"));
  const temporaryKey = join(scratch, "key.pem");
  const temporaryCertificate = join(scratch, "certificate.pem");
  const config = join(scratch, "openssl.cnf");
  try {
    writeFileSync(
      config,
      `[req]\nprompt = no\ndistinguished_name = subject\nx509_extensions = extensions\n[subject]\nCN = ${SERVER_NAME}\n[extensions]\nsubjectAltName = DNS:${SERVER_NAME}\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,digitalSignature,keyCertSign\nextendedKeyUsage = serverAuth\n`,
      { mode: 0o600 },
    );
    runOpenSsl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", temporaryKey]);
    runOpenSsl([
      "req",
      "-new",
      "-x509",
      "-sha256",
      "-days",
      "3650",
      "-key",
      temporaryKey,
      "-out",
      temporaryCertificate,
      "-config",
      config,
    ]);
    chmodSync(temporaryKey, 0o600);
    chmodSync(temporaryCertificate, 0o600);
    validateIdentity(readPrivateFile(temporaryKey), readBoundedFile(temporaryCertificate));
    renameSync(temporaryKey, keyPath);
    renameSync(temporaryCertificate, certificatePath);
    chmodSync(keyPath, 0o600);
    chmodSync(certificatePath, 0o600);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function runOpenSsl(arguments_: string[]): void {
  const result = spawnSync("/usr/bin/openssl", arguments_, { encoding: "utf8", timeout: 10_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `openssl could not create the Server identity: ${(result.stderr || result.stdout).trim()}`,
    );
  }
}

function readPrivateFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Server identity key is not a private regular file: ${path}`);
  }
  return readBoundedFile(path);
}

function readBoundedFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_PEM_BYTES) {
    throw new Error(`Server identity file is invalid: ${path}`);
  }
  return readFileSync(path, "utf8");
}

function validateIdentity(privateKeyPem: string, certificatePem: string): void {
  let privateKey: KeyObject;
  let certificate: X509Certificate;
  try {
    privateKey = createPrivateKey(privateKeyPem);
    certificate = new X509Certificate(certificatePem);
  } catch {
    throw new Error("Server identity is not valid PEM");
  }
  if (
    privateKey.asymmetricKeyType !== "ec" ||
    privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new Error("Server identity key must be P-256");
  }
  const fromPrivate = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const fromCertificate = certificate.publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.from(fromPrivate).equals(Buffer.from(fromCertificate))) {
    throw new Error("Server identity certificate does not match its private key");
  }
}
