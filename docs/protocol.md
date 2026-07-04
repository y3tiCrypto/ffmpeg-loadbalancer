# Protocol & Translation Specification

This document details the communication protocols and parameter translations used in the load-balanced transcoder cluster.

---

## 1. TCP Protocol: Dummy FFmpeg &harr; Server

The C++ dummy FFmpeg binary connects to the Load Balancer Server on `127.0.0.1:4001` (TCP) and speaks a packet-framed stream protocol.

### Packet Frame Format
Every packet transmitted over the socket uses the following framing:
```text
+-------------------+---------------------------+---------------------------------+
| Type ID (1 byte)  | Payload Length (4 bytes)  | Payload Data (N bytes)          |
|                   | (Big-Endian UInt32)       |                                 |
+-------------------+---------------------------+---------------------------------+
```

### Packet Types

| Type ID | Name | Direction | Payload Description |
| :--- | :--- | :--- | :--- |
| `0x01` | **INIT** | Dummy &rarr; Server | A UTF-8 JSON string containing the execution environment. <br>Format: `{"cwd": "working_directory", "args": ["arg1", "arg2", ...]}` |
| `0x02` | **STDIN** | Dummy &rarr; Server | Raw bytes read from the dummy's stdin. |
| `0x03` | **STDOUT** | Server &rarr; Dummy | Raw bytes to write directly to the dummy's stdout. |
| `0x04` | **STDERR** | Server &rarr; Dummy | Raw bytes to write directly to the dummy's stderr. |
| `0x05` | **EXIT** | Server &rarr; Dummy | A 4-byte big-endian signed integer representing the exit code. The dummy exits with this code after receiving this packet. |

---

## 2. WebSocket Protocol: Client &harr; Server

The Transcoder Clients connect to the Load Balancer Server at `ws://<server_ip>:<port>/ws` and communicate using a combination of JSON control messages and binary stream frames.

### Cross-Version Callback Compatibility
WebSocket callback handlers on the client are designed with variable argument signatures (`*args` and `**kwargs`) to accommodate differences in argument parameters between `websocket-client` library versions (e.g. `on_close` and `on_open` changes in version `0.x` vs `1.x`).

### A. JSON Messages (Control & Status Updates)

#### 1. Registration (`type: register`)
Sent by the client immediately upon connection to report capabilities.
```json
{
  "type": "register",
  "hostname": "ClientNode1",
  "capabilities": {
    "cpu": true,
    "nvidia": true,
    "amd": false
  }
}
```

#### 2. Start Transcode (`type: start_transcode`)
Sent by the server to initiate transcoding on the client.
```json
{
  "type": "start_transcode",
  "jobId": "job_12_4821",
  "args": ["ffmpeg", "-i", "http://...", "-vcodec", "h264_nvenc", "pipe:1"],
  "outputMode": "stream",
  "outputPath": "C:\\Windows\\Temp\\serviio\\transcoding-temp\\12.st"
}
```

---

## 3. Parameter and Path Translations

Before executing the FFmpeg binary, the load balancer cluster modifies the command line parameters to optimize for remote network and hardware execution.

### A. Automatic HLS Detection (Server-Side)
Because HLS (Apple Live Streaming) output consists of multiple segment files and a dynamically updated playlist, it **cannot** be piped sequentially to standard output (`pipe:1`).
*   The server automatically scans the incoming arguments. If any parameter contains the word `"hls"` (such as `-f hls` or `-hls_segment_filename`), it overrides the configuration and forces the job's `outputMode` to **`"shared_folder"`**.
*   This prevents the last argument from being rewritten to `pipe:1`, allowing the client to write all segments and playlists directly to disk.

### B. Client-Side Path Translation (`pathMappings`)
In `"shared_folder"` mode, the client must write files to a drive accessible by both machines. The client maps paths using the `"pathMappings"` configuration:
*   *Example mapping:* `{"D:\\Serviio\\Serviio": "Z:\\"}`.
*   The client searches all arguments for `D:\Serviio\Serviio` and translates them to `Z:\` (e.g., `D:\Serviio\Serviio\temp\playlist.m3u8` becomes `Z:\temp\playlist.m3u8`).
*   The client automatically runs `os.makedirs` to create parent directories on the target network drive if they do not exist before starting the transcode, avoiding folder path write failures.

### C. GPU Parameter Compatibility Mapping
Standard CPU encoding options configured in Serviio cause failures when passed directly to hardware encoders. The client translates them on-the-fly:

1. **Preset Translation**:
   - **Nvidia NVENC**: Maps CPU presets (`ultrafast` to `veryslow`) to NVENC presets (`p1` to `p7`).
   - **AMD AMF**: Maps CPU presets to AMF presets (`speed`, `balanced`, `quality`).
2. **Quality Parameter Mapping (`-crf`)**:
   - Hardware encoders do not support Constant Rate Factor (`-crf`). The client automatically translates `-crf <val>` to Constant Quality target parameter `-cq <val>` for Nvidia NVENC and `-qp <val>` for AMD AMF.
3. **Profile and Level Stripping**:
   - GPU encoders do not support certain legacy CPU profiles (e.g. `baseline` profile is unsupported by NVENC) or syntax for levels.
   - When mapping to hardware encoders, the client **automatically strips out** `-profile`, `-profile:v`, `-level`, and `-level:v` parameters entirely. This allows the GPU drivers to dynamically negotiate the optimal profile and level.
