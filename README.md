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
- A rooted target AVD, or an approved userdebug/Magisk/rootAVD setup.
- Network access for first-run SDK, Frida, and system-image downloads.

The project can download Android command-line tools, Platform Tools, Emulator,
and configured system images. It does not silently execute an arbitrary rooting
script: root preparation is image/build-specific and must be performed once by
the operator.

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

Verify root directly when preparing a new target:

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb -s $env:LAB_TARGET_SERIAL shell su -c id
```

Continue only when the output contains `uid=0(root)`.

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

## Burp and certificates

The runner sets the target's global Android proxy to the configured
`LAB_BURP_HOST:LAB_BURP_PORT`. For this lab that is:

```text
$env:LAB_BURP_HOST`:$env:LAB_BURP_PORT
```

If `cert/` has no certificate, the runner requests Burp's CA through
`http://burp/cert` using the configured listener and saves it as
`cert/burp-ca.cer`. You may also place a `.cer`, `.crt`, `.der`, or `.pem` file
there, or pass `--burp-cert=<path>`.

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
LAB_SDK_ROOT            auto-detected Android SDK
LAB_API_LEVEL           33
LAB_ABI                 x86_64
LAB_FRIDA_VERSION       auto
LAB_BURP_HOST           Burp host reachable from the target
LAB_BURP_PORT           Burp listener port
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

Burp is one shared endpoint:

```text
LAB_BURP_HOST + LAB_BURP_PORT -> Android global http_proxy on the target
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
  scripts/hook.js          Optional Frida hook
  src/
    lab.ts                 Lifecycle commands and orchestration
    transfer.ts            Split APK transfer
    adb.ts                 Serial-aware ADB wrapper
    avd.ts                 AVD creation and startup
    config.ts              Defaults, flags, and LAB_* variables
    download.ts            Download/extraction helpers
    exec.ts                Process execution
    frida.ts               Host/server Frida management
    log.ts                 Console logging
    platform.ts            Windows/WSL/Linux/macOS detection
    sdk.ts                 SDK discovery and installation
  cert/README.md           Burp CA instructions
  apk/                     Optional local APKs, ignored by Git
  tools/                   Caches and local SDK, ignored by Git
```

## Troubleshooting

**No target root**

Prepare the target AVD with an approved rootAVD/Magisk/userdebug method, reboot,
and confirm `su -c id` returns `uid=0(root)`.

**SDK tools or image missing**

Run:

```powershell
bun run init -- --install-sdk
```

**Two emulators are ambiguous**

Check serials and override them with `LAB_TARGET_SERIAL` and
`LAB_SOURCE_SERIAL`. All project ADB and Frida operations use the target serial
explicitly.

**Burp is unreachable**

Confirm Burp listens on the configured LAN address and port, then check:

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
