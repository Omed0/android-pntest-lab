"use strict";
// PairIP DRM bypass
// PairIP's LicenseActivity does a Play Store license check at startup and calls
// System.exit(0) when the app was sideloaded or the emulator account is not
// licensed. An async background thread re-checks the license and also calls
// System.exit(0) when it fails.
// Fix: intercept LicenseActivity.onCreate() calling Activity.onCreate() to
// satisfy Android's lifecycle requirement, then deliver RESULT_OK; also block
// System.exit/Runtime.exit(0) from the background thread.
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
});
