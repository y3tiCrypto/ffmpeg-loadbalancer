# Transcoder Load Balancer Documentation

Welcome to the documentation catalog for the **FFmpeg Distributed Transcoder Load Balancer for Serviio & Jellyfin**.

---

## 📖 Document Index

| Document | Link | Target Audience / Purpose |
| :--- | :--- | :--- |
| **Setup & Installation** | [setup.md](setup.md) | System administrators deploying client nodes or configuring Serviio / Jellyfin. |
| **Supported Devices** | [supported_devices.md](supported_devices.md) | Compatibility list for operating systems, hardware encoders, and software runtimes. |
| **Protocol Specifications** | [protocol.md](protocol.md) | Specifications for TCP packet frames, WebSocket JSON messages, and parameter translation layers. |
| **Security Policy** | [../security.md](../security.md) | Network trust boundaries, firewall routing guidelines, and path traversal mitigations. |

---

## 🏗️ Repository Structure

*   `dummy-ffmpeg/`: Source code (`ffmpeg.cpp`) for the C++ command interceptor wrapper.
*   `server/`: Node.js scheduler application, HTTP streaming routes, and the glassmorphic Admin Dashboard.
*   `client/`: Python node client script, Tkinter status overlay, and pystray tray control.
*   `docs/`: Deployment, configuration, and developer guides.
