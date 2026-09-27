"use strict";
// PairIP DRM bypass
//
// Kill paths covered:
//   1. LicenseActivity.onCreate   → immediate RESULT_OK + finish()
//   2. System.exit / Runtime.exit / Runtime.halt   (Java-layer kills)
//   3. Process.killProcess / Process.sendSignal    (Java SIGKILL paths)
//   4. Guardian service blocking  (prevents the watcher process from spawning)
//   5. LicenseCheckerCallback.dontAllow → allow    (makes check appear to pass)
//   6. Native _exit / exit        (libpairip.so C-level kill, ret-stub hook)

// ── 6. Native _exit hook ─────────────────────────────────────────────────────
// Per-call isolation so a TypeError on one attempt does not mask the others.
(function () {
  var addr = null;
  var attempts = [
    ["libc.so", "_exit"],
    ["libc.so", "exit"],
    [null, "_exit"],
    [null, "exit"],
  ];
  for (var i = 0; i < attempts.length && !addr; i++) {
    try {
      addr = Module.findExportByName(attempts[i][0], attempts[i][1]);
      if (addr) {
        console.log(
          "== [PairIP bypass] native " +
            attempts[i][1] +
            " found in " +
            (attempts[i][0] || "all modules") +
            " at " +
            addr +
            " ==",
        );
      }
    } catch (e) {
      console.log(
        "== [PairIP bypass] findExportByName(" +
          attempts[i][0] +
          ", " +
          attempts[i][1] +
          ") threw: " +
          e +
          " ==",
      );
    }
  }
  if (addr) {
    try {
      // Write a minimal no-op stub (just a ret) so _exit returns instead of
      // terminating the process. Interceptor.replace accepts any NativePointer.
      var retOpcode =
        Process.arch === "arm64"
          ? [0xc0, 0x03, 0x5f, 0xd6] // RET
          : Process.arch === "arm"
            ? [0x1e, 0xff, 0x2f, 0xe1] // BX LR
            : [0xc3]; // x86 / x86_64 RET
      var stub = Memory.alloc(Process.pageSize);
      Memory.protect(stub, Process.pageSize, "rwx");
      stub.writeByteArray(retOpcode);
      Interceptor.replace(addr, stub);
      console.log("== [PairIP bypass] native exit hooked (ret stub) ==");
    } catch (e) {
      console.log("== [PairIP bypass] native exit replace failed: " + e + " ==");
    }
  } else {
    console.log(
      "== [PairIP bypass] native exit not found — C-level kill path unblocked ==",
    );
  }
})();

// ── Java hooks ───────────────────────────────────────────────────────────────
Java.perform(function () {
  var hasPairIP = false;
  try {
    Java.use("com.pairip.licensecheck.LicenseActivity");
    hasPairIP = true;
  } catch (_) {}
  if (!hasPairIP) return;

  console.log("== PairIP detected — installing bypass ==");

  // ── 1. LicenseActivity.onCreate ──────────────────────────────────────────
  var LicenseActivity = Java.use("com.pairip.licensecheck.LicenseActivity");
  var ActivityBase = Java.use("android.app.Activity");
  LicenseActivity.onCreate.overload("android.os.Bundle").implementation =
    function (bundle) {
      ActivityBase.onCreate.overload("android.os.Bundle").call(this, bundle);
      console.log(
        "== [PairIP bypass] LicenseActivity.onCreate intercepted — returning RESULT_OK ==",
      );
      this.setResult(-1 /* RESULT_OK */);
      this.finish();
    };

  // ── 2. Java-layer exit kills ──────────────────────────────────────────────
  Java.use("java.lang.System")
    .exit.overload("int")
    .implementation = function (code) {
    console.log("== [PairIP bypass] System.exit(" + code + ") blocked ==");
  };
  Java.use("java.lang.Runtime")
    .exit.overload("int")
    .implementation = function (code) {
    console.log("== [PairIP bypass] Runtime.exit(" + code + ") blocked ==");
  };
  try {
    Java.use("java.lang.Runtime")
      .halt.overload("int")
      .implementation = function (code) {
      console.log("== [PairIP bypass] Runtime.halt(" + code + ") blocked ==");
    };
  } catch (_) {}

  // ── 3. Process signal kills ───────────────────────────────────────────────
  var Proc = Java.use("android.os.Process");
  Proc.killProcess.overload("int").implementation = function (pid) {
    console.log("== [PairIP bypass] Process.killProcess(" + pid + ") blocked ==");
  };
  try {
    Proc.sendSignal.overload("int", "int").implementation = function (pid, sig) {
      console.log(
        "== [PairIP bypass] Process.sendSignal(" + pid + ", " + sig + ") blocked ==",
      );
    };
  } catch (_) {}

  // ── 4. Guardian service blocking ─────────────────────────────────────────
  // PairIP spawns a watcher (guardian) process/service that sends SIGKILL to
  // the main process when the license check fails. Block it before it starts.
  var ContextWrapper = Java.use("android.content.ContextWrapper");

  function isPairIPIntent(intent) {
    try {
      var comp = intent.getComponent();
      var compCls = comp ? comp.getClassName() : "";
      var pkg =
        comp ? comp.getPackageName() : (intent.getPackage() || "");
      var action = intent.getAction() || "";
      return (
        compCls.indexOf("pairip") !== -1 ||
        compCls.indexOf("LicenseService") !== -1 ||
        compCls.indexOf("guardian") !== -1 ||
        pkg.indexOf("pairip") !== -1 ||
        action.indexOf("pairip") !== -1
      );
    } catch (_) {
      return false;
    }
  }

  try {
    var origStart = ContextWrapper.startService.overload(
      "android.content.Intent",
    );
    origStart.implementation = function (intent) {
      if (isPairIPIntent(intent)) {
        console.log(
          "== [PairIP bypass] guardian startService blocked: " + intent + " ==",
        );
        return null;
      }
      return origStart.call(this, intent);
    };
  } catch (_) {}

  try {
    var origBind = ContextWrapper.bindService.overload(
      "android.content.Intent",
      "android.content.ServiceConnection",
      "int",
    );
    origBind.implementation = function (intent, conn, flags) {
      if (isPairIPIntent(intent)) {
        console.log(
          "== [PairIP bypass] guardian bindService blocked: " + intent + " ==",
        );
        return false;
      }
      return origBind.call(this, intent, conn, flags);
    };
  } catch (_) {}

  // ── 5. LicenseCheckerCallback.dontAllow → allow ───────────────────────────
  // PairIP's internal LicenseCheckerCallback implementation calls dontAllow()
  // when Google Play licensing fails. Redirect it to allow() so the check
  // appears to pass and the guardian process never activates.

  function hookDontAllow(className) {
    try {
      var cls = Java.use(className);
      if (!cls.dontAllow) return;
      cls.dontAllow.overloads.forEach(function (ov) {
        ov.implementation = function (reason) {
          console.log(
            "== [PairIP bypass] " +
              className +
              ".dontAllow(" +
              reason +
              ") → redirecting to allow ==",
          );
          try {
            this.allow(0);
          } catch (_) {}
        };
      });
      console.log(
        "== [PairIP bypass] hooked dontAllow on " + className + " ==",
      );
    } catch (_) {}
  }

  // Known candidates; dynamic scan fills in the rest after classes load.
  hookDontAllow("com.pairip.licensecheck.LicenseCheckerCallback");
  hookDontAllow("com.pairip.licensecheck.DefaultLicenseCheckerCallback");
  hookDontAllow("com.pairip.licensecheck.PairIPLicenseCheckerCallback");

  // After 1 s, enumerate loaded classes to find any runtime-loaded pairip class
  // and hook dontAllow on it. Log all pairip classes for visibility.
  setTimeout(function () {
    Java.perform(function () {
      try {
        Java.enumerateLoadedClassesSync().forEach(function (name) {
          if (name.indexOf("pairip") !== -1) {
            console.log("== [PairIP bypass] class loaded: " + name + " ==");
            hookDontAllow(name);
          }
        });
      } catch (_) {}
    });
  }, 1000);

  // ── Diagnostics ───────────────────────────────────────────────────────────
  // Log all Activity.finish() calls from pairip classes.
  try {
    var Activity = Java.use("android.app.Activity");
    var origFinish = Activity.finish.overload();
    origFinish.implementation = function () {
      var cls = this.getClass().getName();
      if (cls.indexOf("pairip") !== -1) {
        console.log(
          "== [PairIP bypass] Activity.finish() from: " + cls + " ==",
        );
      }
      origFinish.call(this);
    };
  } catch (_) {}

  // Log uncaught exceptions — if PairIP crashes the app via RuntimeException,
  // suppress the PairIP one and let real crashes through.
  try {
    var Thread = Java.use("java.lang.Thread");
    Thread.dispatchUncaughtException.implementation = function (exc) {
      var msg = exc.toString();
      if (msg.indexOf("pairip") !== -1 || msg.indexOf("LicenseActivity") !== -1) {
        console.log(
          "== [PairIP bypass] uncaught PairIP exception suppressed: " + msg + " ==",
        );
        return;
      }
      console.log("== [DEBUG] uncaught exception: " + msg + " ==");
      this.dispatchUncaughtException(exc);
    };
  } catch (_) {}

  console.log("== [PairIP bypass] all hooks installed ==");
});
