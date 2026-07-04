# Distributed FFmpeg Transcoder Load Balancer for Serviio

A high-performance load-balanced transcoding cluster designed for Serviio Media Server. It intercepts transcoding requests made by your Serviio server and distributes them across one or more client machines on your local network (LAN) to balance CPU and GPU load.

```
                  +--------------------------------+
                  |     Serviio Media Server       |
                  +--------------------------------+
                                  |
                                  v (Executes ffmpeg.exe)
                  +--------------------------------+
                  |  Dummy FFmpeg Wrapper (C++)    |
                  +--------------------------------+
                                  |
                                  v (Local TCP Socket)
                  +--------------------------------+
                  |   Load Balancer Server (Node)  | <===================+
                  +--------------------------------+                     |
                            /            \                               |
                (Websocket)/              \(Websocket)                   |
                          v                v                             |
            +----------------+          +----------------+               |
            | Client 1 (GPU) |          | Client 2 (CPU) |               |
            +----------------+          +----------------+               |
                    |                           |                        |
                    +------------(HTTP Stream)--+------------------------+
```

---

## Key Features

- **Zero Client configuration for File Sharing**: In "Stream" output mode, media files are streamed from the server to clients over HTTP, and the transcoded output is streamed back via WebSockets. No network share setup is required on client nodes!
- **Automatic HLS Redirection**: The server automatically detects HLS streams (Apple HTTP Live Streaming) and handles them via `shared_folder` mode. This writes segment and playlist files directly to disk (using client path mappings), preventing sequential pipe writing issues.
- **Flexible Path Translation (`pathMappings`)**: Remote client nodes can translate paths dynamically (e.g. mapping the server's local directory `D:\Serviio\Serviio` to a client-mapped network drive `Z:\`), allowing seamless writing of segments directly to the server.
- **Local Fallback**: If no remote client nodes are connected or active, the server seamlessly runs the transcoding task locally on the host machine. Playback is never interrupted.
- **Hardware Acceleration Mapping**: Clients map CPU encoding (`libx264`/`libx265`) to Nvidia GPU (`h264_nvenc`/`hevc_nvenc`) or AMD GPU (`h264_amf`/`hevc_amf`) transcoders.
- **GPU Parameter Translation**:
  - Automatically translates CPU presets (like `veryfast`, `slow`) to valid GPU presets (`p1` to `p7` for NVENC, `speed`/`balanced`/`quality` for AMF).
  - Automatically translates `-crf` parameters to Constant Quality options (`-cq` for NVENC, `-qp` for AMF).
  - Strips high-conflict parameters (like `-profile:v baseline -level 3`) when mapping to GPU encoders to allow the hardware driver to establish optimal settings.
- **Sleek Admin Dashboard**: A responsive, real-time, glassmorphic dark-mode web console (built with Bootstrap 5) to monitor connected nodes, active transcode statistics (FPS, speed, elapsed time), and system event logs.
- **Desktop Status & Tray**: Desktop clients feature a modern, borderless status overlay window in the bottom-right corner and a system tray icon for seamless background running.
- **Persistent Idle Display**: Right-clicking the tray icon and choosing **Show Status Overlay** reveals the status window which remains visible and displays a clean "Idle" state (showing active hardware mode and hostname) while waiting for tasks.
- **Memory & Logging Optimizations**: Memory buffers are optimized. Server logs are capped to 100 entries, and client nodes default to `enableDebugLog: false` to completely bypass disk I/O write operations and stderr collection during production.

---

## Technology Stack

1. **Dummy FFmpeg**: Compiled native C++ command-line application. Fast start-up time (~0ms overhead), zero external runtime dependencies. Compiles easily on Windows via the portable **w64devkit** (GCC/G++).
2. **Load Balancer Server**: Node.js, Express, and WebSockets (`ws`).
3. **Transcoder Client**: Python 3, `websocket-client`, `pystray`, `Pillow`, and `tkinter`.
4. **Admin Dashboard**: HTML5, Vanilla JavaScript, and Bootstrap 5 (CSS).

---

## Getting Started

To get started compiling the dummy binary, configuring your JVM startup parameters, and starting your nodes, read the:

### 📖 **[Setup & Installation Guide](docs/setup.md)**

---

## Security Model

Before deploying, please review the security guidelines regarding port bindings and local area network isolation in the:

### 🔒 **[Security Policy](security.md)**

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
