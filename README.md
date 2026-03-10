# scrcpy-auto

自动发现、配对、连接 Android 设备并启动 scrcpy 的工具。

## 使用方法

```bash
# 日常使用（一条命令搞定）
scrcpy-auto

# 强制重新发现设备
scrcpy-auto -r

# 传递额外参数给 scrcpy
scrcpy-auto --no-audio
```

## 流程图

```mermaid
flowchart TD
    START["运行 scrcpy-auto"] --> CHECK_CONNECTED{"检查 adb devices\n是否已有连接?"}

    CHECK_CONNECTED -->|"已连接"| LAUNCH["启动 scrcpy"]
    CHECK_CONNECTED -->|"未连接"| MDNS_SCAN["mDNS 扫描局域网\n(监听 8 秒)"]

    MDNS_SCAN --> SCAN_CONNECT["查找 _adb-tls-connect._tcp\n(已配对设备)"]
    MDNS_SCAN --> SCAN_PAIRING["查找 _adb-tls-pairing._tcp\n(待配对设备)"]

    SCAN_CONNECT --> HAS_CONNECT{"发现已配对\n设备?"}

    HAS_CONNECT -->|"是"| MULTI_CONNECT{"多个设备?"}
    MULTI_CONNECT -->|"是"| SELECT_CONNECT["用户选择设备"]
    MULTI_CONNECT -->|"否"| AUTO_SELECT_CONNECT["自动选择唯一设备"]
    SELECT_CONNECT --> ADB_CONNECT["执行 adb connect IP:端口"]
    AUTO_SELECT_CONNECT --> ADB_CONNECT
    ADB_CONNECT --> CONNECT_OK{"连接成功?"}
    CONNECT_OK -->|"是"| LAUNCH
    CONNECT_OK -->|"否"| CHECK_PAIRING

    HAS_CONNECT -->|"否"| CHECK_PAIRING{"发现待配对\n设备?"}

    SCAN_PAIRING -.-> CHECK_PAIRING

    CHECK_PAIRING -->|"是"| ASK_CODE["提示用户输入\n手机上的 6 位配对码"]
    ASK_CODE --> ADB_PAIR["执行 adb pair IP:端口 配对码"]
    ADB_PAIR --> PAIR_OK{"配对成功?"}
    PAIR_OK -->|"是"| WAIT["等待 3 秒\n(手机切换广播状态)"]
    PAIR_OK -->|"否"| FAIL_PAIR["显示: 配对失败\n请确认配对码"]
    WAIT --> RESCAN["重新 mDNS 扫描"]
    RESCAN --> FOUND_AFTER{"发现可连接\n设备?"}
    FOUND_AFTER -->|"是"| ADB_CONNECT2["执行 adb connect"]
    FOUND_AFTER -->|"否"| FAIL_CONNECT["显示: 未发现连接服务"]
    ADB_CONNECT2 --> LAUNCH

    CHECK_PAIRING -->|"否"| NO_DEVICE["未发现任何设备\n显示排查指引"]

    LAUNCH --> SCRCPY_RUN["scrcpy 推送 server 到手机\n开始屏幕投射"]
    SCRCPY_RUN --> END["用户关闭 scrcpy 时退出"]

    style START fill:#4CAF50,color:#fff
    style LAUNCH fill:#2196F3,color:#fff
    style SCRCPY_RUN fill:#2196F3,color:#fff
    style END fill:#607D8B,color:#fff
    style NO_DEVICE fill:#f44336,color:#fff
    style FAIL_PAIR fill:#f44336,color:#fff
    style FAIL_CONNECT fill:#f44336,color:#fff
    style MDNS_SCAN fill:#FF9800,color:#fff
    style RESCAN fill:#FF9800,color:#fff
```

## 技术原理图

```mermaid
sequenceDiagram
    participant PC as 电脑 (scrcpy-auto)
    participant LAN as 局域网 (mDNS)
    participant Phone as 手机 (Android 11+)

    Note over Phone: 用户开启「无线调试」
    Phone->>LAN: 广播 _adb-tls-connect._tcp<br/>(IP, 端口, 设备名)

    Note over PC: 用户运行 scrcpy-auto
    PC->>LAN: mDNS 查询: 谁是 _adb-tls-connect._tcp?
    LAN->>PC: 回复: 手机 IP=192.168.1.100, Port=38945

    alt 首次使用 (未配对过)
        Note over Phone: 用户点击「使用配对码配对设备」
        Phone->>LAN: 广播 _adb-tls-pairing._tcp<br/>(IP, 配对端口)
        Phone-->>Phone: 显示 6 位配对码: 482916
        PC->>LAN: mDNS 查询: 谁是 _adb-tls-pairing._tcp?
        LAN->>PC: 回复: 手机 IP=192.168.1.100, PairPort=37291
        Note over PC: 用户输入配对码 482916
        PC->>Phone: adb pair 192.168.1.100:37291 482916
        Phone->>PC: 配对成功 (交换 TLS 密钥)
        Note over PC,Phone: 密钥永久保存, 之后不再需要配对
    end

    PC->>Phone: adb connect 192.168.1.100:38945
    Phone->>PC: 连接建立 (TLS 加密通道)

    Note over PC: 启动 scrcpy
    PC->>Phone: 推送 scrcpy-server.jar
    Phone->>Phone: 启动 server, 捕获屏幕
    Phone->>PC: 实时传输编码后的画面
    PC->>Phone: 传输鼠标/键盘事件

    Note over PC: SDL 窗口显示手机画面
```

## 关键概念

### 配对 vs 连接

|              | 配对 (pair)             | 连接 (connect)              |
| ------------ | ----------------------- | --------------------------- |
| 做什么       | 交换 TLS 密钥           | 建立通信通道                |
| 类比         | 蓝牙配对                | 蓝牙连接                    |
| 频率         | 只需一次                | 每次使用                    |
| 换网络后     | 不需要重新配对          | 需要重新连接 (工具自动处理) |
| mDNS 服务    | `_adb-tls-pairing._tcp` | `_adb-tls-connect._tcp`     |
| 需要用户操作 | 输入 6 位配对码         | 无 (全自动)                 |

### 为什么换网络不用重新配对?

配对的本质是密钥交换：

- 电脑的密钥保存在 `~/.android/adbkey`
- 手机记住了这个密钥的公钥

换网络后只是 IP 和端口变了，但密钥没变。
工具通过 mDNS 自动发现新的 IP 和端口，所以换网络也能自动连上。
