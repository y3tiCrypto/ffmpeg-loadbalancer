# Setup & Installation Guide (Windows & Linux)

This guide details how to compile, configure, and run the Serviio/Jellyfin FFmpeg Loadbalanced Transcoder cluster on both **Windows** and **Linux** systems.

---

## 1. Compile the Dummy FFmpeg (C++)

The dummy `ffmpeg` binary acts as a wrapper that replaces Serviio's/Jellyfin's local `ffmpeg`. It intercepts transcoder invocations and redirects them over TCP to the Load Balancer Server. The source code is cross-platform and compiles natively.

### A. Windows Compilation (via w64devkit)
1. Download `w64devkit-x64-2.8.0.7z.exe` from [skeeto/w64devkit GitHub Releases](https://github.com/skeeto/w64devkit/releases).
2. Extract the archive to `C:\w64devkit`.
3. Open a PowerShell window and compile the wrapper:
   ```powershell
   $env:PATH = "C:\w64devkit\bin;" + $env:PATH
   g++ -O3 -o dummy-ffmpeg\ffmpeg.exe dummy-ffmpeg\ffmpeg.cpp -lws2_32
   ```

### B. Linux Compilation (via GCC)
1. Install build essentials:
   ```bash
   # Debian / Ubuntu / Mint
   sudo apt update && sudo apt install build-essential -y

   # RHEL / Rocky / Fedora
   sudo dnf groupinstall "Development Tools" -y
   ```
2. Compile the wrapper:
   ```bash
   g++ -O3 -o dummy-ffmpeg/ffmpeg dummy-ffmpeg/ffmpeg.cpp -lpthread
   ```

---

## 2. Configure the Media Server (Serviio / Jellyfin)

To make your media server route transcodes through the load balancer:

### A. Serviio configuration

#### On Windows:
1. Copy your compiled `dummy-ffmpeg\ffmpeg.exe` to a deployment path (e.g. `C:\ServiioTranscoderLoadbalancer\ffmpeg.exe`).
2. Go to the Serviio installation folder bin directory (usually `C:\Program Files\Serviio\bin`).
3. Rename the real FFmpeg executable in the lib directory (`C:\Program Files\Serviio\lib\ffmpeg.exe`) to `ffmpeg_real.exe` (so the server can still run local fallback jobs).
4. Edit the file `ServiioService.exe.vmoptions` and append the location of your dummy binary:
   ```text
   -Dffmpeg.location=C:\Path\To\Your\Compiled\ffmpeg.exe
   ```
5. Restart the **Serviio** service in Windows Services (`services.msc`).

#### On Linux:
1. Copy the compiled `dummy-ffmpeg/ffmpeg` binary to `/usr/lib/serviio/bin/ffmpeg_dummy`.
2. Rename the real FFmpeg executable in your Serviio bin folder (usually `/usr/share/serviio/bin/ffmpeg`) to `ffmpeg_real`.
3. Create a symlink pointing to the dummy binary, or edit `/usr/share/serviio/bin/serviio.sh` and append the JVM option to `JAVA_OPTS`:
   ```bash
   JAVA_OPTS="-Dffmpeg.location=/usr/lib/serviio/bin/ffmpeg_dummy ..."
   ```
4. Restart the Serviio daemon:
   ```bash
   sudo systemctl restart serviio
   ```

### B. Jellyfin configuration (Windows & Linux)
Jellyfin makes changing transcode binaries extremely simple.
1. Open the Jellyfin Web Admin Dashboard.
2. Navigate to **Dashboard &rarr; Playback &rarr; Transcoding**.
3. Under **FFmpeg path**, replace the default location with the absolute path of your compiled dummy binary:
   *   *Windows:* `C:\Path\To\dummy-ffmpeg\ffmpeg.exe`
   *   *Linux:* `/path/to/dummy-ffmpeg/ffmpeg`
4. Click **Save** at the bottom of the page.

---

## 3. Install & Start the Load Balancer Server

The Load Balancer Server runs on your primary media server host. It requires **Node.js** (v24+).

1. Navigate to the `server/` directory:
   ```bash
   cd server
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the server:
   ```bash
   npm start
   ```
4. Open the Web Dashboard at `http://<server_ip>:4000` in your web browser. (If running on the local host, use `http://localhost:4000`).

---

## 4. Install & Start Transcoder Clients

Clients run on any node in your LAN (including the server itself to utilize local hardware/GPUs). Clients require **Python 3.8+**.

### A. Install Dependencies

#### GUI Nodes (Windows / Linux Desktops)
If running on a desktop with a graphical interface (showing the tray icon and status overlay widget):
```bash
pip install websocket-client pillow pystray
```
*(On Linux desktops, you may also need to install Tkinter if it is not bundled with your python distribution: `sudo apt install python3-tk`)*.

#### Headless Nodes (Linux Servers / CLI Only)
If running on headless nodes, the client automatically bypasses all GUI dependencies. You **do not** need to install `pystray` or `pillow`:
```bash
pip install websocket-client
```

### B. Configure the Client
Edit the `client/config.json` file:
*   `serverUrl`: Point this to the server's IP address (e.g. `ws://192.168.1.141:4000/ws`).
*   `ffmpegPath`: Path to the real, hardware-enabled `ffmpeg` binary on the client.
*   `transcoderMode`: Set to `"nvidia"` (NVENC), `"amd"` (AMF), or `"cpu"`.
*   `enableUi`: Set to `true` (UI desktop overlay) or `false` (headless command line mode).
*   `enableDebugLog`: Set to `false` (highly recommended to disable disk I/O) or `true` (writes `client.log`).
*   `pathMappings`: Remaps directories for HLS streams (where the server reads segment files).
    *   *Example mapping:* If the server writes temp files to `D:\Serviio\Serviio` (Windows) or `/tmp/serviio` (Linux), and the client mounts it as `/mnt/serviio-temp` (Linux) or `Z:\` (Windows):
        ```json
        "pathMappings": {
          "D:\\Serviio\\Serviio": "Z:\\"
        }
        ```

### C. Run the Client
```bash
# Windows
python client/client.py

# Linux
python3 client/client.py
```
*   **Overlay Closing Tip:** On desktop configurations with the UI enabled, you can hide/dismiss the status overlay widget by **double-clicking** anywhere on its window, or right-clicking the system tray icon and selecting **Hide Status Overlay**.
