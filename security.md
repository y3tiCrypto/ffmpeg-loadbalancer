# Security Policy & Considerations

This document outlines the security model of the Serviio & Jellyfin Transcoder Load Balancer and best practices for securing your deployment.

---

## 1. Trust Model
The Load Balancer cluster is designed for deployment within a **trusted, private local area network (LAN)**. 

### Core Assumptions:
- **No Built-in Authentication**: The WebSocket control server and HTTP media streamer do not implement authentication or TLS out-of-the-box. This is optimized for low-overhead, high-speed media streaming on local subnets.
- **Subnet Isolation**: It is assumed that only trusted client nodes can access the server's ports.

---

## 2. Port Boundaries & Network Binding

### TCP Server (Port `4001`)
- **Default Bind Address**: `127.0.0.1` (localhost only)
- **Security Control**: Because it binds strictly to the loopback interface, external machines cannot access this port. Only the dummy `ffmpeg.exe` running locally on the same server can send transcode requests.

### HTTP / WebSocket Server (Port `4000`)
- **Default Bind Address**: `0.0.0.0` (all interfaces)
- **Risk**: Any machine on the local network can access the Admin Dashboard, register as a client node, and request video streams.
- **Mitigation**:
  - **Do NOT expose port 4000 to the public internet** (e.g. via port forwarding or UPnP).
  - Use your router's firewall or the host OS firewall (e.g. Windows Defender Firewall) to restrict access to port `4000` to specific IP addresses of your client nodes.

---

## 3. Media Stream Path Traversal Prevention

The HTTP file server endpoint (`/api/media?file=...`) allows clients to stream raw video files from the server.

### Current Implementation:
- The server reads the file path provided directly by the query parameter. This is necessary because media libraries in Serviio and Jellyfin can span multiple drives and directory structures.

### Recommended Defenses:
1. **Host Firewall Filtering**: Restrict incoming traffic on port `4000` to designated client IP addresses only.
2. **Drive/Directory Whitelists** (Optional): If you want to tighten access control, you can modify the Express route in `server.js` to only allow paths starting with a predefined array of shared library root folders (e.g. `D:\Movies`, `E:\TV Shows`).

---

## 4. Host System Security

- **Run under Low Privilege**: Run the NodeJS server under a service account with the lowest necessary privileges. It only requires read access to your media files, write access to the media server's transcode temp folder, and network permissions.
- **Client privilege boundary**: Ensure the client Python script does not run under Administrator or root privileges, as it executes subprocesses (`ffmpeg`). Run it as a standard desktop user.
