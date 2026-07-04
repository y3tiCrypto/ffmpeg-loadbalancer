# Distributed FFmpeg Transcoding Cluster for Serviio & Jellyfin

A high-performance, cross-platform distributed transcoding scheduler designed for **Serviio** and **Jellyfin** Media Servers. By intercepting encoder invocations and dynamically delegating workloads to remote GPU-enabled client nodes on your local area network (LAN), this load balancer offloads intensive 4K, HDR, and high-bitrate video transcoding tasks, ensuring stutter-free media playback and preserving host system resources.

---

## 🏗️ Architecture & Workflows

The cluster coordinates transcoding tasks across nodes using a multi-layered communication pipeline:

```text
+-------------------------+      +-------------------------+      +-------------------------+
|      Media Server       | ---> |  Dummy FFmpeg Wrapper   | ---> |  Load Balancer Server   |
|  (Serviio / Jellyfin)   |      |         (C++)           |      |        (NodeJS)         |
+-------------------------+      +-------------------------+      +-------------------------+
                                                                               |
               +-----------------+-----------------+-----------------+---------+-------+
               |                 |                 |                 |                 | (WebSockets)
               v                 v                 v                 v                 v
         +-----------+     +-----------+     +-----------+     +-----------+     +-----------+
         | Client 1  |     | Client 2  |     | Client 3  |     | Client 4  |     | Client 5  |
         |  GPU (N)  |     |  GPU (A)  |     |    CPU    |     |  GPU (N)  |     |    CPU    |
         |  Windows  |     |   Linux   |     |  Windows  |     |   Linux   |     |   macOS   |
         +-----------+     +-----------+     +-----------+     +-----------+     +-----------+
               |                 |                 |                 |                 |
               +-----------------+-----------------+-----------------+-----------------+--- (HTTP Media Stream)
```

### Transcoding Execution Flow
1.  **Request Interception**: When playback starts, the media server executes our compiled C++ **Dummy FFmpeg Wrapper** instead of the actual local FFmpeg binary. The wrapper captures the full command-line arguments and working directory, and transmits them to the server via a local TCP loopback socket.
2.  **Job Scheduling**: The **Node.js Load Balancer Server** receives the transcode command. It searches its active node registry, selects the most suitable client node (prioritizing GPU-enabled nodes that are currently idle), and transmits the transcode task via WebSockets.
3.  **Low-Latency Stream Handling**:
    *   **Stream Mode**: The client reads the source media file from the server via HTTP range-requests, transcodes the frames, and streams the binary output chunks back to the server over the WebSocket. The server writes this stream directly to the dummy wrapper, which outputs it to the player in real-time.
    *   **Shared-Folder Mode (HLS)**: If HLS options (`-f hls`) are detected, the server automatically bypasses WebSocket pipes. The client applies path translations (e.g., mapping `D:\Serviio\Serviio` to `Z:\`) and writes HLS playlist/segment files directly to the shared network storage, letting the media server serve them natively.
4.  **Local Fallback**: If no nodes are connected or an error occurs during scheduling, the server automatically spawns the local fallback FFmpeg instance locally, preventing server stutters.

---

## 🌟 Key Features

### 🌐 Low-Overhead Network Pipeline
*   **Zero-Config Streaming**: Media files are served to client nodes over HTTP range-requests. The transcoded video is streamed back to the server in chunks over WebSockets. No file sharing or directory mounts are required for standard streams.
*   **HLS Segment Translation**: Automatically redirects HLS streams to `shared_folder` mode. The client writes segments (`.ts`) and updates playlists (`.m3u8`) directly on a shared disk.
*   **Path Mapping Engine (`pathMappings`)**: Allows clients to map paths dynamically across differing OS structures (e.g. mapping Windows server library paths to local mount points on Linux/macOS nodes).

### ⚡ Dynamic Hardware Translation Layer
*   **Automatic Codec Remapping**: Translates CPU encoders (`libx264`/`libx265`) to equivalent hardware encoders:
    *   **Nvidia NVENC**: `h264_nvenc` / `hevc_nvenc`
    *   **AMD AMF**: `h264_amf` / `hevc_amf`
*   **GPU Parameter Mapping**:
    *   Translates CPU presets (`ultrafast` to `veryslow`) to hardware equivalents (`p1`-`p7` on NVENC, `speed`/`balanced`/`quality` on AMF).
    *   Translates Constant Rate Factor (`-crf`) to target quality limits (`-cq` on NVENC, `-qp` on AMF).
    *   Filters out conflicting profile/level parameters (e.g. `-profile:v baseline -level 3`) when hardware encoding is active to prevent encoder crashes.

### 📊 Real-Time Operations Management
*   **Glassmorphic Web Dashboard**: Dark-mode console built on Bootstrap 5 to monitor registered nodes, transcode statistics (FPS, speed multiplier, elapsed time), and system event logs.
*   **Persistent Node Registry**: Tracks and displays all client nodes that have ever registered, showing real-time states (`idle`, `transcoding`, or `offline`) and last-seen timestamps. Offline nodes are dimmed and sorted at the bottom.
*   **Desktop Status Overlay**: Clients can toggle a borderless, translucent status overlay in the bottom-right corner of their screen. Double-click the overlay window or right-click the system tray to hide it.
*   **Resource Capping**: Caps server log memory to 100 entries. Client nodes default to `enableDebugLog: false` to skip disk writes and stderr collections.

---

## 📖 Documentation Index

| Guide | Description |
| :--- | :--- |
| **[Setup & Installation Guide](docs/setup.md)** | Directives for compiling the C++ dummy wrapper, configuring Serviio & Jellyfin, and launching client/server processes. |
| **[Supported Devices List](docs/supported_devices.md)** | Compatibility catalog of supported GPUs (NVENC/AMF), CPUs, Operating Systems, and software runtimes. |
| **[Protocol Specifications](docs/protocol.md)** | TCP socket frames, JSON WebSocket schemas, and REST status API formats. |
| **[Security Policy](security.md)** | Host environment safety boundaries, port binding rules, and directory traversal mitigations. |

---

## 🛠️ Technology Stack

*   **Dummy Wrapper**: Native C++11 (GCC / MSVC)
*   **Load Balancer Server**: Node.js, Express, and `ws` (WebSockets)
*   **Transcoder Client**: Python 3 (`websocket-client`, `Tkinter`, `pystray`, `Pillow`)
*   **Web Dashboard**: HTML5, Vanilla JavaScript, Bootstrap 5

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
