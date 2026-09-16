# Burp CA

The normal runner manages this folder automatically.

1. Start Burp on the configured listener, for example `192.168.10.91:6666`.
2. Run `bun run e2e -- --package=<package>`.
3. The runner downloads Burp's CA from `http://burp/cert` when no local CA exists.
4. It saves the CA as `cert/burp-ca.cer`, installs it into the rooted target's
   system trust store, and verifies the certificate marker.

You can provide a certificate manually as `burp-ca.cer`, `burp-ca.crt`,
`burp-ca.der`, or `burp-ca.pem`, or pass `--burp-cert=<path>`.

Use only a CA belonging to your own Burp listener and authorized test lab.
