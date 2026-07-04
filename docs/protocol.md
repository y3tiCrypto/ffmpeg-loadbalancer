# Protocol Specification

This document details the communication protocols used between the components in the load-balanced transcoder cluster.

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

> [!NOTE]
> **Cross-Version Compatibility**: WebSocket callback handlers on the client are designed with variable argument signatures (`*args` and `**kwargs`) to accommodate differences in argument parameters between `websocket-client` library versions (e.g. `on_close` and `on_open` changes in version `0.x` vs `1.x`).

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

#### 3. Transcode Progress (`type: progress`)
Sent by the client periodically during transcoding.
```json
{
  "type": "progress",
  "jobId": "job_12_4821",
  "fps": 52.4,
  "speed": 2.15,
  "bitrate": "1840kbits/s",
  "time": "00:03:14.20",
  "percentage": 14
}
```

#### 4. Transcode Stop (`type: stop_transcode`)
Sent by the server to abort a transcoding task on the client.
```json
{
  "type": "stop_transcode",
  "jobId": "job_12_4821"
}
```

#### 5. Job Exit (`type: exit`)
Sent by the client when the FFmpeg process terminates.
```json
{
  "type": "exit",
  "jobId": "job_12_4821",
  "exitCode": 0
}
```

#### 6. Stdin Forwarding (`type: stdin`)
Sent by the server to relay raw stdin stream chunks from the dummy process to the client process.
```json
{
  "type": "stdin",
  "jobId": "job_12_4821",
  "data": "base64_encoded_payload..."
}
```

### B. Binary Frames (Relaying Stdout/Stderr Data)
To achieve fast performance and bypass JSON serialization overhead, output stream chunks (stdout/stderr) are sent from the client as binary WebSocket frames.

#### Binary Frame Format
```text
+-------------------+----------------------------+-----------------------+-------------------------+
| Job ID Length     | Job ID String              | Stream Type (1 byte)  | Raw Stream Chunk Data   |
| (1 byte, UInt8)   | (N bytes, UTF-8 encoded)   | (0x03=out, 0x04=err)  | (M bytes)               |
+-------------------+----------------------------+-----------------------+-------------------------+
```
- **Job ID Length (Byte 0)**: Number of bytes in the job ID string (e.g. `12`).
- **Job ID String**: UTF-8 bytes corresponding to the jobId.
- **Stream Type**:
  - `0x03`: Stdout chunk. Relayed to the local temp file (in `"stream"` mode) or written back to the dummy's stdout.
  - `0x04`: Stderr chunk. Relayed back to the dummy's stderr and printed in the server dashboard logs.
- **Raw Stream Chunk Data**: Remaining payload bytes.
