# Setup & Installation Guide

This guide details how to compile, configure, and run the Serviio FFmpeg Loadbalanced Transcoder cluster.

---

## 1. Compile the Dummy FFmpeg (C++)

The dummy `ffmpeg` binary acts as a wrapper that replaces Serviio's local `ffmpeg.exe`. It communicates with the Load Balancer over TCP.

### On Windows (Recommended)
You can compile using **MSVC (Microsoft Visual C++)** or **MinGW-w64**.

#### Using MSVC (Developer Command Prompt for VS):
```bash
cl.exe /EHsc /O2 /Fe:ffmpeg.exe dummy-ffmpeg/ffmpeg.cpp Ws2_32.lib
```

#### Using MinGW (g++):
```bash
g++ -O3 -o ffmpeg.exe dummy-ffmpeg/ffmpeg.cpp -lws2_32
```

### On Linux (if running Serviio on Linux)
```bash
g++ -O3 -o ffmpeg dummy-ffmpeg/ffmpeg.cpp -lpthread
```

Once compiled, rename the real FFmpeg executable in your Serviio folder (typically located at `C:\Program Files\Serviio\lib\ffmpeg.exe`) to `ffmpeg_real.exe` (to keep it as a fallback), and copy your compiled `ffmpeg.exe` to a custom location (e.g. `C:\ServiioTranscoderLoadbalancer\ffmpeg.exe`).

---

## 2. Configure Serviio

To make Serviio use your new dummy executable, update its JVM startup arguments.

1. Open your Serviio installation directory (usually `C:\Program Files\Serviio\bin`).
2. Locate and open the file `ServiioService.exe.vmoptions` in a text editor (requires administrator privileges).
3. Add the following line to the end of the file:
   ```text
   -Dffmpeg.location=C:\Path\To\Your\Compiled\ffmpeg.exe
   ```
   *Replace `C:\Path\To\Your\Compiled\ffmpeg.exe` with the actual path to your compiled dummy binary.*
4. Restart the **Serviio** service from the Windows Services Manager (`services.msc`).

---

## 3. Install & Start the Load Balancer Server

The Load Balancer Server runs on the same machine as your Serviio server. It requires **Node.js** (version 18+ recommended).

1. Navigate to the `server/` directory:
   ```bash
   cd server
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure the environment variables at startup or edit the top of `server.js` if necessary:
   - `HTTP_PORT`: Port for WebSocket clients and Admin UI (default `4000`).
   - `TCP_PORT`: Port for the C++ dummy wrapper connection (default `4001`).
   - `FALLBACK_FFMPEG_PATH`: Full path to the real local FFmpeg binary (e.g. `C:\Program Files\Serviio\lib\ffmpeg_real.exe`).
   - `TRANSCODE_TEMP_MODE`: `"stream"` (default, relays transcoded stream back over connection) or `"shared_folder"` (requires network share configuration).
4. Run the server:
   ```bash
   npm start
   ```
5. Open your browser and navigate to `http://localhost:4000` to verify the Admin Dashboard is running.

---

## 4. Install & Start Transcoder Clients

Clients can run on any machine in the local network (including the server itself to utilize local CPU/GPU). Clients require **Python 3.8+**.

### Install Dependencies
```bash
pip install websocket-client pillow pystray
```
*(If running on a headless Linux server, you can omit `pillow` and `pystray` and the client will automatically start in Headless mode).*

### Configure the Client
Edit the `client/config.json` file:
- `serverUrl`: Change this to point to the server's IP address, e.g. `ws://192.168.1.10:4000/ws`.
- `ffmpegPath`: Path to the real `ffmpeg` binary on the client machine (must have execute permissions).
- `transcoderMode`: Set to `"nvidia"` (uses NVENC), `"amd"` (uses AMF), or `"cpu"` (standard CPU transcoding).
- `enableUi`: Set to `true` (shows system tray icon and status overlay on desktop) or `false` (headless mode).

### Run the Client
```bash
python client/client.py
```
A system tray icon (purple rectangle with a cyan play symbol) will appear in the taskbar. When a transcode task starts, a borderless dark overlay status window will slide up in the bottom-right corner of the screen.
