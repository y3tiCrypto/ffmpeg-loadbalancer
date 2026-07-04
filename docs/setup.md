# Setup & Installation Guide

This guide details the steps required to compile, configure, and deploy the distributed transcoding cluster for **Serviio** and **Jellyfin** Media Servers on both **Windows** and **Linux** environments.

---

## 1. Compile the Dummy FFmpeg Wrapper

The dummy `ffmpeg` binary acts as a subprocess wrapper that replaces the media server's default `ffmpeg` executable. It intercepts transcode invocations and relays command parameters over local TCP loopback to the Load Balancer Server.

### 💻 Windows Compilation (via w64devkit)
1. Download the portable GCC compiler suite `w64devkit-x64-2.8.0.7z.exe` from [skeeto/w64devkit Releases](https://github.com/skeeto/w64devkit/releases).
2. Extract the archive to `C:\w64devkit`.
3. Open PowerShell and compile the C++ source:
   ```powershell
   $env:PATH = "C:\w64devkit\bin;" + $env:PATH
   g++ -O3 -o dummy-ffmpeg\ffmpeg.exe dummy-ffmpeg\ffmpeg.cpp -lws2_32
   ```

### 🐧 Linux Compilation (via GCC)
1. Install native build tools:
   ```bash
   # Debian / Ubuntu / Linux Mint
   sudo apt update && sudo apt install build-essential -y

   # RHEL / Rocky Linux / Fedora
   sudo dnf groupinstall "Development Tools" -y
   ```
2. Compile the C++ source:
   ```bash
   g++ -O3 -o dummy-ffmpeg/ffmpeg dummy-ffmpeg/ffmpeg.cpp -lpthread
   ```

---

## 2. Configure the Media Server Host

Configure your primary media server to execute the dummy binary instead of its default transcoder:

### 📺 Serviio Configuration

#### On Windows:
1. Copy the compiled `dummy-ffmpeg\ffmpeg.exe` to a deployment path (e.g., `C:\ServiioTranscoderLoadbalancer\ffmpeg.exe`).
2. Navigate to the Serviio installation folder (usually `C:\Program Files\Serviio\bin`).
3. Rename the real FFmpeg executable in the lib directory (`C:\Program Files\Serviio\lib\ffmpeg.exe`) to `ffmpeg_real.exe` (this is used for host-side local fallbacks).
4. Edit the file `ServiioService.exe.vmoptions` and append the JVM option pointing to your dummy binary:
   ```text
   -Dffmpeg.location=C:\Path\To\Your\Compiled\ffmpeg.exe
   ```
5. Restart the **Serviio** service via Windows Services manager (`services.msc`).

#### On Linux:
1. Copy the compiled `dummy-ffmpeg/ffmpeg` binary to `/usr/lib/serviio/bin/ffmpeg_dummy`.
2. Rename the real FFmpeg executable in the Serviio folder (usually `/usr/share/serviio/bin/ffmpeg`) to `ffmpeg_real`.
3. Edit the startup script `/usr/share/serviio/bin/serviio.sh` and append the location mapping to `JAVA_OPTS`:
   ```bash
   JAVA_OPTS="-Dffmpeg.location=/usr/lib/serviio/bin/ffmpeg_dummy ..."
   ```
4. Restart the systemd daemon:
   ```bash
   sudo systemctl restart serviio
   ```

### 🍇 Jellyfin Configuration (Windows & Linux)
1. Access the Jellyfin Web Admin Dashboard.
2. Navigate to **Dashboard &rarr; Playback &rarr; Transcoding**.
3. Under the **FFmpeg path** setting, input the absolute path of your compiled dummy binary:
   *   *Windows:* `C:\Path\To\dummy-ffmpeg\ffmpeg.exe`
   *   *Linux:* `/path/to/dummy-ffmpeg/ffmpeg`
4. Click **Save** at the bottom of the page.

---

## 3. Install & Start the Load Balancer Server

The Load Balancer Server acts as the cluster scheduler. It runs on the media server host machine and requires **Node.js (v24+)**.

1. Navigate to the server root:
   ```bash
   cd server
   ```
2. Install node dependencies:
   ```bash
   npm install
   ```
3. Boot the scheduler:
   ```bash
   npm start
   ```
4. Access the real-time glassmorphic dashboard by opening `http://<server_ip>:4000` (or `http://localhost:4000` if local) in any web browser.

---

## 4. Deploy Transcoder Client Nodes

Client nodes run on any system connected to your local network (including the media server host to utilize its local GPU resources). Clients require **Python 3.8+**.

### 📦 A. Install Dependencies

#### GUI Nodes (Windows / Linux Desktops)
If deploying on a client node with a graphical interface (supports the status overlay widget and system tray icon controls):
```bash
pip install websocket-client pillow pystray
```
> [!NOTE]
> On Linux desktop environments, you may also need to install Tkinter if it is not pre-packaged:
> `sudo apt install python3-tk`

#### Headless Nodes (Linux Servers / CLI Only)
If deploying on headless systems, the client automatically falls back to console execution and bypasses graphical packages:
```bash
pip install websocket-client
```

### ⚙️ B. Configure the Client
Modify `client/config.json` to define node behaviors:
*   `serverUrl`: Points to the Load Balancer WebSocket endpoint (e.g. `ws://192.168.1.141:4000/ws`).
*   `ffmpegPath`: Path to the real hardware-enabled `ffmpeg` binary on the client.
*   `transcoderMode`: Set target hardware acceleration mode: `"nvidia"` (NVENC), `"amd"` (AMF), or `"cpu"`.
*   `enableUi`: Toggle `true` to render the desktop widget, or `false` for headless CLI logs.
*   `enableDebugLog`: Toggle `false` (recommended to avoid raw stderr buffers and disk write I/O) or `true`.
*   `pathMappings`: Translate server paths to local mounts for HLS file segments:
    ```json
    "pathMappings": {
      "D:\\Serviio\\Serviio": "Z:\\"
    }
    ```

### 🚀 C. Execute Client Node
Launch the client script in the background:
```bash
# Windows
python client/client.py

# Linux / macOS
python3 client/client.py
```

> [!TIP]
> **Status Overlay Dismissal**: On desktop layouts with the UI enabled, double-click anywhere on the borderless status overlay window to hide it immediately. Alternatively, right-click the system tray icon and select **Hide Status Overlay** to toggle visibility.
