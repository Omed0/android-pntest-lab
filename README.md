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

The very first run on a brand-new AVD needs **one manual step**: Magisk
requires a human to approve its first superuser grant (Android's own
security model — no script can fake this without defeating the point of
it). `init` doesn't fail when it hits this — it prints exactly what to do
and waits, picking up automatically the moment you do it:

```
[!] Manual step needed — this will keep waiting and continue automatically once it's done:
  Open the Magisk app inside the emulator window.
  Go to Settings and set Superuser access to auto-grant (not "Prompt") for ADB/shell requests.
  This will notice automatically once granted and continue — no need to rerun anything.
```

Do that once in the emulator window and the same `init` run continues on
its own through Frida/proxy/cert setup to `LAB READY` — no rerun needed.
Every subsequent `init`/`clean`+`init` on the same AVD skips this (Magisk's
grant persists on the device).

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
- [Root: Play Store + Magisk by default](#root-play-store--magisk-by-default)
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
| `bun run init -- --install-sdk` | Download/install everything needed (Java, SDK, Frida), create + boot both emulator roles, root the target (Play Store + Magisk by default — waits for the one-time grant on a fresh AVD instead of failing), deploy Frida, set the device proxy and install its CA. Safe to rerun — skips anything already in place. |
| `bun run run -- --package=<pkg>` | Install or recover an app, re-confirm the proxy (Burp by default) and its CA, launch the app, attach Frida with the unpinning suite. |
| `bun run clean` | Delete this lab's AVDs and the entire downloaded `tools/` directory (SDK, cache, Frida binaries, rootAVD toolkit), so the next `init` is a genuine from-scratch rebuild. Never touches your APKs, `cert/`, or anything outside what this lab manages. |
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
   │  rooted, Play Store   │          │  Play Store enabled,  │
   │  (Magisk) by default  │          │  never rooted         │
   │  Frida attaches here  │◄─────────┤  app installed here    │
   │  (bun run run)         │ transfer │  (interactive sign-in │
   │                        │          │   + one Install tap)  │
   └────────────────────────┘          └────────────────────────┘
```

The **source** is never rooted, on purpose — it exists purely so Play Store
fully trusts it and will show/install anything, including apps that a
rooted device gets hidden from or blocked on. Whether the **target** also
needs to stay separate for a given app is a judgment call — see
[Root: Play Store + Magisk by default](#root-play-store--magisk-by-default)
for when a single rooted-and-Play-Store target is enough on its own, and
when you still want the source + `transfer` path.

| Role | AVD name | Serial | Purpose |
|---|---|---|---|
| Target | `$LAB_AVD_NAME` (default `Pixel_7_Pro`) | `$LAB_TARGET_SERIAL` (default `emulator-5554`) | Rooted, Play Store enabled by default, Frida-attached test device |
| Source | `$LAB_SOURCE_AVD` (default `Pixel_10_Pro`) | `$LAB_SOURCE_SERIAL` (default `emulator-5556`) | Play Store app recovery only, never rooted |

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
| Correct AVD identity | `avdmanager create avd`'s own template substitution breaks on some system images (see [Troubleshooting](#troubleshooting)) — this lab detects and repairs it automatically right after creation, on every AVD. |
| Android Studio (GUI) | Installed via `winget` as a real, standard app — shows up in Windows search / Start Menu, the deliberate *opposite* of `--portable`'s isolated pattern above. Purely additive: this lab's own AVD/emulator management always uses the headless CLI-managed SDK regardless of whether Studio is installed. Skip with `--no-android-studio`. |
| Root | Play Store + real Magisk root by default (see below) — patches the target's ramdisk via rootAVD and waits for the one-time superuser grant on a fresh AVD instead of failing. |

## Emulator display: GPU and window

**GPU mode** — two independent settings, because the two roles behave differently:

- **Target** (`--gpu-mode`, env `LAB_GPU_MODE`, default `auto`): with GPU explicitly enabled in its AVD config (see table above), `auto` reliably renders on the host GPU.
- **Source**: launched with **no `-gpu` flag at all** — confirmed directly that this AVD renders correctly when launched exactly like Android Studio's own Device Manager does (no CLI override, `hw.gpu.mode=auto` from its `config.ini` is the only setting in effect); this lab's own earlier custom `-gpu` override on this AVD was the cause of instability, not the fix for it. The one exception: a **brand-new** source AVD's very first boot has no snapshot yet and must cold-boot the full guest graphics stack, which was confirmed to crash-loop (endless restarting boot animation) under host GPU on at least one machine (AMD integrated GPU + this preview system image) — so that one first-ever cold boot forces `--source-gpu-mode` (env `LAB_SOURCE_GPU_MODE`, default `swiftshader_indirect`) automatically. Every later boot of that same AVD (once a snapshot exists) goes back to the flagless, Device-Manager-matching path. A boot timeout on a non-fresh AVD also retries once with this override.

**Window** — visible by default, no bare console window, and sized to actually fit your screen:

- Launches with a real, visible window (`--no-show-window` to hide it), with the terminal/console window it would otherwise also pop up suppressed (`-NoNewWindow`, not just a hidden style — a genuinely different Windows API call).
- Raised and un-minimized immediately after launch (not just at the end), so you can watch it boot.
- Position/size are locked read-only (`--no-lock-window` to disable) so the emulator can't silently reset them on shutdown, the way it normally would.
- **Size is measured, not guessed**: `--window-scale` defaults to `0`, meaning "auto-fit" — at lock time, the lab measures *this machine's actual screen work area* (via .NET's `Screen.WorkingArea`, falling back to raw `GetSystemMetrics` if that API isn't available) and *this AVD's actual device resolution* (`hw.lcd.width`/`hw.lcd.height` from its own `config.ini`), then computes the largest scale that fits both dimensions within ~92% of the screen. If either real measurement fails, `window.scale` is left unset (the emulator's own default) rather than substituting a guessed number. Pass an explicit `--window-scale=<n>` (`0 < n <= 1.0`; `1.0` = native size) to override with a literal scale instead.
- The emulator's window enforces its locked scale as a hard *maximum* too — a real Win32 "maximize" call has no effect once a scale is locked, which is exactly why the auto-fit measurement (not an OS maximize call) is what makes the window actually fill the screen for the **target**. The **source** has no scale lock at all, so its window uses a real OS-level maximize instead.
- **Host keyboard input**: every AVD also gets `hw.keyboard=yes` written into its `config.ini` — `avdmanager create avd` defaults this to `no` for phone profiles, which makes Android expect only the on-screen soft keyboard and ignore host keystrokes entirely. With it enabled, typing on your physical keyboard reaches whatever field is focused in either emulator, same as Android Studio's own AVDs.

## Root: Play Store + Magisk by default

The **target** defaults to a Play Store system image (`--system-image-tag`, default `google_apis_playstore`) rooted with real Magisk (`--magisk-root`, default **on**) — one device with both Play Services present and genuine root, confirmed working end to end. `verifyRoot()` tries `adb shell id` → `adb root` → `su -c id` in order; a Play Store image can't use plain `adb root` at all (blocked by Google), so Magisk is what actually grants root there.

**The one-time manual step** (see [Quick start](#quick-start)): a fresh Magisk patch needs a human to approve its first `su` grant — there's no UI to tap for a headless `adb shell su` call, so Magisk's own access policy denies it by default (`Permission denied`, even though the patch and `magiskd` are both genuinely fine — confirmed directly: `magiskd` running as root, the Magisk app installed, at the exact moment it denies). `init` doesn't fail on this — it prints the fix and waits (polling every few seconds, with periodic reminders, for up to 15 minutes by default), continuing automatically the moment you grant it in the Magisk app. This is a one-time cost per fresh AVD; the grant persists across `init` reruns on the same AVD.

**Lighter alternative**: `--system-image-tag=google_apis --no-magisk-root` skips Play Store and Magisk entirely — a plain userdebug image where `adb root` alone grants root, no manual step, no ramdisk patch, faster boot. Use this if an app under test doesn't need Play Services at all.

**`--magisk-root` only ever applies to the target**, never the Play Store **source** — the source stays intentionally unrooted per the architecture above; that's not something this flag changes.

The patch step is idempotent (rerunning `--magisk-root` detects an already-Magisk-rooted device and skips straight past it) and non-fatal on genuine failure (a truly broken patch — not the grant-policy wait above — logs a clear warning and falls back to plain adb-root, rather than aborting the whole lab setup, on an image where that fallback is possible).

### When one rooted+Play-Store device is enough, and when it isn't

The default single-target setup works great for apps that only need Play Services to *be present*. It doesn't replace the source/`transfer` workflow for apps that enforce **Play Integrity**/device certification strictly — Play Store itself hides or blocks installs on a rooted/Magisk device for those, regardless of any hiding trick a script could apply:

| App's requirement | Use |
|---|---|
| Just needs Play Services present, no strict device-integrity checks | The default target as-is — sign into Play Store directly on it, install the app there. |
| Enforces Play Integrity / device certification strictly (common for banking, DRM/streaming apps) | Install on the clean, unrooted **source**, then `bun run transfer` to the rooted **target** — Play Store on the rooted device often won't cooperate at all for these. |

If you're not sure which an app needs, try installing directly on the target first — it's simpler — and fall back to `transfer` if Play Store won't cooperate there.

An existing target AVD is **not** automatically converted — `bun run init` reuses an existing AVD by name as-is, ignoring `--system-image-tag`/`--magisk-root` unless you also pass `--force-avd` (which deletes and recreates it from scratch, losing whatever was installed on it).

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
no `-writable-system`, no dm-verity disable, no reboot — and also pushed to
`/data/local/tmp/cert-der.crt`, the fixed path several unpinning techniques
(including the vendored suite below) expect. Already-installed certs are
detected and skipped on rerun.

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

**Clearing the proxy:** `bun run init -- --clear-proxy` (or `bun run run -- --clear-proxy`) resolves the target/proxy settings from the same config as everything else and clears the device's proxy — no hand-written `adb` commands needed. It's a standalone action; no other setup steps run alongside it.

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
standard, non-`_ps16k` image for exactly this reason.

## Configuration reference

Priority: **CLI flag** > **environment variable** > **built-in default**.

```text
LAB_TARGET_SERIAL         Rooted target ADB serial              [emulator-5554]
LAB_AVD_NAME              Target AVD name                       [Pixel_7_Pro]
LAB_API_LEVEL             Target Android API level              [33]
LAB_ABI                   CPU ABI                                [x86_64]
LAB_SYSTEM_IMAGE_TAG      Target system-image tag                [google_apis_playstore]
LAB_SOURCE_SERIAL         Play Store source ADB serial          [emulator-5556]
LAB_SOURCE_AVD            Play Store source AVD name            [Pixel_10_Pro]
LAB_SOURCE_IMAGE_PACKAGE  Play Store source system image         [android-37.0, google_apis_playstore, no ps16k]
LAB_SOURCE_DEVICE_PROFILE Preferred source device profile       [pixel_7_pro]
LAB_SDK_ROOT              Android SDK root                      [auto-detect]
LAB_FRIDA_VERSION         Frida version                          ["auto" = match host]
LAB_PROXY_HOST/PORT       Proxy endpoint (Burp by default)       [10.0.2.2:8080]
LAB_BURP_HOST/PORT        Older aliases for the above, still work
LAB_GPU_MODE              Target emulator -gpu mode              [auto]
LAB_SOURCE_GPU_MODE       Source emulator first-cold-boot -gpu mode [swiftshader_indirect]
LAB_WINDOW_SCALE          Emulator window scale                  [0 = auto-fit screen]
LAB_PORTABLE              1 = download deps into tools/ only, never the host's own
```

`--magisk-root` and `--android-studio` are on by default and are CLI-only
booleans (`--no-magisk-root`, `--no-android-studio`) — no `LAB_*` env
equivalent. Run `bun run init -- --help` for the complete flag list (AVD
sizing, boot timeout, window position, SDK paths, and more).

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
(vendored under `scripts/unpinning/`, AGPL-3.0-or-later — see its own
`LICENSE`/`README.md`) **automatically, by default** — no flag needed. It
covers far more real apps than a single hand-written script can:

| Script | What it covers |
|---|---|
| `native-connect-hook.js` | Redirects all raw socket connections to the proxy, even ones that ignore system proxy settings entirely. |
| `native-tls-hook.js` | Patches BoringSSL-level TLS validation directly — the layer Flutter, most native code, and many hybrid frameworks actually use instead of the Java TLS stack. |
| `android-proxy-override.js` | Forces the app's own proxy config to the configured host/port. |
| `android-system-certificate-injection.js` | Native-level system trust store injection (complements, doesn't replace, the tmpfs overlay `run`/`init` already install). |
| `android-certificate-unpinning.js` | OkHttp, TrustKit, Appmattus, and other named pinning libraries. |
| `android-certificate-unpinning-fallback.js` | **Auto-detects and patches unrecognized pinning failures on the fly**, and when it genuinely can't, prints a loud, unmissable alert — see below. |
| `android-disable-root-detection.js` | Common root/Magisk detection checks (file existence, `su`, system properties) — genuinely relevant now that the target is really Magisk-rooted by default. |
| `android-disable-flutter-certificate-pinning.js` | Flutter's own bundled TLS stack, which ignores the system trust store and most Java-level hooks entirely. |

`bun run run` generates a fresh `scripts/unpinning/config.generated.js` on
every run (gitignored) from your live `--proxy-host`/`--proxy-port` and the
currently-installed proxy CA, substituted into the real vendored `config.js`
template — no manual editing needed.

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
    interactive.ts         Wait-and-poll helper for genuinely manual steps (e.g. Magisk grant)
    adb.ts                 Serial-aware ADB wrapper, root detection, CA install
    avd.ts                 AVD creation, GPU config, identity repair, window lock/raise, launch
    magisk.ts              Real Magisk root via rootAVD (--magisk-root, on by default)
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
defaults to software rendering on its first cold boot.

**Source AVD boot-loops (Google logo → briefly loads → back to logo, forever)**

Historical cause, now fixed automatically: `avdmanager create avd` (the
older cmdline-tools build this project auto-installs) can't parse a
*decimal* API level some system images report (e.g. `37.0`), and silently
writes broken, unresolved template placeholders into the new AVD's files
instead of real values (`target=android-0` in the AVD's `.ini` pointer
file; `avd.id=<build>`, `disk.dataPartition.path=<temp>` in its
`config.ini`) — a partial AVD identity that's consistent with the observed
boot-loop. Confirmed by direct inspection, and confirmed that Android
Studio's own newer AVD tooling correctly parses the decimal value and
silently repairs these exact fields on "Edit AVD → Finish" with no other
change, after which the same AVD boots fine. This lab now detects and
repairs those same broken markers itself, right after AVD creation — no
manual Studio step needed. If you ever see this on a *new* system image in
the future (a different, not-yet-seen broken marker), the fix is the same
manual workaround: open Android Studio's AVD Manager, edit the AVD, and
click Finish with no changes.

**Emulator never boots / `init` looks stuck with no output**

The boot wait polls within its timeout rather than using a blocking `adb
wait-for-device` (which used to hang forever with zero output when the
emulator never registered with adb at all). If you hit this, it's almost
always missing hardware acceleration — enable **Windows Hypervisor
Platform** ("Turn Windows features on or off") and VT-x/AMD-V in BIOS/UEFI.

**`init` is waiting at the Magisk root step**

Expected on a fresh AVD — see [Root: Play Store + Magisk by
default](#root-play-store--magisk-by-default). Open the Magisk app inside
the emulator window and set Superuser access to auto-grant for ADB/shell
requests; `init` notices within a few seconds and continues on its own.

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
at the source window yourself; if it's genuinely blank/black/white, try
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
