package com.adbpairing;

import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

/**
 * 主界面 Activity
 *
 * 功能：
 * 1. 显示当前无线调试的开关状态
 * 2. 一键开关无线调试（需要 WRITE_SECURE_SETTINGS 权限）
 * 3. 一键跳转到系统的无线调试设置页面（用于查看配对码）
 *
 * 权限说明：
 * WRITE_SECURE_SETTINGS 权限不能通过普通方式获取，
 * 需要首次通过 USB 连接后执行一次 ADB 命令授权：
 *   adb shell pm grant com.adbpairing android.permission.WRITE_SECURE_SETTINGS
 * 授权后永久生效（除非卸载 app）。
 *
 * 这个授权步骤也是一次性的，之后就再也不需要 USB 了。
 */
public class MainActivity extends AppCompatActivity {

    // 系统设置中无线调试的键名
    // 这是 Android 系统内部使用的 Settings.Global 键
    private static final String ADB_WIFI_ENABLED = "adb_wifi_enabled";

    private TextView statusText;
    private TextView infoText;
    private Button toggleButton;
    private Button openSettingsButton;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        // 绑定界面元素
        statusText = findViewById(R.id.statusText);
        infoText = findViewById(R.id.infoText);
        toggleButton = findViewById(R.id.toggleButton);
        openSettingsButton = findViewById(R.id.openSettingsButton);

        // 按钮1：一键开关无线调试
        toggleButton.setOnClickListener(v -> toggleWirelessDebugging());

        // 按钮2：跳转到系统无线调试设置页（可以看配对码）
        openSettingsButton.setOnClickListener(v -> openWirelessDebuggingSettings());

        // 初始化时更新状态显示
        updateStatus();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 每次回到前台都刷新状态（比如从设置页返回后）
        updateStatus();
    }

    /**
     * 读取当前无线调试的开关状态并更新界面
     */
    private void updateStatus() {
        boolean isEnabled = isWirelessDebuggingEnabled();

        if (isEnabled) {
            statusText.setText("无线调试: 已开启");
            statusText.setTextColor(0xFF4CAF50); // 绿色
            toggleButton.setText("关闭无线调试");
            infoText.setText("无线调试已开启。\n\n"
                    + "如果是首次连接，请点击下方按钮\n"
                    + "进入设置页面查看配对码。\n\n"
                    + "如果已经配对过，直接在电脑上\n"
                    + "运行 scrcpy-auto 即可。");
        } else {
            statusText.setText("无线调试: 已关闭");
            statusText.setTextColor(0xFFF44336); // 红色
            toggleButton.setText("开启无线调试");
            infoText.setText("点击上方按钮开启无线调试。\n\n"
                    + "如果按钮无效，请先通过 USB 执行：\n"
                    + "adb shell pm grant com.adbpairing\n"
                    + "  android.permission.WRITE_SECURE_SETTINGS");
        }
    }

    /**
     * 检查无线调试是否已开启
     *
     * 通过读取 Settings.Global 中的 adb_wifi_enabled 值来判断。
     * 返回值：0 = 关闭，1 = 开启
     */
    private boolean isWirelessDebuggingEnabled() {
        try {
            int value = Settings.Global.getInt(
                    getContentResolver(),
                    ADB_WIFI_ENABLED,
                    0  // 默认值，读不到时返回 0（关闭）
            );
            return value == 1;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 切换无线调试的开关状态
     *
     * 通过 Settings.Global.putInt() 修改系统设置。
     * 这需要 WRITE_SECURE_SETTINGS 权限。
     * 如果没有权限会抛异常，我们捕获后提示用户。
     */
    private void toggleWirelessDebugging() {
        try {
            boolean currentlyEnabled = isWirelessDebuggingEnabled();
            // 写入新的状态值：当前开着就写0（关），当前关着就写1（开）
            Settings.Global.putInt(
                    getContentResolver(),
                    ADB_WIFI_ENABLED,
                    currentlyEnabled ? 0 : 1
            );
            // 更新界面
            updateStatus();
            Toast.makeText(this,
                    currentlyEnabled ? "无线调试已关闭" : "无线调试已开启",
                    Toast.LENGTH_SHORT).show();
        } catch (SecurityException e) {
            // 没有 WRITE_SECURE_SETTINGS 权限时会进入这里
            Toast.makeText(this,
                    "缺少权限，请先通过 USB 执行 ADB 授权命令",
                    Toast.LENGTH_LONG).show();
            // 显示授权指引
            infoText.setText("请用 USB 连接手机，在电脑上执行：\n\n"
                    + "adb shell pm grant com.adbpairing "
                    + "android.permission.WRITE_SECURE_SETTINGS\n\n"
                    + "授权一次后永久生效。");
        }
    }

    /**
     * 跳转到系统的无线调试设置页面
     *
     * 这里尝试直接打开无线调试页面（而不是开发者选项主页）。
     * 如果系统不支持直接跳转，就退而求其次打开开发者选项页。
     */
    private void openWirelessDebuggingSettings() {
        try {
            // 尝试直接打开无线调试设置页
            // 这个 action 在大多数 Android 11+ 设备上有效
            Intent intent = new Intent("android.settings.WIRELESS_DEBUGGING_SETTINGS");
            startActivity(intent);
        } catch (Exception e) {
            try {
                // 如果上面的 Intent 不支持，打开开发者选项页
                Intent devIntent = new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS);
                startActivity(devIntent);
            } catch (Exception e2) {
                Toast.makeText(this, "无法打开设置页面", Toast.LENGTH_SHORT).show();
            }
        }
    }
}
