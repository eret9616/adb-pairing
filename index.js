#!/usr/bin/env node

// ============================================================
// scrcpy-auto: 自动发现、配对、连接 Android 设备并启动 scrcpy
// ============================================================
//
// 【核心原理】
//
// Android 11+ 引入了「无线调试」功能，底层基于 ADB over TLS。
// 当手机开启无线调试后，会通过 mDNS（多播DNS/Bonjour）协议
// 在局域网中广播自己的存在，就像 AirPlay 设备广播自己一样。
//
// 手机会广播两种 mDNS 服务：
//
//   1. _adb-tls-connect._tcp
//      含义：「我是一台已经和某些电脑配对过的设备，可以直接连接」
//      什么时候广播：只要无线调试开关打开就一直广播
//      谁能连：只有之前配对过的电脑（拥有正确 ADB 密钥的）
//
//   2. _adb-tls-pairing._tcp
//      含义：「我正在等待新设备来配对」
//      什么时候广播：用户在手机上点了「使用配对码配对设备」后才会广播
//      作用：让新电脑可以发现并配对这台手机
//
// 【配对 vs 连接】
//
//   配对(pair)：交换密钥的过程，类似蓝牙配对。只需做一次。
//              配对后密钥保存在 ~/.android/adbkey 中，换网络也不用重新配对。
//
//   连接(connect)：建立实际通信通道。每次使用都需要，但可以自动完成。
//                 因为手机 IP 和端口可能变化，所以需要 mDNS 来自动发现。
//
// 【mDNS 是什么】
//
//   mDNS (Multicast DNS) 是一种零配置网络协议。
//   设备通过向局域网发送多播 UDP 包来广播自己的服务。
//   不需要 DNS 服务器，设备之间直接通信。
//   macOS 的 Bonjour、Linux 的 Avahi 都是 mDNS 的实现。
//   我们用 Node.js 的 bonjour-service 库来监听这些广播。
//
// 【整体流程】
//
//   1. 检查是否已有 ADB 连接 -> 有则直接启动 scrcpy
//   2. 通过 mDNS 扫描局域网中的 Android 设备
//   3. 如果发现已配对设备 -> 自动连接 -> 启动 scrcpy
//   4. 如果发现待配对设备 -> 提示输入配对码 -> 配对 -> 连接 -> 启动 scrcpy
//   5. 如果什么都没发现 -> 显示帮助信息
//
// ============================================================

// --- 导入依赖 ---

// bonjour-service: mDNS 服务发现库，用于在局域网中查找 Android 设备的广播
const { Bonjour } = require("bonjour-service");

// execSync: 同步执行 shell 命令（用于 adb 操作）
// spawn: 异步启动子进程（用于启动 scrcpy，保持交互）
const { execSync, spawn } = require("child_process");

// readline: Node.js 内置模块，用于从终端读取用户输入（比如配对码）
const readline = require("readline");

// --- 常量配置 ---

// mDNS 扫描的超时时间，8秒内收集所有发现的设备
// 太短可能漏掉设备，太长用户等待太久
const DISCOVERY_TIMEOUT = 8000;

// Android 无线调试广播的 mDNS 服务类型
// 这两个字符串是 Android 系统固定的，不是我们定义的
const CONNECT_SERVICE = "adb-tls-connect"; // 已配对设备的连接服务
const PAIRING_SERVICE = "adb-tls-pairing"; // 等待配对的服务

// --- 工具函数 ---

// 统一的日志输出，带前缀方便识别
function log(msg) {
  console.log(`[scrcpy-auto] ${msg}`);
}

// 统一的错误输出
function logError(msg) {
  console.error(`[scrcpy-auto] 错误: ${msg}`);
}

// 执行 shell 命令并返回输出文本
// 如果命令失败不会抛异常，而是返回空字符串或 stdout 内容
function runCmd(cmd) {
  try {
    // encoding: "utf-8" 让返回值是字符串而不是 Buffer
    // timeout: 10秒超时，避免命令卡住
    return execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim();
  } catch (e) {
    // 命令失败时，尝试返回已有的 stdout 输出
    return e.stdout ? e.stdout.trim() : "";
  }
}

// 在终端中向用户提问，返回用户输入的内容
// 用于获取配对码和选择设备
function askQuestion(question) {
  // 创建 readline 接口，绑定到标准输入/输出
  const rl = readline.createInterface({
    input: process.stdin, // 从键盘读取
    output: process.stdout, // 输出到终端
  });
  return new Promise((resolve) => {
    // 显示问题并等待用户输入
    rl.question(question, (answer) => {
      rl.close(); // 用完关闭，释放资源
      resolve(answer.trim()); // 去除首尾空格后返回
    });
  });
}

// --- 核心功能函数 ---

/**
 * 检查是否已有 ADB 无线连接
 *
 * 原理：执行 `adb devices` 命令，检查输出中是否有
 * 格式为 "IP:端口  device" 的行。
 * 如果有，说明之前已经连上了，不需要重新发现和连接。
 *
 * 返回：已连接设备的 "IP:端口" 字符串，或 null
 */
function isAlreadyConnected() {
  // `adb devices` 输出示例：
  // List of devices attached
  // 192.168.1.100:5555    device
  // emulator-5554         device
  const output = runCmd("adb devices");

  // 筛选包含 ":" 的行（无线连接都是 IP:端口 格式）
  // 同时包含 "device" 表示已连接（排除 "offline"、"unauthorized" 等状态）
  const lines = output
    .split("\n")
    .filter((l) => l.includes(":") && l.includes("device"));

  // 返回第一个匹配设备的地址，或 null
  return lines.length > 0 ? lines[0].split("\t")[0] : null;
}

/**
 * 通过 mDNS 在局域网中自动发现 Android 设备
 *
 * 原理：
 * 1. 创建 Bonjour 实例（mDNS 客户端）
 * 2. 同时监听两种服务类型的广播：
 *    - _adb-tls-connect._tcp：已配对设备，可直接连接
 *    - _adb-tls-pairing._tcp：等待配对的设备
 * 3. 等待 DISCOVERY_TIMEOUT 毫秒，收集所有发现的设备
 * 4. 返回分类后的设备列表
 *
 * mDNS 的工作方式：
 * - 向局域网发送多播查询包（目标地址 224.0.0.251:5353）
 * - 符合条件的设备会回复自己的 IP、端口、服务名等信息
 * - 这一切都在局域网内完成，不需要互联网
 */
function discoverDevices() {
  return new Promise((resolve) => {
    // 创建 mDNS 浏览器实例
    const bonjour = new Bonjour();

    // 存储发现的设备，分为两类
    const results = {
      connect: [], // 已配对，可直接连接的设备
      pairing: [], // 正在等待配对的设备
    };

    log("正在扫描局域网中的 Android 设备...");

    // 监听已配对设备的 mDNS 广播
    // bonjour.find() 会持续监听，每发现一个设备就调用回调
    const connectBrowser = bonjour.find(
      { type: CONNECT_SERVICE }, // 查找 _adb-tls-connect._tcp 类型的服务
      (service) => {
        // service 对象包含设备信息：
        //   service.name: 设备名称（通常是 "adb-XXXXXX" 格式）
        //   service.addresses: IP 地址数组（可能有 IPv4 和 IPv6）
        //   service.port: 服务端口号（每次重启可能变化）
        //   service.referer: 回复这个广播的设备地址

        // 优先取 IPv4 地址（包含 "." 的），否则用 referer 的地址
        const addr =
          service.addresses?.find((a) => a.includes(".")) ||
          service.referer?.address;
        if (addr) {
          results.connect.push({
            name: service.name, // 设备标识名
            host: addr, // IP 地址
            port: service.port, // 端口号
          });
          log(`发现已配对设备: ${service.name} (${addr}:${service.port})`);
        }
      },
    );

    // 监听等待配对设备的 mDNS 广播
    // 只有用户在手机上点了「使用配对码配对设备」才会出现
    const pairingBrowser = bonjour.find(
      { type: PAIRING_SERVICE }, // 查找 _adb-tls-pairing._tcp 类型的服务
      (service) => {
        const addr =
          service.addresses?.find((a) => a.includes(".")) ||
          service.referer?.address;
        if (addr) {
          results.pairing.push({
            name: service.name,
            host: addr,
            port: service.port,
          });
          log(`发现等待配对的设备: ${service.name} (${addr}:${service.port})`);
        }
      },
    );

    // 等待 DISCOVERY_TIMEOUT 毫秒后停止扫描，返回所有发现的设备
    setTimeout(() => {
      connectBrowser.stop(); // 停止监听连接服务
      pairingBrowser.stop(); // 停止监听配对服务
      bonjour.destroy(); // 销毁 mDNS 客户端，释放端口
      resolve(results); // 返回结果
    }, DISCOVERY_TIMEOUT);
  });
}

/**
 * 与设备配对
 *
 * 原理：
 * 1. 用户在手机上点「使用配对码配对设备」后，手机显示 6 位数字码
 * 2. 我们通过 mDNS 已经自动获取到了手机的 IP 和配对端口
 * 3. 用户只需输入那 6 位数字，我们执行 `adb pair IP:端口 配对码`
 * 4. 配对成功后，ADB 密钥（~/.android/adbkey）被添加到手机的信任列表
 * 5. 之后这台电脑就可以直接连接这台手机了，不需要再配对
 *
 * @param device - 通过 mDNS 发现的设备信息 {name, host, port}
 * @returns true 配对成功，false 配对失败
 */
async function pairDevice(device) {
  log(`准备配对设备: ${device.name} (${device.host}:${device.port})`);
  log("请查看手机上显示的 6 位配对码");

  // 提示用户输入手机上显示的配对码
  const code = await askQuestion("[scrcpy-auto] 请输入配对码: ");

  // 验证配对码格式
  if (!code || code.length < 6) {
    logError("配对码无效");
    return false;
  }

  log("正在配对...");
  // 执行 ADB 配对命令
  // 格式：adb pair <IP:端口> <6位配对码>
  // 这会在手机和电脑之间建立 TLS 信任关系
  const output = runCmd(`adb pair ${device.host}:${device.port} ${code}`);
  console.log(output);

  // 检查输出是否包含 "success" 来判断配对是否成功
  if (output.toLowerCase().includes("success")) {
    log("配对成功!");
    return true;
  } else {
    logError("配对失败，请确认配对码是否正确");
    return false;
  }
}

/**
 * 连接到已配对的设备
 *
 * 原理：
 * 配对完成后（或之前已配对过），执行 `adb connect IP:端口`
 * 建立 ADB 通信通道。连接成功后 scrcpy 就可以通过这个通道工作了。
 *
 * 注意：连接端口和配对端口是不同的！
 * - 配对端口：手机点「使用配对码配对设备」时临时分配的
 * - 连接端口：无线调试开启后持续使用的，通过 _adb-tls-connect._tcp 广播
 *
 * @param device - 设备信息 {name, host, port}
 * @returns true 连接成功，false 连接失败
 */
function connectDevice(device) {
  log(`正在连接 ${device.host}:${device.port}...`);
  // 执行 ADB 连接命令
  const output = runCmd(`adb connect ${device.host}:${device.port}`);
  console.log(output);

  // 判断连接结果
  if (output.toLowerCase().includes("connected")) {
    log("连接成功!");
    return true;
  } else if (output.toLowerCase().includes("already")) {
    // 如果已经连接了，也算成功
    log("设备已连接!");
    return true;
  } else {
    logError("连接失败");
    return false;
  }
}

/**
 * 启动 scrcpy 进行屏幕投射
 *
 * 原理：
 * scrcpy 会通过已建立的 ADB 连接：
 * 1. 将 scrcpy-server.jar 推送到手机上
 * 2. 在手机端启动 server 进程
 * 3. server 捕获手机屏幕画面，编码后通过网络传给电脑
 * 4. 电脑端用 SDL 窗口显示画面，并将鼠标/键盘事件发回手机
 *
 * @param extraArgs - 传递给 scrcpy 的额外参数
 */
function launchScrcpy(extraArgs = []) {
  log("正在启动 scrcpy...");

  // scrcpy 启动参数（官方推荐的超低延迟配置）
  // 参考：https://github.com/Genymobile/scrcpy/blob/master/doc/video.md
  const args = [
    "-m",
    "800", // 降分辨率到 800，大幅减少数据传输量
    "--max-fps=60", // 保持 60fps，降帧率不减延迟只会让画面更卡
    "--video-buffer=0", // 零视频缓冲，这是降低延迟的核心参数
    "--no-audio", // 关闭音频，减少带宽占用
    ...extraArgs, // 用户自定义参数（可覆盖上面的默认值）
  ];

  log(`scrcpy ${args.join(" ")}`);

  // 使用 spawn 异步启动 scrcpy 进程
  // stdio: "inherit" 让 scrcpy 的输出直接显示在当前终端
  const child = spawn("scrcpy", args, {
    stdio: "inherit", // 继承父进程的标准输入/输出/错误
    detached: false, // 不分离进程，随主进程退出
  });

  // 监听启动错误（比如 scrcpy 没安装）
  child.on("error", (err) => {
    logError(`启动 scrcpy 失败: ${err.message}`);
  });

  // 监听 scrcpy 退出事件
  child.on("exit", (code) => {
    if (code === 0) {
      log("scrcpy 已退出");
    } else {
      logError(`scrcpy 异常退出 (code: ${code})`);
    }
    process.exit(code || 0); // 跟随 scrcpy 退出
  });
}

/**
 * 当发现多个设备时，让用户选择要连接哪一个
 *
 * @param devices - 设备列表
 * @param label - 显示标签（"可连接" 或 "待配对"）
 * @returns 用户选择的设备
 */
async function selectDevice(devices, label) {
  // 只有一个设备，直接返回，不需要选择
  if (devices.length === 1) return devices[0];

  // 列出所有发现的设备，让用户按编号选择
  console.log(`\n发现多个${label}设备:`);
  devices.forEach((d, i) => {
    console.log(`  [${i + 1}] ${d.name} (${d.host}:${d.port})`);
  });

  const answer = await askQuestion(`请选择设备 [1-${devices.length}]: `);
  const idx = parseInt(answer) - 1;

  // 验证输入范围，无效则默认选第一个
  if (idx >= 0 && idx < devices.length) {
    return devices[idx];
  }
  return devices[0];
}

// ============================================================
// 主流程 - 按优先级依次尝试连接
// ============================================================
async function main() {
  // 显示欢迎信息
  console.log("");
  console.log("========================================");
  console.log("  scrcpy-auto - 无线连接 Android 设备");
  console.log("========================================");
  console.log("");

  // --- 解析命令行参数 ---
  const args = process.argv.slice(2); // 去掉 node 和脚本路径
  const scrcpyArgs = []; // 传递给 scrcpy 的参数
  let forceRediscover = false; // 是否强制重新发现设备

  for (const arg of args) {
    if (arg === "--rediscover" || arg === "-r") {
      // -r 参数：跳过已有连接，强制重新扫描
      forceRediscover = true;
    } else {
      // 其他参数原样传给 scrcpy
      scrcpyArgs.push(arg);
    }
  }

  // --- 步骤 1: 检查是否已有 ADB 连接 ---
  // 如果之前已经连上了，直接启动 scrcpy，不需要重新发现
  if (!forceRediscover) {
    const existing = isAlreadyConnected();
    if (existing) {
      log(`检测到已连接的设备: ${existing}`);
      launchScrcpy(scrcpyArgs);
      return; // 直接启动，流程结束
    }
  }

  // --- 步骤 2: mDNS 自动发现设备 ---
  // 在局域网中扫描 8 秒，收集所有 Android 设备的广播
  const devices = await discoverDevices();

  // --- 步骤 3A: 发现已配对设备 -> 直接连接 ---
  // 优先处理已配对设备，因为不需要用户交互
  if (devices.connect.length > 0) {
    const device = await selectDevice(devices.connect, "可连接");
    const connected = connectDevice(device);
    if (connected) {
      launchScrcpy(scrcpyArgs);
      return;
    }
  }

  // --- 步骤 3B: 发现待配对设备 -> 先配对再连接 ---
  // 需要用户输入配对码（只需做一次）
  if (devices.pairing.length > 0) {
    const device = await selectDevice(devices.pairing, "待配对");
    const paired = await pairDevice(device);

    if (paired) {
      // 配对成功后，等待手机开始广播连接服务
      // 手机需要几秒钟来切换状态
      log("配对成功，正在等待设备广播连接服务...");
      await new Promise((r) => setTimeout(r, 3000));

      // 重新扫描，这次应该能发现可连接的服务了
      const retryDevices = await discoverDevices();
      if (retryDevices.connect.length > 0) {
        const connectDevice2 = retryDevices.connect[0];
        const connected = connectDevice(connectDevice2);
        if (connected) {
          launchScrcpy(scrcpyArgs);
          return;
        }
      } else {
        logError("配对成功但未发现连接服务，请确认手机上无线调试仍然开启");
      }
    }
  }

  // --- 步骤 3C: 什么设备都没发现 ---
  // 显示排查指引
  if (devices.connect.length === 0 && devices.pairing.length === 0) {
    console.log("");
    logError("未发现任何 Android 设备");
    console.log("");
    console.log("请检查以下事项:");
    console.log("  1. 手机和电脑是否在同一个 WiFi 网络");
    console.log("  2. 手机是否已开启 [开发者选项] > [无线调试]");
    console.log("  3. 如果是首次配对，请在手机上点击 [使用配对码配对设备]");
    console.log("");
    console.log("提示:");
    console.log("  - 配对只需要做一次，之后换网络也不用重新配对");
    console.log("  - 只需保持 [无线调试] 开关开启即可");
    console.log("");
    process.exit(1);
  }
}

// 启动主流程，捕获未处理的异常
main().catch((err) => {
  logError(err.message);
  process.exit(1);
});
