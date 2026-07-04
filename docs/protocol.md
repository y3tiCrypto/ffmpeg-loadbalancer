# Protocol & Parameter Translation Specification

This document details the communication framing, data structures, and dynamic argument translations utilized across the distributed transcoding cluster.

---

## 1. TCP Loopback Protocol (Wrapper &leftrightarrow; Server)

The compiled C++ dummy binary communicates with the Load Balancer Server over a local TCP loopback connection on port `4001`.

### A. Packet Frame Structure
Every packet is binary-framed to prevent stream fragmentation issues:

```text
+-------------------+---------------------------+---------------------------------+
| Type ID (1 byte)  | Payload Length (4 bytes)  | Payload Data (N bytes)          |
|                   | (Big-Endian UInt32)       |                                 |
+-------------------+---------------------------+---------------------------------+
```

### B. Packet Types

| Type ID | Packet Name | Data Direction | Payload Description |
| :--- | :--- | :--- | :--- |
| **`0x01`** | **INIT** | Wrapper &rarr; Server | UTF-8 JSON payload defining execution parameters. <br>Format: `{"cwd": "working_directory", "args": ["arg1", "arg2", ...]}` |
| **`0x02`** | **STDIN** | Wrapper &rarr; Server | Raw binary bytes read from the wrapper's standard input. |
| **`0x03`** | **STDOUT** | Server &rarr; Wrapper | Raw transcoded stream bytes written directly to the wrapper's stdout. |
| **`0x04`** | **STDERR** | Server &rarr; Wrapper | Diagnostics and frame progress bytes relayed to the wrapper's stderr. |
| **`0x05`** | **EXIT** | Server &rarr; Wrapper | 4-byte big-endian signed integer representing the exit code. The wrapper shuts down with this status. |

---

## 2. WebSocket Protocol (Client &leftrightarrow; Server)

Transcoder Client nodes connect to the server via WebSockets (`ws://<server_ip>:4000/ws`) using a dual JSON/binary payload channel.

> [!NOTE]
> **Cross-Version API Compatibility**: Client callbacks use variable parameters (`*args`, `**kwargs`) to remain fully compatible across various Python `websocket-client` library versions (specifically `0.x` and `1.x` series releases).

### A. Client Node Registration (`type: register`)
Sent by the client node immediately upon connection:
```json
{
  "type": "register",
  "hostname": "ClientNode1",
  "os": "Windows",
  "capabilities": {
    "cpu": true,
    "nvidia": true,
    "amd": false
  }
}
```

### B. Job Dispatch Command (`type: start_transcode`)
Sent by the server to initiate transcoding on the client:
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

## 3. Server HTTP Dashboard Status API (`GET /api/status`)

Used by the Web Dashboard to monitor active transcodes, client statuses, and cluster history:

```json
{
  "version": "1.0.0",
  "config": {
    "HTTP_PORT": 4000,
    "TCP_PORT": 4001,
    "FALLBACK_FFMPEG_PATH": "C:\\Program Files\\Serviio\\lib\\ffmpeg.exe",
    "TRANSCODE_TEMP_MODE": "stream",
    "LOCAL_TEMP_DIR": "C:\\Windows\\Temp\\serviio\\transcoding-temp",
    "SHARED_TEMP_DIR": "\\\\127.0.0.1\\serviio-temp"
  },
  "serverIp": "192.168.1.141",
  "nodes": [
    {
      "ip": "192.168.1.37",
      "hostname": "Y3TI",
      "os": "Windows",
      "status": "idle",
      "capabilities": { "cpu": true, "nvidia": true, "amd": false },
      "lastSeen": 1720120194821
    }
  ],
  "jobs": [
    {
      "id": "job_2_0160",
      "status": "transcoding",
      "node": "Y3TI",
      "args": "-threads 0 -i http://...",
      "startTime": 1720120194000,
      "stats": {
        "fps": 54,
        "speed": "2.3x",
        "time": "00:01:23.00",
        "percentage": 5
      }
    }
  ],
  "logs": [
    "[2026-07-04T18:55:08.123Z] Registered node: Y3TI (192.168.1.37)"
  ]
}
```

---

## 4. Parameter & Path Translations

The cluster implements real-time parser translation layers to optimize commands for network execution and GPU hardware constraints.

### A. Automatic HLS Redirection
Because Apple HTTP Live Streaming (HLS) generates multiple sequential segment files and a dynamically updated playlist, it cannot be written to a single stdout pipe (`pipe:1`).
*   **Interception**: The server scans incoming parameters. If HLS keys are detected (e.g. `-f hls` or `-hls_segment_filename`), it overrides settings and forces the execution to **`"shared_folder"`** mode.
*   **Result**: The wrapper keeps its standard output pipeline open while the remote client writes segment chunks directly to the shared network folders.

### B. Client-Side Path Translation (`pathMappings`)
In shared-folder mode, clients map the server's local path structure to their local network mounts using the `pathMappings` JSON dictionary:
*   *Mapping Example*: `{"D:\\Serviio\\Serviio": "Z:\\"}`
*   *Result*: An argument path like `D:\Serviio\Serviio\temp\pl.m3u8` is translated on-the-fly to `Z:\temp\pl.m3u8`.
*   *Safety*: The client automatically calls `os.makedirs` on parent directories prior to running the transcode process to avoid write-access failures on newly generated directories.

### C. GPU Compatibility Mapping
Standard CPU parameters configured by media servers fail when passed directly to hardware-accelerated encoders. The client translates these command line arguments dynamically:

1.  **Preset Conversion**:
    *   **Nvidia NVENC**: Remaps CPU speed presets (`ultrafast` through `veryslow`) to NVENC presets (`p1` through `p7`).
    *   **AMD AMF**: Remaps CPU speed presets to AMF parameters (`speed`, `balanced`, or `quality`).
2.  **Constant Quality Conversion (`-crf`)**:
    *   Since GPU encoders do not support Constant Rate Factor parameters directly, the client converts `-crf <val>` to Constant Quality targets (`-cq <val>` for Nvidia NVENC and `-qp <val>` for AMD AMF).
3.  **Incompatible Argument Stripping**:
    *   GPU encoders crash if passed conflicting profiles or levels (e.g., NVENC does not support `-profile:v baseline -level 3`).
    *   When GPU modes are active, the client automatically strips `-profile`, `-profile:v`, `-level`, and `-level:v` parameters, letting the hardware driver negotiate the optimal settings.
