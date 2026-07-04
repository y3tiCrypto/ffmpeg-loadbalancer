# Supported Devices & Compatibility List

This document lists the operating systems, hardware platforms, media servers, and software dependencies compatible with the Transcoder Load Balancer.

---

## 1. Supported Operating Systems

### A. Windows (Host & Client Nodes)
*   **Versions**: Windows 10, Windows 11, Windows Server 2016 / 2019 / 2022
*   **Runtimes**: Python 3.8+ (x86_64), Node.js v24+ (for Server Host)
*   **GUI Mode**: Supported (displays system tray icon and status overlay widget in the bottom-right corner)
*   **Headless Mode**: Supported

### B. Linux (Host & Client Nodes)
*   **Distributions**: Ubuntu (18.04+), Debian (10+), CentOS/RHEL/Rocky Linux (8+), Fedora, Arch Linux
*   **GUI Mode**: Supported (requires desktop environment + Tkinter `python3-tk` package)
*   **Headless Mode**: Supported (CLI-only mode automatically runs when X11/Wayland display server is not detected; GUI libraries like `pillow` and `pystray` are completely optional and not required to run)

### C. macOS (Client Nodes Only)
*   **Versions**: macOS 10.13 (High Sierra) and later
*   **Headless Mode**: Supported (automatically runs in headless console mode)

---

## 2. Supported Hardware Acceleration APIs & Encoders

### A. NVIDIA NVENC (Nvidia Graphics Cards)
*   **Architectures**: Kepler, Maxwell, Pascal, Turing, Ampere, Ada Lovelace, Blackwell
*   **Supported Encoders**: `h264_nvenc`, `hevc_nvenc`
*   **Driver Requirement**: NVIDIA Proprietary Graphics Driver (v450+ on Windows/Linux)
*   **Translation Mapping**:
    *   Automatic CPU preset remapping (`ultrafast` to `veryslow` maps to NVENC `p1` to `p7`).
    *   Automatic CRF parameter translation (`-crf` maps to `-cq`).
    *   Automatic profile/level stripping to avoid encoder initialization failures.

### B. AMD AMF (AMD Radeon Graphics Cards)
*   **Architectures**: Radeon HD 7000 Series (GCN 1st Gen) and later; RX Series (400, 500, Vega, 5000, 6000, 7000, 8000+)
*   **Supported Encoders**: `h264_amf`, `hevc_amf`
*   **Driver Requirement**: Radeon Software Crimson/Adrenalin (Windows), AMDGPU-Pro Proprietary Driver (Linux)
*   **Translation Mapping**:
    *   Automatic CPU preset remapping maps to AMF `speed`, `balanced`, or `quality`.
    *   Automatic CRF parameter translation (`-crf` maps to `-qp`).
    *   Automatic profile/level stripping.

### C. CPU Fallback (All CPUs)
*   **Architectures**: x86, x86_64, ARM (ARM32/ARM64, e.g. Raspberry Pi 4/5, Apple Silicon M-series)
*   **Supported Encoders**: `libx264`, `libx265`, `libvpx`
*   **Translation Mapping**: Executes the standard command line arguments natively without hardware overrides.

---

## 3. Supported Media Server Software

### A. Serviio Media Server
*   **Compatible Versions**: Serviio v2.0 and later
*   **Configuration**: Replaces the lib executable via JVM argument `-Dffmpeg.location`.

### B. Jellyfin Media Server
*   **Compatible Versions**: Jellyfin v10.8.0 and later
*   **Configuration**: Point the **FFmpeg path** setting in the dashboard directly to the load balancer wrapper binary.

---

## 4. Software Runtimes & Dependencies

### Server Host Machine
*   **Node.js**: v24.0.0 or higher
*   **Express**: v4.19.0+
*   **ws** (WebSocket library): v8.17.0+

### Client Node Machines
*   **Python**: v3.8.0 or higher
*   **websocket-client**: v1.0.0+ (Required)
*   **Pillow** (PIL): v9.0.0+ (Optional, for Tray Icon/Overlay graphics)
*   **pystray**: v0.19.0+ (Optional, for Tray Icon control)
