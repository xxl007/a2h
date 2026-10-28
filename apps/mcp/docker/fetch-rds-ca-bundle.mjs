// Build-time only (apps/mcp/Dockerfile): download the AWS RDS global CA
// bundle that the mcp service uses to verify Aurora's TLS certificate, check that
// it is a non-empty list of valid X.509 CA certificates, and write it out.
// Usage: node fetch-rds-ca-bundle.mjs <output path>
/* global process, fetch, console -- Node 22 globals; the root ESLint config declares none for .mjs */
import { X509Certificate } from "node:crypto";
import { writeFileSync } from "node:fs";

const URL_ = "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem";
const out = process.argv[2];
if (!out) throw new Error("usage: fetch-rds-ca-bundle.mjs <output path>");

const res = await fetch(URL_);
if (!res.ok) throw new Error(`GET ${URL_}: HTTP ${res.status}`);
const pem = await res.text();
const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
if (blocks.length === 0) throw new Error("RDS CA bundle contains no certificate");
for (const block of blocks) {
  const cert = new X509Certificate(block);
  if (!cert.ca) throw new Error(`not a CA certificate: ${cert.subject}`);
}
writeFileSync(out, pem, { mode: 0o644 });
console.log(`RDS CA bundle: ${blocks.length} CA certificates -> ${out}`);
