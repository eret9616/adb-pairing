package com.adbpairing;

import android.provider.Settings;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * Quick Settings Tile（快速设置磁贴）
 *
 * 这是 Android 的「快速设置」功能（下拉通知栏顶部的那排图标）。
 * 用户可以在快速设置中添加我们的磁贴，这样不用打开 app，
 * 只需下拉通知栏点击一下就能开关无线调试。
 *
 * 使用方法：
 * 1. 安装 app 后，下拉通知栏
 * 2. 点击编辑按钮（通常是铅笔图标）
 * 3. 找到「无线调试」磁贴，拖到快速设置区域
 * 4. 以后点一下就能开关无线调试
 *
 * 同样需要 WRITE_SECURE_SETTINGS 权限才能生效。
 */
public class WirelessDebugTileService extends TileService {

    // 与 MainActivity 中一样的系统设置键名
    private static final String ADB_WIFI_ENABLED = "adb_wifi_enabled";

    /**
     * 当磁贴变为可见时调用（比如下拉通知栏时）
     * 此时更新磁贴的显示状态（开/关）
     */
    @Override
    public void onStartListening() {
        super.onStartListening();
        updateTileState();
    }

    /**
     * 用户点击磁贴时调用
     * 切换无线调试的开关状态
     */
    @Override
    public void onClick() {
        super.onClick();
        try {
            boolean isEnabled = isWirelessDebuggingEnabled();
            // 切换状态
            Settings.Global.putInt(
                    getContentResolver(),
                    ADB_WIFI_ENABLED,
                    isEnabled ? 0 : 1
            );
            // 更新磁贴显示
            updateTileState();
        } catch (SecurityException e) {
            // 没有权限，无法切换
            // Quick Settings 中无法显示 Toast，用户需要打开 app 查看提示
        }
    }

    /**
     * 更新磁贴的视觉状态
     * - 开启时：磁贴高亮（STATE_ACTIVE）
     * - 关闭时：磁贴灰色（STATE_INACTIVE）
     */
    private void updateTileState() {
        Tile tile = getQsTile();
        if (tile == null) return;

        boolean isEnabled = isWirelessDebuggingEnabled();
        tile.setState(isEnabled ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        tile.setLabel(isEnabled ? "无线调试: 开" : "无线调试: 关");
        tile.updateTile(); // 刷新磁贴显示
    }

    /**
     * 读取无线调试状态
     */
    private boolean isWirelessDebuggingEnabled() {
        try {
            return Settings.Global.getInt(
                    getContentResolver(),
                    ADB_WIFI_ENABLED,
                    0
            ) == 1;
        } catch (Exception e) {
            return false;
        }
    }
}
