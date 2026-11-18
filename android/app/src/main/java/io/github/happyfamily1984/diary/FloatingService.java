package io.github.happyfamily1984.diary;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Two floating buttons shown over every app: 📖 records a diary entry, 💡 an idea.
 * Tap once to start recording (red), tap again to stop (blue while it is sent to the diary server).
 * Long-press opens the app on the latest diary entry / the ideas list. Drag to move: in "together"
 * mode the two buttons move as a pair (with an adjustable gap), in "apart" mode each one on its own.
 * Other players are paused during recording (audio focus), and recording keeps going whatever app
 * is on screen, because this is a foreground service started while the diary app was open.
 */
public class FloatingService extends Service {
    public static final String PREFS = "floating";
    static final String ACTION_STOP = "stop";
    static final String ACTION_APPLY = "apply";
    static final String ACTION_RECORD = "record";      // start recording right away (extra "kind")
    // 배민리프레시 can show the two buttons itself ("hosted"): it sends taps through LinkProvider
    // and is told the recording state with this broadcast.
    static final String HOST_PKG = "com.baeminrefresh.app";
    static final String STATE_ACTION = "io.github.happyfamily1984.diary.STATE";
    static volatile FloatingService instance;
    private static final String CHANNEL = "floating";
    private static final int NOTIFICATION_ID = 1;
    private static final int RATE = 16000;
    private static final int MAX_SECONDS = 600;

    // idle colours are deliberately far from red, so "recording" (red) is never mistaken
    private static final int PURPLE = 0xFF7C5CFF, AMBER = 0xFFF59F00, RED = 0xFFE03131, BLUE = 0xFF3B82F6;
    private static final int SILENCE_PEAK = 1200;      // 16-bit peak below this for the whole take = nothing said

    private WindowManager wm;
    // two separate overlay windows: [0] 📖 diary, [1] 💡 idea
    private final TextView[] btn = new TextView[2];
    private final WindowManager.LayoutParams[] lp = new WindowManager.LayoutParams[2];
    private static final String[] KIND = { "diary", "idea" };
    private final Handler main = new Handler(Looper.getMainLooper());

    // recording state
    private volatile boolean recording;
    private String recordingKind;
    private Thread recordThread;
    private AudioFocusRequest focusRequest;
    private boolean sending;

    static boolean hosted(Context c) {
        return c.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("hosted", false);
    }

    /** The microphone is always needed; "display over other apps" only when this app draws the buttons itself. */
    static boolean canRun(Context c) {
        return (hosted(c) || Settings.canDrawOverlays(c))
                && c.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    /** "idle", "recording" or "sending" (+ which button) — read by LinkProvider from another thread. */
    String stateName() { return recording ? "recording" : recordingKind != null ? "sending" : "idle"; }
    String stateKind() { String k = recordingKind; return k == null ? "" : k; }

    private void broadcastState() {
        if (!hosted(this)) return;
        try {
            sendBroadcast(new Intent(STATE_ACTION).setPackage(HOST_PKG)
                    .putExtra("state", stateName()).putExtra("kind", stateKind()));
        } catch (Exception ignored) { }
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        instance = this;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            prefs().edit().putBoolean("enabled", false).apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        try { startAsForeground(); }
        catch (Exception e) { stopSelf(); return START_NOT_STICKY; }   // not allowed to start from the background
        boolean wanted = prefs().getBoolean("enabled", false) || hosted(this);
        if (!wanted || !canRun(this)) { stopSelf(); return START_NOT_STICKY; }
        syncButtons();
        if (ACTION_RECORD.equals(action)) {
            String kind = intent.getStringExtra("kind");
            if (kind != null && kind.matches("diary|idea") && !recording && !sending) onTap(kind);
        }
        sendLeftovers();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        recording = false;
        recordingKind = null;
        broadcastState();
        if (instance == this) instance = null;
        removeButtons();
        super.onDestroy();
    }

    private void removeButtons() {
        for (int i = 0; i < 2; i++) {
            if (btn[i] != null) { try { wm.removeView(btn[i]); } catch (Exception ignored) { } btn[i] = null; }
        }
    }

    /** Own buttons are shown only when switched on here and 배민리프레시 is not showing them instead. */
    void syncButtons() {
        boolean own = !hosted(this) && prefs().getBoolean("enabled", false) && Settings.canDrawOverlays(this);
        if (!own) removeButtons();
        else if (btn[0] == null) createButtons();
        else applySettings();
    }

    /** 배민리프레시 attached or detached (called on the main thread by LinkProvider). */
    void hostChanged() {
        if (!hosted(this) && !prefs().getBoolean("enabled", false)) { stopSelf(); return; }
        syncButtons();
        try { startAsForeground(); } catch (Exception ignored) { }
        broadcastState();
    }

    /** A tap on the button that 배민리프레시 shows. */
    void hostTap(String kind) { onTap(kind); }

    private SharedPreferences prefs() { return getSharedPreferences(PREFS, MODE_PRIVATE); }

    private int dp(float v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    // ---------------------------------------------------------------- notification

    private void startAsForeground() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "플로팅 녹음 버튼", NotificationManager.IMPORTANCE_MIN);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, FloatingService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        Notification n = b.setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentTitle("일기장 플로팅 녹음 버튼")
                .setContentText(recording ? "녹음 중이에요"
                        : hosted(this) ? "배민리프레시의 📖 · 💡 버튼으로 녹음해요" : "📖 일기 · 💡 아이디어 버튼이 켜져 있어요")
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, "끄기", stop).build())
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        else startForeground(NOTIFICATION_ID, n);
    }

    // ---------------------------------------------------------------- buttons

    private TextView makeButton(String emoji) {
        TextView v = new TextView(this);
        v.setText(emoji);
        v.setGravity(Gravity.CENTER);
        v.setTextColor(Color.WHITE);
        v.setElevation(dp(4));
        return v;
    }

    private void paint(TextView v, int color) {
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.OVAL);
        d.setColor(color);
        d.setStroke(dp(2), Color.WHITE);
        v.setBackground(d);
    }

    private void refreshColors() {
        broadcastState();
        if (btn[0] == null) return;
        paint(btn[0], "diary".equals(recordingKind) ? (recording ? RED : BLUE) : PURPLE);
        paint(btn[1], "idea".equals(recordingKind) ? (recording ? RED : BLUE) : AMBER);
    }

    private boolean together() { return !"apart".equals(prefs().getString("mode", "together")); }

    @SuppressLint("ClickableViewAccessibility")
    private void createButtons() {
        DisplayMetrics m = getResources().getDisplayMetrics();
        for (int i = 0; i < 2; i++) {
            btn[i] = makeButton(i == 0 ? "📖" : "💡");
            WindowManager.LayoutParams l = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                    PixelFormat.TRANSLUCENT);
            l.gravity = Gravity.TOP | Gravity.START;
            // old single position ("x","y") becomes the first button's
            l.x = prefs().getInt("x" + i, prefs().getInt("x", m.widthPixels - dp(70)));
            l.y = prefs().getInt("y" + i, prefs().getInt("y", m.heightPixels / 2) + (i == 1 ? dp(140) : 0));
            lp[i] = l;
            btn[i].setOnTouchListener(new ButtonTouch(i));
        }
        applySettings();
        for (int i = 0; i < 2; i++) wm.addView(btn[i], lp[i]);
    }

    /** Tap = record, hold still = open the app, move = drag (the pair together, or one button alone). */
    private class ButtonTouch implements View.OnTouchListener {
        final int i;
        final int slop = ViewConfiguration.get(FloatingService.this).getScaledTouchSlop();
        float downX, downY; int startX, startY; boolean moved, longPressed;
        final Runnable longPress = new Runnable() {
            @Override public void run() {
                if (moved) return;
                longPressed = true;
                btn[i].performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS);
                openApp(KIND[i]);
            }
        };
        ButtonTouch(int i) { this.i = i; }

        @Override public boolean onTouch(View v, MotionEvent e) {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downX = e.getRawX(); downY = e.getRawY(); startX = lp[i].x; startY = lp[i].y;
                    moved = false; longPressed = false;
                    main.postDelayed(longPress, ViewConfiguration.getLongPressTimeout());
                    return true;
                case MotionEvent.ACTION_MOVE:
                    if (longPressed) return true;
                    float dx = e.getRawX() - downX, dy = e.getRawY() - downY;
                    if (!moved && Math.hypot(dx, dy) > slop) { moved = true; main.removeCallbacks(longPress); }
                    if (moved) moveTo(i, startX + Math.round(dx), startY + Math.round(dy));
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    main.removeCallbacks(longPress);
                    if (longPressed) return true;
                    if (moved) { snapToEdge(i); savePositions(); }
                    else if (e.getActionMasked() == MotionEvent.ACTION_UP) onTap(KIND[i]);
                    return true;
            }
            return false;
        }
    }

    /** Opens the diary app on the latest diary entry (📖) or the ideas list (💡). */
    private void openApp(String kind) {
        Intent i = new Intent(this, MainActivity.class)
                .putExtra("open", kind)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        try { startActivity(i); } catch (Exception e) { toast("앱을 열 수 없어요"); }
    }

    private int sizePx() { return dp(prefs().getInt("size", 50)); }

    /** Where the 💡 button sits relative to 📖 in "together" mode. */
    private int[] partnerOffset() {
        int step = sizePx() + dp(prefs().getInt("gap", 8));
        return "row".equals(prefs().getString("layout", "column")) ? new int[] { step, 0 } : new int[] { 0, step };
    }

    /** Moves button i (and, in "together" mode, its partner with it). */
    private void moveTo(int i, int x, int y) {
        DisplayMetrics m = getResources().getDisplayMetrics();
        int s = sizePx();
        if (together()) {
            int[] off = partnerOffset();
            int ax = i == 0 ? x : x - off[0], ay = i == 0 ? y : y - off[1];   // position of 📖 (the anchor)
            ax = Math.max(0, Math.min(ax, m.widthPixels - s - off[0]));
            ay = Math.max(0, Math.min(ay, m.heightPixels - s - off[1]));
            lp[0].x = ax; lp[0].y = ay; lp[1].x = ax + off[0]; lp[1].y = ay + off[1];
            update(0); update(1);
        } else {
            lp[i].x = Math.max(0, Math.min(x, m.widthPixels - s));
            lp[i].y = Math.max(0, Math.min(y, m.heightPixels - s));
            update(i);
        }
    }

    private void update(int i) { try { wm.updateViewLayout(btn[i], lp[i]); } catch (Exception ignored) { } }

    /** Size (dp), opacity, together/apart, gap and row/column from the app's settings. */
    void applySettings() {
        if (btn[0] == null) return;
        SharedPreferences p = prefs();
        int size = sizePx();
        float alpha = Math.max(0.2f, Math.min(1f, p.getInt("alpha", 90) / 100f));
        for (int i = 0; i < 2; i++) {
            lp[i].width = size; lp[i].height = size;
            btn[i].setAlpha(alpha);
            btn[i].setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, size * 0.45f);
        }
        refreshColors();
        moveTo(0, lp[0].x, lp[0].y);                     // re-places the partner for the new gap/layout
        if (!together()) moveTo(1, lp[1].x, lp[1].y);
        savePositions();
    }

    /** After a drag the button(s) stick to the nearer side of the screen, at the height they were dropped. */
    private void snapToEdge(int i) {
        if (!prefs().getBoolean("snap", true)) return;
        DisplayMetrics m = getResources().getDisplayMetrics();
        int s = sizePx();
        if (together()) {
            int[] off = partnerOffset();
            int w = s + off[0];
            moveTo(0, lp[0].x + w / 2 < m.widthPixels / 2 ? 0 : m.widthPixels - w, lp[0].y);
        } else {
            moveTo(i, lp[i].x + s / 2 < m.widthPixels / 2 ? 0 : m.widthPixels - s, lp[i].y);
        }
    }

    private void savePositions() {
        prefs().edit().putInt("x0", lp[0].x).putInt("y0", lp[0].y).putInt("x1", lp[1].x).putInt("y1", lp[1].y).apply();
    }

    // ---------------------------------------------------------------- recording

    private void onTap(String kind) {
        if (sending && !recording) { toast("앞의 녹음을 보내는 중이에요"); return; }
        if (recording) {
            if (kind.equals(recordingKind)) stopRecording();
            else toast(("diary".equals(recordingKind) ? "📖 일기" : "💡 아이디어") + " 녹음 중이에요. 같은 버튼을 눌러 끝내세요");
            return;
        }
        startRecording(kind);
    }

    @SuppressLint("MissingPermission")
    private void startRecording(String kind) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            toast("마이크 권한이 필요해요. 일기장 앱을 열어 허용해 주세요");
            return;
        }
        int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        final AudioRecord rec;
        try {
            rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, RATE));
            if (rec.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException("mic busy");
        } catch (Exception e) {
            toast("마이크를 쓸 수 없어요 (다른 앱이 쓰는 중일 수 있어요)");
            return;
        }
        pauseOtherPlayers();
        buzz();
        recording = true;
        recordingKind = kind;
        refreshColors();
        startAsForeground();
        final long startedAt = System.currentTimeMillis();
        final String time = new SimpleDateFormat("yyyy-MM-dd'T'HH:mmXXX", Locale.US).format(new Date(startedAt));
        recordThread = new Thread(() -> {
            ByteArrayOutputStream pcm = new ByteArrayOutputStream();
            byte[] buf = new byte[RATE / 5];
            int peak = 0;
            rec.startRecording();
            while (recording && System.currentTimeMillis() - startedAt < MAX_SECONDS * 1000L) {
                int n = rec.read(buf, 0, buf.length);
                if (n > 0) {
                    pcm.write(buf, 0, n);
                    for (int k = 0; k + 1 < n; k += 2) peak = Math.max(peak, Math.abs((short) ((buf[k] & 0xff) | (buf[k + 1] << 8))));
                }
            }
            final boolean silent = peak < SILENCE_PEAK;
            try { rec.stop(); } catch (Exception ignored) { }
            rec.release();
            main.post(() -> finished(kind, time, pcm.toByteArray(), silent));
        }, "diary-recorder");
        recordThread.start();
        toast(("diary".equals(kind) ? "📖 일기" : "💡 아이디어") + " 녹음 시작 — 다시 누르면 끝나요");
    }

    private void stopRecording() { recording = false; }

    private void finished(String kind, String time, byte[] pcm, boolean silent) {
        recording = false;
        releaseFocus();
        buzz();
        if (pcm.length < RATE * 2 * 0.7 || silent) {   // under 0.7 s, or no voice at all → not saved
            recordingKind = null; refreshColors(); startAsForeground();
            toast(silent ? "말소리가 들리지 않아 저장하지 않았어요 (다른 앱이 마이크를 쓰는 중일 수도 있어요)" : "녹음이 너무 짧아요");
            return;
        }
        sending = true;
        refreshColors();                                 // blue while sending
        startAsForeground();
        File f = new File(pendingDir(), kind + "_" + System.currentTimeMillis() + ".wav");
        String meta = kind + "|" + time;
        try (FileOutputStream out = new FileOutputStream(f)) { out.write(wav(pcm)); }
        catch (Exception e) { sending = false; recordingKind = null; refreshColors(); toast("녹음을 저장하지 못했어요"); return; }
        try { Files.write(new File(f.getPath() + ".meta").toPath(), meta.getBytes("UTF-8")); } catch (Exception ignored) { }
        new Thread(() -> {
            boolean ok = upload(f, kind, time);
            main.post(() -> {
                sending = false;
                recordingKind = null;
                refreshColors();
                startAsForeground();
                toast(ok ? ("diary".equals(kind) ? "📖 일기" : "💡 아이디어") + " 녹음을 보냈어요. 곧 글로 바뀌어요"
                         : "보내지 못했어요. 인터넷이 연결되면 다시 보낼게요");
            });
        }, "diary-upload").start();
    }

    /** A short vibration so starting and stopping a recording can be felt. */
    private void buzz() {
        try {
            android.os.Vibrator v = getSystemService(android.os.Vibrator.class);
            if (v != null) v.vibrate(android.os.VibrationEffect.createOneShot(40, android.os.VibrationEffect.DEFAULT_AMPLITUDE));
        } catch (Exception ignored) { }
    }

    // Other players (YouTube, YouTube Music, …) pause while we hold transient audio focus.
    private void pauseOtherPlayers() {
        AudioManager am = getSystemService(AudioManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ASSISTANT)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                    .setOnAudioFocusChangeListener(c -> { })
                    .build();
            am.requestAudioFocus(focusRequest);
        } else {
            am.requestAudioFocus(c -> { }, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE);
        }
    }

    private void releaseFocus() {
        AudioManager am = getSystemService(AudioManager.class);
        if (Build.VERSION.SDK_INT >= 26 && focusRequest != null) am.abandonAudioFocusRequest(focusRequest);
        focusRequest = null;
    }

    private static byte[] wav(byte[] pcm) {
        ByteBuffer h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
        h.put("RIFF".getBytes()).putInt(36 + pcm.length).put("WAVE".getBytes()).put("fmt ".getBytes())
         .putInt(16).putShort((short) 1).putShort((short) 1).putInt(RATE).putInt(RATE * 2)
         .putShort((short) 2).putShort((short) 16).put("data".getBytes()).putInt(pcm.length);
        byte[] out = new byte[44 + pcm.length];
        System.arraycopy(h.array(), 0, out, 0, 44);
        System.arraycopy(pcm, 0, out, 44, pcm.length);
        return out;
    }

    // ---------------------------------------------------------------- sending

    private File pendingDir() {
        File d = new File(getFilesDir(), "pending");
        d.mkdirs();
        return d;
    }

    /** POST the recording to the diary server; on success the local file is removed. */
    private boolean upload(File f, String kind, String time) {
        SharedPreferences p = prefs();
        String base = p.getString("worker", null), token = p.getString("token", null);
        if (base == null || token == null) return false;
        for (int attempt = 0; attempt < 3; attempt++) {
            HttpURLConnection c = null;
            try {
                URL url = new URL(base + "/api/voice?kind=" + kind + "&time=" + URLEncoder.encode(time, "UTF-8"));
                c = (HttpURLConnection) url.openConnection();
                c.setRequestMethod("POST");
                c.setDoOutput(true);
                c.setConnectTimeout(15000);
                c.setReadTimeout(60000);
                c.setRequestProperty("Authorization", "Bearer " + token);
                c.setRequestProperty("Content-Type", "audio/wav");
                c.setFixedLengthStreamingMode(f.length());
                try (OutputStream out = c.getOutputStream(); InputStream in = new java.io.FileInputStream(f)) {
                    byte[] b = new byte[65536]; int n;
                    while ((n = in.read(b)) > 0) out.write(b, 0, n);
                }
                int code = c.getResponseCode();
                if (code == 200) {
                    f.delete();
                    new File(f.getPath() + ".meta").delete();
                    return true;
                }
                if (code == 400 || code == 401) return false;    // won't get better by retrying now
            } catch (Exception ignored) {
            } finally { if (c != null) c.disconnect(); }
            try { Thread.sleep(2000L * (attempt + 1)); } catch (InterruptedException ignored) { }
        }
        return false;
    }

    /** Recordings that could not be sent earlier (no network) are sent when the service starts again. */
    private void sendLeftovers() {
        File[] files = pendingDir().listFiles((d, n) -> n.endsWith(".wav"));
        if (files == null || files.length == 0) return;
        new Thread(() -> {
            int sent = 0;
            for (File f : files) {
                try {
                    String[] meta = new String(Files.readAllBytes(new File(f.getPath() + ".meta").toPath()), "UTF-8").split("\\|");
                    if (upload(f, meta[0], meta[1])) sent++;
                } catch (Exception ignored) { }
            }
            if (sent > 0) { int s = sent; main.post(() -> toast("밀린 녹음 " + s + "개를 보냈어요")); }
        }, "diary-leftovers").start();
    }

    private void toast(String msg) { main.post(() -> Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()); }
}
