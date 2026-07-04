# Serviio & Jellyfin Transcoder Load Balancer Documentation

Welcome to the documentation for the **FFmpeg Loadbalanced Transcoder for Serviio & Jellyfin**.

This documentation is divided into the following guides:

1. **[Setup & Installation Guide](setup.md)**: Details on compiling the C++ dummy wrapper, configuring Serviio / Jellyfin, and running the server/client nodes.
2. **[Protocol Reference](protocol.md)**: Specifications for the TCP and WebSocket communication protocols used between components.
3. **[Security Policy](../security.md)**: Important security details and configurations for hosting in a local network environment.

---
## Repository Structure

- `dummy-ffmpeg/`: Contains the C++ dummy FFmpeg wrapper source code (`ffmpeg.cpp`).
- `server/`: Contains the NodeJS Load Balancer Server source code, Express media stream API, and the Bootstrap 5 Admin Dashboard.
- `client/`: Contains the Python Client source code, config files, and the system tray/overlay GUI.
- `docs/`: Deployment and specification documentation.
