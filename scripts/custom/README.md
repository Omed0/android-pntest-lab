# Custom per-app pinning fixes

The [HTTPToolkit unpinning suite](../unpinning/) (loaded automatically by
`bun run.ts`) covers most real-world pinning: OkHttp, TrustKit, Appmattus,
Flutter's own bundled TLS stack, native/BoringSSL connections, and an
auto-patching fallback layer for anything it doesn't recognize by name.

When that fallback layer still can't handle a specific app, it says so
clearly in the Frida console — look for:

```
!!! --- Unexpected TLS failure --- !!!
...
[ ] Unrecognized TLS error - this must be patched manually
```

That's your cue to write a one-off hook for that specific app. Drop it here as:

```
scripts/custom/<package.name>.js
```

For example, `scripts/custom/com.example.app.js`. It's picked up
automatically — no flag needed — whenever you run:

```powershell
bun run.ts --package=com.example.app
```

It loads **after** the whole unpinning suite, in the same Frida script
context, so it can freely build on anything the suite already set up
(`Java.perform`, hooked classes, etc. are all still in scope).

## Known per-app issues in this lab

- **`com.tarikalthuraya.maui.android`** (Tarik-Althuraya, .NET MAUI): hooking
  `javax.net.ssl.SSLContext.init` directly crashes this app with a native
  SIGSEGV during startup (`art::JNI::CallNonvirtualVoidMethod` inside
  `ActivityThread.handleBindApplication`), reproduced reliably regardless of
  timing. The unpinning suite's own `native-tls-hook.js` (BoringSSL-level,
  never touches `SSLContext.init`) already covers this app without crashing
  it — no custom script needed for the base pinning bypass. Only add one
  here if a *different*, app-specific check shows up later.

## Writing one

A minimal template:

```js
// scripts/custom/com.example.app.js
Java.perform(function () {
  try {
    // Your app-specific hook here, e.g.:
    // var Foo = Java.use('com.example.app.security.PinningCheck');
    // Foo.verify.implementation = function () { return true; };
    console.log('[custom] com.example.app hook installed');
  } catch (e) {
    console.log('[custom] SKIP: ' + e);
  }
});
```

Wrap everything in `try/catch` — a class that doesn't exist on a given app
build should be skipped, not crash the whole session.
