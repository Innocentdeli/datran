#!/bin/sh
# Test CA + one certificate per node (server + client auth, for HTTPS and QUIC mTLS).
# SANs: the compose service name (node-a/b/c), localhost and 127.0.0.1 (the test driver connects through
# ports published on 127.0.0.1). Idempotent: existing certificates are kept.
set -eu
OUT=${CERT_DIR:-/certs}
mkdir -p "$OUT"
cd "$OUT"
if [ ! -f ca.pem ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 \
    -subj "/CN=datran cluster-test CA" -keyout ca.key -out ca.pem \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
fi
for n in node-a node-b node-c; do
  [ -f "$n.pem" ] && continue
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=$n" \
    -keyout "$n.key.tmp" -out "$n.csr" 2>/dev/null
  # PKCS#8 key (rustls reads PKCS#8, SEC1 and PKCS#1)
  openssl pkcs8 -topk8 -nocrypt -in "$n.key.tmp" -out "$n.key"
  rm -f "$n.key.tmp"
  printf 'subjectAltName=DNS:%s,DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth,clientAuth\n' "$n" > "$n.ext"
  openssl x509 -req -in "$n.csr" -CA ca.pem -CAkey ca.key -CAcreateserial -days 30 -sha256 \
    -extfile "$n.ext" -out "$n.pem" 2>/dev/null
  rm -f "$n.csr" "$n.ext"
done
# test-only material: readable by the unprivileged reactor user and the host-side driver
chmod 644 ./*.pem ./*.key
echo "certgen: $(ls "$OUT" | tr '\n' ' ')"
