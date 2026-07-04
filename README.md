# Distributed FFmpeg Transcoder Load Balancer

A high-performance, cross-platform distributed transcoding cluster designed for **Serviio** and **Jellyfin** Media Servers. It intercepts transcoder requests on the server host and routes them over WebSocket and TCP sockets to a pool of GPU-enabled client machines on your LAN, dynamically balancing CPU and hardware-accelerated encoding loads.

---

## System Architecture

```text
                  +--------------------------------+
                  |    Serviio / Jellyfin Server   |
                  +--------------------------------+
                                  |
                                  v (Executes ffmpeg)
                  +--------------------------------+
                  |  Dummy FFmpeg Wrapper (C++)    |
                  +--------------------------------+
                                  |
                                  v (Local TCP Socket)
                  +--------------------------------+
                  |   Load Balancer Server (Node)  |
                  +--------------------------------+
                   /      /       |       \      \
                 (WS)   (WS)    (WS)    (WS)    (WS)
                 /      /         |         \      \
                v      v          v          v      v
            +-------+ +-------+ +-------+ +-------+ +-------+
            |Client1| |Client2| |Client3| |Client4| |Client5|
            |GPU (N)| |GPU (A)| |  CPU  | |GPU (N)| |  CPU  |
            |Windows| | Linux | |Windows| | Linux | | macOS |
            +-------+ +-------+ +-------+ +-------+ +-------+
                |         |         |         |         |
                +---------+--(HTTP Media Stream)--------+
```

---

## Key Features

### 🌐 Network & Streaming
*   **Zero-Config File Streaming (`stream` mode)**: Media is fetched from the server via HTTP range-requests, and the transcoded output is piped back via WebSockets. No file sharing or directory mounts are required on client machines!
*   **Automatic HLS Redirection**: The server automatically detects HLS commands (`-f hls`) and falls back to `shared_folder` mode. This writes playlists and segment files directly to the shared network drive, enabling buffer-less streaming.
*   **Path Translation (`pathMappings`)**: Resolves directory structures across nodes (e.g. mapping the server's transcode folder `D:\Serviio\Serviio` to a client's mapped network drive `Z:\`).

### ⚡ GPU / Hardware Transcoding
*   **Dynamic Codec Remapping**: Converts standard CPU parameters (`libx264`/`libx265`) to Nvidia GPU (`h264_nvenc`/`hevc_nvenc`) or AMD GPU (`h264_amf`/`hevc_amf`) parameters.
*   **Encoder Parameter Translation**:
    *   Remaps CPU presets (`veryfast`, `slow`) to equivalent hardware presets (`p1`-`p7` on NVENC, `speed`/`balanced`/`quality` on AMF).
    *   Translates constant rate factor (`-crf`) to target quality variables (`-cq` or `-qp`).
    *   Strips incompatible profiles and levels (e.g., `-profile:v baseline -level 3`) so the GPU driver can determine optimal encoding settings automatically.

### 📊 Monitoring & UI Dashboard
*   **Glassmorphic Admin Dashboard**: A dark-mode, real-time web console to monitor registered clients, active transcodes, hardware features, encoding frame rates, conversion speeds, and event logs.
*   **Node Registry & State Tracking**: Persistent database of client nodes, tracking online/offline status, last-seen timestamps, and visual row dimming.
*   **Desktop Overlay Widget**: Clients can toggle a borderless, transparent overlay widget in the corner of their desktop to watch transcoding status in real-time. Double-click the widget to hide it instantly.

### ⚙️ System Optimizations
*   **Local Fallback**: Automatically routes transcodes back to the host machine if no remote client nodes are connected.
*   **Minimal Overhead**: The C++ dummy wrapper has a ~0ms startup time. Client logs and memory traces are disabled by default (`enableDebugLog: false`) to avoid disk writes.

---

## Project Documentation

| Document | Description |
| :--- | :--- |
| 📖 **[Setup & Installation Guide](docs/setup.md)** | Step-by-step instructions for Windows & Linux compiles, media server setups, and node configurations. |
| 📋 **[Supported Devices List](docs/supported_devices.md)** | Compatibility catalog of supported GPUs (NVENC/AMF), CPU fallbacks, OS versions, and libraries. |
| ⚙️ **[Protocol Specifications](docs/protocol.md)** | TCP socket frames, JSON websocket schemas, and REST status API formats. |
| 🔒 **[Security Policy](security.md)** | Security considerations, network boundaries, and directory traversal mitigations. |

---

## Technology Stack

*   **Dummy Wrapper**: Native, lightweight C++ (GCC/G++)
*   **Load Balancer Server**: Node.js (Express, ws)
*   **Transcoder Client**: Python 3 (websocket-client, Tkinter, pystray, Pillow)
*   **Web Dashboard**: HTML5, Vanilla JavaScript, Bootstrap 5

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
