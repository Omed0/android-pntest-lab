"use strict";
// PairIP DRM bypass
// PairIP's LicenseActivity does a Play Store license check at startup and calls
// System.exit(0) when the app was sideloaded or the emulator account is not
// licensed. An async background thread re-checks the license and also calls
// System.exit(0) when it fails. libpairip.so may also call _exit() directly
// (bypasses all Java-layer hooks) or android.os.Process.killProcess(myPid).
// Fix: intercept all three kill paths.

// Block _exit() at the native layer before Java.perform — covers calls from
// libpairip.so's C code that bypass Java's System.exit entirely.
// Uses a raw ret-instruction stub instead of NativeCallback (which is broken
// in Frida 17.x at spawn time) — Interceptor.replace accepts any NativePointer.
try {
  var nativeExitAddr =
    Module.findExportByName("libc.so", "_exit") ||
    Module.findExportByName("libc.so", "exit") ||
    Module.findExportByName(null, "_exit") ||
    Module.findExportByName(null, "exit");
  if (nativeExitAddr) {
    // Write a minimal no-op stub: just a ret instruction so _exit returns to
    // its caller instead of terminating the process.
    var retOpcode =
      Process.arch === "arm64"
        ? [0xc0, 0x03, 0x5f, 0xd6] // RET
        : Process.arch === "arm"
          ? [0x1e, 0xff, 0x2f, 0xe1] // BX LR
          : [0xc3]; // x86 / x86_64 RET
    var stub = Memory.alloc(Process.pageSize);
    Memory.protect(stub, Process.pageSize, "rwx");
    stub.writeByteArray(retOpcode);
    Interceptor.replace(nativeExitAddr, stub);
    console.log(
      "== [PairIP bypass] native exit hooked (ret stub) at " + nativeExitAddr + " ==",
    );
  } else {
    console.log(
      "== [PairIP bypass] WARNING: native exit symbol not found — native kill path may be unblocked ==",
    );
  }
} catch (e) {
  console.log("== [PairIP bypass] native exit hook error: " + e + " ==");
}

Java.perform(function () {
  var hasPairIP = false;
  try {
    Java.use("com.pairip.licensecheck.LicenseActivity");
    hasPairIP = true;
  } catch (_) {}

  if (!hasPairIP) return;

  console.log("== PairIP detected — bypassing LicenseActivity ==");

  var LicenseActivity = Java.use("com.pairip.licensecheck.LicenseActivity");
  // Call android.app.Activity.onCreate() directly (base-class only) to satisfy
  // Android's super.onCreate() requirement without running PairIP's license-check
  // logic, then immediately deliver RESULT_OK and finish.
  var ActivityBase = Java.use("android.app.Activity");

  LicenseActivity.onCreate.overload("android.os.Bundle").implementation =
    function (bundle) {
      ActivityBase.onCreate.overload("android.os.Bundle").call(this, bundle);
      console.log(
        "== [PairIP bypass] LicenseActivity.onCreate intercepted — returning RESULT_OK ==",
      );
      this.setResult(-1 /* Activity.RESULT_OK */);
      this.finish();
    };

  // PairIP also fires an async background check that calls System.exit(0) on
  // failure. Real app crashes go through uncaught exception handlers, not
  // System.exit — so blocking all Java-layer exits is safe in a pentest context.
  var System = Java.use("java.lang.System");
  System.exit.overload("int").implementation = function (code) {
    console.log("== [PairIP bypass] System.exit(" + code + ") blocked ==");
  };

  var Runtime = Java.use("java.lang.Runtime");
  Runtime.exit.overload("int").implementation = function (code) {
    console.log("== [PairIP bypass] Runtime.exit(" + code + ") blocked ==");
  };

  // Block Process.killProcess and Process.sendSignal — PairIP may send SIGKILL
  // via either API instead of calling System.exit().
  var AndroidProcess = Java.use("android.os.Process");
  AndroidProcess.killProcess.overload("int").implementation = function (pid) {
    console.log(
      "== [PairIP bypass] Process.killProcess(" + pid + ") blocked ==",
    );
  };
  try {
    AndroidProcess.sendSignal.overload("int", "int").implementation = function (
      pid,
      signal,
    ) {
      console.log(
        "== [PairIP bypass] Process.sendSignal(" + pid + ", " + signal + ") blocked ==",
      );
    };
  } catch (_) {}

  // Block Runtime.halt() — bypasses shutdown hooks, kills JVM directly.
  var Runtime = Java.use("java.lang.Runtime");
  try {
    Runtime.halt.overload("int").implementation = function (code) {
      console.log("== [PairIP bypass] Runtime.halt(" + code + ") blocked ==");
    };
  } catch (_) {}

  // Diagnostic: log which Activity classes call finish() so we can see
  // if a non-LicenseActivity is driving the close.
  var Activity = Java.use("android.app.Activity");
  var origFinish = Activity.finish.overload();
  origFinish.implementation = function () {
    var cls = this.getClass().getName();
    if (cls.indexOf("pairip") !== -1 || cls.indexOf("LicenseActivity") !== -1) {
      console.log("== [PairIP bypass] Activity.finish() called by: " + cls + " ==");
    }
    origFinish.call(this);
  };

  // Diagnostic: catch uncaught exceptions before they crash the process —
  // lets us see if PairIP throws RuntimeException instead of calling exit().
  var Thread = Java.use("java.lang.Thread");
  Thread.dispatchUncaughtException.implementation = function (exc) {
    var msg = exc.toString();
    if (
      msg.indexOf("pairip") !== -1 ||
      msg.indexOf("license") !== -1 ||
      msg.indexOf("LicenseActivity") !== -1
    ) {
      console.log("== [PairIP bypass] uncaught exception (suppressed): " + msg + " ==");
      return;
    }
    console.log("== [DEBUG] uncaught exception (not PairIP, allowing crash): " + msg + " ==");
    this.dispatchUncaughtException(exc);
  };
});
