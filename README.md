# Distributed FFmpeg Transcoding Cluster for Serviio & Jellyfin

A high-performance, cross-platform distributed transcoding scheduler designed for **Serviio** and **Jellyfin** Media Servers. By intercepting encoder invocations and dynamically delegating workloads to remote GPU-enabled client nodes on your local area network (LAN), this load balancer offloads intensive 4K, HDR, and high-bitrate video transcoding tasks, ensuring stutter-free media playback and preserving host system resources.

---

## 🏗️ Architecture & Workflows

The cluster coordinates transcoding tasks across nodes using a multi-layered communication pipeline:

```text
                  +--------------------------------+
                  |    Serviio / Jellyfin Server   |
                  +--------------------------------+
                                  |
                                  v (Executes ffmpeg wrapper)
                  +--------------------------------+
                  |  Dummy FFmpeg Wrapper (C++)    |
                  +--------------------------------+
                                  |
                                  v (Local Loopback TCP Socket)
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

### Invalidation & Execution Pipeline
1.  **Interception**: The media server executes our compiled C++ **Dummy FFmpeg Wrapper** instead of the local FFmpeg binary. The wrapper intercepts the full list of command-line arguments and working directories, packaging them into a TCP packet.
2.  **Scheduling**: The wrapper transmits the packet to the **Node.js Load Balancer Server** via local loopback. The server checks the list of active WebSocket client nodes and schedules the job to the most appropriate node (prioritizing GPU-enabled idle nodes).
3.  **Low-Latency Media Streaming**:
    *   *Stream Mode*: The client fetches the raw media file from the server via HTTP range-requests. The client's GPU transcodes the stream and pipes the binary output chunks back to the server in real-time over the WebSocket. The server writes the data directly to the dummy wrapper's stdout TCP packet handler.
    *   *Shared Folder Mode (For HLS)*: The server detects HLS streams (`-f hls`) and switches to shared folder execution. The client applies path translations (e.g., mapping `D:\Serviio\Serviio` to `Z:\`) and writes segments directly to the shared network storage.
4.  **Local Fallback**: If no remote nodes are connected or an error occurs during scheduling, the server automatically spawns the local fallback FFmpeg process on the host machine to prevent playback interruptions.

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
