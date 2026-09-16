# Android Pentest Lab

A cross-platform Bun/TypeScript workflow for a rooted Android emulator, ADB,
Frida, and optional Burp Suite proxying. It is intended for applications you
own or are explicitly authorized to test.

## What it does

`scripts/initialize-lab.ts` is the recommended first-run command. It prepares
the rooted lab through `scripts/bootstrap-lab.ts`, then starts the optional Play
Store source emulator. `scripts/bootstrap-lab.ts` remains available when only
the rooted lab is needed.

`scripts/bootstrap-lab.ts` prepares the rooted lab in stages:

1. Detects Windows, WSL, Linux, or macOS.
2. Finds the Android SDK, `adb`, and `emulator`.
3. Creates or verifies the configured AVD.
4. Starts the emulator and waits for boot, unless it is already running.
5. Verifies root access through `adb root` or `su`.
6. Installs host Frida tools with `pip` when needed.
7. Downloads the matching Android `frida-server` for the device ABI.
8. Pushes and starts `frida-server` as a root daemon.
9. Verifies host-to-device communication with the configured target serial.

`run.ts` assumes that initialization has completed. It configures Burp, prepares
the certificate, installs or recovers the application, launches it, and attaches
or spawns it under Frida.

## Two-emulator workflow

The project uses two explicit emulator roles:

- **Target lab:** `Pixel_7_Pro`, normally `emulator-5554`, rooted for Frida.
- **Source:** `Pixel_10_Pro`, normally `emulator-5556`, Android 36 Google APIs
  Play Store image used to obtain Play-distributed apps.

Initialize both roles:

```powershell
bun install
bun run init -- --install-sdk
```

## One-command end-to-end run

For the complete lifecycle, use `scripts/run-e2e.ts`:

```powershell
bun run e2e -- `
  --package=com.tarikalthuraya.maui.android `
  --burp-host=192.168.10.91 `
  --burp-port=6666
```

With a local APK as the first installation source:

```powershell
bun run e2e -- `
  --package=com.tarikalthuraya.maui.android `
  --apk=.\apk\Tarik.apk `
  --burp-host=192.168.10.91 `
  --burp-port=6666
```

This initializes both emulator roles, checks root and Frida, uses the local APK
when possible, falls back to the Play Store source for missing/split packages,
configures Burp and its certificate flow, launches the app, and attaches Frida.
E2E requests SDK/tool downloads automatically on first run. If the configured
source AVD is missing, it also attempts to install the Android 36.1 Play Store
image and create `Pixel_10_Pro`. Override the image package with
`--source-image-package=<package-id>` when your SDK channel uses a different ID.
The first run still requires root preparation, Google Play login/install consent,
and Android certificate confirmation.

On later runs:

```powershell
bun run init
```

Use `bun run init -- --skip-source` when only the rooted target is needed. With
`--install-sdk`, initialization attempts to download/create the configured
Google APIs Play Store source AVD. It does not create a Play Store account or
silently accept Google Play licensing.

Override either role without editing source code:

```powershell
$env:LAB_TARGET_SERIAL = "emulator-5554"
$env:LAB_SOURCE_SERIAL = "emulator-5556"
$env:LAB_SOURCE_AVD = "Pixel_10_Pro"
$env:LAB_BURP_HOST = "192.168.10.91"
$env:LAB_BURP_PORT = "6666"
```

Check both devices before transferring:

```powershell
adb devices -l
adb -s emulator-5554 shell getprop ro.boot.qemu.avd_name
adb -s emulator-5556 shell getprop ro.boot.qemu.avd_name
```

### Automatic package recovery

Use `run.ts` as the normal entry point. You do not need to run `src/transfer.ts`
separately:

```powershell
bun run.ts `
  --package=com.tarikalthuraya.maui.android `
  --burp-host=192.168.10.91 `
  --burp-port=6666
```

The runner checks the rooted target first. If the package is absent, it checks
the source emulator, opens the Play Store page if necessary, waits for the app,
pulls all base/split APKs, installs them on the rooted target, and continues to
launch and attach Frida. If `--apk` is supplied, it tries that APK first and
falls back to the source emulator when the file is missing or produces a split
installation error.

```powershell
bun run.ts `
  --package=com.tarikalthuraya.maui.android `
  --apk=.\apk\Tarik.apk `
  --burp-host=192.168.10.91 `
  --burp-port=6666
```

The source Play Store install still requires Google Play account consent and a
user action. Everything after the source package is installed is automatic.

For diagnostics or standalone use, the lower-level transfer command remains.
When an application is available through Google Play but is not available as a
universal APK, it uses two running emulators:

- Source: Play Store emulator, default `emulator-5556`
- Target: rooted lab emulator, default `emulator-5554`

The command first checks whether the target already has the package. If not, it
reuses an existing source installation; otherwise it opens the Play Store page,
waits for installation, discovers the base APK and every split APK, caches them
under `tools/cache/transfers/`, and installs the complete set on the target.
The Play Store interaction cannot be completed silently because it requires a
Google account and user consent.

```powershell
bun run transfer -- --package=com.tarikalthuraya.maui.android
```

For different emulator serials:

```powershell
bun run transfer -- `
  --package=com.example.app `
  --source-serial=emulator-5556 `
  --target-serial=emulator-5554
```

The source package must be installed from the same release. If the source
emulator is offline, reconnect it before running the command:

```powershell
adb devices -l
```

Frida and ADB are pinned to the target serial even while the source emulator is
online.

```powershell
bun run.ts `
  --package=com.example.app `
  --burp-host=192.168.10.91 `
  --burp-port=6666
```

## Prerequisites

- [Bun](https://bun.sh/) 1.4 or newer
- Python and `pip` for installing `frida` and `frida-tools`
- Android SDK Platform Tools and Emulator, or an SDK that the bootstrap can install
- A rooted AVD or another rooted Android device visible to ADB
- Burp Suite if HTTP/S interception is required

The default lab uses a `Pixel_7_Pro` AVD with Android API 33, `google_apis`, and
`x86_64`. A normal production/user image is not automatically rooted; prepare a
compatible userdebug, rooted, or Magisk-based image first.

## Install and bootstrap

From the project directory:

```powershell
bun install
bun run init
```

If the Android SDK is not installed or cannot be detected, request headless
command-line-tools installation:

```powershell
bun run init -- --install-sdk
```

Useful bootstrap options:

```powershell
bun run bootstrap -- --help
bun run init -- --help
bun run bootstrap -- --avd-name=Pixel_8 --api-level=35
bun run bootstrap -- --sdk-root="C:\Android\Sdk"
bun run bootstrap -- --skip-emulator
bun run bootstrap -- --force-frida
bun run bootstrap -- --force-avd
```

The matching host and device Frida versions are important. By default, the
device server version follows the installed host version. Use
`--frida-version=17.9.7` to pin a version.

## Run an application

Attach to an already running application:

```powershell
bun run.ts --package=com.example.app
```

Install an APK first and load a hook script:

```powershell
bun run.ts `
  --package=com.example.app `
  --apk=.\target.apk `
  --frida-script=.\scripts\hook.js
```

Other run options:

```powershell
bun run.ts --help
bun run.ts --package=com.example.app --spawn
bun run.ts --package=com.example.app --main-activity=com.example.app.MainActivity
bun run.ts --package=com.example.app --no-burp
```

The default hook path is `scripts/hook.js` when that file exists. Frida remains
interactive, so its REPL and script output stay in the terminal.

## Verify the lab

Run the health check at any time:

```powershell
bun verify.ts
bun verify.ts --verbose
```

It checks host Frida, the configured target ADB connection, emulator boot state,
ABI, root, the versioned `frida-server` process and binary, target-specific
Frida communication, and the configured device proxy. If the target is absent,
start with `bun run init`.

## Burp Suite and certificates

The default proxy is `10.0.2.2:8080`, where `10.0.2.2` is the host gateway for
the standard Android Emulator NAT configuration. Configure Burp to listen on
that port and on an interface reachable by the emulator.

Override the proxy when using a different network:

```powershell
bun run.ts --package=com.example.app --burp-host=192.168.1.10 --burp-port=8080
```

The runner writes the global Android `http_proxy` setting. If `cert/` is empty,
it first downloads Burp's CA from `http://burp/cert` through the configured
Burp listener. You can also put the CA in `cert/burp-ca.cer` (or `.crt`, `.der`,
`.pem`). On the first
Burp-enabled run, `run.ts` pushes it to the target and opens Android's
certificate installer. Complete the Android prompts, then type `y` in the
terminal. A marker on the rooted target prevents repeated prompts.

If no certificate is in `cert/`, the runner prints the export/install steps and
waits for `y` after you complete them manually. Use `--burp-cert=<path>` for a
certificate outside the default folder. HTTPS interception and certificate
pinning still depend on the target application's trust configuration.

## Configuration

Configuration precedence is:

1. CLI flag, such as `--avd-name=Pixel_8`
2. Environment variable, such as `LAB_AVD_NAME=Pixel_8`
3. Built-in default

Common environment variables include `LAB_SDK_ROOT`, `LAB_AVD_NAME`,
`LAB_API_LEVEL`, `LAB_ABI`, `LAB_TARGET_SERIAL`, `LAB_SOURCE_SERIAL`,
`LAB_SOURCE_AVD`, `LAB_FRIDA_VERSION`, `LAB_BURP_HOST`, and `LAB_BURP_PORT`.
Set these once in your PowerShell profile if they are your normal lab values.
See `bun run bootstrap -- --help` and `bun run init -- --help` for the complete list.

## Project layout

```text
android-pentest-lab/
  scripts/
    bootstrap-lab.ts     # Prepare the rooted target and Frida
    initialize-lab.ts    # Prepare both emulator roles
    run-e2e.ts            # Full initialize, install, Burp, and Frida flow
  run.ts             # Install, launch, and attach Frida to an app
  src/transfer.ts     # Transfer a Play Store install between emulators
  verify.ts          # Health check
  src/
    adb.ts           # ADB device operations
    avd.ts           # AVD creation and emulator startup
    config.ts        # Defaults, CLI flags, and LAB_* variables
    download.ts      # Download and archive extraction helpers
    exec.ts          # Process execution helpers
    frida.ts         # Host install and device deployment
    log.ts            # Console logging
    platform.ts       # Windows, WSL, Linux, and macOS detection
    sdk.ts            # SDK discovery and installation
  scripts/
    hook.js           # Optional Frida hook script
  cert/
    README.md         # Burp CA placement and installation notes
  tools/
    cache/            # Download cache, ignored by Git
    frida/            # Cached frida-server binaries, ignored by Git
```

`tools/android-sdk/` is also ignored when an SDK is installed inside the
project. APK files are ignored by the repository's `.gitignore`.

## Troubleshooting

- **No ADB or emulator:** install Platform Tools/Emulator, set `ANDROID_HOME`
  or `LAB_SDK_ROOT`, then run `bun run init`.
- **No root:** use a rooted or userdebug AVD. `adb root` cannot convert a
  standard production image into a rooted image.
- **Frida version mismatch:** rerun bootstrap with `--force-frida`, or pin the
  same version with `--frida-version=<version>`.
- **Download failure:** ensure the host can reach GitHub release downloads;
  cached binaries in `tools/frida/` can be reused offline.
- **Burp is unreachable:** verify the listener address, port, emulator network,
  and the value shown by `bun verify.ts`. For this lab, use
  `LAB_BURP_HOST=192.168.10.91` and `LAB_BURP_PORT=6666` when Burp listens on
  the LAN address.

## Package scripts

```powershell
bun run init
bun run e2e -- --package=com.example.app
bun run bootstrap
bun run run -- --package=com.example.app
bun run transfer -- --package=com.example.app
bun run verify
bun run help
```
