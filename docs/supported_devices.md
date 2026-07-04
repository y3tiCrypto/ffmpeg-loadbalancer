# Supported Devices & Compatibility

This document lists the operating systems, hardware platforms, media servers, and software dependencies compatible with the Transcoder Load Balancer.

---

## 1. Supported Operating Systems

| Operating System | Client Node Support | Server Host Support | Display Modes |
| :--- | :---: | :---: | :--- |
| 💻 **Windows** (10, 11, Server 2016+) | Yes | Yes | Headless / Desktop GUI Mode (Tray & Status Overlay) |
| 🐧 **Linux** (Ubuntu, Debian, RHEL, Arch) | Yes | Yes | Headless (Default) / Desktop GUI Mode (via `python3-tk`) |
| 🍏 **macOS** (10.13 High Sierra+) | Yes | No | Headless (Console Mode Only) |

---

## 2. Hardware Acceleration Compatibility

### A. NVIDIA NVENC (Nvidia Graphics Cards)
*   **Supported Architectures**: Kepler, Maxwell, Pascal, Turing, Ampere, Ada Lovelace, Blackwell
*   **Supported Encoders**: `h264_nvenc`, `hevc_nvenc`
*   **Requirements**: Nvidia Proprietary Driver (v450.00+ on Windows and Linux)
*   **Engine Conversions**:
    *   Maps CPU presets (`ultrafast` &rarr; `veryslow`) to NVENC presets (`p1` &rarr; `p7`).
    *   Translates Constant Rate Factor (`-crf`) to target quality variables (`-cq`).
    *   Strips incompatible profiles/levels (e.g. `baseline`) automatically to avoid driver initialization crashes.

### B. AMD AMF (AMD Radeon Graphics Cards)
*   **Supported Architectures**: Radeon HD 7000 Series (GCN 1.0) and later; RX Series (400, 500, Vega, 5000, 6000, 7000, 8000+)
*   **Supported Encoders**: `h264_amf`, `hevc_amf`
*   **Requirements**: Radeon Software Crimson/Adrenalin (Windows), AMDGPU-Pro Proprietary Driver (Linux)
*   **Engine Conversions**:
    *   Maps CPU presets to AMF presets (`speed`, `balanced`, or `quality`).
    *   Translates Constant Rate Factor (`-crf`) to quantization parameters (`-qp`).
    *   Strips incompatible profile/level constraints.

### C. CPU Fallback (Standard Processing)
*   **Supported Architectures**: x86_64, ARM (ARM32/ARM64, including Raspberry Pi 4/5 and Apple Silicon M-series)
*   **Supported Encoders**: `libx264`, `libx265`, `libvpx`
*   **Engine Conversions**: Runs standard native CPU encoders directly without hardware translation filters.

---

## 3. Compatible Media Servers

### A. Serviio Media Server
*   **Compatible Versions**: v2.0 or higher
*   **Control Hook**: Native support via Java JVM setting `-Dffmpeg.location` mapped to the C++ dummy binary.

### B. Jellyfin Media Server
*   **Compatible Versions**: v10.8.0 or higher
*   **Control Hook**: Native configuration via the **Playback &rarr; Transcoding &rarr; FFmpeg path** setting in the dashboard.

---

## 4. Software Dependencies

### Server Host Machine
*   **Runtime Environment**: Node.js **v24.0.0 or higher**
*   **Express Framework**: v4.19.0+
*   **ws** (WebSocket library): v8.17.0+

### Client Node Machines
*   **Runtime Environment**: Python **3.8 or higher**
*   **websocket-client**: v1.0.0+ (Required)
*   **Pillow** (PIL): v9.0.0+ (Optional, required for System Tray/Overlay UI graphics)
*   **pystray**: v0.19.0+ (Optional, required for System Tray rendering)
