# Setup & Installation Guide

This guide details how to compile, configure, and run the Serviio FFmpeg Loadbalanced Transcoder cluster.

---

## 1. Compile the Dummy FFmpeg (C++)

The dummy `ffmpeg` binary acts as a wrapper that replaces Serviio's local `ffmpeg.exe`. It communicates with the Load Balancer over TCP.

### Recommended: Windows Compilation via w64devkit
We recommend using **w64devkit**, a lightweight, zero-configuration portable GCC/G++ suite.

1. Download `w64devkit-x64-2.8.0.7z.exe` from [skeeto/w64devkit GitHub Releases](https://github.com/skeeto/w64devkit/releases).
2. Extract the archive to `C:\w64devkit` (you can do this via command line: `w64devkit.exe -y -oC:\`).
3. Compile the wrapper by temporarily prepending the compiler path in your PowerShell terminal:
   ```powershell
   $env:PATH = "C:\w64devkit\bin;" + $env:PATH
   g++ -O3 -o dummy-ffmpeg\ffmpeg.exe dummy-ffmpeg\ffmpeg.cpp -lws2_32
   ```

### Alternative Compilers
If you already have developer environments installed, you can compile with:

- **MSVC (Visual Studio Developer Command Prompt)**:
  ```bash
  cl.exe /EHsc /O2 /Fe:ffmpeg.exe dummy-ffmpeg/ffmpeg.cpp Ws2_32.lib
  ```
- **Standard MinGW-w64 (g++)**:
  ```bash
  g++ -O3 -o ffmpeg.exe dummy-ffmpeg/ffmpeg.cpp -lws2_32
  ```

---

## 2. Configure Serviio

To make Serviio use your new dummy executable:

1. Locate your compiled `ffmpeg.exe` inside the `dummy-ffmpeg` folder.
2. Copy it to a safe deployment path on your Serviio machine (e.g. `C:\ServiioTranscoderLoadbalancer\ffmpeg.exe`).
3. Open your Serviio installation bin folder (usually `C:\Program Files\Serviio\bin`).
4. Rename the real FFmpeg executable in the lib directory (`C:\Program Files\Serviio\lib\ffmpeg.exe`) to `ffmpeg_real.exe` (this keeps it available as a local fallback for the Load Balancer).
5. Locate the file `ServiioService.exe.vmoptions` in the bin directory.
6. Open it in a text editor (with Administrator privileges) and append the following line:
   ```text
   -Dffmpeg.location=C:\Path\To\Your\Compiled\ffmpeg.exe
   ```
   *Replace `C:\Path\To\Your\Compiled\ffmpeg.exe` with your actual copy path from Step 2.*
7. Restart the **Serviio** service in the Windows Services console (`services.msc`) for changes to take effect.

---

## 3. Install & Start the Load Balancer Server

The Load Balancer Server runs on the same machine as your Serviio server. It requires **Node.js** (v18+).

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
4. Verify by visiting the Admin Dashboard at `http://localhost:4000` in your web browser.

---

## 4. Install & Start Transcoder Clients

Clients run on any node in your LAN (including the server itself). Clients require **Python 3.8+**.

### Install Dependencies
```bash
pip install websocket-client pillow pystray
```
*(If running on a headless server, you can omit `pillow` and `pystray` and the client will automatically start in Headless mode).*

### Configure the Client
Edit the `client/config.json` file:
- `serverUrl`: Point this to the server's IP address, e.g. `ws://192.168.1.141:4000/ws`.
- `ffmpegPath`: Path to the real `ffmpeg` binary on the client machine.
- `transcoderMode`: Set to `"nvidia"` (NVENC), `"amd"` (AMF), or `"cpu"`.
- `enableUi`: Set to `true` (shows system tray icon and status overlay on desktop) or `false` (headless mode).

### Run the Client
```bash
python client/client.py
```
*(Note: If you run it on your desktop with GUI enabled, a tray icon will appear. You can right-click the icon and choose **Show Status Overlay** to open the status widget in the bottom-right corner. It will show a clean "Idle" state while waiting for tasks, and slide up with active progress bars during transcoding.)*
