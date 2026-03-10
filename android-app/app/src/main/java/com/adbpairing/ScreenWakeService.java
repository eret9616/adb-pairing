package com.adbpairing;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * 屏幕常亮前台服务
 *
 * 功能：
 * 当此服务运行时，持有 PowerManager.WakeLock，防止屏幕熄灭和锁屏。
 * 即使 App 切到后台，屏幕也会保持常亮状态。
 *
 * 原理：
 * Android 8+ 要求长期运行的后台任务必须以"前台服务"的形式运行，
 * 前台服务会在通知栏显示一个持久通知，告知用户有服务在运行。
 * 服务内持有 SCREEN_DIM_WAKE_LOCK | ACQUIRE_CAUSES_WAKEUP 类型的 WakeLock，
 * 这可以阻止屏幕熄灭（SCREEN_DIM_WAKE_LOCK），
 * 并在服务启动时立即唤醒屏幕（ACQUIRE_CAUSES_WAKEUP）。
 *
 * 使用方式：
 * - 启动服务：startForegroundService(new Intent(this, ScreenWakeService.class))
 * - 停止服务：stopService(new Intent(this, ScreenWakeService.class))
 */
public class ScreenWakeService extends Service {

    // 通知频道 ID（Android 8+ 要求）
    private static final String CHANNEL_ID = "screen_wake_channel";

    // 通知 ID，用于更新或取消通知
    private static final int NOTIFICATION_ID = 1001;

    // WakeLock TAG，用于调试（在 dumpsys power 中可以看到）
    private static final String WAKE_LOCK_TAG = "AdbPairing:ScreenWake";

    // 持有 WakeLock 的引用，方便在 onDestroy 时释放
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        // 创建通知频道（Android 8+ 必须）
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 构建前台服务通知（必须在 5 秒内调用 startForeground，否则 ANR）
        Notification notification = buildNotification();
        startForeground(NOTIFICATION_ID, notification);

        // 申请屏幕常亮锁
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null && (wakeLock == null || !wakeLock.isHeld())) {
            // SCREEN_DIM_WAKE_LOCK: 保持屏幕常亮（允许屏幕稍微变暗，但不会熄灭）
            // ACQUIRE_CAUSES_WAKEUP: 申请锁时立即唤醒屏幕（如果屏幕是关着的）
            //noinspection deprecation
            wakeLock = pm.newWakeLock(
                    PowerManager.SCREEN_DIM_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP,
                    WAKE_LOCK_TAG
            );
            // 不设超时，持续持有直到手动释放
            wakeLock.acquire();
        }

        // START_STICKY: 如果服务被系统杀死，系统会尝试重启它
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        // 释放 WakeLock，屏幕恢复正常熄屏/锁屏行为
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
            wakeLock = null;
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        // 这是一个 Started Service，不支持绑定
        return null;
    }

    /**
     * 创建通知频道（Android 8+ 必须）
     * 通知频道只需要创建一次，重复创建不会有副作用
     */
    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "屏幕常亮",                          // 频道名称（用户可在设置里看到）
                NotificationManager.IMPORTANCE_LOW   // 低重要性，不会有声音/震动
        );
        channel.setDescription("ADB Pairing 屏幕常亮服务运行中");

        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) {
            nm.createNotificationChannel(channel);
        }
    }

    /**
     * 构建前台服务通知
     * 点击通知可以返回主界面
     */
    private Notification buildNotification() {
        // 点击通知时打开 MainActivity
        Intent activityIntent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                0,
                activityIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("ADB Pairing - 屏幕常亮中")
                .setContentText("屏幕已锁定保持常亮，点击返回 App 可关闭")
                .setSmallIcon(android.R.drawable.ic_lock_idle_charging)
                .setContentIntent(pendingIntent)
                .setOngoing(true)  // 不可被用户手动清除
                .build();
    }
}
