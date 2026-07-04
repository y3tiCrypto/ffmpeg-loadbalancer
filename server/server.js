const net = require('net');
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// Configuration
const CONFIG = {
  HTTP_PORT: process.env.HTTP_PORT || 4000,
  TCP_PORT: process.env.TCP_PORT || 4001,
  // Path to the real FFmpeg executable on the server for local fallback
  FALLBACK_FFMPEG_PATH: process.env.FALLBACK_FFMPEG_PATH || "C:\\Program Files\\Serviio\\lib\\ffmpeg.exe",
  // Mode: "stream" (server writes client stream to disk) or "shared_folder" (client writes directly)
  TRANSCODE_TEMP_MODE: process.env.TRANSCODE_TEMP_MODE || "stream",
  LOCAL_TEMP_DIR: process.env.LOCAL_TEMP_DIR || "C:\\Windows\\Temp\\serviio\\transcoding-temp",
  SHARED_TEMP_DIR: process.env.SHARED_TEMP_DIR || "\\\\127.0.0.1\\serviio-temp"
};

// Global State
const clients = new Map(); // wsClient -> { id, ip, status, hostname, capabilities, startTime }
const activeJobs = new Map(); // jobId -> { id, dummySocket, wsClient, status, args, originalArgs, startTime, fallbackProcess, outputStream }
let jobCounter = 0;
const systemLogs = [];

function logEvent(message) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${message}`;
  console.log(entry);
  systemLogs.push(entry);
  if (systemLogs.length > 500) {
    systemLogs.shift();
  }
  broadcastState();
}

// Get the local IPv4 address
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const SERVER_IP = getLocalIp();
logEvent(`Server IP detected: ${SERVER_IP}`);

// Packet Types
const PKT_INIT   = 0x01;
const PKT_STDIN  = 0x02;
const PKT_STDOUT = 0x03;
const PKT_STDERR = 0x04;
const PKT_EXIT   = 0x05;

// Packet Serialization Helper
function createPacket(type, payload) {
  const header = Buffer.alloc(5);
  header[0] = type;
  if (payload) {
    header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([header, payload]);
  } else {
    header.writeUInt32BE(0, 1);
    return header;
  }
}

// Setup Express and HTTP Server
const app = express();
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API: Get status data for Dashboard
app.get('/api/status', (req, res) => {
  const nodes = Array.from(clients.values()).map(c => ({
    id: c.id,
    ip: c.ip,
    hostname: c.hostname,
    status: c.status,
    capabilities: c.capabilities,
    startTime: c.startTime
  }));

  const jobs = Array.from(activeJobs.values()).map(j => ({
    id: j.id,
    status: j.status,
    node: j.wsClient ? clients.get(j.wsClient)?.hostname || 'Remote Node' : 'Local Fallback',
    args: j.args.slice(1).join(' '), // Skip original path
    startTime: j.startTime,
    stats: j.stats || {}
  }));

  res.json({
    config: CONFIG,
    serverIp: SERVER_IP,
    nodes,
    jobs,
    logs: systemLogs
  });
});

// API: Media range-request server
app.get('/api/media', (req, res) => {
  const filePath = req.query.file;
  if (!filePath) {
    return res.status(400).send('Missing file parameter');
  }

  try {
    if (!fs.existsSync(filePath)) {
      logEvent(`[Media Server] File not found: ${filePath}`);
      return res.status(404).send('File not found');
    }

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      return res.status(400).send('Cannot stream directory');
    }

    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize) {
        res.status(416).send(`Range Not Satisfiable: ${start} >= ${fileSize}`);
        return;
      }

      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(filePath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/octet-stream',
      };

      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': 'video/octet-stream',
      };
      res.writeHead(200, head);
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    logEvent(`[Media Server] Error reading file ${filePath}: ${err.message}`);
    res.status(500).send('Server Error');
  }
});

// Upgrade HTTP to WebSocket for client connections
httpServer.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// WebSocket Server Logic (Transcoder Client Nodes)
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress.replace(/^.*:/, '');
  const clientInfo = {
    id: `node_${Math.random().toString(36).substring(2, 9)}`,
    ip,
    status: 'idle',
    hostname: 'Unknown',
    capabilities: { cpu: true, nvidia: false, amd: false },
    startTime: Date.now()
  };

  clients.set(ws, clientInfo);
  logEvent(`New client connection from ${ip}`);

  ws.on('message', (message, isBinary) => {
    try {
      // Handle Binary Stream (FFmpeg output relay)
      if (isBinary) {
        handleClientStream(message);
        return;
      }

      // Handle Text Message (Control/Status)
      const data = JSON.parse(message.toString());
      switch (data.type) {
        case 'register':
          clientInfo.hostname = data.hostname || clientInfo.hostname;
          clientInfo.capabilities = data.capabilities || clientInfo.capabilities;
          logEvent(`Registered node: ${clientInfo.hostname} (${ip}) - Caps: ${JSON.stringify(clientInfo.capabilities)}`);
          broadcastState();
          break;

        case 'progress':
          const job = activeJobs.get(data.jobId);
          if (job) {
            job.stats = {
              fps: data.fps,
              speed: data.speed,
              bitrate: data.bitrate,
              time: data.time,
              percentage: data.percentage
            };
            broadcastState();
          }
          break;

        case 'exit':
          handleJobEnd(data.jobId, data.exitCode);
          break;
      }
    } catch (err) {
      logEvent(`Error parsing WebSocket message from ${ip}: ${err.message}`);
    }
  });

  ws.on('close', () => {
    logEvent(`Client disconnected: ${clientInfo.hostname} (${ip})`);
    clients.delete(ws);

    // Cancel any active jobs on this client
    for (const [jobId, job] of activeJobs.entries()) {
      if (job.wsClient === ws) {
        logEvent(`Job ${jobId} failed: Client disconnected during transcode.`);
        cleanupJob(jobId, 1); // Exit with error
      }
    }
    broadcastState();
  });
});

// Relay binary stream chunk (stdout/stderr) from Client to Dummy socket or file
function handleClientStream(buffer) {
  if (buffer.length < 2) return;

  const jobIdLen = buffer[0];
  const jobId = buffer.toString('utf8', 1, 1 + jobIdLen);
  const streamType = buffer[1 + jobIdLen];
  const data = buffer.subarray(2 + jobIdLen);

  const job = activeJobs.get(jobId);
  if (!job) return;

  if (streamType === PKT_STDOUT) {
    if (job.outputStream) {
      job.outputStream.write(data);
    } else {
      // Send directly back to dummy's stdout
      sendPacketToDummy(job.dummySocket, PKT_STDOUT, data);
    }
  } else if (streamType === PKT_STDERR) {
    // Send stderr logs back to dummy's stderr
    sendPacketToDummy(job.dummySocket, PKT_STDERR, data);
  }
}

// Broadcaster to all Admin UI connections
function broadcastState() {
  // Can be implemented if Admin UI uses WebSockets, but we'll use SSE or polling for simplicity.
  // We will serve HTTP endpoints.
}

// Helper: send TCP packet to Dummy FFmpeg
function sendPacketToDummy(socket, type, payload) {
  if (socket && !socket.destroyed) {
    try {
      socket.write(createPacket(type, payload));
    } catch (err) {
      console.error('Error writing packet to dummy:', err.message);
    }
  }
}

// TCP Server Logic (Local Dummy FFmpeg Executions)
const tcpServer = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  let jobId = null;

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    processPackets();
  });

  function processPackets() {
    while (buffer.length >= 5) {
      const type = buffer[0];
      const length = buffer.readUInt32BE(1);

      if (buffer.length < 5 + length) {
        break; // Incomplete packet
      }

      const payload = buffer.subarray(5, 5 + length);
      buffer = buffer.subarray(5 + length);

      if (type === PKT_INIT) {
        try {
          const initData = JSON.parse(payload.toString());
          jobId = `job_${++jobCounter}_${Date.now().toString().slice(-4)}`;
          startJob(jobId, socket, initData);
        } catch (err) {
          logEvent(`TCP init failed to parse JSON: ${err.message}`);
          socket.destroy();
        }
      } else if (type === PKT_STDIN) {
        const job = activeJobs.get(jobId);
        if (job) {
          if (job.wsClient) {
            // Forward stdin to remote client
            const wsPayload = JSON.stringify({ type: 'stdin', jobId, data: payload.toString('base64') });
            job.wsClient.send(wsPayload);
          } else if (job.fallbackProcess) {
            // Forward stdin to local fallback process
            job.fallbackProcess.stdin.write(payload);
          }
        }
      }
    }
  }

  socket.on('close', () => {
    if (jobId) {
      const job = activeJobs.get(jobId);
      if (job) {
        logEvent(`Dummy FFmpeg connection closed for job ${jobId}`);
        // If the dummy socket is closed, make sure the client stops transcoding
        if (job.wsClient) {
          job.wsClient.send(JSON.stringify({ type: 'stop_transcode', jobId }));
        } else if (job.fallbackProcess) {
          job.fallbackProcess.kill();
        }
        cleanupJob(jobId, 0);
      }
    }
  });

  socket.on('error', (err) => {
    logEvent(`TCP socket error for job ${jobId}: ${err.message}`);
  });
});

// Scheduling / Job start logic
function startJob(jobId, dummySocket, initData) {
  const originalArgs = [...initData.args];
  const cwd = initData.cwd;

  logEvent(`Started job ${jobId} with args: ${originalArgs.join(' ')}`);

  // Rewrite arguments
  const { rewrittenArgs, outputMode, originalOutputPath } = rewriteArgsForClients(originalArgs);

  // Find best available client
  let selectedWs = null;
  for (const [ws, info] of clients.entries()) {
    if (info.status === 'idle') {
      selectedWs = ws;
      break;
    }
  }

  const job = {
    id: jobId,
    dummySocket,
    wsClient: selectedWs,
    status: 'transcoding',
    args: rewrittenArgs,
    originalArgs,
    startTime: Date.now(),
    stats: {},
    outputStream: null
  };

  activeJobs.set(jobId, job);

  if (selectedWs) {
    const info = clients.get(selectedWs);
    info.status = 'transcoding';
    logEvent(`Assigned job ${jobId} to client: ${info.hostname} (${info.ip})`);

    // Prepare local output stream if we are streaming the output back
    if (outputMode === 'stream' && originalOutputPath) {
      try {
        const dir = path.dirname(originalOutputPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        job.outputStream = fs.createWriteStream(originalOutputPath);
        logEvent(`[Server] Streaming output to local file: ${originalOutputPath}`);
      } catch (err) {
        logEvent(`Failed to create output file write stream: ${err.message}`);
        cleanupJob(jobId, 1);
        return;
      }
    }

    // Send transcode task to client
    selectedWs.send(JSON.stringify({
      type: 'start_transcode',
      jobId,
      args: rewrittenArgs,
      outputMode,
      outputPath: originalOutputPath
    }));
  } else {
    // Fallback to local execution
    logEvent(`No remote transcode nodes available. Falling back to local execution...`);
    job.status = 'local_fallback';
    runLocalFallback(jobId, originalArgs, cwd);
  }
}

// Rewrite FFmpeg arguments for remote client execution
function rewriteArgsForClients(args) {
  const rewrittenArgs = [...args];
  let outputMode = CONFIG.TRANSCODE_TEMP_MODE;
  let originalOutputPath = null;

  // HLS cannot be piped via stdout. Force shared_folder mode if HLS is detected.
  const isHls = args.some(arg => arg.toLowerCase().includes('hls'));
  if (isHls && outputMode === 'stream') {
    outputMode = 'shared_folder';
    logEvent(`HLS output detected. Forcing shared_folder mode because HLS cannot be piped to stdout.`);
  }

  // 1. Identify and rewrite input files (-i)
  for (let i = 0; i < rewrittenArgs.length; i++) {
    if (rewrittenArgs[i] === '-i') {
      const inputPath = rewrittenArgs[i + 1];
      if (inputPath && !inputPath.startsWith('http://') && !inputPath.startsWith('https://') && inputPath !== '-' && !inputPath.startsWith('pipe:')) {
        // Rewrite local path to Server HTTP Stream URL
        const encPath = encodeURIComponent(inputPath);
        rewrittenArgs[i + 1] = `http://${SERVER_IP}:${CONFIG.HTTP_PORT}/api/media?file=${encPath}`;
        logEvent(`Rewrote input path: ${inputPath} -> ${rewrittenArgs[i + 1]}`);
      }
    }
  }

  // 2. Identify output file (usually the last argument)
  if (rewrittenArgs.length > 1) {
    const lastArg = rewrittenArgs[rewrittenArgs.length - 1];
    if (!lastArg.startsWith('-') && !lastArg.startsWith('tcp://') && !lastArg.startsWith('udp://') && !lastArg.startsWith('pipe:') && lastArg !== '-') {
      originalOutputPath = lastArg;

      if (outputMode === 'stream') {
        // Force output to stdout (pipe:1), and server will write to disk
        rewrittenArgs[rewrittenArgs.length - 1] = 'pipe:1';
        logEvent(`Output set to stream-back mode. Rewriting output argument to pipe:1.`);
      } else if (outputMode === 'shared_folder') {
        // Replace local temp directory with network share path
        if (lastArg.startsWith(CONFIG.LOCAL_TEMP_DIR)) {
          const relativePart = lastArg.substring(CONFIG.LOCAL_TEMP_DIR.length);
          rewrittenArgs[rewrittenArgs.length - 1] = path.join(CONFIG.SHARED_TEMP_DIR, relativePart).replace(/\\/g, '/');
          logEvent(`Shared folder mode: rewrote output path: ${lastArg} -> ${rewrittenArgs[rewrittenArgs.length - 1]}`);
        }
      }
    }
  }

  return { rewrittenArgs, outputMode, originalOutputPath };
}

// Execute FFmpeg locally on the server if no client nodes are connected
function runLocalFallback(jobId, args, cwd) {
  const job = activeJobs.get(jobId);
  if (!job) return;

  // Extract argument options (skip the first element which is the dummy's path)
  const procArgs = args.slice(1);

  logEvent(`Executing fallback FFmpeg: "${CONFIG.FALLBACK_FFMPEG_PATH}" ${procArgs.join(' ')}`);

  const ffmpegProc = spawn(CONFIG.FALLBACK_FFMPEG_PATH, procArgs, { cwd });
  job.fallbackProcess = ffmpegProc;

  ffmpegProc.stdout.on('data', (data) => {
    sendPacketToDummy(job.dummySocket, PKT_STDOUT, data);
  });

  ffmpegProc.stderr.on('data', (data) => {
    sendPacketToDummy(job.dummySocket, PKT_STDERR, data);
  });

  ffmpegProc.on('close', (code) => {
    logEvent(`Local fallback FFmpeg closed with exit code ${code}`);
    handleJobEnd(jobId, code);
  });

  ffmpegProc.on('error', (err) => {
    logEvent(`Local fallback FFmpeg startup error: ${err.message}`);
    handleJobEnd(jobId, 1);
  });
}

// Handle transcode end from Client / Fallback
function handleJobEnd(jobId, exitCode) {
  const job = activeJobs.get(jobId);
  if (!job) return;

  const cleanExitCode = typeof exitCode === 'number' ? exitCode : 0;
  logEvent(`Job ${jobId} finished with exit code ${cleanExitCode}`);

  try {
    // Send exit code packet back to dummy
    const codeBuf = Buffer.alloc(4);
    codeBuf.writeInt32BE(cleanExitCode, 0);
    sendPacketToDummy(job.dummySocket, PKT_EXIT, codeBuf);
  } catch (err) {
    logEvent(`Error sending exit packet to dummy for job ${jobId}: ${err.message}`);
  }

  cleanupJob(jobId, cleanExitCode);
}

// Cleanup and free resources
function cleanupJob(jobId, exitCode) {
  const job = activeJobs.get(jobId);
  if (!job) return;

  // Free client status
  if (job.wsClient) {
    const info = clients.get(job.wsClient);
    if (info) {
      info.status = 'idle';
    }
  }

  // Close output stream
  if (job.outputStream) {
    try {
      job.outputStream.end();
    } catch (err) {
      console.error('Error closing file write stream:', err.message);
    }
  }

  // Close dummy socket
  if (job.dummySocket && !job.dummySocket.destroyed) {
    try {
      job.dummySocket.destroy();
    } catch (err) {}
  }

  activeJobs.delete(jobId);
  broadcastState();
}

// Start Servers
httpServer.listen(CONFIG.HTTP_PORT, () => {
  logEvent(`Web UI & WebSocket Server listening on http://0.0.0.0:${CONFIG.HTTP_PORT}`);
});

tcpServer.listen(CONFIG.TCP_PORT, '127.0.0.1', () => {
  logEvent(`TCP Server listening locally on 127.0.0.1:${CONFIG.TCP_PORT}`);
});
