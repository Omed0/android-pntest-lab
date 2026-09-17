# Burp CA

The normal runner manages this folder automatically.

1. Start Burp on the host and port configured by `LAB_BURP_HOST` and
   `LAB_BURP_PORT`.
2. Run `bun run run -- --package=<package>` (after `bun run init` has set up the emulators).
3. The runner downloads Burp's CA from `http://burp/cert` when no local CA exists.
4. It saves the CA as `cert/burp-ca.cer` and installs it into the rooted
   target's system trust store (a tmpfs overlay over
   `/system/etc/security/cacerts` — no `-writable-system`, verity-disable, or
   reboot needed). Already-installed certs are detected and skipped.

If the CA cannot be downloaded or is not present, `run.ts` pauses and asks you
to place the certificate in this folder, then type `y` to retry. It will not
continue with an unverified certificate setup.

You can provide a certificate manually as `burp-ca.cer`, `burp-ca.crt`,
`burp-ca.der`, or `burp-ca.pem`, or pass `--burp-cert=<path>`.

Use only a CA belonging to your own Burp listener and authorized test lab.
