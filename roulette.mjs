// run-roulette.mjs
// Joy-Con(R) ルーレット: HID 初期化 → 外部デバイス検出 → 出目取得 → WebSocket で配信（単一ファイル）
// 依存: node-hid / express / ws / winston
//
// 起動: node run-roulette.mjs  → http://localhost:3000
//
// WebSocket 接続先（接続毎に指定可能）:
//   ws://localhost:8080/ws?mode=1|2|3|4&interval=<ms>&fps=<n>
//     - mode:
//         1) 従来: JSON {type:"roulette:number", data:{raw, value, ts, state}} を随時送信（"sensor-update" も併送）
//         2) 停止に遷移した瞬間のみ、数値（1..10）を JSON の data として送信
//         3) 回転中は "⟳<n>"（JSON の data に文字列）、停止に遷移した瞬間は 数値（1..10）
//         4) JSON を使わず生テキスト: 回転中 "rot_<n>"、停止は "<n>"
//     - interval: 送信の最小間隔（ミリ秒）。この間隔より短い連続送信は抑制し、最後の値を遅延送信（トレーリング）
//     - fps: 送信上限 FPS（interval よりも前に指定された場合だけ有効。例: fps=5 → interval=200ms 相当）
//       ※ interval が指定されていれば interval を優先。どちらも未指定なら無制限（サーバ既定）
//
// 環境変数:
//   ROULETTE_STOP_MS       … 停止判定のデボンス時間（既定: 600ms）
//   WS_SEND_MODE           … mode の既定値（1..4、既定: 1）
//   WS_MIN_INTERVAL_MS     … 送信最小間隔の既定値（ms, 既定: 0=無制限）

import HIDLib from "node-hid";
import { EventEmitter } from "events";
import express from "express";
import { createServer } from "http";
import WebSocket, { WebSocketServer } from "ws";
import winston from "winston";
import { setTimeout as sleep } from "timers/promises";

// ========== 定数・ユーティリティ ==========
const VENDOR_ID = 1406; // 0x057e (Nintendo)
const PRODUCT_ID = 8199; // 0x2007 (Joy-Con R)

const DeviceType = { JOYCON_L: 0x01, JOYCON_R: 0x02, PRO_CONTROLLER: 0x03 };
const InputReportMode = {
  STANDARD_FULL: 0x30,
  MCU_NFC_IR: 0x31,
  SIMPLE_HID: 0x3f,
};
const LightPosition = {
  OFF: 0x00,
  ONE: 0x01,
  TWO: 0x02,
  THREE: 0x04,
  FOUR: 0x08,
};
const MCUState = { SUSPEND: 0x00, RESUME: 0x01, RESUME_FOR_UPDATE: 0x02 };
const ExternalDeviceType = { RINGCON: 0x20, ROULETTE: 0x29 };

// 停止判定のデフォルトしきい値（ms）
// const STOP_DEBOUNCE_MS = Number(process.env.ROULETTE_STOP_MS || 800);
const STOP_DEBOUNCE_MS = Number(process.env.ROULETTE_STOP_MS || 400);
// const STOP_DEBOUNCE_MS = Number(process.env.ROULETTE_STOP_MS || 600);

// WS 送信モードの既定（1|2|3|4）
const WS_DEFAULT_MODE = 4;
// const WS_DEFAULT_MODE = Math.min(
//   4,
//   Math.max(1, Number(process.env.WS_SEND_MODE || 1))
// );

// WS 送信最小間隔の既定（ms, 0=無制限）
const WS_DEFAULT_MIN_INTERVAL_MS = 0;
// const WS_DEFAULT_MIN_INTERVAL_MS = 20;
// const WS_DEFAULT_MIN_INTERVAL_MS = Math.max(
//   0,
//   Number(process.env.WS_MIN_INTERVAL_MS || 0)
// );

function toHex2(n) {
  return ("00" + n.toString(16)).slice(-2);
}

// CRC-8 テーブル（subcommand 0x21 用）
const CRC8_TABLE = [];
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let j = 0; j < 8; j++) crc = crc & 0x80 ? (crc << 1) ^ 0x07 : crc << 1;
  CRC8_TABLE[i] = crc & 0xff;
}
function crc8(data) {
  let cc = 0x00;
  for (const b of data) cc = CRC8_TABLE[(cc ^ b) & 0xff];
  return cc & 0xff;
}

// ========== HID ラッパ ==========
function listDevices() {
  if (typeof HIDLib.devices === "function") return HIDLib.devices();
  return HIDLib?.default?.devices?.() ?? [];
}
function openHIDDevice(deviceInfo) {
  const dev = deviceInfo?.path
    ? new HIDLib.HID(deviceInfo.path)
    : new HIDLib.HID(deviceInfo.vendorId, deviceInfo.productId);

  return {
    on: (evt, cb) => dev.on(evt, cb),
    async write(buf) {
      const arr = Array.isArray(buf) ? buf : Array.from(buf);
      return dev.write(arr);
    },
    async close() {
      try {
        dev.close();
      } catch (_) {}
    },
  };
}

// ========== Rumble ==========
const defaultRumble = [0x00, 0x01, 0x40, 0x40];
const nullRumble = [0x00, 0x00, 0x00, 0x00];
const Rumble = {
  fromBuffer(data = defaultRumble) {
    if (data.length !== 4) throw new Error("Invalid rumble data");
    return { data };
  },
  get defaultRumble() {
    return { data: defaultRumble };
  },
  get nullRumble() {
    return { data: nullRumble };
  },
};

// ========== Subcommand Request/Reply ==========
class SubCommandReply {
  constructor(data) {
    this._ack = data.readUInt8(0);
    this._subcmdId = data.readUInt8(1);
    this._data = data.subarray(2);
  }
  get ack() {
    return this._ack;
  }
  get id() {
    return this._subcmdId;
  }
  get data() {
    return this._data;
  }
  static fromBuffer(data) {
    switch (data.readUInt8(1)) {
      case 0x02:
        return new DeviceInfoResponse(data);
      case 0x10:
        return new ReadSPIResponse(data);
      default:
        return new SubCommandReply(data);
    }
  }
}
class RequestBase {
  constructor(id) {
    this._id = id;
    this._data = Buffer.alloc(0);
  }
  get id() {
    return this._id;
  }
  getData() {
    return Buffer.from([this._id, ...this._data]);
  }
  toString() {
    return `${this.constructor.name}(0x${this.id.toString(
      16
    )}): ${this._data.toString("hex")}`;
  }
}
class DeviceInfoRequest extends RequestBase {
  constructor() {
    super(0x02);
  }
}
class SetInputReportModeRequest extends RequestBase {
  constructor(mode) {
    super(0x03);
    this._data = Buffer.from([mode]);
  }
}
class TriggerButtonElapsedTimeRequest extends RequestBase {
  constructor(time) {
    super(0x04);
    this._data = Buffer.from([time]);
  }
}
class Shipment extends RequestBase {
  constructor(status) {
    super(0x08);
    this._data = Buffer.from([status]);
  }
}
class ReadSPI extends RequestBase {
  constructor(address, length) {
    super(0x10);
    this._data = Buffer.alloc(5);
    this._data.writeUint32LE(address);
    this._data.writeUint8(length, 4);
  }
}
class ReadSPIResponse extends SubCommandReply {
  constructor(data) {
    super(data);
  }
  get address() {
    return this._data.readUInt32LE(0);
  }
  get length() {
    return this._data.readUInt8(4);
  }
  get SPIData() {
    return this._data.subarray(5, 5 + this.length);
  }
}
class DeviceInfoResponse extends SubCommandReply {
  constructor(data) {
    super(data);
  }
  get firmwareVersion() {
    return `${this._data.readUInt8(0)}.${this._data.readUInt8(1)}`;
  }
  get type() {
    return this._data.readUInt8(2);
  }
}
class ConfigureMCURequest extends RequestBase {
  constructor(arg1, arg2, arg3) {
    super(0x21);
    const args = Buffer.alloc(36);
    args[0] = arg2;
    args[1] = arg3;
    this._data = Buffer.concat([new Uint8Array([arg1, ...args, crc8(args)])]);
  }
}
class SetMCUStateRequest extends RequestBase {
  constructor(state) {
    super(0x22);
    this._data = Buffer.from([state]);
  }
}
class SetPlayerLightsRequest extends RequestBase {
  constructor(light = LightPosition.OFF, blink = LightPosition.OFF) {
    super(0x30);
    const arg = (blink << 4) | light;
    this._data = Buffer.from([arg]);
  }
}
class EnableIMU6AxisSensorRequest extends RequestBase {
  constructor(status) {
    super(0x40);
    this._data = Buffer.from([status]);
  }
}
class EnableVibrationRequest extends RequestBase {
  constructor(enabled) {
    super(0x48);
    this._data = Buffer.from([enabled ? 0x01 : 0x00]);
  }
}
class UnknownMCUExternalDevice_58 extends RequestBase {
  constructor(a1, a2, a3, a4) {
    super(0x58);
    this._data = Buffer.from([a1, a2, a3, a4]);
  }
}
class GetExternalDeviceInfo extends RequestBase {
  constructor() {
    super(0x59);
  }
}
class EnableExternalDevicePolling extends RequestBase {
  constructor(data) {
    super(0x5a);
    this._data = Buffer.from(data);
  }
}
class DisableExternalDevicePolling extends RequestBase {
  constructor() {
    super(0x5b);
  }
}
class SetExternalDeviceConfig extends RequestBase {
  constructor(data) {
    super(0x5c);
    this._data = Buffer.from(data);
  }
}

// ========== 入力レポート ==========
class InputReportBase {
  constructor(data) {
    this._id = data.readUInt8(0);
    this._data = data;
  }
  get id() {
    return this._id;
  }
  get data() {
    return this._data;
  }
}
class StandardReportBase extends InputReportBase {
  constructor(data) {
    super(data);
    this._timer = data.readUInt8(1);
    this._batteryLevel = (data.readUInt8(2) >> 4) & 0xf;
    this._connectionInfo = data.readUInt8(2) & 0xf;
    this._leftAnalog = data.subarray(6, 9);
    this._rightAnalog = data.subarray(9, 12);
  }
  get connectionInfo() {
    return this._connectionInfo;
  }
  get leftAnalog() {
    return this._leftAnalog;
  }
  get rightAnalog() {
    return this._rightAnalog;
  }
}
class StandardReport extends StandardReportBase {
  constructor(data) {
    super(data);
    this._subCommandReply = SubCommandReply.fromBuffer(data.subarray(13, 50));
  }
  get subCommandReply() {
    return this._subCommandReply;
  }
}
class StandardFullReport extends StandardReportBase {
  constructor(data) {
    super(data);
    this._sixAxisData = [];
    for (let i = 0; i < 3; i++) {
      const o = 13 + i * 12;
      this._sixAxisData.push({
        xAxis: data.readInt16LE(o),
        yAxis: data.readInt16LE(o + 2),
        zAxis: data.readInt16LE(o + 4),
        gyro1: data.readInt16LE(o + 6),
        gyro2: data.readInt16LE(o + 8),
        gyro3: data.readInt16LE(o + 10),
      });
    }
  }
  get sixAxisData() {
    return this._sixAxisData;
  }
}
class MCUReport extends StandardFullReport {
  constructor(data) {
    super(data);
    this._mcuData = data.subarray(49);
  }
  get mcuData() {
    return this._mcuData;
  }
}

// ========== 回転/停止 判定ロジック ==========
class SpinStateDetector {
  constructor({ stillMs = STOP_DEBOUNCE_MS } = {}) {
    this.stillMs = stillMs;
    this.prevRaw = null;
    this.lastChangeTs = 0;
    this.state = "unknown"; // "spinning" | "stopped" | "unknown"
    this.lastStoppedValue = null;
  }
  /**
   * @param {number} raw 現在の生値（1..10）
   * @param {number} stable 多数決などで安定化した値（1..10）
   * @param {number} ts ミリ秒のタイムスタンプ
   * @returns {{state: "spinning"|"stopped", justStopped: boolean}}
   */
  update(raw, stable, ts) {
    let justStopped = false;

    if (this.prevRaw === null) {
      this.prevRaw = raw;
      this.lastChangeTs = ts;
      this.state = "spinning";
      return { state: this.state, justStopped };
    }

    if (raw !== this.prevRaw) {
      // 値が変わった → 回転中
      this.prevRaw = raw;
      this.lastChangeTs = ts;
      if (this.state !== "spinning") this.state = "spinning";
      return { state: this.state, justStopped };
    }

    // 値が変わっていない場合、一定時間継続で「停止」
    if (ts - this.lastChangeTs >= this.stillMs) {
      if (this.state !== "stopped") {
        this.state = "stopped";
        if (this.lastStoppedValue !== stable) {
          this.lastStoppedValue = stable;
          justStopped = true; // 停止に遷移した瞬間のみ true
        }
      }
    } else {
      if (this.state !== "spinning") this.state = "spinning";
    }

    return { state: this.state, justStopped };
  }
}

// ========== 外部デバイス抽象とルーレット ==========
class ExternalDevice extends EventEmitter {
  constructor(joycon) {
    super();
    this.joycon = joycon;
  }
  async initialize() {
    return this.initializeImpl();
  }
  async initializeImpl() {
    throw new Error("Not implemented");
  }
  async sendRumbleOnConnected() {
    const j = this.joycon;
    j.sendRumbleSingle(Rumble.fromBuffer([0x80, 0x78, 0x60, 0x80]));
    j.sendRumbleSingle(Rumble.fromBuffer([0x00, 0x01, 0x3f, 0x72]));
    j.sendRumbleSingle(Rumble.fromBuffer([0x00, 0x01, 0x52, 0x72]));
    j.sendRumbleSingle(Rumble.fromBuffer([0x72, 0x98, 0x61, 0xb2]));
    j.sendRumbleSingle(Rumble.fromBuffer([0x92, 0xf8, 0x63, 0xae]));
    j.sendRumbleSingle(Rumble.fromBuffer([0x00, 0x01, 0x49, 0x6a]));
    j.sendRumbleSingle(Rumble.fromBuffer([0x8e, 0xb8, 0x60, 0xab]));
    j.sendRumbleSingle(Rumble.fromBuffer([0x6c, 0x18, 0x62, 0xb2]));
    j.sendRumbleSingle(Rumble.fromBuffer([0x8e, 0xd8, 0xe0, 0x8a]));
    j.sendRumbleSingle(Rumble.fromBuffer([0x90, 0x18, 0x61, 0x91]));
    j.sendRumbleSingle(Rumble.fromBuffer([0x00, 0x01, 0xc4, 0x46]));
    j.sendRumbleSingle(Rumble.fromBuffer([0x90, 0x78, 0x61, 0x87]));
    j.sendRumbleSingle(Rumble.fromBuffer([0x8c, 0x18, 0x62, 0x81]));
    j.sendRumbleSingle(Rumble.defaultRumble);
  }
  dispose() {}
}

class RouletteDevice extends ExternalDevice {
  constructor(joycon) {
    super(joycon);
    this.deviceConnected = false;
    this.currentNumber = 0;
    this.previousNumbers = [];
    this.currentCallback = null;

    this.spin = new SpinStateDetector();
  }
  static get deviceName() {
    return "Roulette";
  }
  static get deviceId() {
    return ExternalDeviceType.ROULETTE;
  }
  get number() {
    return this.currentNumber;
  }

  async initializeImpl() {
    await this.joycon.sendSubcommandAndWaitAsync(
      new EnableIMU6AxisSensorRequest(3)
    );
    await this.joycon.sendSubcommandAndWaitAsync(
      new SetExternalDeviceConfig(
        new Uint8Array([
          0x06, 0x03, 0x25, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          0x00, 0x00, 0x00, 0x00, 0x00,
        ])
      )
    );
    await this.joycon.sendSubcommandAndWaitAsync(
      new EnableExternalDevicePolling(new Uint8Array([0x01, 0x02, 0x03, 0x04]))
    );

    this.currentCallback = this.onStandardFullReport.bind(this);
    this.joycon.onStandardFullReport(this.currentCallback);

    this.deviceConnected = true;
    this.sendRumbleOnConnected();
    return true;
  }

  async onStandardFullReport(data) {
    if (!this.deviceConnected) return;

    const index = data.leftAnalog[1] + (data.leftAnalog[2] << 8);
    const broken = ((data.sixAxisData[2].xAxis >> 8) & 0x01) === 1;
    let number;

    for (let i = 0; i < 10; i++) {
      if (index >> i === 1) number = i + 1; // 元実装のロジックを踏襲
    }
    if (number === undefined || broken) return;

    // 直近履歴の多数決で安定値（stable）を算出
    const counts = {};
    this.previousNumbers.forEach(
      (n) => (counts[n] = counts[n] ? counts[n] + 1 : 1)
    );
    const stableKey = Object.keys(counts).sort(
      (a, b) => (counts[b] ?? 0) - (counts[a] ?? 0)
    )[0];
    const stableNumber = Number(stableKey ?? number);

    this.currentNumber = stableNumber;

    const ts = Date.now();
    const spinInfo = this.spin.update(number, stableNumber, ts);

    this.emit("rouletteNumber", {
      raw: number,
      stable: stableNumber,
      ts,
      state: spinInfo.state, // "spinning" | "stopped"
      justStopped: !!spinInfo.justStopped,
    });

    // 履歴更新（多数決用）
    this.previousNumbers.push(number);
    if (this.previousNumbers.length > 9) this.previousNumbers.shift();
  }

  dispose() {
    if (this.currentCallback)
      this.joycon.removeListenerForStandardFullReport(this.currentCallback);
  }
}

// ========== Joy-Con 実装 ==========
const EXT_DEVICE_CONNECTED = "ext_device_connected";
const EXT_DEVICE_DISCONNECTED = "ext_device_disconnected";

class Packet {
  constructor(id, data) {
    this.id = id;
    this.data = data;
  }
}

class Joycon extends EventEmitter {
  constructor({ logger } = {}) {
    super();
    this.device = null;
    this.packetNumber = 0;
    this.previousState = null;
    this.initialized = false;

    this._serialNumber = "";
    this._deviceType = null;
    this._firmwareVersion = "";
    this._logger =
      logger ||
      winston.createLogger({
        level: "fatal",
        format: winston.format.simple(),
        transports: [],
      });

    this.packetQueue = [];
    this.isProcessingQueue = false;
    this.rumbleQueue = [];
    this.inSync = false;
  }

  static async findDevices() {
    const devices = listDevices();
    return devices.filter(
      (d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID
    );
  }

  get logger() {
    return this._logger;
  }

  async openDevice(deviceInfo) {
    if (this.device) return false;
    try {
      this.device = openHIDDevice(deviceInfo);
      this.device.on("data", this.dataReceived.bind(this));
      this.device.on("error", this.onError.bind(this));
      await this.initializeDevice();
    } catch (err) {
      this.logger.error("Error opening device", err);
      return false;
    }
    return true;
  }

  async initializeDevice() {
    await this.sendSubcommandAndWaitAsync(new Shipment(0));
    const di = await this.sendSubcommandAndWaitAsync(new DeviceInfoRequest());
    this._firmwareVersion = di.firmwareVersion;
    this._deviceType = di.type;

    await this.readSPIData();

    await this.sendSubcommandAndWaitAsync(
      new SetInputReportModeRequest(InputReportMode.STANDARD_FULL)
    );
    await this.sendSubcommandAndWaitAsync(
      new TriggerButtonElapsedTimeRequest(0)
    );
    await this.sendSubcommandAndWaitAsync(new EnableIMU6AxisSensorRequest(2));
    await this.sendSubcommandAndWaitAsync(new EnableVibrationRequest(true));
    await this.sendSubcommandAndWaitAsync(
      new SetMCUStateRequest(MCUState.RESUME)
    );
    await this.sendSubcommandAndWaitAsync(
      new SetPlayerLightsRequest(LightPosition.ONE)
    );
    await this.sendSubcommandAndWaitAsync(new ConfigureMCURequest(0x21, 0, 0));
    await this.sendSubcommandAndWaitAsync(
      new SetMCUStateRequest(MCUState.SUSPEND)
    );

    this.initialized = true;
  }

  async readSPIData() {
    const serialNumber = await this.sendSubcommandAndWaitAsync(
      new ReadSPI(0x6000, 0x10)
    );
    if (serialNumber.data[0] > 0x80) this._serialNumber = "";
    else this._serialNumber = serialNumber.SPIData.toString("ascii");
    this.logger.info(`Serial number: ${this._serialNumber}`);

    await this.sendSubcommandAndWaitAsync(new ReadSPI(0x6050, 0x0d));
    await this.sendSubcommandAndWaitAsync(new ReadSPI(0x6080, 0x18));
    await this.sendSubcommandAndWaitAsync(new ReadSPI(0x8010, 0x18));
    await this.sendSubcommandAndWaitAsync(new ReadSPI(0x603d, 0x19));
    await this.sendSubcommandAndWaitAsync(new ReadSPI(0x6020, 0x18));
  }

  async close() {
    this.emit("disconnected");
    try {
      if (this.device) await this.device.close();
    } finally {
      this.device = null;
    }
  }

  dataReceived(data) {
    const type = data.readUInt8(0);
    switch (type) {
      case 0x21:
        this.processStandard(new StandardReport(data));
        return;
      case 0x30:
        this.processStandardFull(new StandardFullReport(data));
        return;
      case 0x31:
        this.processMCU(new MCUReport(data));
        return;
      case 0x3f:
        this.inSync = false;
        return;
      case 0x63:
        this.logger.warn("Maybe reconnect request?", type, data);
        return;
      default:
        this.logger.warn("Not implemented: ", type, data);
    }
  }

  async findExternalDevice() {
    this.logger.verbose("finding external device");
    try {
      await this.sendSubcommandAndWaitAsync(
        new SetMCUStateRequest(MCUState.RESUME)
      );
      let result;
      for (let i = 0; i < 100; i++) {
        result = await this.sendSubcommandAndWaitAsync(
          new ConfigureMCURequest(0x21, 0, 3)
        );
        if (result.data[0] === 0xff && result.data[1] === 0xff) return false; // 未接続？
        if (
          result.data[0] === 0x01 &&
          result.data[1] === 0x32 &&
          result.data[7] === 0x03
        )
          break; // ready
      }
      await this.sendSubcommandAndWaitAsync(
        new ConfigureMCURequest(0x21, 1, 1)
      );

      for (let i = 0; i < 100; i++) {
        if ((this.previousState?.connectionInfo & 0x01) === 0x01) break;
        await sleep(100);
      }

      const info = await this.sendSubcommandAndWaitAsync(
        new GetExternalDeviceInfo()
      );
      if (info.data[0] === 0) {
        const deviceType = info.data[1];
        this.emit(EXT_DEVICE_CONNECTED, deviceType);
      } else {
        this.logger.error(
          "Failed to initialize external device:",
          info.data[0]
        );
        return false;
      }
    } catch (e) {
      this.logger.error("Error initializing external device", e);
      return false;
    }
    return true;
  }

  setPreviousReport(report) {
    if (!this.initialized) return;

    const extDeviceInitialized = (report.connectionInfo & 0x01) === 0x01;
    const extDevicePreviouslyInitialized =
      (this.previousState?.connectionInfo & 0x01) === 0x01;
    const previousDeviceType = this.previousState?.connectionInfo & 0x6;
    const deviceType = report.connectionInfo & 0x6;
    const noDevice = (report.connectionInfo & 0x6) === 0x6;
    const previouslyNoDevice =
      (this.previousState?.connectionInfo & 0x6) === 0x6;
    const maybeJoycon = report.connectionInfo & 0x8;
    const firstTime = this.previousState === null;

    const stateChanged =
      this.previousState &&
      this.previousState.connectionInfo !== report.connectionInfo;

    let detected = false;
    let removed = false;

    if (stateChanged)
      this.logger.debug(
        `connectionInfo: ${this.previousState.connectionInfo} -> ${report.connectionInfo}`
      );

    if (!maybeJoycon) {
      // do nothing
    } else if (firstTime) {
      if (!noDevice) detected = true;
    } else if (stateChanged) {
      if (maybeJoycon) {
        if (previouslyNoDevice && !noDevice && !extDeviceInitialized)
          detected = true;
        else if (
          (!extDeviceInitialized &&
            extDevicePreviouslyInitialized &&
            previousDeviceType !== deviceType) ||
          (!extDeviceInitialized && !extDevicePreviouslyInitialized && noDevice)
        )
          removed = true;
        else if (
          !noDevice &&
          !extDeviceInitialized &&
          previousDeviceType !== deviceType
        )
          detected = true;
      }
    }

    try {
      if (detected) {
        this.logger.verbose("Device connection detected");
        this.logger.info("External device detected. Initializing...");
        this.findExternalDevice();
      } else if (removed) {
        this.logger.verbose("Device disconnected");
        this.disposeExternalDevice();
        this.emit(EXT_DEVICE_DISCONNECTED);
      }
    } catch (err) {
      this.logger.error("Error processing previous state", err);
    } finally {
      this.previousState = report;
    }
  }

  processStandardBase(info) {
    this.setPreviousReport(info);
    this.processQueue();
  }
  processStandard(info) {
    this.emit("standard", info);
    this.emit(
      this.subcommandKey(info.subCommandReply.id),
      info.subCommandReply
    );
    this.processStandardBase(info);
  }
  processMCU(info) {
    this.inSync = true;
    this.emit("mcu", info);
    this.processStandardFull(info);
  }
  processStandardFull(info) {
    this.inSync = true;
    this.emit("standardFull", info);
    this.processStandardBase(info);
  }

  subcommandKey(id) {
    return `subcommand_${toHex2(id)}`;
  }

  async disposeExternalDevice() {
    await this.sendSubcommandAndWaitAsync(new DisableExternalDevicePolling());
    await this.sendSubcommandAndWaitAsync(new EnableIMU6AxisSensorRequest(2));
    await this.sendSubcommandAndWaitAsync(
      new SetExternalDeviceConfig(Buffer.from([]))
    );
    await this.sendSubcommandAndWaitAsync(new ConfigureMCURequest(0x21, 1, 0));
    await this.sendSubcommandAndWaitAsync(
      new SetMCUStateRequest(MCUState.SUSPEND)
    );
  }

  onExternalDeviceConnected(cb) {
    this.on(EXT_DEVICE_CONNECTED, cb);
  }
  onExternalDeviceDisconnected(cb) {
    this.on(EXT_DEVICE_DISCONNECTED, cb);
  }
  onDisconnected(cb) {
    this.on("disconnected", cb);
  }
  onStandardFullReport(cb) {
    this.on("standardFull", cb);
  }
  removeListenerForStandardFullReport(cb) {
    this.removeListener("standardFull", cb);
  }

  async processQueue() {
    if (this.isProcessingQueue) return;

    const hasRumble = this.rumbleQueue.length > 0;
    const rumbleData = hasRumble
      ? this.rumbleQueue.shift()
      : this.generateRumbleData();

    if (this.packetQueue.length === 0) {
      if (hasRumble) await this.sendRumbleImmediatelyAsync(rumbleData);
      return;
    }

    this.isProcessingQueue = true;
    const data = this.packetQueue.shift();
    if (data) {
      const rawData = Buffer.from([
        data.id,
        this.getNextPacketNumber(),
        ...rumbleData,
        ...data.data,
      ]);
      await this.sendDataInternal(rawData);
    }
  }

  async sendSubcommandAndWaitAsync(subcommand) {
    this.logger.debug(`Sending subcommand ${subcommand}`);
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListenerForSubcommandReply(
          subcommand.id,
          subcommandCallback
        );
        reject(
          new Error(`Timeout: No response to subcommand ${subcommand.id}`)
        );
        this.isProcessingQueue = false;
        this.processQueue();
      }, 5000);

      const subcommandCallback = (data) => {
        clearTimeout(timer);
        this.logger.debug(
          `Received subcommand 0x${data.id.toString(
            16
          )} reply: ${data.data.toString("hex")}`
        );
        resolve(data);
        this.isProcessingQueue = false;
        this.processQueue();
      };

      this.listenOnceForSubcommandReply(subcommand.id, subcommandCallback);
    });

    await this.sendSubcommandAsync(subcommand);
    return promise;
  }

  generateRumbleData(rumble = Rumble.defaultRumble) {
    switch (this._deviceType) {
      case DeviceType.JOYCON_L:
        return [...rumble.data, ...Rumble.nullRumble.data];
      case DeviceType.JOYCON_R:
        return [...Rumble.nullRumble.data, ...rumble.data];
      case DeviceType.PRO_CONTROLLER:
        return [...rumble.data, ...rumble.data];
      default:
        return [...Rumble.nullRumble.data, ...Rumble.nullRumble.data];
    }
  }

  async sendSubcommandAsync(subcommand) {
    return this.sendOutputReportAsync(0x01, [...subcommand.getData()]);
  }
  sendRumbleSingle(rumble) {
    if (!this.inSync) return;
    this.rumbleQueue.push(this.generateRumbleData(rumble));
  }
  async sendRumbleImmediatelyAsync(rumble = this.generateRumbleData()) {
    const rawData = Buffer.from([0x10, this.getNextPacketNumber(), ...rumble]);
    await this.sendDataInternal(rawData);
  }

  async sendOutputReportAsync(id, data) {
    if (!this.device) return;
    if (!this.inSync) {
      const rawData = Buffer.from([
        id,
        this.getNextPacketNumber(),
        ...this.generateRumbleData(),
        ...data,
      ]);
      this.logger.debug(`Sending output report immediately`);
      await this.sendDataInternal(rawData);
      return;
    }
    this.packetQueue.push(new Packet(id, Buffer.from(data)));
  }

  async sendDataInternal(data) {
    if (!this.device) return;
    this.logger.debug(`Sending output report: ${data.toString("hex")}`);
    return await this.device.write(data);
  }

  getNextPacketNumber() {
    return this.packetNumber++ & 0xf;
  }
  listenOnceForSubcommandReply(id, cb) {
    this.once(this.subcommandKey(id), cb);
  }
  removeListenerForSubcommandReply(id, cb) {
    this.removeListener(this.subcommandKey(id), cb);
  }
  onError(err) {
    this.logger.error("Error received from device:", err);
    this.close();
  }
}

// ========== Web サーバ & WebSocket ==========
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple()
  ),
  transports: [new winston.transports.Console()],
});

const joycon = new Joycon({ logger });
let rouletteDevice = null;

// 最新値のキャッシュ（接続直後の初期送信に利用）
let latestRaw = null; // 直近の raw 値
let latestStable = null; // 直近の stable 値
let latestStopped = null; // 最後に「停止」確定した stable 値
let currentSpinState = "unknown"; // "spinning" | "stopped" | "unknown"

const app = express();
const server = createServer(app);

// 単一ファイル運用のため HTML をインライン提供
app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8" />
<title>Roulette</title><meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans JP",sans-serif;margin:0;padding:24px}
  #v{font-size:120px;text-align:center;margin:24px 0}
  .row{margin:8px 0}
  code{background:#f3f3f3;padding:2px 6px;border-radius:4px}
</style>
</head><body>
<h1>Roulette</h1>
<div class="row">接続先: <code>ws(s)://{host}/ws?mode=&lt;1|2|3|4&gt;&interval=&lt;ms&gt;&fps=&lt;n&gt;</code>（このページのクエリを転用）</div>
<div class="row">今のモード: <strong id="mode">–</strong>（1:従来 / 2:停止時のみ数字 / 3:回転中「⟳数字」停止時は数字 / 4:回転中「rot_数字」停止時は「数字」（生テキスト））</div>
<div class="row">送信間隔: <strong id="interval">–</strong> / およそFPS: <strong id="fps">–</strong></div>
<div id="v">–</div>
<div class="row">raw: <span id="raw">–</span></div>
<div class="row">stable: <span id="stable">–</span></div>
<div class="row">state: <span id="state">–</span></div>
<div class="row" id="st">WS: connecting…</div>
<script>
  const params = new URLSearchParams(location.search);
  const mode = Number(params.get("mode")||"${WS_DEFAULT_MODE}");
  const intervalParam = params.get("interval");
  const fpsParam = params.get("fps");
  const interval = intervalParam != null ? Math.max(0, Number(intervalParam)) :
                   (fpsParam != null ? Math.floor(1000/Math.max(0.0001, Number(fpsParam))) : ${WS_DEFAULT_MIN_INTERVAL_MS});
  const fps = interval > 0 ? Math.round(1000 / interval) : Infinity;

  document.getElementById('mode').textContent = String(mode);
  document.getElementById('interval').textContent = interval > 0 ? (interval + " ms") : "無制限";
  document.getElementById('fps').textContent = isFinite(fps) ? (fps + " fps") : "無制限";

  const WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws?mode=" + mode + "&interval=" + interval;
  const s = new WebSocket(WS_URL);

  const v = document.getElementById('v');
  const raw = document.getElementById('raw');
  const st  = document.getElementById('stable');
  const S   = document.getElementById('st');
  const STATE = document.getElementById('state');

  s.addEventListener('open',    () => { S.textContent = 'WS: connected'; });
  s.addEventListener('close',   () => { S.textContent = 'WS: disconnected'; });
  s.addEventListener('error',   () => { S.textContent = 'WS: error'; });

  s.addEventListener('message', (ev) => {
    let parsed = null;
    try { parsed = JSON.parse(ev.data); } catch (_e) {}
    // JSON {type, data} パス
    if (parsed && typeof parsed === 'object' && parsed.type) {
      const msg = parsed;
      if (msg.type === 'roulette:number') {
        const d = msg.data;
        if (typeof d === 'object' && d && ('value' in d || 'raw' in d)) {
          // mode=1
          v.textContent = d.value ?? '–';
          raw.textContent = d.raw ?? '–';
          st.textContent = d.value ?? '–';
          STATE.textContent = d.state ?? '–';
        } else if (typeof d === 'number') {
          // mode=2 または mode=3(停止時)
          v.textContent = d;
          raw.textContent = '–';
          st.textContent = d;
          STATE.textContent = 'stopped';
        } else if (typeof d === 'string') {
          // mode=3 回転中 "⟳<n>"
          v.textContent = d;
          const m = d.match(/\\d+/);
          raw.textContent = m ? m[0] : '–';
          st.textContent = '–';
          STATE.textContent = 'spinning';
        }
      } else if (msg.type === 'sensor-update') {
        const value = (msg.data ?? msg.value);
        if (typeof value !== 'undefined') st.textContent = value;
      }
      return;
    }

    // 生テキスト（mode=4）パス
    const t = (typeof parsed === 'number') ? String(parsed) : String(ev.data);
    if (/^rot_\\d+$/.test(t)) {
      // 回転中 "rot_<n>"
      v.textContent = t;
      const m = t.match(/\\d+/);
      raw.textContent = m ? m[0] : '–';
      st.textContent = '–';
      STATE.textContent = 'spinning';
    } else if (/^\\d+$/.test(t)) {
      // 停止 "<n>"
      v.textContent = t;
      raw.textContent = '–';
      st.textContent = t;
      STATE.textContent = 'stopped';
    } else {
      console.warn('Unknown message:', ev.data);
    }
  });
</script>
</body></html>`);
});

// --- WebSocket サーバ（ws）---
const wss = new WebSocketServer({ server, path: "/ws" });

// ---- 送信ユーティリティ（頻度制御対応） ----
function sendJSON(ws, type, data) {
  try {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type, data }));
  } catch (e) {
    logger.warn("WS send JSON failed", e);
  }
}
function sendText(ws, text) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(String(text));
  } catch (e) {
    logger.warn("WS send text failed", e);
  }
}

/**
 * prepared:
 *  - { type, data, immediate? }  // JSON 送信
 *  - { text, immediate? }        // テキスト送信
 */
function actualSend(ws, prepared) {
  if ("text" in prepared) sendText(ws, prepared.text);
  else sendJSON(ws, prepared.type, prepared.data);
}

/**
 * 送信頻度制限付きの送信
 * - immediate=true の場合は頻度制限を無視して即送信（停止確定など重要イベント）
 * - immediate=false の場合は ws.minIntervalMs を下回る頻度を抑制し、最後のメッセージを遅延送信（トレーリング）
 */
function scheduleSend(ws, prepared, immediate = false) {
  if (immediate || ws.minIntervalMs <= 0) {
    actualSend(ws, prepared);
    ws.lastSentAt = Date.now();
    return;
  }
  const now = Date.now();
  const delta = now - (ws.lastSentAt ?? 0);

  if (delta >= ws.minIntervalMs && !ws.flushTimer) {
    actualSend(ws, prepared);
    ws.lastSentAt = now;
    return;
  }

  // 遅延送信用に最後のメッセージを保持
  ws.pendingMsg = prepared;
  if (!ws.flushTimer) {
    const wait = Math.max(0, ws.minIntervalMs - delta);
    ws.flushTimer = setTimeout(() => {
      ws.flushTimer = null;
      if (ws.readyState !== WebSocket.OPEN) {
        ws.pendingMsg = null;
        return;
      }
      if (ws.pendingMsg) {
        actualSend(ws, ws.pendingMsg);
        ws.pendingMsg = null;
        ws.lastSentAt = Date.now();
      }
    }, wait);
  }
}

/**
 * 各クライアントに対してメッセージ仕様を生成し、頻度制限を考慮して送信。
 * formatter(ws) は以下を返す:
 *  - { type, data, immediate? }  // JSON
 *  - { text, immediate? }        // テキスト
 *  - null                        // 送らない
 */
function broadcastPerClient(formatter) {
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const spec = formatter(client);
    if (!spec) continue;
    scheduleSend(client, spec, !!spec.immediate);
  }
}

// 接続管理（ヘルスチェック）
function heartbeat() {
  this.isAlive = true;
}
const pingInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try {
        ws.terminate();
      } catch (_) {}
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (_) {}
  }
}, 30000);
wss.on("close", () => clearInterval(pingInterval));

server.listen(8080, () =>
  logger.info("Server is running on http://localhost:8080")
);

function parseModeFromReq(req) {
  try {
    const url = new URL(req.url, "http://localhost");
    const m = Number(url.searchParams.get("mode") || WS_DEFAULT_MODE);
    if ([1, 2, 3, 4].includes(m)) return m;
  } catch (_) {}
  return WS_DEFAULT_MODE;
}
function parseRateFromReq(req) {
  let minInterval = WS_DEFAULT_MIN_INTERVAL_MS;
  try {
    const url = new URL(req.url, "http://localhost");
    const fpsParam = url.searchParams.get("fps");
    const intervalParam = url.searchParams.get("interval");
    if (fpsParam != null) {
      const fps = Number(fpsParam);
      if (Number.isFinite(fps) && fps > 0) minInterval = Math.floor(1000 / fps);
    }
    if (intervalParam != null) {
      const ms = Number(intervalParam);
      if (Number.isFinite(ms) && ms >= 0) minInterval = ms;
    }
  } catch (_) {}
  // 上限・下限クランプ（0=無制限、最大60秒）
  return Math.max(0, Math.min(60000, minInterval));
}

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  ws.sendMode = parseModeFromReq(req);
  ws.minIntervalMs = parseRateFromReq(req); // ★ クライアント毎の送信最小間隔（ms）
  ws.lastSentAt = 0;
  ws.pendingMsg = null;
  ws.flushTimer = null;

  ws.on("close", () => {
    if (ws.flushTimer) {
      clearTimeout(ws.flushTimer);
      ws.flushTimer = null;
    }
    ws.pendingMsg = null;
  });

  logger.info(
    `WS connected: ${req?.socket?.remoteAddress ?? "unknown"} mode=${
      ws.sendMode
    } interval=${ws.minIntervalMs}ms`
  );

  // 初期送信（頻度制限は無視して即時）
  if (ws.sendMode === 1) {
    if (latestStable != null) {
      sendJSON(ws, "roulette:number", {
        raw: latestRaw ?? latestStable,
        value: latestStable,
        ts: Date.now(),
        state: currentSpinState,
      });
      sendJSON(ws, "sensor-update", latestStable); // 互換
    }
  } else if (ws.sendMode === 2) {
    if (latestStopped != null) sendJSON(ws, "roulette:number", latestStopped);
  } else if (ws.sendMode === 3) {
    if (currentSpinState === "spinning" && latestRaw != null) {
      sendJSON(ws, "roulette:number", `⟳${latestRaw}`);
    } else if (latestStopped != null) {
      sendJSON(ws, "roulette:number", latestStopped);
    }
  } else if (ws.sendMode === 4) {
    if (currentSpinState === "spinning" && latestRaw != null) {
      sendText(ws, `rot_${latestRaw}`);
    } else if (latestStopped != null) {
      sendText(ws, String(latestStopped));
    }
  }
});

// ルーレット接続時のセットアップ
joycon.onExternalDeviceConnected(async (deviceType) => {
  if (deviceType !== ExternalDeviceType.ROULETTE) return;
  logger.info("Roulette connected");
  rouletteDevice = new RouletteDevice(joycon);
  try {
    await rouletteDevice.initialize();
  } catch (e) {
    logger.error("Failed to initialize roulette device", e);
    return;
  }

  rouletteDevice.on("rouletteNumber", (payload) => {
    // payload: { raw, stable, ts, state, justStopped }
    latestRaw = payload.raw;
    latestStable = payload.stable;
    currentSpinState = payload.state;
    if (payload.justStopped) latestStopped = payload.stable;

    // クライアント毎のモードに応じて送信内容を切替（頻度制限あり）
    broadcastPerClient((ws) => {
      switch (ws.sendMode) {
        case 1:
          return {
            type: "roulette:number",
            data: {
              raw: payload.raw,
              value: payload.stable,
              ts: payload.ts,
              state: payload.state,
            },
            // 停止確定は即時、それ以外は頻度制限
            immediate: !!payload.justStopped,
          };
        case 2:
          if (payload.justStopped) {
            return {
              type: "roulette:number",
              data: payload.stable,
              immediate: true,
            };
          }
          return null; // 停止時以外は送らない
        case 3:
          if (payload.state === "spinning") {
            return { type: "roulette:number", data: `⟳${payload.raw}` }; // 制限対象
          }
          if (payload.justStopped) {
            return {
              type: "roulette:number",
              data: payload.stable,
              immediate: true,
            };
          }
          return null;
        case 4:
          if (payload.state === "spinning") {
            return { text: `rot_${payload.raw}` }; // 制限対象
          }
          if (payload.justStopped) {
            return { text: String(payload.stable), immediate: true };
          }
          return null;
        default:
          return {
            type: "roulette:number",
            data: {
              raw: payload.raw,
              value: payload.stable,
              ts: payload.ts,
              state: payload.state,
            },
            immediate: !!payload.justStopped,
          };
      }
    });

    // 互換イベントは mode=1 のクライアントにのみ配信（頻度制限対象）
    broadcastPerClient((ws) => {
      if (ws.sendMode !== 1) return null;
      return { type: "sensor-update", data: payload.stable };
    });

    logger.debug(
      `Broadcast: raw=${payload.raw}, stable=${payload.stable}, state=${payload.state}, justStopped=${payload.justStopped}`
    );
  });
});

joycon.onExternalDeviceDisconnected(() => {
  logger.info("External device disconnected");
  if (rouletteDevice) {
    rouletteDevice.dispose();
    rouletteDevice = null;
  }
});
joycon.onDisconnected(() => logger.warn("JoyCon disconnected"));

// Joy-Con 検出ループ
(async () => {
  while (true) {
    logger.info("Finding JoyCon-R…");
    const devices = await Joycon.findDevices();
    if (devices.length === 0) {
      await sleep(1000);
      continue;
    }
    const opened = await joycon.openDevice(devices[0]);
    if (opened) break;
    logger.error("Couldn't open device. Retry...");
    await joycon.close();
    await sleep(1000);
  }
})();

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", err);
  joycon.close();
});
process.on("exit", () => {
  joycon.close();
});
