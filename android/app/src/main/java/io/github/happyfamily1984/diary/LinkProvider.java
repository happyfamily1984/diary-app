package io.github.happyfamily1984.diary;

import android.Manifest;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

/**
 * The door for 배민리프레시 (com.baeminrefresh.app), which can show the 📖 / 💡 buttons among its own
 * floating buttons. It holds no data; only call() is used, and only that app may call it.
 *
 *   attach        배민리프레시 shows the buttons → ours are hidden
 *   detach        it stopped → ours come back (if switched on here)
 *   toggle <kind> a tap: start / stop recording "diary" or "idea"
 *   state         just read the state
 *
 * The answer has "result" ("ok", or "need_open" when the recorder is not running and the app has to
 * be opened once to start it), "state" ("idle" / "recording" / "sending") and "kind".
 */
public class LinkProvider extends ContentProvider {
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    public Bundle call(String method, String arg, Bundle extras) {
        Context c = getContext();
        if (c == null || !FloatingService.HOST_PKG.equals(getCallingPackage()))
            throw new SecurityException("not allowed");
        String result = "ok";
        FloatingService s = FloatingService.instance;
        if ("attach".equals(method) || "detach".equals(method)) {
            c.getSharedPreferences(FloatingService.PREFS, Context.MODE_PRIVATE).edit()
                    .putBoolean("hosted", "attach".equals(method)).commit();
            if (s != null) main.post(s::hostChanged);
        } else if ("toggle".equals(method)) {
            if (arg == null || !arg.matches("diary|idea")) throw new IllegalArgumentException("kind");
            if (!FloatingService.hosted(c)) {
                c.getSharedPreferences(FloatingService.PREFS, Context.MODE_PRIVATE).edit()
                        .putBoolean("hosted", true).commit();
                if (s != null) main.post(s::hostChanged);
            }
            boolean mic = c.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
            if (s == null || !mic) result = "need_open";
            else main.post(() -> s.hostTap(arg));
        }
        Bundle b = new Bundle();
        b.putString("result", result);
        b.putString("state", s == null ? "idle" : s.stateName());
        b.putString("kind", s == null ? "" : s.stateKind());
        b.putBoolean("running", s != null);
        return b;
    }

    @Override public boolean onCreate() { return true; }
    @Override public Cursor query(Uri u, String[] p, String s, String[] a, String o) { return null; }
    @Override public String getType(Uri u) { return null; }
    @Override public Uri insert(Uri u, ContentValues v) { return null; }
    @Override public int delete(Uri u, String s, String[] a) { return 0; }
    @Override public int update(Uri u, ContentValues v, String s, String[] a) { return 0; }
}
