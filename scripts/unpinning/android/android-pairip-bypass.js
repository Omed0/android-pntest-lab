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

// ── Native kill hooks ────────────────────────────────────────────────────────
// Module.findExportByName() is undefined in Frida 17.x (moved to the module
// instance). Use Process.findModuleByName(name).findExportByName(symbol).
// Hook both _exit/exit (JVM termination) and kill (SIGKILL sent from C code).
(function () {
  function findExport(modName, symbol) {
    try {
      var mod = Process.findModuleByName(modName);
      return mod ? mod.findExportByName(symbol) : null;
    } catch (_) {
      return null;
    }
  }

  function hookWithRetStub(addr, label) {
    if (!addr) return false;
    try {
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
      console.log("== [PairIP bypass] hooked " + label + " at " + addr + " ==");
      return true;
    } catch (e) {
      console.log("== [PairIP bypass] hook " + label + " failed: " + e + " ==");
      return false;
    }
  }

  // _exit / exit — JVM termination
  hookWithRetStub(
    findExport("libc.so", "_exit") || findExport("libc.so", "exit"),
    "native _exit",
  );

  // kill(pid, sig) — libpairip.so sends SIGKILL to self via this libc function
  var killAddr = findExport("libc.so", "kill");
  if (killAddr) {
    try {
      Interceptor.attach(killAddr, {
        onEnter: function (args) {
          var sig = args[1].toInt32();
          if (sig === 9 /* SIGKILL */ || sig === 19 /* SIGSTOP */) {
            console.log(
              "== [PairIP bypass] libc.kill(pid=" +
                args[0].toInt32() +
                ", sig=" +
                sig +
                ") blocked ==",
            );
            args[1] = ptr(0); // change signal to 0 (harmless existence check)
          }
        },
      });
      console.log("== [PairIP bypass] hooked libc.kill ==");
    } catch (e) {
      console.log("== [PairIP bypass] hook libc.kill failed: " + e + " ==");
    }
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

  // ── LicenseClient direct hooks ──────────────────────────────────────────
  // The actual license state machine. Hook it to:
  // (a) log all method names so we know what's available
  // (b) block DelayedTaskExecutor so background re-checks never run
  // (c) intercept LicenseCheckException creation

  try {
    var LicenseClient = Java.use("com.pairip.licensecheck.LicenseClient");

    // Log method names for discovery
    var lcMethods = LicenseClient.class.getDeclaredMethods();
    var lcNames = [];
    for (var mi = 0; mi < lcMethods.length; mi++) {
      lcNames.push(lcMethods[mi].getName());
    }
    console.log("== [LicenseClient methods] " + lcNames.join(", ") + " ==");

    // Hook every method whose name suggests a failure / deny / kill path.
    // If we get the name right the method becomes a no-op (returns undefined/void).
    var killWords = ["deny", "fail", "exit", "kill", "stop", "block", "revoke",
                     "invalid", "illegal", "forbidden", "dontAllow", "notLicensed",
                     "unlicensed", "reject", "terminate", "abort"];
    lcNames.forEach(function (name) {
      var lower = name.toLowerCase();
      var isKillCandidate = killWords.some(function (w) {
        return lower.indexOf(w) !== -1;
      });
      if (!isKillCandidate) return;
      try {
        LicenseClient[name].overloads.forEach(function (ov) {
          ov.implementation = function () {
            console.log(
              "== [PairIP bypass] LicenseClient." + name + " blocked ==",
            );
          };
        });
      } catch (_) {}
    });
  } catch (_) {}

  // Block LicenseCheckException from propagating — PairIP may throw this
  // instead of calling exit() to crash the app.
  try {
    var LicenseCheckException = Java.use(
      "com.pairip.licensecheck.LicenseCheckException",
    );
    LicenseCheckException.$init.overloads.forEach(function (ov) {
      var origInit = ov.implementation;
      ov.implementation = function () {
        console.log(
          "== [PairIP bypass] LicenseCheckException created — will suppress ==",
        );
        ov.call.apply(ov, [this].concat(Array.prototype.slice.call(arguments)));
      };
    });
  } catch (_) {}

  // Block DelayedTaskExecutorImpl — prevents background license re-checks
  // from ever scheduling a task that could trigger the kill.
  try {
    var DelayedExec = Java.use(
      "com.pairip.licensecheck.LicenseClient$DelayedTaskExecutorImpl",
    );
    var delayedMethods = DelayedExec.class.getDeclaredMethods();
    console.log(
      "== [DelayedTaskExecutorImpl methods] " +
        Array.from({length: delayedMethods.length}, function(_, i) {
          return delayedMethods[i].getName();
        }).join(", ") +
        " ==",
    );
    // Block all scheduling methods
    for (var di = 0; di < delayedMethods.length; di++) {
      (function (methodName) {
        try {
          DelayedExec[methodName].overloads.forEach(function (ov) {
            ov.implementation = function () {
              console.log(
                "== [PairIP bypass] DelayedTaskExecutorImpl." + methodName + " blocked ==",
              );
            };
          });
        } catch (_) {}
      })(delayedMethods[di].getName());
    }
  } catch (_) {}

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
