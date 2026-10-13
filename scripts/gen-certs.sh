#!/bin/sh
# Self-signed TLS certificate for the local WAF edge (docker compose --profile full). Use a real certificate in production.
set -e
cd "$(dirname "$0")/../nginx/certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout tls.key -out tls.crt -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
echo "Wrote nginx/certs/tls.crt and tls.key"
