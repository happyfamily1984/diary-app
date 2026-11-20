package io.github.happyfamily1984.diary;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Reminders the web page asks for (e.g. "phone plan discount ends in 30 days"): each one fires a
 * notification at its time. The list is kept so the alarms are set again after a reboot or update.
 */
public class ReminderReceiver extends BroadcastReceiver {
    static final String ACTION_REMIND = "io.github.happyfamily1984.diary.REMIND";
    private static final String PREFS = "reminders";
    private static final String CHANNEL = "reminders";

    /** Replaces all reminders with the given JSON array of {id, at (epoch ms), title, text, open}. */
    static void schedule(Context c, String json) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        cancelAll(c, p.getString("list", "[]"));
        p.edit().putString("list", json).apply();
        setAll(c, json);
    }

    private static PendingIntent intentFor(Context c, JSONObject r) {
        Intent i = new Intent(c, ReminderReceiver.class).setAction(ACTION_REMIND)
                .putExtra("id", r.optString("id")).putExtra("title", r.optString("title"))
                .putExtra("text", r.optString("text")).putExtra("open", r.optString("open"));
        return PendingIntent.getBroadcast(c, r.optString("id").hashCode(), i,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static void setAll(Context c, String json) {
        AlarmManager am = c.getSystemService(AlarmManager.class);
        long now = System.currentTimeMillis();
        try {
            JSONArray a = new JSONArray(json);
            for (int k = 0; k < a.length(); k++) {
                JSONObject r = a.getJSONObject(k);
                long at = r.optLong("at");
                if (at > now) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intentFor(c, r));
            }
        } catch (Exception ignored) { }
    }

    private static void cancelAll(Context c, String json) {
        AlarmManager am = c.getSystemService(AlarmManager.class);
        try {
            JSONArray a = new JSONArray(json);
            for (int k = 0; k < a.length(); k++) am.cancel(intentFor(c, a.getJSONObject(k)));
        } catch (Exception ignored) { }
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            setAll(c, c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("list", "[]"));
            return;
        }
        if (!ACTION_REMIND.equals(action)) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null)
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "알림 (휴대폰 요금할인 등)", NotificationManager.IMPORTANCE_DEFAULT));
        Intent open = new Intent(c, MainActivity.class).putExtra("open", intent.getStringExtra("open"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        String id = intent.getStringExtra("id");
        Notification n = new Notification.Builder(c, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setContentTitle(intent.getStringExtra("title"))
                .setContentText(intent.getStringExtra("text"))
                .setStyle(new Notification.BigTextStyle().bigText(intent.getStringExtra("text")))
                .setContentIntent(PendingIntent.getActivity(c, id == null ? 0 : id.hashCode(), open,
                        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
                .setAutoCancel(true)
                .build();
        nm.notify(id == null ? 0 : id.hashCode(), n);
    }
}
