# Vendored: HTTPToolkit unpinning suite

Everything in this directory (`config.js`, `native-connect-hook.js`,
`native-tls-hook.js`, `android/*.js`, `LICENSE`) is vendored unmodified from
[httptoolkit/frida-interception-and-unpinning](https://github.com/httptoolkit/frida-interception-and-unpinning)
(fetched 2026-09-18), licensed **AGPL-3.0-or-later** — see `LICENSE` in this
directory. Copyright Tim Perry / HTTP Toolkit.

`config.generated.js` (gitignored) is the only generated/modified file —
`src/unpinning.ts` substitutes the `CERT_PEM`/`PROXY_HOST`/`PROXY_PORT`/
`DEBUG_MODE` constants at the top of `config.js` into it on every
`bun run.ts` invocation, leaving all of upstream's own logic (base64/PEM
decoding, the module-load observer other scripts subscribe to) untouched.

See the main [README's SSL/TLS pinning bypass section](../../README.md#ssltls-pinning-bypass)
for how this is wired into the lab, and each individual script's own
top-of-file comment for what it does.
