# Android Pentest Lab

A Bun and TypeScript lab for authorized Android application testing with two
emulators, ADB, Frida, and Burp Suite.

## Architecture

The project has one lifecycle entry point:

```text
src/lab.ts
```

It exposes three subcommands:

- `bootstrap`: prepare the rooted target emulator and Frida.
- `init`: bootstrap the target and start the Play Store source emulator.
- `e2e`: initialize both roles, install/recover the app, configure Burp, launch
  the app, and attach Frida.

The other runtime entry points are intentionally focused:

- `run.ts`: configure Burp/certificates, install or recover an app, launch it,
  and attach Frida.
- `src/transfer.ts`: transfer a complete installed package, including split APKs,
  from the source emulator to the rooted target.
- `verify.ts`: report target health.

## Emulator roles

| Role | Default AVD | Default serial | Purpose |
|---|---|---|---|
| Target | `$LAB_TARGET_AVD` | `$LAB_TARGET_SERIAL` | Rooted lower-API Frida target |
| Source | `$LAB_SOURCE_AVD` | `$LAB_SOURCE_SERIAL` | Play Store app source |

The target image, source image, AVD names, and serials are configuration values;
set them for each machine rather than relying on these examples.

## Requirements

Install or provide:

- Bun 1.4 or newer.
- Burp Suite with a listener reachable by the target emulator.
- Network access for first-run SDK, Frida, and system-image downloads.

Everything else below is either already automated or self-healing on
`--install-sdk`:

| Dependency | Handled how |
|---|---|
| Java (JRE/JDK) | Detected before touching `sdkmanager`/`avdmanager` (both are Java programs); auto-installed via `winget install EclipseAdoptium.Temurin.21.JRE` on Windows with `--install-sdk`, otherwise a clear manual-install message. |
| Python + pip | Used to `pip install frida frida-tools`. An existing Python install is found and reused even when it isn't yet visible on PATH (common right after a fresh/winget install in an already-open shell — a bare `python`/`pip` PATH check alone can't tell "not installed" from "installed, but this process can't see it yet"); only installs a new one via `winget install Python.Python.3.13` on Windows when none can be found at all. |
| 7-Zip (Windows only) | Auto-installed via `winget install 7zip.7zip` with `--install-sdk`; `.zip` extraction still falls back to the built-in `Expand-Archive` if 7-Zip can't be installed, but `.xz` (frida-server's format) has no fallback and needs it. |
| Android cmdline-tools / Platform-Tools / Emulator / system images | Downloaded and installed by `sdkmanager` under `--install-sdk`, cached under `tools/cache/`. |
| Root | Auto-detected per device — see **Root: two kinds, handled automatically** below. Never silently attempts an arbitrary rooting exploit. |
| Emulator GPU mode | Defaults to `-gpu auto` (safe on VMs like VMware, which usually can't offer real GPU passthrough — this replaced a previous hardcoded `-gpu host` that could show a black emulator window on such machines). A boot timeout also triggers one automatic retry with `-gpu swiftshader_indirect`. Override with `--gpu-mode=<mode>` if needed. |

### Running fully portable (no system-wide installs at all)

Pass `--portable` to any bootstrap command (`bun run init -- --portable
--install-sdk`, etc.) to download Java, Python, and 7-Zip as private
zip/portable copies under this project's own `tools/` directory instead of
using `winget` or anything already on the host. This is for verifying (or
running) the lab on a machine without touching its existing installs at
all — even if the host already has its own Java/Python/7-Zip, `--portable`
never uses them and never mutates system state (no `winget install`, no
PATH/registry changes — only this process's own `PATH` is extended). The
Android SDK/AVD also default to a private path under `tools/android-sdk`
in this mode instead of the host's real SDK, unless you pass an explicit
`--sdk-root`. Delete the `tools/` directory afterward to remove everything
this mode downloaded.

### Root: two kinds, handled automatically

There are two legitimately different "rooted" devices this project targets,
and the tooling now tells them apart itself instead of assuming one:

- **`adb root`-rooted emulators** — this is what you get for free from the
  lab's own default (`google_apis`, non-Play-Store) system image: it's a
  userdebug build where `adb root` alone restarts `adbd` as root, no Magisk
  or rootAVD needed. `bun run bootstrap`/`init` try this automatically
  before falling back to anything else — **for the default configuration,
  root now requires zero manual steps.**
- **Magisk/su-rooted devices** — physical hardware, Play-Store images, or a
  rootAVD-prepared AVD. The base shell is unprivileged; `su -c '<cmd>'` is
  required. The tooling falls back to this automatically when `adb root`
  doesn't grant `uid=0` (e.g. it's a no-op on production/Play-Store builds).

You don't pass a flag for which kind you have — `verifyRoot()` tries `adb
shell id` -> `adb root` -> `su -c id` in that order and uses whichever
succeeds, then every later root-only command uses that same mode. If none
of the three work, it tells you to prepare the AVD with rootAVD/Magisk.

## First run

Clone and install dependencies:

```powershell
git clone https://github.com/Omed0/android-pntest-lab.git
Set-Location .\android-pntest-lab
bun install
```

Configure the two emulator roles and Burp for the current machine:

```powershell
$env:LAB_TARGET_SERIAL = "<rooted-target-serial>"
$env:LAB_SOURCE_SERIAL = "<play-source-serial>"
$env:LAB_SOURCE_AVD = "<play-source-avd-name>"
$env:LAB_BURP_HOST = "<burp-reachable-host>"
$env:LAB_BURP_PORT = "<burp-listener-port>"
```

Start Burp on the configured host and port, then initialize both roles:

```powershell
bun run init -- --install-sdk
```

Initialization downloads missing SDK/runtime components, creates missing AVDs
when the required SDK tools are available, starts the emulators, verifies the
target is rooted, installs host Frida, downloads the matching `frida-server`,
and verifies target-specific Frida communication.

Verify root directly at any time — this works for both root kinds described
above (it's exactly what `bun run verify` checks):

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb -s $env:LAB_TARGET_SERIAL shell id            # uid=0 here = adb-root image
& $adb -s $env:LAB_TARGET_SERIAL shell su -c id       # uid=0 here = Magisk/rootAVD image
```

Continue once either command's output contains `uid=0(root)`.

### Using your own existing AVD (rooted or Play Store) instead

If you already have an AVD you'd rather reuse — your own rooted target, or
a Play Store AVD you built by hand — point the lab at it by name instead of
letting it create one. `avdExists()` is checked before any AVD is created,
so an existing AVD with the configured name is reused as-is and never
recreated or modified:

```powershell
$env:LAB_AVD_NAME = "<your-existing-rooted-avd-name>"
$env:LAB_SOURCE_AVD = "<your-existing-playstore-avd-name>"
bun run init
```

To create a fresh non-rooted Play Store AVD yourself (no lab code needed —
just the SDK the lab already manages):

```powershell
$SDK = "$env:LOCALAPPDATA\Android\Sdk"
& "$SDK\cmdline-tools\latest\bin\sdkmanager.bat" --install "system-images;android-36.1;google_apis_playstore_ps16k;x86_64"
& "$SDK\cmdline-tools\latest\bin\avdmanager.bat" create avd --name PlayStore_Source --package "system-images;android-36.1;google_apis_playstore_ps16k;x86_64" --device pixel_7_pro --force
& "$SDK\emulator\emulator.exe" -avd PlayStore_Source -gpu host
```

Play Store images are intentionally locked down by Google (no `adb root`,
no Magisk) — that's expected, not a limitation of this project. It's exactly
why this is the separate **source** role: install the real app there once
(interactive Google sign-in, one **Install** tap), then `bun run transfer`
or `bun run e2e` hands it off to your separate rooted **target** for actual
testing. The two roles are deliberately never the same device.

**Device profile note:** `--device <id>` above must be an id your installed
`cmdline-tools` actually knows about — run `avdmanager list device` to see
them. The auto-downloaded "command-line tools only" package ships an older,
fixed device list than Android Studio does, so a literal `pixel_10_pro` (or
other very new device id) frequently doesn't exist yet even though it's
valid on a Studio-managed SDK. The lab's own `ensureAvd()`/`ensureSourceAvd()`
now resolve this automatically (falling back to the newest available
`pixel_*_pro` profile with a warning instead of hard-failing) — this note is
only for when you're running `avdmanager` by hand as above.

**First-boot timing:** a Play Store AVD's very first boot has no boot
snapshot yet and has to cold-start Google Play services — this measured at
well over 5 minutes on this project's own test machine, longer than you'd
expect from later boots (which reuse the snapshot and are fast). `bun run
init`'s default source-boot timeout accounts for this; override with
`--timeout=<sec>` if your machine needs even longer. Give the emulator a
minute after `sys.boot_completed=1` before installing anything — the
package/activity manager services can still be settling immediately after
that property flips, especially on a loaded host running two emulators at
once.

## One-command E2E run

Use this as the normal workflow:

```powershell
bun run e2e -- `
  --package=<authorized.package.name> `
  --burp-host=$env:LAB_BURP_HOST `
  --burp-port=$env:LAB_BURP_PORT
```

With a local APK as the first installation source:

```powershell
bun run e2e -- `
  --package=<authorized.package.name> `
  --apk=.\apk\<target.apk> `
  --burp-host=$env:LAB_BURP_HOST `
  --burp-port=$env:LAB_BURP_PORT
```

The flow is:

1. Initialize the target and source emulator roles.
2. Verify target root and Frida.
3. Configure the target proxy.
4. Use the supplied APK when it exists and is complete.
5. If the package is absent or the APK is missing splits, open the source
   Play Store page and wait for the source installation.
6. Pull all base/split APKs from the source and install them on the target.
7. Prepare the Burp CA certificate.
8. Launch the app and attach Frida to the target serial.

Google Play login and the first Play Store **Install** action remain interactive.
Everything after the source package is installed is automated.

## Everyday commands

```powershell
# Prepare both emulator roles
bun run init

# Prepare only the rooted target
bun run bootstrap -- --skip-emulator

# Run the complete app workflow
bun run e2e -- --package=com.example.app

# Run the app directly when it is already installed
bun run run -- --package=com.example.app

# Transfer an installed source package manually when needed
bun run transfer -- --package=com.example.app

# Check target health
bun run verify
```

Use `bun run help`, `bun run init -- --help`, or `bun run transfer -- --help`
for command-specific options.

## Proxy and certificates (Burp by default — any other tool also works)

The runner sets the target's global Android proxy to the configured
`LAB_PROXY_HOST:LAB_PROXY_PORT` (the older `LAB_BURP_HOST`/`LAB_BURP_PORT`
names still work as aliases for the same values). For this lab that is:

```text
$env:LAB_PROXY_HOST`:$env:LAB_PROXY_PORT
```

Burp Suite is the default and needs no extra flags. If `cert/` has no
certificate, the runner requests Burp's CA through `http://burp/cert` using
the configured listener and saves it as `cert/burp-ca.cer`. You may also
place a `.cer`, `.crt`, `.der`, or `.pem` file there yourself, or pass
`--proxy-cert=<path>` (alias: `--burp-cert=<path>`).

**Using a different proxy tool** (mitmproxy, etc.): pass
`--proxy-tool=other` so the Burp-only `http://burp/cert` auto-download is
skipped, along with `--proxy-host`/`--proxy-port` for your tool's listener
and either a cert dropped in `cert/` or `--proxy-cert=<path>` for its CA:

```powershell
bun run.ts --package=<pkg> --proxy-tool=other --proxy-host=10.0.2.2 --proxy-port=8080 --proxy-cert=.\mitmproxy-ca.pem
```

**Using no proxy at all:** pass `--no-proxy` (alias: `--no-burp`) to skip
proxy and certificate setup entirely.

The rooted target receives the CA in its system trust store with Android's
required filename, permissions, and SELinux context. A certificate-specific
marker prevents needless reinstallation. Restart the target app after changing
the CA. Certificate pinning and app-specific trust policies may still block
HTTPS interception.

## Configuration

Priority is:

1. CLI flag, for example `--burp-port=<port>`.
2. Environment variable, for example `LAB_BURP_PORT=<port>`.
3. Built-in default.

Important variables:

```text
LAB_TARGET_SERIAL       rooted target ADB serial
LAB_SOURCE_SERIAL       Play Store source ADB serial
LAB_SOURCE_AVD          Play Store source AVD name
LAB_SOURCE_IMAGE_PACKAGE Play Store source image package
LAB_SOURCE_DEVICE_PROFILE Preferred source device profile [pixel_7_pro]
LAB_SDK_ROOT            auto-detected Android SDK
LAB_API_LEVEL           33
LAB_ABI                 x86_64
LAB_FRIDA_VERSION       auto
LAB_PROXY_HOST          Proxy host reachable from the target [Burp by default]
LAB_PROXY_PORT          Proxy listener port
LAB_BURP_HOST           Older alias for LAB_PROXY_HOST, still works
LAB_BURP_PORT           Older alias for LAB_PROXY_PORT, still works
LAB_GPU_MODE            Emulator -gpu mode [auto]
LAB_PORTABLE            1 = download Java/Python/7-Zip into tools/ only, never the host's own
```

### How values relate

The target values control the rooted test device:

```text
LAB_TARGET_SERIAL -> ADB commands, root checks, Frida, proxy, and app launch
LAB_AVD_NAME      -> target AVD created/started by bootstrap
```

The source values control only Play Store recovery:

```text
LAB_SOURCE_SERIAL       -> source ADB device
LAB_SOURCE_AVD          -> source AVD started by init
LAB_SOURCE_IMAGE_PACKAGE -> source system image installed when missing
```

The proxy is one shared endpoint (Burp by default):

```text
LAB_PROXY_HOST + LAB_PROXY_PORT -> Android global http_proxy on the target
```

Example for another workstation:

```powershell
$env:LAB_TARGET_SERIAL = "emulator-6000"
$env:LAB_SOURCE_SERIAL = "emulator-6002"
$env:LAB_AVD_NAME = "Rooted_Target"
$env:LAB_SOURCE_AVD = "Play_Source"
$env:LAB_BURP_HOST = "192.168.50.20"
$env:LAB_BURP_PORT = "8080"

bun run e2e -- `
  --package=com.example.authorized `
  --burp-host=$env:LAB_BURP_HOST `
  --burp-port=$env:LAB_BURP_PORT
```

## Project layout

```text
android-pentest-lab/
  package.json             Bun commands and dependencies
  run.ts                   App launch, Burp, certificate, and Frida attach
  verify.ts                Target health check
  scripts/hook.js          Minimal placeholder Frida hook
  scripts/ssl-unpinning.js Universal SSL/TLS pinning bypass (see below)
  src/
    lab.ts                 Lifecycle commands and orchestration
    transfer.ts            Split APK transfer (source -> target)
    adb.ts                 Serial-aware ADB wrapper, root-mode detection
    avd.ts                 AVD creation/startup, device-profile resolution
    config.ts              Defaults, flags, and LAB_* variables
    download.ts            Download/extraction helpers, Java/7-Zip bootstrap
    exec.ts                Process execution
    frida.ts               Host/server Frida management
    log.ts                 Console logging
    platform.ts            Windows/WSL/Linux/macOS detection
    sdk.ts                 SDK discovery and installation
  cert/README.md           Burp CA instructions
  apk/                     Optional local APKs, ignored by Git
  tools/                   Caches and local SDK, ignored by Git
```

## SSL/TLS pinning bypass

`scripts/ssl-unpinning.js` is a generic, reusable pinning-bypass script,
separate from `scripts/hook.js` (a minimal placeholder meant to be replaced
per-app). Use it directly:

```powershell
bun run.ts --package=<pkg> --frida-script=scripts/ssl-unpinning.js
```

It patches OkHttp's `CertificatePinner`, `WebViewClient.onReceivedSslError`
(covers WebView/hybrid apps), and conscrypt's `TrustManagerImpl.verifyChain`,
skipping any hook whose target class isn't present in a given app instead of
throwing. The `javax.net.ssl.SSLContext.init`/`TrustManager` override is
**off by default** — see the KNOWN ISSUE comment at the top of the file: it
has been observed to reliably crash a .NET MAUI app at process-bind time.
Installing the Burp CA into the rooted system trust store (which `run.ts`
already does automatically) is frequently enough on its own for apps with
no custom pinning logic at all — try that first before enabling the
SSLContext override.

## Troubleshooting

**No target root**

`bun run bootstrap` already tries `adb root` automatically before falling
back to `su -c id` (see **Root: two kinds, handled automatically** above).
If both fail, the AVD genuinely needs manual preparation: rootAVD/Magisk for
a Play-Store image or physical device, or confirm you're using this
project's default non-Play-Store `google_apis` tag for a zero-effort target.

**"Error: No device found matching --device \<id\>"**

The device id you (or a config default) requested isn't in the
`avdmanager` device list this SDK install shipped — most commonly a
literal `pixel_10_pro`/similarly-new id on the auto-downloaded "command-line
tools only" package, which has an older, fixed device list than Android
Studio's. `bun run bootstrap`/`init` resolve this automatically now
(falling back to the newest available `pixel_*_pro` profile with a
warning); if you're running `avdmanager` by hand, run `avdmanager list
device` to see what's actually available and pick from that list.

**Play Store AVD boot times out on its very first boot**

A brand-new Play Store AVD has no boot snapshot yet and can take several
minutes to cold-start Google Play services — measured well over 5 minutes
on this project's own test machine. `bun run init`'s default source-boot
timeout already accounts for this; raise it further with `--timeout=<sec>`
if needed. Give it another 30-60s after `sys.boot_completed=1` before
installing anything — package/activity manager services can still be
settling right after that property flips.

**Emulator window is black / boot times out on another machine (e.g. a VM)**

Almost always a GPU-passthrough issue — VMware and similar VMs generally
can't offer the real OpenGL passthrough `-gpu host` needs. The default is
now `-gpu auto` (picks host GPU when it actually works, software rendering
otherwise), and a boot timeout right after launching the emulator also
triggers one automatic retry with `-gpu swiftshader_indirect`. If it still
fails, force software rendering directly: `bun run init -- --gpu-mode=swiftshader_indirect`.

**Need to verify or run the lab without touching the host's own installs**

Use `--portable` (see **Running fully portable** above) — it downloads
private copies of Java/Python/7-Zip into `tools/` instead of using `winget`
or whatever the host already has, so nothing outside this project's own
directory is touched.

**"Can't find service: package/activity" during transfer or install**

Transient system-server hiccup, most often seen right after an AVD's first
boot or when two emulators are running at once on a loaded host — it
recovers on its own within seconds. `src/transfer.ts`'s `adb()` helper
already retries a few times on exactly this error class; if you hit it
elsewhere, wait a few seconds and rerun the command.

**SDK tools or image missing**

Run:

```powershell
bun run init -- --install-sdk
```

**Two emulators are ambiguous**

Check serials and override them with `LAB_TARGET_SERIAL` and
`LAB_SOURCE_SERIAL`. All project ADB and Frida operations use the target serial
explicitly.

**Proxy (Burp or otherwise) is unreachable**

Confirm your proxy tool listens on the configured LAN address and port, then check:

```powershell
adb -s $env:LAB_TARGET_SERIAL shell settings get global http_proxy
bun run verify
```

**Frida is unavailable**

Run:

```powershell
bun run bootstrap -- --force-frida
bun run verify
```

**Play Store app is not found**

Open the source emulator, sign in to Google Play, install the app once, and
rerun `bun run e2e -- --package=<package>`. The package must be installed from
the same release on the source emulator.

## Safety

Use this lab only with applications and systems you own or are explicitly
authorized to test. Do not commit APKs, SDKs, Frida binaries, private
certificates, or credentials.
