package io.github.happyfamily1984.diary;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;

/** Opens the diary web app full screen; the page itself holds all features. */
public class MainActivity extends Activity {
    private WebView webView;
    private FrameLayout root;
    private String appUrl;
    private PermissionRequest pendingMic;           // a page request waiting for the Android mic permission
    private static final int REQ_MIC = 7, REQ_FLOATING = 8, REQ_LINK = 9;
    private String pendingRecord;                   // 배민리프레시 asked to start a recording ("diary" / "idea")
    private boolean askingLinkMic;
    private boolean enablingFloating;               // waiting for the user to grant overlay / mic permission

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        appUrl = getString(R.string.app_url);

        webView = new WebView(this);
        webView.setBackgroundColor(getColor(R.color.background));
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // the page keeps the GitHub token in localStorage
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.addJavascriptInterface(new NativeBridge(), "DiaryNative");   // floating-button settings
        webView.setWebChromeClient(new WebChromeClient() {   // also shows the page's confirm() dialogs
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // The page asks for the microphone to record a voice entry.
                boolean wantsMic = false;
                for (String r : request.getResources())
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wantsMic = true;
                if (!wantsMic || !request.getOrigin().toString().startsWith(appUrl.substring(0, appUrl.indexOf('/', 8)))) {
                    request.deny();
                    return;
                }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                } else {
                    pendingMic = request;
                    requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQ_MIC);
                }
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri.toString().startsWith(appUrl)) return false;
                // other links (e.g. GitHub token page) open in the browser
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    view.loadDataWithBaseURL(null, offlinePage(), "text/html", "utf-8", null);
                }
            }
        });

        // The WebView sits in a plain container; keyboard/system-bar insets are applied to the
        // container, never to the WebView itself (padding a WebView breaks the keyboard connection).
        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.background));
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        applySystemBars();
        setContentView(root);
        if (savedInstanceState == null) takeRecord(getIntent());
        String open = getIntent().getStringExtra("open");
        if (savedInstanceState != null && open == null) webView.restoreState(savedInstanceState);
        else webView.loadUrl(open != null ? appUrl + "#open=" + open : appUrl);
    }

    private void applySystemBars() {
        Window w = getWindow();
        w.setStatusBarColor(getColor(R.color.background));
        w.setNavigationBarColor(getColor(R.color.background));
        // The app is always light (sky theme), so use dark status/navigation icons in both modes.
        w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                | (Build.VERSION.SDK_INT >= 26 ? View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : 0));
        // Android 15 draws edge-to-edge: keep the page clear of the status/navigation bars and keyboard.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets b = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                v.setPadding(b.left, b.top, b.right, b.bottom);
            } else {
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
    }

    private String offlinePage() {
        return "<html><body style='font-family:sans-serif;text-align:center;padding-top:40vh;"
                + "background:#c9dbff;color:#26283d'>인터넷에 연결되지 않았어요.<br><br>"
                + "<button style='font-size:16px;padding:8px 16px' onclick=\"location.href='"
                + appUrl + "'\">다시 시도</button></body></html>";
    }

    // ---------------------------------------------------------------- floating record buttons

    private SharedPreferences floatPrefs() { return getSharedPreferences(FloatingService.PREFS, MODE_PRIVATE); }

    /**
     * 배민리프레시 shows the 📖 / 💡 buttons itself. When the recording service is not running it opens
     * this screen with "record": the service must be started while the app is visible to use the
     * microphone, so we start it, begin recording and step back to the app the user was in.
     */
    private void takeRecord(Intent intent) {
        String kind = intent.getStringExtra("record");
        if (kind == null) return;
        intent.removeExtra("record");
        if (kind.matches("diary|idea") && FloatingService.hosted(this)) pendingRecord = kind;
    }

    private void runPendingRecord() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            if (!askingLinkMic) {
                askingLinkMic = true;
                requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQ_LINK);
            }
            return;
        }
        String kind = pendingRecord;
        pendingRecord = null;
        try {
            startForegroundService(new Intent(this, FloatingService.class)
                    .setAction(FloatingService.ACTION_RECORD).putExtra("kind", kind));
            webView.postDelayed(() -> moveTaskToBack(true), 600);
        } catch (Exception ignored) { }
    }

    /** 배민리프레시 was removed while it was showing the buttons: show our own again. */
    private void dropStaleHost() {
        if (!FloatingService.hosted(this)) return;
        try { getPackageManager().getPackageInfo(FloatingService.HOST_PKG, 0); }
        catch (PackageManager.NameNotFoundException e) { floatPrefs().edit().putBoolean("hosted", false).apply(); }
    }

    private void startFloating(String action) {
        Intent i = new Intent(this, FloatingService.class);
        if (action != null) i.setAction(action);
        startForegroundService(i);
    }

    /** Asks for whatever is missing (microphone, notifications, "display over other apps"), then starts the buttons. */
    private void continueEnabling() {
        if (!enablingFloating) return;
        java.util.List<String> ask = new java.util.ArrayList<>();
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
            ask.add(Manifest.permission.RECORD_AUDIO);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && !floatPrefs().getBoolean("askedNotif", false)) {
            ask.add(Manifest.permission.POST_NOTIFICATIONS);
            floatPrefs().edit().putBoolean("askedNotif", true).apply();
        }
        if (!ask.isEmpty()) { requestPermissions(ask.toArray(new String[0]), REQ_FLOATING); return; }
        if (!Settings.canDrawOverlays(this)) {
            startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())));
            return;                                  // continues in onResume when the user comes back
        }
        enablingFloating = false;
        floatPrefs().edit().putBoolean("enabled", true).apply();
        startFloating(null);
        notifyPage();
    }

    private void notifyPage() {
        webView.post(() -> webView.evaluateJavascript("window.onFloatingChanged && window.onFloatingChanged()", null));
    }

    /** Called from the web page (window.DiaryNative). */
    private class NativeBridge {
        @JavascriptInterface
        public String getFloating() {
            SharedPreferences p = floatPrefs();
            try {
                return new JSONObject()
                        .put("enabled", p.getBoolean("enabled", false))
                        .put("size", p.getInt("size", 50)).put("alpha", p.getInt("alpha", 90))
                        .put("gap", p.getInt("gap", 8)).put("layout", p.getString("layout", "column"))
                        .put("snap", p.getBoolean("snap", true))
                        .put("mode", p.getString("mode", "together"))
                        .put("overlay", Settings.canDrawOverlays(MainActivity.this))
                        .put("mic", checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
                        .toString();
            } catch (Exception e) { return "{}"; }
        }

        @JavascriptInterface
        public void setFloating(String json) {
            try {
                JSONObject o = new JSONObject(json);
                SharedPreferences.Editor e = floatPrefs().edit();
                if (o.has("size")) e.putInt("size", Math.max(24, Math.min(80, o.getInt("size"))));
                if (o.has("alpha")) e.putInt("alpha", Math.max(20, Math.min(100, o.getInt("alpha"))));
                if (o.has("gap")) e.putInt("gap", Math.max(0, Math.min(120, o.getInt("gap"))));
                if (o.has("layout")) e.putString("layout", "row".equals(o.getString("layout")) ? "row" : "column");
                if (o.has("snap")) e.putBoolean("snap", o.getBoolean("snap"));
                if (o.has("mode")) e.putString("mode", "apart".equals(o.getString("mode")) ? "apart" : "together");
                e.apply();
                if (floatPrefs().getBoolean("enabled", false) && FloatingService.canRun(MainActivity.this))
                    runOnUiThread(() -> startFloating(FloatingService.ACTION_APPLY));
            } catch (Exception ignored) { }
        }

        @JavascriptInterface
        public void enableFloating(boolean on) {
            runOnUiThread(() -> {
                if (on) { enablingFloating = true; continueEnabling(); }
                else {
                    enablingFloating = false;
                    floatPrefs().edit().putBoolean("enabled", false).apply();
                    // 배민리프레시 is showing the buttons: keep the recorder running for it
                    if (FloatingService.hosted(MainActivity.this) && FloatingService.canRun(MainActivity.this))
                        startFloating(FloatingService.ACTION_APPLY);
                    else stopService(new Intent(MainActivity.this, FloatingService.class));
                    notifyPage();
                }
            });
        }

        /** The buttons send recordings straight to the diary server with the app's token. */
        @JavascriptInterface
        public void setCredentials(String workerUrl, String token) {
            floatPrefs().edit().putString("worker", workerUrl).putString("token", token).apply();
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        if (code == REQ_LINK) {
            askingLinkMic = false;
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                if (pendingRecord != null) runPendingRecord();
            } else pendingRecord = null;
            return;
        }
        if (code == REQ_FLOATING) {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                enablingFloating = false;
                notifyPage();
            } else continueEnabling();
            return;
        }
        if (code != REQ_MIC || pendingMic == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED)
            pendingMic.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
        else pendingMic.deny();
        pendingMic = null;
    }

    // Back goes to the previous screen of the page (sheet → day → home); on the first screen, ask before quitting.
    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) { webView.goBack(); return; }
        new AlertDialog.Builder(this)
                .setMessage("앱을 종료하겠습니까?")
                .setPositiveButton("예", (d, w) -> finish())
                .setNegativeButton("아니오", null)
                .show();
    }

    /** A floating button was long-pressed while the app was already open. */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        takeRecord(intent);
        String open = intent.getStringExtra("open");
        if (open != null && open.matches("diary|idea"))
            webView.evaluateJavascript("location.hash='open=" + open + "'", null);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
        dropStaleHost();
        if (pendingRecord != null) runPendingRecord();
        else if (enablingFloating) continueEnabling();     // back from the "display over other apps" screen
        else if ((floatPrefs().getBoolean("enabled", false) || FloatingService.hosted(this))
                && FloatingService.canRun(this)) startFloating(null);
        notifyPage();
    }

    @Override
    protected void onPause() {
        webView.onPause();
        super.onPause();
    }
}
