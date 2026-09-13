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
import android.net.wifi.WifiManager;

/**
 * Keeps the phone serving while the film plays on the television.
 *
 * ## Why this is not optional
 *
 * While casting, the phone is the media server: the Chromecast fetches every
 * segment from `CastProxyServer` over the LAN. The obvious thing for a user to
 * do at that point is put the phone down and watch the television — at which
 * point Android is entitled to freeze the process, drop the Wi-Fi multicast
 * lock, and eventually kill the app to reclaim memory. The stream stalls partway
 * through the film with no error and nothing on screen to explain it.
 *
 * A foreground service is the platform's answer to "this app is doing something
 * for the user even though they are not looking at it". The notification it
 * requires is not an unfortunate side effect; it is the thing that makes the
 * arrangement legible, and it gives the user somewhere to stop the cast from.
 *
 * ## Why the two locks as well
 *
 * The foreground service keeps the *process*; the locks keep the *radios*. A
 * partial wake lock stops the CPU sleeping between segment requests, and the
 * Wi-Fi lock stops the adapter dropping to a power-saving mode that adds enough
 * latency to starve the receiver's buffer. Both are released in `onDestroy` —
 * a leaked wake lock is a flat battery by morning.
 */
public class CastKeepAliveService extends Service {

    private static final String CHANNEL_ID = "cast";
    private static final int NOTIFICATION_ID = 4181;
    private static final String ACTION_STOP = "net.watchthemall.app.STOP_CAST";

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    public static void start(Context context) {
        Intent intent = new Intent(context, CastKeepAliveService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, CastKeepAliveService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();

        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (power != null) {
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "WatchThemAll:cast");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        }

        WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wifi != null) {
            wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "WatchThemAll:cast");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openApp = PendingIntent.getActivity(
            this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);

        Notification notification = builder
            .setContentTitle("Casting to your TV")
            .setContentText("WatchThemAll is streaming from this phone")
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentIntent(openApp)
            .setOngoing(true)
            .build();

        /*
         * Android 14 requires every foreground service to declare a type, and
         * refuses to start one that does not. `mediaPlayback` is the accurate
         * description: the phone is the source of a stream the user is watching.
         */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        // Not sticky: if Android kills this, the cast is already broken and the
        // stream URLs are likely expired. Silently restarting would reconnect to
        // nothing.
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        wakeLock = null;
        wifiLock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;

        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Casting",
            // LOW: this notification exists to keep the process alive and to
            // offer a way out, not to interrupt anybody.
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }
}
