// Copies ONE root certificate (by its common name) out of Amazon's RDS CA bundle. Prisma's migration engine reads only
// the first certificate of a PEM file, so it needs the root that signed the database's certificate on its own; the
// Node app reads the whole bundle (NODE_EXTRA_CA_CERTS). Used by the root Dockerfile (migrate stage).
//   node scripts/extract-rds-root.mjs <bundle.pem> <out.pem> "Amazon RDS ap-south-1 Root CA RSA2048 G1"
import { X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [bundle, out, cn] = process.argv.slice(2);
if (!bundle || !out || !cn) {
  console.error('usage: extract-rds-root.mjs <bundle> <out> <common name>');
  process.exit(2);
}
const pems =
  readFileSync(bundle, 'utf8').match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
  ) ?? [];
const hits = pems.filter((p) =>
  new X509Certificate(p).subject.split('\n').includes(`CN=${cn}`),
);
if (hits.length !== 1) {
  console.error(`expected exactly one certificate "${cn}" in ${bundle}, found ${hits.length}`);
  process.exit(1);
}
writeFileSync(out, `${hits[0]}\n`);
