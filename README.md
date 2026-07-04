# Serviio Transcoder Load Balancer

A distributed FFmpeg transcoding cluster for Serviio. It intercepts transcoding requests made by your Serviio server and distributes them across one or more client machines on your local network (LAN) to balance CPU and GPU load.

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

- **Zero Client configuration for File Sharing**: In "Stream" output mode, media files are streamed from the server to clients over HTTP, and the transcoded output is streamed back via WebSockets. No SAMBA/NFS/Network share setup is required on client nodes!
- **Local Fallback**: If no remote client nodes are connected or active, the server seamlessly runs the transcoding task locally on the host machine. Playback is never interrupted.
- **Hardware Acceleration Support**: Clients can be configured to map CPU encoding (`libx264`/`libx265`) to Nvidia GPU (`h264_nvenc`/`hevc_nvenc`) or AMD GPU (`h264_amf`/`hevc_amf`) transcoders.
- **Sleek Admin Dashboard**: A responsive, real-time, glassmorphic dark-mode web console (built with Bootstrap 5) to monitor connected nodes, active transcode statistics (FPS, speed, elapsed time), and system event logs.
- **Desktop Status & Tray**: Desktop clients feature a modern, borderless status overlay window in the bottom-right corner and a system tray icon for seamless background running.
- **Headless Client Mode**: Clients run headless automatically on CLI-only environments (e.g. Linux servers, Docker) if graphical libraries are not present.

---

## Technology Stack

1. **Dummy FFmpeg**: Compiled native C++ command-line application. Fast start-up time (~0ms overhead), zero external runtime dependencies.
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
