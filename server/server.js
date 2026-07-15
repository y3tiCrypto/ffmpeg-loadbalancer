const net = require('net');
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { version: VERSION } = require('./package.json');

const isWin = process.platform === 'win32';

// Configuration
const CONFIG = {
  HTTP_PORT: process.env.HTTP_PORT || 4000,
  TCP_PORT: process.env.TCP_PORT || 4001,
  // Path to the real FFmpeg executable on the server for local fallback
  FALLBACK_FFMPEG_PATH: process.env.FALLBACK_FFMPEG_PATH || (isWin ? path.join(__dirname, '..', 'client', 'bin', 'ffmpeg.exe') : "/usr/lib/serviio/bin/ffmpeg"),
  // Number of threads to allocate for local fallback FFmpeg (0 = auto)
  FALLBACK_FFMPEG_THREADS: parseInt(process.env.FALLBACK_FFMPEG_THREADS || "0", 10),
  // Mode: "stream" (server writes client stream to disk) or "shared_folder" (client writes directly)
  TRANSCODE_TEMP_MODE: process.env.TRANSCODE_TEMP_MODE || "stream",
  LOCAL_TEMP_DIR: process.env.LOCAL_TEMP_DIR || (isWin ? "C:\\Windows\\Temp\\serviio\\transcoding-temp" : "/tmp/serviio/transcoding-temp"),
  SHARED_TEMP_DIR: process.env.SHARED_TEMP_DIR || (isWin ? "\\\\127.0.0.1\\serviio-temp" : "/mnt/serviio-temp")
};

// Global State
const clients = new Map(); // wsClient -> { id, ip, status, hostname, capabilities, startTime }
const activeJobs = new Map(); // jobId -> { id, dummySocket, wsClient, status, args, originalArgs, startTime, fallbackProcess, outputStream }
const knownNodes = new Map(); // key (hostname/ip) -> { hostname, ip, capabilities, status, lastSeen }
let jobCounter = 0;
const systemLogs = [];

function logEvent(message) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${message}`;
  console.log(entry);
  systemLogs.push(entry);
  if (systemLogs.length > 100) {
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
  const nodes = Array.from(knownNodes.values()).map(n => ({
    ip: n.ip,
    hostname: n.hostname,
    os: n.os,
    status: n.status,
    capabilities: n.capabilities,
    activeJobsCount: n.activeJobsCount || 0,
    maxConcurrentJobs: n.maxConcurrentJobs || 1,
    lastSeen: n.lastSeen
  }));

  // Check how many local fallback jobs are running
  const localJobsCount = Array.from(activeJobs.values()).filter(j => !j.wsClient && j.status === 'transcoding').length;

  // Add the Local Server node itself
  nodes.push({
    ip: '127.0.0.1',
    hostname: 'Local Server',
    os: isWin ? 'Windows' : 'Linux',
    status: localJobsCount > 0 ? 'transcoding' : 'idle',
    capabilities: { cpu: true, nvidia: false, amd: false },
    activeJobsCount: localJobsCount,
    maxConcurrentJobs: 4, // Local fallback can handle up to 4 concurrent processes by default
    lastSeen: Date.now()
  });

  // Sort: online nodes first, then by lastSeen desc
  nodes.sort((a, b) => {
    if (a.status === 'offline' && b.status !== 'offline') return 1;
    if (a.status !== 'offline' && b.status === 'offline') return -1;
    return b.lastSeen - a.lastSeen;
  });

  const jobs = Array.from(activeJobs.values()).map(j => {
    let stats = j.stats || {};
    if (j.isCoalesced && j.parentJobId) {
      const parentJob = activeJobs.get(j.parentJobId);
      if (parentJob && parentJob.stats) {
        stats = parentJob.stats;
      }
    }
    return {
      id: j.id,
      status: j.status,
      node: j.wsClient ? clients.get(j.wsClient)?.hostname || 'Remote Node' : (j.isCoalesced ? `Coalesced -> ${j.parentJobId}` : 'Local Fallback'),
      args: j.args ? j.args.slice(1).join(' ') : '', // Skip original path
      startTime: j.startTime || Date.now(),
      stats
    };
  });

  res.json({
    version: VERSION,
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

// API: Get Serviio logs for debugging
app.get('/api/serviio-log', (req, res) => {
  const logPaths = [
    'D:\\Serviio\\Serviio\\log\\serviio.log',
    'C:\\Program Files\\Serviio\\log\\serviio.log',
    'C:\\Program Files\\Serviio\\bin\\..\\log\\serviio.log'
  ];
  for (const logPath of logPaths) {
    if (fs.existsSync(logPath)) {
      try {
        const logContent = fs.readFileSync(logPath, 'utf8');
        const lines = logContent.split('\n');
        return res.json({ path: logPath, lines: lines.slice(-150) });
      } catch (e) {
        return res.status(500).send(`Error reading log file: ${e.message}`);
      }
    }
  }
  res.status(404).send('Serviio log file not found');
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
    os: 'Unknown',
    capabilities: { cpu: true, nvidia: false, amd: false },
    maxConcurrentJobs: 1,
    activeJobsCount: 0,
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
          clientInfo.os = data.os || 'Unknown';
          clientInfo.maxConcurrentJobs = data.maxConcurrentJobs || 1;
          logEvent(`Registered node: ${clientInfo.hostname} (${ip}) - OS: ${clientInfo.os} - Caps: ${JSON.stringify(clientInfo.capabilities)} - MaxJobs: ${clientInfo.maxConcurrentJobs}`);
          
          // Update knownNodes registry
          const regKey = clientInfo.hostname === 'Unknown' ? ip : clientInfo.hostname;
          knownNodes.set(regKey, {
            hostname: clientInfo.hostname,
            ip: ip,
            os: clientInfo.os,
            capabilities: clientInfo.capabilities,
            maxConcurrentJobs: clientInfo.maxConcurrentJobs,
            activeJobsCount: 0,
            status: 'idle',
            lastSeen: Date.now()
          });

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
              percentage: data.percentage,
              transcodeMode: data.transcodeMode || 'cpu'
            };
            broadcastState();
          }
          break;

        case 'sync_file':
          if (data.folder && data.file && data.content) {
            try {
              const job = activeJobs.get(data.jobId);
              let destFile = null;
              if (job && job.originalOutputPath) {
                const baseDir = path.dirname(job.originalOutputPath);
                if (!fs.existsSync(baseDir)) {
                  fs.mkdirSync(baseDir, { recursive: true });
                }
                destFile = path.join(baseDir, data.file);
              } else {
                const destDir = path.join('D:\\Serviio\\Serviio', 'transcoding-temp-' + data.folder.replace('transcoding-temp-', ''));
                if (!fs.existsSync(destDir)) {
                  fs.mkdirSync(destDir, { recursive: true });
                }
                destFile = path.join(destDir, data.file);
              }
              const fileBuffer = Buffer.from(data.content, 'base64');
              fs.writeFileSync(destFile, fileBuffer);
            } catch (err) {
              console.error(`Error writing synced file ${data.file}:`, err.message);
            }
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
    
    // Mark in knownNodes as offline
    const discKey = clientInfo.hostname === 'Unknown' ? ip : clientInfo.hostname;
    const knownNode = knownNodes.get(discKey);
    if (knownNode) {
      knownNode.status = 'offline';
      knownNode.lastSeen = Date.now();
    }

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
      if (job.childSockets) {
        for (const childSocket of job.childSockets) {
          sendPacketToDummy(childSocket, PKT_STDOUT, data);
        }
      }
    }
  } else if (streamType === PKT_STDERR) {
    // Send stderr logs back to dummy's stderr
    sendPacketToDummy(job.dummySocket, PKT_STDERR, data);
    if (job.childSockets) {
      for (const childSocket of job.childSockets) {
        sendPacketToDummy(childSocket, PKT_STDERR, data);
      }
    }
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
const tcpServer = net.createServer({ allowHalfOpen: true }, (socket) => {
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
        if (job.isCoalesced) {
          const parentJob = activeJobs.get(job.parentJobId);
          if (parentJob && parentJob.childSockets) {
            parentJob.childSockets = parentJob.childSockets.filter(s => s !== socket);
          }
          activeJobs.delete(jobId);
        } else {
          if (job.wsClient) {
            job.wsClient.send(JSON.stringify({ type: 'stop_transcode', jobId }));
          } else if (job.fallbackProcess) {
            job.fallbackProcess.kill();
          }
          if (job.childSockets) {
            for (const childSocket of job.childSockets) {
              try { childSocket.destroy(); } catch (err) {}
            }
          }
          cleanupJob(jobId, 0);
        }
      }
    }
  });

  socket.on('error', (err) => {
    logEvent(`TCP socket error for job ${jobId}: ${err.message}`);
    const job = activeJobs.get(jobId);
    if (job) {
      if (job.isCoalesced) {
        const parentJob = activeJobs.get(job.parentJobId);
        if (parentJob && parentJob.childSockets) {
          parentJob.childSockets = parentJob.childSockets.filter(s => s !== socket);
        }
        activeJobs.delete(jobId);
      } else {
        if (job.wsClient) {
          job.wsClient.send(JSON.stringify({ type: 'stop_transcode', jobId }));
        } else if (job.fallbackProcess) {
          job.fallbackProcess.kill();
        }
        if (job.childSockets) {
          for (const childSocket of job.childSockets) {
            try { childSocket.destroy(); } catch (err) {}
          }
        }
        cleanupJob(jobId, 1);
      }
    }
  });
});

// Scheduling / Job start logic
function startJob(jobId, dummySocket, initData) {
  const originalArgs = [...initData.args];
  const cwd = initData.cwd;

  logEvent(`Started job ${jobId} with args: ${originalArgs.join(' ')}`);

  // Rewrite arguments
  const { rewrittenArgs, outputMode, originalOutputPath } = rewriteArgsForClients(originalArgs);

  // Coalesce duplicate transcode requests targeting the same output directory
  if (originalOutputPath && originalOutputPath.toLowerCase().includes('.stf')) {
    const outputDir = path.dirname(originalOutputPath);
    let existingJob = null;
    for (const [activeJobId, activeJob] of activeJobs.entries()) {
      if (activeJob.originalOutputPath && !activeJob.isCoalesced) {
        const activeOutputDir = path.dirname(activeJob.originalOutputPath);
        if (activeOutputDir.toLowerCase() === outputDir.toLowerCase()) {
          existingJob = activeJob;
          break;
        }
      }
    }

    if (existingJob) {
      logEvent(`Found duplicate job request ${jobId} for directory ${outputDir}. Coalescing into existing job ${existingJob.id}.`);
      const job = {
        id: jobId,
        dummySocket,
        isCoalesced: true,
        parentJobId: existingJob.id,
        status: 'coalesced',
        originalOutputPath,
        args: existingJob.args || [],
        startTime: Date.now(),
        stats: {}
      };
      activeJobs.set(jobId, job);

      if (!existingJob.childSockets) {
        existingJob.childSockets = [];
      }
      existingJob.childSockets.push(dummySocket);
      return; // Stop execution of new transcode
    }
  }

  // Find best available client
  let selectedWs = null;
  for (const [ws, info] of clients.entries()) {
    const activeCount = info.activeJobsCount || 0;
    const maxJobs = info.maxConcurrentJobs || 1;
    if (activeCount < maxJobs) {
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
    outputStream: null,
    originalOutputPath
  };

  activeJobs.set(jobId, job);

  if (selectedWs) {
    const info = clients.get(selectedWs);
    info.activeJobsCount = (info.activeJobsCount || 0) + 1;
    info.status = info.activeJobsCount >= info.maxConcurrentJobs ? 'busy' : 'idle';
    logEvent(`Assigned job ${jobId} to client: ${info.hostname} (${info.ip}) - Active jobs: ${info.activeJobsCount}/${info.maxConcurrentJobs}`);

    // Update knownNodes status
    const assignKey = info.hostname === 'Unknown' ? info.ip : info.hostname;
    const knownNode = knownNodes.get(assignKey);
    if (knownNode) {
      knownNode.activeJobsCount = info.activeJobsCount;
      knownNode.status = info.activeJobsCount >= info.maxConcurrentJobs ? 'busy' : 'idle';
      knownNode.lastSeen = Date.now();
    }

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

// Parse progress stats from local fallback FFmpeg stderr
function parseLocalFfmpegProgress(chunk, job) {
  if (!job.stderrBuffer) {
    job.stderrBuffer = '';
  }
  job.stderrBuffer += chunk;
  
  const lines = job.stderrBuffer.split(/\r?\n/);
  job.stderrBuffer = lines.pop() || '';
  
  for (const line of lines) {
    // Parse duration
    if (line.includes('Duration:')) {
      const match = line.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (match) {
        const hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);
        const seconds = parseInt(match[3], 10);
        job.durationSeconds = (hours * 3600) + (minutes * 60) + seconds;
      }
    }

    // Parse progress stats
    if (line.includes('frame=') || line.includes('size=')) {
      const frameMatch = line.match(/frame=\s*(\d+)/);
      const fpsMatch = line.match(/fps=\s*([\d.]+)/);
      const timeMatch = line.match(/time=\s*([\d:.]+)/);
      const speedMatch = line.match(/speed=\s*([\d.]+)x/);
      const bitrateMatch = line.match(/bitrate=\s*([\d.kmb/s]+)/);

      if (timeMatch) {
        if (!job.stats) job.stats = {};
        job.stats.time = timeMatch[1];
        job.stats.fps = fpsMatch ? parseInt(fpsMatch[1], 10) : 0;
        job.stats.speed = speedMatch ? `${speedMatch[1]}x` : 'N/A';
        job.stats.bitrate = bitrateMatch ? bitrateMatch[1] : 'N/A';
        job.stats.transcodeMode = 'cpu';

        // Calculate percentage
        const parts = timeMatch[1].split(':');
        if (parts.length === 3) {
          const secs = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
          if (job.durationSeconds && job.durationSeconds > 0) {
            job.stats.percentage = Math.min(100, Math.round((secs / job.durationSeconds) * 100));
          } else {
            job.stats.percentage = 0;
          }
        }
        broadcastState();
      }
    }
  }
}

// Execute FFmpeg locally on the server if no client nodes are connected
function runLocalFallback(jobId, args, cwd) {
  const job = activeJobs.get(jobId);
  if (!job) return;

  // Extract argument options (skip the first element which is the dummy's path)
  const procArgs = args.slice(1);
  if (!procArgs.includes('-stats')) {
    procArgs.unshift('-stats');
  }

  // Apply threads configuration if set in CONFIG
  if (CONFIG.FALLBACK_FFMPEG_THREADS > 0) {
    let threadsReplaced = false;
    for (let i = 0; i < procArgs.length - 1; i++) {
      if (procArgs[i] === '-threads') {
        procArgs[i + 1] = CONFIG.FALLBACK_FFMPEG_THREADS.toString();
        threadsReplaced = true;
        break;
      }
    }
    if (!threadsReplaced) {
      procArgs.unshift(CONFIG.FALLBACK_FFMPEG_THREADS.toString());
      procArgs.unshift('-threads');
    }
    // Add -filter_threads to enable multi-threaded scaling
    procArgs.unshift(CONFIG.FALLBACK_FFMPEG_THREADS.toString());
    procArgs.unshift('-filter_threads');
  }

  logEvent(`Executing fallback FFmpeg: "${CONFIG.FALLBACK_FFMPEG_PATH}" ${procArgs.join(' ')}`);

  const ffmpegProc = spawn(CONFIG.FALLBACK_FFMPEG_PATH, procArgs, { cwd });
  job.fallbackProcess = ffmpegProc;

  ffmpegProc.stdout.on('data', (data) => {
    sendPacketToDummy(job.dummySocket, PKT_STDOUT, data);
    if (job.childSockets) {
      for (const childSocket of job.childSockets) {
        sendPacketToDummy(childSocket, PKT_STDOUT, data);
      }
    }
  });

  ffmpegProc.stderr.on('data', (data) => {
    const text = data.toString('utf8');
    if (!job.fallbackStderrLines) {
      job.fallbackStderrLines = 0;
    }
    if (job.fallbackStderrLines < 20) {
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (line.trim() && job.fallbackStderrLines < 20) {
          logEvent(`[Fallback stderr] ${line.trim()}`);
          job.fallbackStderrLines++;
        }
      }
    }

    sendPacketToDummy(job.dummySocket, PKT_STDERR, data);
    if (job.childSockets) {
      for (const childSocket of job.childSockets) {
        sendPacketToDummy(childSocket, PKT_STDERR, data);
      }
    }
    parseLocalFfmpegProgress(text, job);
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

  // Convert exitCode to signed 32-bit integer to prevent Node.js RangeErrors
  const cleanExitCode = typeof exitCode === 'number' ? (exitCode | 0) : 0;
  logEvent(`Job ${jobId} finished with exit code ${cleanExitCode}`);

  try {
    // Send exit code packet back to dummy
    const codeBuf = Buffer.alloc(4);
    codeBuf.writeInt32BE(cleanExitCode, 0);
    sendPacketToDummy(job.dummySocket, PKT_EXIT, codeBuf);

    // Notify any coalesced child sockets as well!
    if (job.childSockets) {
      for (const childSocket of job.childSockets) {
        if (childSocket && !childSocket.destroyed) {
          sendPacketToDummy(childSocket, PKT_EXIT, codeBuf);
        }
      }
    }
  } catch (err) {
    logEvent(`Error sending exit packet for job ${jobId}: ${err.message}`);
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
      info.activeJobsCount = Math.max(0, (info.activeJobsCount || 0) - 1);
      info.status = info.activeJobsCount >= info.maxConcurrentJobs ? 'busy' : 'idle';
      logEvent(`Released job ${jobId} from client: ${info.hostname} (${info.ip}) - Active jobs: ${info.activeJobsCount}/${info.maxConcurrentJobs}`);

      // Update knownNodes status
      const cleanKey = info.hostname === 'Unknown' ? info.ip : info.hostname;
      const knownNode = knownNodes.get(cleanKey);
      if (knownNode) {
        knownNode.activeJobsCount = info.activeJobsCount;
        knownNode.status = info.activeJobsCount >= info.maxConcurrentJobs ? 'busy' : 'idle';
        knownNode.lastSeen = Date.now();
      }
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

  // Close and cleanup child sockets
  if (job.childSockets) {
    for (const childSocket of job.childSockets) {
      if (childSocket && !childSocket.destroyed) {
        try {
          childSocket.destroy();
        } catch (err) {}
      }
    }
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
