# Android Pentest Lab

A Bun/TypeScript automation lab for authorized Android application testing.
Two emulators (a rooted **target** for Frida, a Play Store **source** for
recovering real apps), ADB, Frida, and a proxy (Burp Suite by default) —
stood up and torn down with a handful of commands. **Windows 11 is the
verified, primary platform** (WSL2/Linux code paths exist but aren't the
current focus).

## Quick start

```powershell
git clone https://github.com/Omed0/android-pntest-lab.git
Set-Location .\android-pntest-lab
bun install

bun run init -- --install-sdk     # downloads/installs everything, boots both emulators
```

Start Burp (or your proxy of choice), then:

```powershell
bun run run -- --package=com.example.app --apk=.\apk\target.apk
```

That's the whole normal workflow: `init` once per machine (or after `clean`),
`run` per app. Everything below explains what each command does and how to
customize it.

## Table of contents

- [Commands](#commands)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Emulator display: GPU and window](#emulator-display-gpu-and-window)
- [Root: two kinds, handled automatically](#root-two-kinds-handled-automatically)
- [Proxy and certificates](#proxy-and-certificates-burp-by-default--any-other-tool-also-works)
- [Portable mode](#portable-mode-no-system-wide-installs-at-all)
- [Using your own existing AVD](#using-your-own-existing-avd-rooted-or-play-store-instead)
- [Configuration reference](#configuration-reference)
- [SSL/TLS pinning bypass](#ssltls-pinning-bypass)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)
- [Safety](#safety)

## Commands

| Command | What it does |
|---|---|
| `bun run init -- --install-sdk` | Download/install everything needed (Java, SDK, Frida), create + boot both emulator roles, verify root, deploy Frida, set the device proxy and install its CA. Safe to rerun — skips anything already in place. |
| `bun run run -- --package=<pkg>` | Install or recover an app, re-confirm the proxy (Burp by default) and its CA, launch the app, attach Frida. |
| `bun run clean` | Delete this lab's AVDs and the entire downloaded `tools/` directory (SDK, cache, Frida binaries), so the next `init` is a genuine from-scratch rebuild. Never touches your APKs, `cert/`, or anything outside what this lab manages. |
| `bun run transfer -- --package=<pkg>` | Pull a complete installed package (base + split APKs) from the Play Store source to the rooted target. `run` calls this automatically when an app isn't on the target yet. |
| `bun run apkinfo -- --apk=<path>` | Read a package name/version/launch-activity out of an APK without installing it. `--quiet` prints only the package name (for scripting). |
| `bun run verify` | Read-only health check: host Frida, ADB, boot state, root, `frida-server`, Frida connectivity, proxy setting. |

Every command supports `--help` for its full flag list (`bun run init -- --help`, `bun run run -- --help`, etc.)

## Architecture

```
                    ┌─────────────────────┐
                    │   Your machine       │
                    │  (Burp / other proxy)│
                    └──────────┬───────────┘
                               │ HTTP(S) proxy, 10.0.2.2:<port>
              ┌────────────────┼────────────────┐
              │                                 │
   ┌──────────▼──────────┐          ┌───────────▼──────────┐
   │  TARGET emulator      │          │  SOURCE emulator      │
   │  rooted, no Play Store│          │  Play Store enabled   │
   │  Frida attaches here  │◄─────────┤  app installed here    │
   │  (bun run run)         │ transfer │  (interactive sign-in │
   │                        │          │   + one Install tap)  │
   └────────────────────────┘          └────────────────────────┘
```

The two roles are deliberately never the same device: Play Store images are
locked down by Google (no `adb root`, no Magisk) — install the real app
there once, then `bun run transfer` (or `run`, which calls it automatically)
hands the APKs to your separate rooted target for actual testing.

| Role | AVD name | Serial | Purpose |
|---|---|---|---|
| Target | `$LAB_AVD_NAME` (default `Pixel_7_Pro`) | `$LAB_TARGET_SERIAL` (default `emulator-5554`) | Rooted, Frida-attached test device |
| Source | `$LAB_SOURCE_AVD` (default `Pixel_10_Pro`) | `$LAB_SOURCE_SERIAL` (default `emulator-5556`) | Play Store app recovery only |

## Requirements

Install or provide yourself:

- Bun 1.4+
- A proxy tool if you want traffic capture (Burp Suite is the default; any other HTTP(S) proxy works too — see below)
- Network access for SDK/Frida/system-image downloads

Everything else is automated by `bun run init -- --install-sdk`:

| Dependency | Handled how |
|---|---|
| Java (JRE/JDK) | Detected before touching `sdkmanager`/`avdmanager`; auto-installed via `winget` on Windows, or downloaded as a private portable zip with `--portable`. |
| Python + pip | Used for `pip install frida frida-tools`. Detected even when not yet visible on a freshly-changed PATH; only installs a new one if truly none is found. |
| 7-Zip (Windows) | Auto-installed via `winget`, or a private portable copy with `--portable`. `.zip` extraction falls back to the built-in `Expand-Archive` either way. |
| Android SDK (cmdline-tools / platform-tools / emulator / system images) | Downloaded and installed by `sdkmanager`, cached under `tools/cache/`. |
| GPU-enabled AVD config | Every AVD this lab creates gets `hw.gpu.enabled=yes` explicitly written into its `config.ini` — `avdmanager create avd` alone defaults this to `no`, which is what actually causes an all-black/white/grey emulator screen (not a `-gpu` flag problem). |
| Android Studio (GUI) | Installed via `winget` as a real, standard app — shows up in Windows search / Start Menu, the deliberate *opposite* of `--portable`'s isolated pattern above. Purely additive: this lab's own AVD/emulator management always uses the headless CLI-managed SDK regardless of whether Studio is installed. Skip with `--no-android-studio`. |
| Root | Auto-detected per device (see below). Never downloads, installs, or configures Magisk unless you explicitly opt in with `--magisk-root`. |

## Emulator display: GPU and window

**GPU mode** — two independent settings, because the two roles behave differently:

- **Target** (`--gpu-mode`, env `LAB_GPU_MODE`, default `auto`): with GPU explicitly enabled in its AVD config (see table above), `auto` reliably renders on the host GPU.
- **Source**: launched with **no `-gpu` flag at all** — confirmed directly that this AVD renders correctly when launched exactly like Android Studio's own Device Manager does (no CLI override, `hw.gpu.mode=auto` from its `config.ini` is the only setting in effect); the lab's own earlier custom `-gpu` override on this AVD was the cause of the instability, not the fix for it. The one exception: a **brand-new** source AVD's very first boot has no snapshot yet and must cold-boot the full guest graphics stack, which was confirmed to crash-loop (endless restarting boot animation) under host GPU on at least one machine (AMD integrated GPU + this preview system image) — so that one first-ever cold boot forces `--source-gpu-mode` (env `LAB_SOURCE_GPU_MODE`, default `swiftshader_indirect`) automatically. Every later boot of that same AVD (once a snapshot exists) goes back to the flagless, Device-Manager-matching path. A boot timeout on a non-fresh AVD also retries once with this override.

**Window** — visible by default, no bare console window, and sized to actually fit your screen:

- Launches with a real, visible window (`--no-show-window` to hide it), with the terminal/console window it would otherwise also pop up suppressed (`-NoNewWindow`, not just a hidden style — a genuinely different Windows API call).
- Raised and un-minimized immediately after launch (not just at the end), so you can watch it boot.
- Position/size are locked read-only (`--no-lock-window` to disable) so the emulator can't silently reset them on shutdown, the way it normally would.
- **Size is measured, not guessed**: `--window-scale` defaults to `0`, meaning "auto-fit" — at lock time, the lab measures *this machine's actual screen work area* (via .NET's `Screen.WorkingArea`, falling back to raw `GetSystemMetrics` if that API isn't available) and *this AVD's actual device resolution* (`hw.lcd.width`/`hw.lcd.height` from its own `config.ini`), then computes the largest scale that fits both dimensions within ~92% of the screen. If either real measurement fails, `window.scale` is left unset (the emulator's own default) rather than substituting a guessed number — the fit is always live-measured for whatever screen this happens to run on, never a hardcoded constant. Pass an explicit `--window-scale=<n>` (`0 < n <= 1.0`; `1.0` = native size) to override with a literal scale instead.
- The emulator's window enforces its locked scale as a hard *maximum* too — a real Win32 "maximize" call has no effect once a scale is locked, which is exactly why the auto-fit measurement (not an OS maximize call) is what makes the window actually fill the screen for the **target**. The **source** has no scale lock at all, so its window uses a real OS-level maximize instead.
- **Host keyboard input**: every AVD also gets `hw.keyboard=yes` written into its `config.ini` — `avdmanager create avd` defaults this to `no` for phone profiles, which makes Android expect only the on-screen soft keyboard and ignore host keystrokes entirely. With it enabled, typing on your physical keyboard reaches whatever field is focused in either emulator, same as Android Studio's own AVDs.

## Root: two kinds, handled automatically

- **`adb root`-rooted emulators** — the default (`google_apis`, non-Play-Store) target image: a userdebug build where `adb root` alone restarts `adbd` as root, no Magisk needed. `bun run init` tries this first — **zero manual steps** for the default configuration.
- **Magisk/su-rooted devices** — physical hardware, Play-Store images, or a rootAVD-prepared AVD. Falls back to `su -c '<cmd>'` automatically when `adb root` doesn't grant `uid=0`.

`verifyRoot()` tries `adb shell id` → `adb root` → `su -c id` in order and uses whichever succeeds; every later root-only command reuses that same mode.

**Does this lab download/install Magisk?** By default, no — it only *detects*
whichever root kind is already present; `adb root` on the default system
image is all it needs. Pass `--magisk-root` and it does: see below.

### Optional: real Magisk on the target (`--magisk-root`)

`adb root` gives every root-only feature this lab uses (Frida, cert install)
a `uid=0` shell — but some apps under test check for root a different way:
looking for the `su` binary specifically, or for the Magisk app package
itself, rather than just checking `id`. `adb root` alone doesn't fool that
kind of check, because there's no real `su`/Magisk installed underneath it.

Pass `--magisk-root` and the target AVD's ramdisk gets patched with real
Magisk via [rootAVD](https://github.com/newbit1/rootAVD) — automatically
downloaded, extracted, and driven through its (otherwise interactive) menu.
This is **opt-in and off by default** because it's a meaningfully heavier,
slower, and riskier operation than everything else this project does
automatically: it patches the AVD's ramdisk image on disk and requires a
full emulator kill+relaunch (not just an `adb reboot`) to take effect. Only
reach for it if you actually need to defeat `su`/Magisk-specific detection;
for everything else, the default `adb root` path is faster and simpler.

`--magisk-root` only ever applies to the rooted **target** AVD, never the
Play Store **source** — the source stays intentionally locked down (no `adb
root`, no Magisk) per the two-roles architecture described above; that's not
something this flag changes or attempts to work around.

The patch step is idempotent — rerunning `bun run init -- --magisk-root`
detects an already-Magisk-rooted device and skips straight past it — and
non-fatal on failure: if rootAVD's patch or the post-patch `su` check doesn't
succeed, bootstrap logs a clear warning and continues with plain adb-root,
rather than aborting the whole lab setup.

## Proxy and certificates (Burp by default — any other tool also works)

`bun run init` sets the target's global Android proxy to
`$LAB_PROXY_HOST:$LAB_PROXY_PORT` and installs its CA **as part of init
itself** (older `LAB_BURP_HOST`/`LAB_BURP_PORT` names still work as
aliases) — the lab is proxy-ready the moment init finishes, without waiting
for the first app run. `bun run run` re-applies the exact same idempotent
steps right before attaching Frida (harmless to repeat — useful after a
device restart, or to point one run at a different proxy/host/port).

**Burp (default, no extra flags needed):** if `cert/` has no certificate,
the lab requests Burp's CA through `http://burp/cert` and saves it as
`cert/burp-ca.cer`. The CA is installed into the target's system trust store
via a **tmpfs overlay** on `/system/etc/security/cacerts` — just `adb root`,
no `-writable-system`, no dm-verity disable, no reboot. Already-installed
certs are detected and skipped on rerun.

**A different proxy tool** (mitmproxy, etc.): pass `--proxy-tool=other` (skips
the Burp-only auto-download), `--proxy-host`/`--proxy-port` for your
listener, and a cert dropped in `cert/` or `--proxy-cert=<path>`:

```powershell
bun run init -- --proxy-tool=other --proxy-host=10.0.2.2 --proxy-port=8080
bun run run -- --package=<pkg> --proxy-tool=other --proxy-host=10.0.2.2 --proxy-port=8080 --proxy-cert=.\mitmproxy-ca.pem
```

**No proxy at all:** `--no-proxy` (alias `--no-burp`) skips proxy/cert setup —
pass it to `init` to skip it there, and/or to `run` to skip it there too;
they're independent.

If the certificate isn't ready yet (Burp not running, no file under `cert/`),
`init` warns and continues rather than aborting the whole setup — root,
Frida, and both emulators are still fully usable; rerun `init` (or `run`,
which checks again) once the cert is in place.

Restart the target app after changing the CA. Certificate pinning and
app-specific trust policies may still block interception — see
[SSL/TLS pinning bypass](#ssltls-pinning-bypass).

## Portable mode (no system-wide installs at all)

Pass `--portable` to `bun run init` to download Java, Python, and 7-Zip as
private zip copies under this project's own `tools/` directory instead of
using `winget` or anything already on the host — even if the host already
has its own copies, `--portable` never uses or mutates them (no `winget
install`, no PATH/registry changes; only this process's own PATH is
extended). The Android SDK/AVD also default to a private path under
`tools/android-sdk` in this mode instead of the host's real SDK, unless you
pass an explicit `--sdk-root`. Delete `tools/` afterward to remove
everything this mode downloaded.

## Using your own existing AVD (rooted or Play Store) instead

Point the lab at an AVD you already have by name — it's checked before any
AVD is created, so an existing one with the configured name is reused as-is
and never recreated or modified:

```powershell
$env:LAB_AVD_NAME = "<your-existing-rooted-avd-name>"
$env:LAB_SOURCE_AVD = "<your-existing-playstore-avd-name>"
bun run init
```

To create a fresh Play Store AVD by hand (no lab code needed, just the SDK
the lab already manages):

```powershell
$SDK = "$env:LOCALAPPDATA\Android\Sdk"
& "$SDK\cmdline-tools\latest\bin\sdkmanager.bat" --install "system-images;android-37.0;google_apis_playstore;x86_64"
& "$SDK\cmdline-tools\latest\bin\avdmanager.bat" create avd --name PlayStore_Source --package "system-images;android-37.0;google_apis_playstore;x86_64" --device pixel_7_pro --force
& "$SDK\emulator\emulator.exe" -avd PlayStore_Source -gpu swiftshader_indirect
```

**Device profile note:** `--device <id>` must be an id your `cmdline-tools`
actually knows about (`avdmanager list device`) — the auto-downloaded
"command-line tools only" package ships an older, fixed device list than
Android Studio, so a very new id may not exist yet. The lab's own AVD
creation resolves this automatically (falls back to the newest available
`pixel_*_pro` profile with a warning); this note is only for running
`avdmanager` by hand.

**First-boot timing:** a Play Store AVD's very first boot has no snapshot yet
and cold-starts Google Play services — measured well over 5 minutes on this
project's own test machine. `init`'s default source-boot timeout (600s)
accounts for this; raise it further with `--timeout=<sec>` if needed. Give it
another 30-60s after `sys.boot_completed=1` before installing anything.

**Avoid "_ps16k" (16 KB Page Size) system images for the source role** — these
are explicitly labeled "Pre-Release" experimental images in `sdkmanager
--list`, and were confirmed directly to cause real instability on at least
one test machine (DMA-readback assertion crashes on `screencap`, Windows
"device attached to the system is not functioning" display errors, and
unreliable boots). This project's own default source image was fixed to a
standard, non-`_ps16k` image for exactly this reason — don't override
`--source-image-package` back to a `_ps16k` variant unless you specifically
need 16 KB page size testing and have verified it's stable on your machine.

## Configuration reference

Priority: **CLI flag** > **environment variable** > **built-in default**.

```text
LAB_TARGET_SERIAL         Rooted target ADB serial              [emulator-5554]
LAB_AVD_NAME              Target AVD name                       [Pixel_7_Pro]
LAB_SOURCE_SERIAL         Play Store source ADB serial          [emulator-5556]
LAB_SOURCE_AVD            Play Store source AVD name            [Pixel_10_Pro]
LAB_SOURCE_IMAGE_PACKAGE  Play Store source system image         [android-37.0, google_apis_playstore, no ps16k]
LAB_SOURCE_DEVICE_PROFILE Preferred source device profile       [pixel_7_pro]
LAB_SDK_ROOT              Android SDK root                      [auto-detect]
LAB_API_LEVEL             Target Android API level              [33]
LAB_ABI                   CPU ABI                                [x86_64]
LAB_FRIDA_VERSION         Frida version                          ["auto" = match host]
LAB_PROXY_HOST/PORT       Proxy endpoint (Burp by default)       [10.0.2.2:8080]
LAB_BURP_HOST/PORT        Older aliases for the above, still work
LAB_GPU_MODE              Target emulator -gpu mode              [auto]
LAB_SOURCE_GPU_MODE       Source emulator -gpu mode               [swiftshader_indirect]
LAB_WINDOW_SCALE          Emulator window scale                  [0 = auto-fit screen]
LAB_PORTABLE              1 = download deps into tools/ only, never the host's own
```

Run `bun run init -- --help` for the complete flag list (AVD sizing, boot
timeout, window position, SDK paths, `--magisk-root`, and more).

Example for a different workstation:

```powershell
$env:LAB_TARGET_SERIAL = "emulator-6000"
$env:LAB_SOURCE_SERIAL = "emulator-6002"
$env:LAB_AVD_NAME = "Rooted_Target"
$env:LAB_SOURCE_AVD = "Play_Source"
$env:LAB_BURP_HOST = "192.168.50.20"
$env:LAB_BURP_PORT = "8080"

bun run init -- --install-sdk
bun run run -- --package=com.example.authorized
```

## SSL/TLS pinning bypass

`bun run run` loads the [HTTPToolkit unpinning
suite](https://github.com/httptoolkit/frida-interception-and-unpinning)
(vendored under `scripts/unpinning/`) **automatically, by default** — no
flag needed. It covers far more real apps than a single hand-written script
can:

| Script | What it covers |
|---|---|
| `native-connect-hook.js` | Redirects all raw socket connections to the proxy, even ones that ignore system proxy settings entirely. |
| `native-tls-hook.js` | Patches BoringSSL-level TLS validation directly — the layer Flutter, most native code, and many hybrid frameworks actually use instead of the Java TLS stack. |
| `android-proxy-override.js` | Forces the app's own proxy config to the configured host/port. |
| `android-system-certificate-injection.js` | Native-level system trust store injection (complements, doesn't replace, the tmpfs overlay `run`/`init` already install). |
| `android-certificate-unpinning.js` | OkHttp, TrustKit, Appmattus, and other named pinning libraries. |
| `android-certificate-unpinning-fallback.js` | **Auto-detects and patches unrecognized pinning failures on the fly**, and when it genuinely can't, prints a loud, unmissable alert — see below. |
| `android-disable-root-detection.js` | Common root/Magisk detection checks (file existence, `su`, system properties). |
| `android-disable-flutter-certificate-pinning.js` | Flutter's own bundled TLS stack, which ignores the system trust store and most Java-level hooks entirely. |

`bun run run` generates a fresh `scripts/unpinning/config.generated.js` on
every run (gitignored) from your live `--proxy-host`/`--proxy-port` and the
currently-installed proxy CA — no manual editing of `config.js` needed.

**If it can't bypass something**: the fallback layer prints this to the
Frida console when a pinning failure isn't one of the patterns it
recognizes:

```
!!! --- Unexpected TLS failure --- !!!
...
[ ] Unrecognized TLS error - this must be patched manually
```

That's your signal to write a small app-specific hook. Drop it at
`scripts/custom/<package.name>.js` — it's picked up and loaded automatically
(after the whole suite) the next time you run that package, no flag needed.
See `scripts/custom/README.md` for a template and this lab's own documented
case (a MAUI app whose `SSLContext.init` crashes if hooked directly — the
suite's native-level hook already avoids that call path, so no custom
script was actually needed there, but the writeup is a useful example of
how to reason about one).

**Your own extra instrumentation**: `--frida-script=<path>` loads an
additional script *on top of* the unpinning suite (not instead of it) —
use it for app-logic hooks unrelated to pinning. `--no-unpinning` skips the
suite entirely and falls back to `--frida-script` alone (or
`scripts/hook.js`, a minimal placeholder, if neither is given).

## Project layout

```text
android-pentest-lab/
  package.json             Bun commands
  run.ts                   App launch, proxy, certificate, and Frida attach
  verify.ts                Target health check
  scripts/hook.js          Minimal placeholder Frida hook
  scripts/unpinning/       Vendored HTTPToolkit unpinning suite (loaded by default)
  scripts/custom/          Your own per-package pinning fixes (auto-loaded by package name)
  src/
    lab.ts                 init/clean orchestration and CLI
    transfer.ts            Split APK transfer (source -> target)
    apkinfo.ts             Read an APK's package name/version without installing
    unpinning.ts           Builds the HTTPToolkit script chain + generates its config
    adb.ts                 Serial-aware ADB wrapper, root detection, CA install
    avd.ts                 AVD creation, GPU config, window lock/raise, launch
    magisk.ts              Optional real Magisk root via rootAVD (--magisk-root)
    proxy.ts               Device proxy + CA cert install/clear (shared by init and run)
    config.ts              Defaults, flags, and LAB_* variables
    download.ts            Download/extraction helpers, Java/7-Zip bootstrap
    exec.ts                Process execution
    frida.ts               Host/server Frida management
    log.ts                 Console logging
    platform.ts            Windows/WSL/Linux/macOS detection
    sdk.ts                 SDK discovery and installation
  cert/README.md           Proxy CA instructions
  apk/                     Optional local APKs, ignored by Git
  tools/                   Caches and local SDK, ignored by Git
```

## Troubleshooting

**Emulator window is black/white/grey**

The cause was `hw.gpu.enabled=no` in the AVD's `config.ini` — fixed for every
AVD this lab creates (see [Requirements](#requirements)). If you still see it
on the target, try `--gpu-mode=swiftshader_indirect`. The source already
defaults to software rendering.

**Emulator never boots / `init` looks stuck with no output**

The boot wait polls within its timeout rather than using a blocking `adb
wait-for-device` (which used to hang forever with zero output when the
emulator never registered with adb at all). If you hit this, it's almost
always missing hardware acceleration — enable **Windows Hypervisor
Platform** ("Turn Windows features on or off") and VT-x/AMD-V in BIOS/UEFI.

**"Can't find service" / "Too early to start activity" during transfer or install**

Transient system-server hiccup right after boot (activity manager not fully
settled yet even though `sys.boot_completed=1`), or two emulators booting at
once on a loaded host. `transfer`'s `adb()` helper retries on this error
class automatically, and `init` waits a few seconds after the source boots
before handing off; if you still hit it elsewhere, wait a moment and rerun.

**`market://` / Play Store intent won't resolve on the source**

The source AVD needs Play Store's own first-run setup completed once
(interactively — sign into Google, accept terms) before `market://` links or
app installs work. This is a one-time, human-only step; open the source
emulator's window and complete it, then rerun `transfer`/`run`.

**Can't tell if the source emulator's screen is actually rendering**

`bun run verify`/`init` never automatically flags this for the source
role — confirmed directly that `adb shell screencap` throws `Assertion
failed: !rcEnc->featureInfo()->hasReadColorBufferDma` on at least one
source-image variant's DMA readback path regardless of GPU mode or the
actual display state, so an automated check here would always be an
unreliable false positive/negative with zero real signal. You have to look
at the source window yourself; if it's genuinely blank/black/white, confirm
you're not on a `_ps16k` experimental image (see above) and try
`--source-gpu-mode=auto` or `swiftshader_indirect` (whichever you're not
currently using). You can also check the real underlying state without
`screencap`, e.g. `adb shell dumpsys window | grep mCurrentFocus` — if it
shows a real launcher/app activity, the device has actually booted correctly
even if the emulator's own window looks wrong (a host-side display/GPU
driver rendering issue, not an Android-level failure).

**"Error: No device found matching --device \<id\>"**

The device id requested isn't in this SDK install's `avdmanager` device
list (older, fixed list vs. Android Studio's newer one). `init` resolves
this automatically now (falls back to the newest available `pixel_*_pro`
profile with a warning); if running `avdmanager` by hand, use `avdmanager
list device` to see what's actually available.

**SDK tools or image missing**

```powershell
bun run init -- --install-sdk
```

**Two emulators are ambiguous**

Check serials and override with `LAB_TARGET_SERIAL`/`LAB_SOURCE_SERIAL`. All
project ADB/Frida operations use the target serial explicitly.

**Proxy is unreachable**

Confirm your proxy tool listens on the configured address/port (bound to
all interfaces, not just localhost), then:

```powershell
adb -s $env:LAB_TARGET_SERIAL shell settings get global http_proxy
bun run verify
```

**Frida is unavailable**

```powershell
bun run init -- --force-frida
bun run verify
```

**Need to verify/run without touching the host's own installs**

Use `--portable` (see [Portable mode](#portable-mode-no-system-wide-installs-at-all)).

## Safety

Use this lab only with applications and systems you own or are explicitly
authorized to test. Do not commit APKs, SDKs, Frida binaries, private
certificates, or credentials.
