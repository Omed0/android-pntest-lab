# Burp CA certificate

Place the Burp Suite CA certificate in this folder as `burp-ca.cer`, `burp-ca.crt`,
`burp-ca.der`, or `burp-ca.pem`.

When `bun run.ts` configures Burp, it will push the certificate to the rooted
target emulator and open Android's certificate installer. Complete the Android
prompts, then answer `y` in the terminal. The target is marked as configured so
future runs do not ask again.

Only use certificates generated for your own Burp listener and authorized test
environments.
