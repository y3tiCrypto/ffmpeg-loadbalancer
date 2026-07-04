# Security Policy & Considerations

This document outlines the security model of the distributed transcoding cluster, its networking boundaries, and recommended practices for securing your deployment.

---

## 1. Trust Model

The load balancer cluster is designed for deployment within a **trusted, private local area network (LAN)**.

> [!WARNING]
> **No Built-in Authentication**: The WebSocket control channel and HTTP media streamer do not implement user authentication or Transport Layer Security (TLS) out-of-the-box. This minimizes routing overhead to maximize media transfer speeds. Do not expose cluster ports to untrusted networks.

---

## 2. Port Boundaries & Network Binding

| Port | Protocol | Default Bind | Scope & Risk | Mitigations |
| :---: | :---: | :---: | :--- | :--- |
| **`4001`** | **TCP** | `127.0.0.1` | Local loopback interface only. Safe from external network calls. Used by the local dummy FFmpeg wrapper to submit transcode jobs. | No external action required. |
| **`4000`** | **HTTP / WS** | `0.0.0.0` | Accessible by all local network adapters. Used for the Admin Dashboard, WebSocket client connections, and raw video streaming. | 1. **Do NOT port-forward** or expose port `4000` to the WAN.<br>2. Bind the server ports behind local firewall routing tables. |

---

## 3. Media Stream Path Traversal Prevention

The HTTP endpoint `/api/media?file=...` enables client nodes to stream source media files directly from the host.

### Risk Analysis
*   The server reads the file path provided by the query parameters. This is necessary because media libraries in Serviio and Jellyfin often span multiple separate drives and directory shares.
*   An unauthorized client on port `4000` could theoretically request files from directories outside your media libraries.

### Mitigations
1.  **Firewall IP Filtering**: Configure your host's firewall rules (e.g. Windows Defender Firewall or `iptables` / `ufw` on Linux) to only allow incoming connections on port `4000` from the specific IP addresses of your registered client nodes.
2.  **Access Whitelists** (Optional Code Override): If you want to enforce strict path limits, you can modify the Express file server route in `server/server.js` to assert that paths start with a predefined array of shared library root paths (e.g. `D:\Movies`, `E:\TV Shows`).

---

## 4. Host System Hardening

*   **Low-Privilege Accounts**: Run the NodeJS server process under a service account with the lowest necessary system privileges. It only requires read access to your media files, write access to the media server's transcode temp directory, and network binding permissions.
*   **Client Process Restrictions**: Ensure the client Python script does not run under Administrator or root privileges, as it spawns subprocesses (`ffmpeg`). Run client scripts under standard desktop user environments.
