package net.watchthemall.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Keeps the app alive while a download runs with the phone in a pocket.
 *
 * The downloads queue runs in the WebView (`mobile/src/bridge/downloads.ts`):
 * every segment is a native fetch (`DownloadsPlugin`) whose answer wakes the
 * page. With the app in the background, Android may freeze or kill the
 * process; a foreground service is the platform's way of saying "this app is
 * doing something for the user", and its notification says what and how far.
 * Measured for casting (`CastKeepAliveService`): a backgrounded page's
 * timers run about once a minute, but the fetch answers, which are not
 * timers, keep coming, and those are what drive a download.
 *
 * Started and updated by `DownloadsPlugin.keepAlive` while a download is
 * under way, stopped when none is. `dataSync` is the type Android 14 asks
 * for a transfer the user started.
 */
public class DownloadKeepAliveService extends Service {

    private static final String CHANNEL_ID = "downloads";
    private static final int NOTIFICATION_ID = 4182;
    private static final String EXTRA_TITLE = "title";
    private static final String EXTRA_TEXT = "text";
    private static final String EXTRA_PERCENT = "percent";

    private PowerManager.WakeLock wakeLock;

    public static void show(Context context, String title, String text, int percent) {
        Intent intent = new Intent(context, DownloadKeepAliveService.class)
            .putExtra(EXTRA_TITLE, title)
            .putExtra(EXTRA_TEXT, text)
            .putExtra(EXTRA_PERCENT, percent);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, DownloadKeepAliveService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (power != null) {
            // The CPU between segments; released in onDestroy.
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "WatchThemAll:downloads");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
        String text = intent != null ? intent.getStringExtra(EXTRA_TEXT) : null;
        int percent = intent != null ? intent.getIntExtra(EXTRA_PERCENT, -1) : -1;

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openApp = PendingIntent.getActivity(
            this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        builder
            .setContentTitle(title != null ? title : "Downloading")
            .setContentText(text != null ? text : "")
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentIntent(openApp)
            .setOnlyAlertOnce(true)
            .setOngoing(true);
        if (percent >= 0) builder.setProgress(100, percent, false);
        else builder.setProgress(0, 0, true);
        Notification notification = builder.build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        // Not sticky: restarted without the page there is nothing to drive;
        // the queue picks itself up the next time the app opens.
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        super.onDestroy();
    }

    /** Android 15 ends a `dataSync` service after six hours a day; the queue resumes next time. */
    @Override
    public void onTimeout(int startId, int fgsType) {
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Downloads", NotificationManager.IMPORTANCE_LOW);
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }
}
