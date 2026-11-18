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
import android.widget.LinearLayout;
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
 * Other players are paused during recording (audio focus), and recording keeps going whatever app
 * is on screen, because this is a foreground service started while the diary app was open.
 */
public class FloatingService extends Service {
    public static final String PREFS = "floating";
    static final String ACTION_STOP = "stop";
    static final String ACTION_APPLY = "apply";
    private static final String CHANNEL = "floating";
    private static final int NOTIFICATION_ID = 1;
    private static final int RATE = 16000;
    private static final int MAX_SECONDS = 600;

    private static final int PINK = 0xFFEC4B84, AMBER = 0xFFF59F00, RED = 0xFFE03131, BLUE = 0xFF3B82F6;

    private WindowManager wm;
    private LinearLayout group;
    private WindowManager.LayoutParams lp;
    private TextView diaryBtn, ideaBtn;
    private final Handler main = new Handler(Looper.getMainLooper());

    // recording state
    private volatile boolean recording;
    private String recordingKind;
    private Thread recordThread;
    private AudioFocusRequest focusRequest;
    private boolean sending;

    static boolean canRun(Context c) {
        return Settings.canDrawOverlays(c)
                && c.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            prefs().edit().putBoolean("enabled", false).apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        startAsForeground();
        if (!canRun(this)) { stopSelf(); return START_NOT_STICKY; }
        if (group == null) createButtons(); else applySettings();
        sendLeftovers();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        recording = false;
        if (group != null) { try { wm.removeView(group); } catch (Exception ignored) { } group = null; }
        super.onDestroy();
    }

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
                .setContentText(recording ? "녹음 중이에요" : "📖 일기 · 💡 아이디어 버튼이 켜져 있어요")
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
        if (group == null) return;
        paint(diaryBtn, "diary".equals(recordingKind) ? (recording ? RED : BLUE) : PINK);
        paint(ideaBtn, "idea".equals(recordingKind) ? (recording ? RED : BLUE) : AMBER);
    }

    @SuppressLint("ClickableViewAccessibility")
    private void createButtons() {
        group = new LinearLayout(this);
        diaryBtn = makeButton("📖");
        ideaBtn = makeButton("💡");
        group.addView(diaryBtn);
        group.addView(ideaBtn);

        lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;

        View.OnTouchListener drag = new View.OnTouchListener() {
            float downX, downY; int startX, startY; boolean moved; final int slop = ViewConfiguration.get(FloatingService.this).getScaledTouchSlop();
            @Override public boolean onTouch(View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = e.getRawX(); downY = e.getRawY(); startX = lp.x; startY = lp.y; moved = false;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        float dx = e.getRawX() - downX, dy = e.getRawY() - downY;
                        if (!moved && Math.hypot(dx, dy) > slop) moved = true;
                        if (moved) { lp.x = startX + Math.round(dx); lp.y = startY + Math.round(dy); keepOnScreen(); wm.updateViewLayout(group, lp); }
                        return true;
                    case MotionEvent.ACTION_UP:
                        if (moved) { snapToEdge(); savePosition(); }
                        else onTap(v == diaryBtn ? "diary" : "idea");
                        return true;
                }
                return false;
            }
        };
        diaryBtn.setOnTouchListener(drag);
        ideaBtn.setOnTouchListener(drag);

        DisplayMetrics m = getResources().getDisplayMetrics();
        lp.x = prefs().getInt("x", m.widthPixels - dp(70));
        lp.y = prefs().getInt("y", m.heightPixels / 2);
        applySettings();
        wm.addView(group, lp);
    }

    /** Size (dp), opacity, gap between the two buttons and row/column layout from the app's settings. */
    void applySettings() {
        if (group == null) return;
        SharedPreferences p = prefs();
        int size = dp(p.getInt("size", 50));
        int gap = dp(p.getInt("gap", 8));
        boolean row = "row".equals(p.getString("layout", "column"));
        group.setOrientation(row ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
        group.setAlpha(Math.max(0.2f, Math.min(1f, p.getInt("alpha", 90) / 100f)));
        for (int i = 0; i < 2; i++) {
            TextView b = i == 0 ? diaryBtn : ideaBtn;
            LinearLayout.LayoutParams l = new LinearLayout.LayoutParams(size, size);
            if (i == 1) { if (row) l.leftMargin = gap; else l.topMargin = gap; }
            b.setLayoutParams(l);
            b.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, size * 0.45f);
        }
        refreshColors();
        group.post(() -> { keepOnScreen(); try { wm.updateViewLayout(group, lp); } catch (Exception ignored) { } });
    }

    private void keepOnScreen() {
        DisplayMetrics m = getResources().getDisplayMetrics();
        int w = group.getWidth() > 0 ? group.getWidth() : dp(60), h = group.getHeight() > 0 ? group.getHeight() : dp(120);
        lp.x = Math.max(0, Math.min(lp.x, m.widthPixels - w));
        lp.y = Math.max(0, Math.min(lp.y, m.heightPixels - h));
    }

    /** After a drag the buttons stick to the nearer side of the screen, at the height they were dropped. */
    private void snapToEdge() {
        if (!prefs().getBoolean("snap", true)) return;
        DisplayMetrics m = getResources().getDisplayMetrics();
        int w = group.getWidth();
        lp.x = lp.x + w / 2 < m.widthPixels / 2 ? 0 : m.widthPixels - w;
        wm.updateViewLayout(group, lp);
    }

    private void savePosition() { prefs().edit().putInt("x", lp.x).putInt("y", lp.y).apply(); }

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
        recording = true;
        recordingKind = kind;
        refreshColors();
        startAsForeground();
        final long startedAt = System.currentTimeMillis();
        final String time = new SimpleDateFormat("yyyy-MM-dd'T'HH:mmXXX", Locale.US).format(new Date(startedAt));
        recordThread = new Thread(() -> {
            ByteArrayOutputStream pcm = new ByteArrayOutputStream();
            byte[] buf = new byte[RATE / 5];
            rec.startRecording();
            while (recording && System.currentTimeMillis() - startedAt < MAX_SECONDS * 1000L) {
                int n = rec.read(buf, 0, buf.length);
                if (n > 0) pcm.write(buf, 0, n);
            }
            try { rec.stop(); } catch (Exception ignored) { }
            rec.release();
            main.post(() -> finished(kind, time, pcm.toByteArray()));
        }, "diary-recorder");
        recordThread.start();
        toast(("diary".equals(kind) ? "📖 일기" : "💡 아이디어") + " 녹음 시작 — 다시 누르면 끝나요");
    }

    private void stopRecording() { recording = false; }

    private void finished(String kind, String time, byte[] pcm) {
        recording = false;
        releaseFocus();
        if (pcm.length < RATE * 2 * 0.7) {             // under 0.7 s
            recordingKind = null; refreshColors(); startAsForeground();
            toast("녹음이 너무 짧아요");
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
