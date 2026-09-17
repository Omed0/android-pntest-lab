/*
 * Universal Android SSL/TLS pinning bypass.
 *
 * Scope/intent: authorized dynamic testing against apps you are explicitly
 * authorized to test (see the repo README "Safety" section). It patches the
 * OS-level trust machinery so a rooted Frida target trusts the installed
 * Burp CA regardless of app-level pinning logic. It does not target any
 * specific app's code — it's written to work across the APKs under apk/
 * (plain Java/Kotlin, Xamarin/.NET MAUI, or WebView-hybrid — a MAUI app's
 * default AndroidMessageHandler still rides on the Java TLS stack hooked
 * below, which is why this generic hook set also covers a hybrid app's
 * networking, not just plain Java/Kotlin apps).
 *
 * Usage:
 *   bun run.ts --package=<pkg> --frida-script=scripts/ssl-unpinning.js
 *   frida -U -f <pkg> -l scripts/ssl-unpinning.js -q -t <seconds>
 *
 * Layers patched:
 *   1. javax.net.ssl.X509TrustManager   — accept any cert chain.
 *   2. javax.net.ssl.SSLContext.init    — force our permissive TrustManager
 *      into every SSLContext the app creates, before any pinning TM is used.
 *      OFF BY DEFAULT — see KNOWN ISSUE below.
 *   3. okhttp3.CertificatePinner.check(String, List)  — no-op (OkHttp3, the
 *      most common cause of pinning failures even after TrustManager bypass).
 *   4. okhttp3.CertificatePinner.check$okhttp(String, ...) — OkHttp >= 4 name
 *      mangling variant.
 *   5. android.webkit.WebViewClient.onReceivedSslError — proceed regardless
 *      (covers the Blazor/MAUI hybrid WebView surface).
 *   6. conscrypt / platform TrustManagerImpl.verifyChain — best-effort, some
 *      OEM builds hardcode chain checks here even when the TM above is swapped.
 *
 * Each hook is wrapped so a class/method that doesn't exist in a given app
 * (e.g. no OkHttp) is silently skipped instead of throwing.
 *
 * KNOWN ISSUE: hooking javax.net.ssl.SSLContext.init at process-bind time
 * has been observed to reliably crash a .NET MAUI app (Tarik-Althuraya,
 * this repo's apk/Tarik.apk, on this lab's Pixel_7_Pro/API 33 target) with
 * a native SIGSEGV inside art::JNI::CallNonvirtualVoidMethod during
 * ActivityThread.handleBindApplication — reproduced identically both
 * immediately and after an 800ms setTimeout delay, so it isn't a simple
 * ordering race; that app's native/.NET networking init path appears
 * unsafe to intercept at that specific call. TrustManager/SSLContext
 * override is therefore OFF by default (ENABLE_TRUSTMANAGER_HOOK below) —
 * enable it only after confirming it doesn't crash your specific target.
 * The OkHttp/WebView/conscrypt hooks below cover most real-world pinning
 * cases without ever touching SSLContext, and installing the Burp CA into
 * the rooted system trust store (which `run.ts` already does) is often
 * sufficient on its own for apps with no custom pinning at all.
 */

'use strict';

var ENABLE_TRUSTMANAGER_HOOK = false;

function log(msg) { console.log('[unpin] ' + msg); }

function hookTrustManager() {
  try {
    var TrustManager = Java.registerClass({
      name: 'com.labtest.TrustAllManager',
      implements: [Java.use('javax.net.ssl.X509TrustManager').class],
      methods: {
        checkClientTrusted: function () {},
        checkServerTrusted: function () {},
        getAcceptedIssuers: function () { return []; },
      },
    });

    var SSLContext = Java.use('javax.net.ssl.SSLContext');
    // Java.array() takes a plain type name, not a JNI "Lpkg/Class;" descriptor
    // (that descriptor form is only for .overload() parameter-type strings).
    var TrustManagerArray = Java.array('javax.net.ssl.TrustManager', [TrustManager.$new()]);

    SSLContext.init.overload(
      '[Ljavax.net.ssl.KeyManager;',
      '[Ljavax.net.ssl.TrustManager;',
      'java.security.SecureRandom'
    ).implementation = function (keyManagers, trustManagers, secureRandom) {
      log('SSLContext.init() -> forcing permissive TrustManager');
      this.init(keyManagers, TrustManagerArray, secureRandom);
    };
    log('Hooked: javax.net.ssl.SSLContext.init (TrustManager override)');
  } catch (e) {
    log('SKIP TrustManager/SSLContext hook: ' + e);
  }
}

function hookOkHttpCertificatePinner() {
  var variants = [
    { sig: ['java.lang.String', 'java.util.List'], name: 'check' },
    { sig: ['java.lang.String', 'kotlin.jvm.functions.Function0'], name: 'check$okhttp' },
  ];
  try {
    var Pinner = Java.use('okhttp3.CertificatePinner');
    variants.forEach(function (v) {
      try {
        Pinner[v.name].overload.apply(Pinner[v.name], v.sig).implementation = function () {
          log('okhttp3.CertificatePinner.' + v.name + '() -> bypassed for ' + arguments[0]);
        };
        log('Hooked: okhttp3.CertificatePinner.' + v.name + v.sig);
      } catch (inner) {
        // overload not present in this OkHttp version — expected on some apps.
      }
    });
  } catch (e) {
    log('SKIP OkHttp CertificatePinner hook (OkHttp not present): ' + e);
  }
}

function hookWebViewSslErrors() {
  try {
    var WebViewClient = Java.use('android.webkit.WebViewClient');
    WebViewClient.onReceivedSslError.overload(
      'android.webkit.WebView', 'android.webkit.SslErrorHandler', 'android.net.http.SslError'
    ).implementation = function (view, handler, error) {
      log('WebViewClient.onReceivedSslError() -> proceeding anyway');
      handler.proceed();
    };
    log('Hooked: android.webkit.WebViewClient.onReceivedSslError (Blazor/MAUI WebView)');
  } catch (e) {
    log('SKIP WebViewClient hook: ' + e);
  }
}

function hookConscryptTrustManagerImpl() {
  try {
    var TMI = Java.use('com.android.org.conscrypt.TrustManagerImpl');
    TMI.verifyChain.implementation = function (untrustedChain) {
      log('conscrypt TrustManagerImpl.verifyChain() -> returning chain unchecked');
      return untrustedChain;
    };
    log('Hooked: com.android.org.conscrypt.TrustManagerImpl.verifyChain');
  } catch (e) {
    log('SKIP conscrypt TrustManagerImpl hook (not on this ROM/API level): ' + e);
  }
}

if (Java.available) {
  Java.perform(function () {
    log('Java runtime ready — installing universal pinning bypass hooks');
    if (ENABLE_TRUSTMANAGER_HOOK) {
      hookTrustManager();
    } else {
      log('SKIP TrustManager/SSLContext hook (disabled by default — see KNOWN ISSUE at top of file)');
    }
    hookOkHttpCertificatePinner();
    hookWebViewSslErrors();
    hookConscryptTrustManagerImpl();
    log('All hook attempts complete. Point the device proxy at Burp and browse.');
  });
} else {
  console.log('[unpin] Java.available is false — non-Java runtime target, nothing to hook here.');
}
