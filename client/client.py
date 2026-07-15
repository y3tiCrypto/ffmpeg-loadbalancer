import sys
import os
import json
import time
import socket
import re
import shutil
import subprocess
import threading
import base64
import traceback

ws_lock = threading.Lock()

def safe_send(payload, opcode=None):
    global ws
    if not ws:
        return False
    try:
        with ws_lock:
            if opcode is not None:
                ws.send(payload, opcode=opcode)
            else:
                ws.send(payload)
        return True
    except Exception as e:
        log_event(f"Error in safe_send: {e}")
        return False

def log_event(msg):
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    log_line = f"[{timestamp}] {msg}\n"
    print(msg)
    if 'config' in globals() and not config.get("enableDebugLog", False):
        return
    try:
        log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "client.log")
        with open(log_path, "a") as f:
            f.write(log_line)
    except Exception:
        pass

# Attempt to load GUI dependencies
HAS_GUI = False
try:
    import tkinter as tk
    from tkinter import messagebox
    import pystray
    from PIL import Image, ImageDraw
    HAS_GUI = True
except ImportError:
    pass

# Global Config Defaults
config = {
  "serverUrl": "ws://127.0.0.1:4000/ws",
  "ffmpegPath": "ffmpeg",
  "transcoderMode": "nvidia",
  "enableUi": True,
  "codecMappings": {
    "nvidia": {
      "libx264": "h264_nvenc",
      "h264": "h264_nvenc",
      "libx265": "hevc_nvenc",
      "hevc": "hevc_nvenc"
    },
    "amd": {
      "libx264": "h264_amf",
      "h264": "h264_amf",
      "libx265": "hevc_amf",
      "hevc": "hevc_amf"
    }
  }
}

# Load config if exists
config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
if os.path.exists(config_path):
    try:
        with open(config_path, "r") as f:
            config.update(json.load(f))
    except Exception as e:
        print(f"Error loading config.json: {e}")

# Client State
client_active_jobs = {} # jobId -> jobInfo (args, process, thread, fps, speed, time, percentage, fileName)
ws = None
hostname = socket.gethostname()

# Detect hardware capabilities
def detect_capabilities():
    caps = {"cpu": True, "nvidia": False, "amd": False}
    # Check Nvidia
    if shutil.which("nvidia-smi") is not None:
        caps["nvidia"] = True
    # Check AMD (Windows query)
    try:
        if sys.platform == "win32":
            out = subprocess.check_output("wmic path win32_VideoController get name", shell=True).decode()
            if "AMD" in out or "Radeon" in out:
                caps["amd"] = True
        else:
            out = subprocess.check_output("lspci", shell=True).decode()
            if "AMD" in out or "Advanced Micro Devices" in out:
                caps["amd"] = True
    except Exception:
        pass
    return caps

capabilities = detect_capabilities()
print(f"Hardware Capabilities: {capabilities}")
print(f"Active Transcode Mode: {config['transcoderMode']}")

# Helper to generate the tray icon image programmatically
def create_icon_image():
    if not HAS_GUI:
        return None
    image = Image.new('RGBA', (64, 64), color=(0, 0, 0, 0))
    dc = ImageDraw.Draw(image)
    # Deep purple square
    dc.rounded_rectangle([4, 4, 60, 60], radius=12, fill=(21, 15, 48, 255), outline=(157, 78, 221, 255), width=3)
    # Neon play triangle
    dc.polygon([(24, 18), (24, 46), (46, 32)], fill=(0, 210, 255, 255))
    return image

# Tkinter status Overlay Window class
class StatusOverlay:
    def __init__(self, root_tk):
        self.root = root_tk
        self.window = tk.Toplevel(self.root)
        self.window.overrideredirect(True)
        self.window.attributes("-topmost", True)
        self.window.configure(bg="#150f30")
        
        # Add thin border outline
        self.window.bind("<Map>", lambda e: self.window.config(highlightbackground="#9d4edd", highlightcolor="#9d4edd", highlightthickness=1))

        self.width = 320
        self.height = 140
        self.visible = False
        self.manually_opened = False
        self.hide()

        # Build Widgets
        self.title_label = tk.Label(self.window, text="FFmpeg Transcoder", fg="#00d2ff", bg="#150f30", font=("Outfit", 12, "bold"))
        self.title_label.pack(anchor="w", padx=15, pady=5)

        self.job_label = tk.Label(self.window, text="Preparing transcode...", fg="#f3f0fc", bg="#150f30", font=("Outfit", 10), wraplength=290, justify="left")
        self.job_label.pack(anchor="w", padx=15, pady=2)

        # Progress bar
        self.canvas = tk.Canvas(self.window, height=8, bg="#0d0b18", highlightthickness=0)
        self.canvas.pack(fill="x", padx=15, pady=5)

        self.stats_label = tk.Label(self.window, text="FPS: - | Speed: - | Progress: -", fg="#a39cb4", bg="#150f30", font=("Outfit", 8))
        self.stats_label.pack(anchor="w", padx=15, pady=5)

        # Bind double-click to hide the overlay easily
        self.window.bind("<Double-1>", lambda e: self.hide())
        self.title_label.bind("<Double-1>", lambda e: self.hide())
        self.job_label.bind("<Double-1>", lambda e: self.hide())
        self.stats_label.bind("<Double-1>", lambda e: self.hide())
        self.canvas.bind("<Double-1>", lambda e: self.hide())

        # Show hand cursor on hover to signify clickability
        self.window.config(cursor="hand2")
        self.title_label.config(cursor="hand2")
        self.job_label.config(cursor="hand2")
        self.stats_label.config(cursor="hand2")
        self.canvas.config(cursor="hand2")

    def show(self, manual=False):
        if manual:
            self.manually_opened = True
        # Position in bottom-right corner
        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        x = sw - self.width - 20
        y = sh - self.height - 60 # offset for taskbar
        self.window.geometry(f"{self.width}x{self.height}+{x}+{y}")
        self.window.deiconify()
        self.visible = True

    def hide(self):
        self.window.withdraw()
        self.visible = False
        self.manually_opened = False

    def update_idle_state(self):
        self.job_label.config(text="Status: Idle\nAwaiting transcoding tasks...")
        self.stats_label.config(text=f"Mode: {config.get('transcoderMode', 'cpu').upper()} | Host: {hostname}")
        self.canvas.delete("all")

    def update_jobs(self, active_jobs):
        if not active_jobs:
            self.hide()
            return

        # Show the first active job details
        job_id = list(active_jobs.keys())[0]
        job = active_jobs[job_id]
        
        self.job_label.config(text=f"Converting: {job.get('fileName', 'Unknown File')}")
        
        pct = job.get("percentage", 0)
        fps = job.get("fps", "N/A")
        speed = job.get("speed", "N/A")
        time_elapsed = job.get("time", "N/A")

        self.stats_label.config(text=f"FPS: {fps} | Speed: {speed}x | Elapsed: {time_elapsed}")
        
        # Redraw canvas progress bar
        self.canvas.delete("all")
        bar_width = (self.width - 30) * (pct / 100.0)
        # Draw gradient outline or solid color
        self.canvas.create_rectangle(0, 0, bar_width, 8, fill="#9d4edd", width=0)

# FFmpeg Execution & Parsing logic
def run_ffmpeg(job_id, args, output_mode, output_path, force_cpu=False):
    global ws
    job = client_active_jobs.get(job_id)
    if not job: return

    # Apply threads configuration if set in config
    rewritten_args = list(args)
    try:
        threads_count = int(config.get("ffmpegThreads", 0))
    except Exception:
        threads_count = 0
        
    if threads_count > 0:
        threads_replaced = False
        for i in range(len(rewritten_args) - 1):
            if rewritten_args[i] == "-threads":
                rewritten_args[i+1] = str(threads_count)
                threads_replaced = True
                break
        if not threads_replaced:
            rewritten_args.insert(1, str(threads_count))
            rewritten_args.insert(1, "-threads")
            
        # Add -filter_threads for multi-threaded HLS filter scaling
        rewritten_args.insert(1, str(threads_count))
        rewritten_args.insert(1, "-filter_threads")
        log_event(f"Configured FFmpeg thread count to {threads_count} (threads and filter_threads)")

    # Rewrite codecs based on config mode
    global_mode = config["transcoderMode"]
    mode = "cpu" if force_cpu else global_mode
    
    # Check GPU limit
    if mode in ["nvidia", "amd"]:
        if mode == "nvidia" and not capabilities["nvidia"]:
            log_event("Nvidia GPU not detected. Falling back to CPU.")
            mode = "cpu"
        elif mode == "amd" and not capabilities["amd"]:
            log_event("AMD GPU not detected. Falling back to CPU.")
            mode = "cpu"
        else:
            max_gpu_jobs = int(config.get("maxGpuJobs", 1))
            active_gpu_count = 0
            for active_job in client_active_jobs.values():
                # Count other jobs that actually selected GPU
                if active_job.get("transcodeMode") in ["nvidia", "amd"]:
                    active_gpu_count += 1
            if active_gpu_count >= max_gpu_jobs:
                log_event(f"Active GPU transcode count ({active_gpu_count}) reached limit ({max_gpu_jobs}). Falling back to CPU for job {job_id}.")
                mode = "cpu"
                
    job["transcodeMode"] = mode

    if mode in config["codecMappings"]:
        mappings = config["codecMappings"][mode]
        for i in range(len(rewritten_args)):
            # If it defines a video codec
            if rewritten_args[i] in ["-vcodec", "-c:v"]:
                codec = rewritten_args[i+1]
                if codec in mappings:
                    rewritten_args[i+1] = mappings[codec]
                    log_event(f"Remapped codec: {codec} -> {rewritten_args[i+1]}")
            # Replace preset for hardware acceleration if unsupported
            elif rewritten_args[i] in ["-preset", "-preset:v"] and mode in ["nvidia", "amd"]:
                preset_val = rewritten_args[i+1]
                nvenc_presets = {
                    "ultrafast": "p1", "superfast": "p1", "veryfast": "p2",
                    "faster": "p3", "fast": "p4", "medium": "p4",
                    "slow": "p5", "slower": "p6", "veryslow": "p7"
                }
                amf_presets = {
                    "ultrafast": "speed", "superfast": "speed", "veryfast": "speed",
                    "faster": "speed", "fast": "balanced", "medium": "balanced",
                    "slow": "quality", "slower": "quality", "veryslow": "quality"
                }
                if mode == "nvidia":
                    rewritten_args[i+1] = nvenc_presets.get(preset_val, "p4")
                    log_event(f"Remapped preset: {preset_val} -> {rewritten_args[i+1]} (Nvidia)")
                elif mode == "amd":
                    rewritten_args[i+1] = amf_presets.get(preset_val, "balanced")
                    log_event(f"Remapped preset: {preset_val} -> {rewritten_args[i+1]} (AMD)")
            # Replace crf for hardware acceleration if unsupported
            elif rewritten_args[i] == "-crf" and mode in ["nvidia", "amd"]:
                if mode == "nvidia":
                    rewritten_args[i] = "-cq"
                    log_event("Remapped -crf to -cq for Nvidia NVENC")
                elif mode == "amd":
                    rewritten_args[i] = "-qp"
                    log_event("Remapped -crf to -qp for AMD AMF")

    # Filter out profile and level for hardware acceleration to prevent driver parameter mismatches
    if mode in ["nvidia", "amd"]:
        filtered_args = []
        idx = 0
        while idx < len(rewritten_args):
            arg = rewritten_args[idx]
            if arg in ["-profile", "-profile:v", "-level", "-level:v"]:
                # Skip this flag and its value
                log_event(f"Removed parameter {arg} {rewritten_args[idx+1]} for hardware compatibility")
                idx += 2
            else:
                filtered_args.append(arg)
                idx += 1
        rewritten_args = filtered_args

    # Extract clean filename from args for display
    file_name = "Stream"
    for i in range(len(rewritten_args)):
        if rewritten_args[i] == "-i":
            url = rewritten_args[i+1]
            match = re.search(r"file=([^&]+)", url)
            if match:
                file_name = os.path.basename(re.sub(r'%[0-9a-fA-F]{2}', lambda m: bytes.fromhex(m.group(0)[1:]).decode('utf-8', 'ignore'), match.group(1)))
            break

    job["fileName"] = file_name
    job["fps"] = 0
    job["speed"] = 0.0
    job["time"] = "00:00:00"
    job["percentage"] = 0
    job["duration_seconds"] = 0.0
    job["stderr_lines"] = []

    # Apply path mappings (e.g. mapping remote Serviio temp folder to a local or mapped network drive folder)
    path_mappings = config.get("pathMappings", {})
    for i in range(len(rewritten_args)):
        arg = rewritten_args[i]
        for remote_path, local_path in path_mappings.items():
            if remote_path in arg:
                rewritten_args[i] = arg.replace(remote_path, local_path)

    # Intercept HLS output paths and redirect them to a local temp folder
    hls_temp_dir = None
    is_hls_job = False
    for i in range(len(rewritten_args)):
        arg = rewritten_args[i]
        if ".stf" in arg:
            is_hls_job = True
            match = re.search(r"transcoding-temp-[0-9a-fA-F]+\.stf", arg)
            if match:
                stf_folder = match.group(0)
                hls_temp_dir = os.path.join(os.environ.get("TEMP", "C:\\Windows\\Temp"), "serviio-loadbalancer", stf_folder)
                os.makedirs(hls_temp_dir, exist_ok=True)
                
                base_name = os.path.basename(arg)
                if "%05d.ts" in base_name:
                    rewritten_args[i] = os.path.join(hls_temp_dir, "segment%05d.ts")
                else:
                    rewritten_args[i] = os.path.join(hls_temp_dir, base_name)

    # Ensure parent directories exist for any absolute output files
    for arg in rewritten_args:
        if (os.path.isabs(arg) or (len(arg) > 2 and arg[1] == ':')) and '.' in os.path.basename(arg):
            try:
                parent_dir = os.path.dirname(arg)
                if parent_dir:
                    os.makedirs(parent_dir, exist_ok=True)
            except Exception as ex:
                log_event(f"Warning: could not create parent directory for {arg}: {ex}")

    # Build command line
    cmd = [config["ffmpegPath"], "-stats"] + rewritten_args[1:] # Skip dummy executable path
    log_event(f"Executing: {' '.join(cmd)}")

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.PIPE,
            bufsize=0
        )
        job["process"] = proc
    except Exception as e:
        log_event(f"Failed to start FFmpeg: {e}")
        # Send fail exit code
        safe_send(json.dumps({"type": "exit", "jobId": job_id, "exitCode": 1}))
        client_active_jobs.pop(job_id, None)
        return

    # Thread 1: Relay stdout back (in binary WebSocket messages)
    def relay_stdout():
        while True:
            chunk = proc.stdout.read(1024 * 32)
            if not chunk:
                break
            # Send binary packet: [jobId len (1 byte)] [jobId] [stream type: 0x03] [data]
            job_id_bytes = job_id.encode('utf-8')
            header = bytes([len(job_id_bytes)]) + job_id_bytes + bytes([0x03])
            if not safe_send(header + chunk, opcode=0x02):
                break

    # Thread 2: Relay/Parse stderr progress logs
    def parse_stderr():
        # Read stderr line by line
        stderr_buffer = bytearray()
        while True:
            char = proc.stderr.read(1)
            if not char:
                break
            stderr_buffer.extend(char)
            if char == b'\n' or char == b'\r':
                line = stderr_buffer.decode('utf-8', errors='ignore')
                stderr_buffer.clear()

                # Store stderr lines for troubleshooting and hardware fallback analysis
                job.setdefault("stderr_lines", []).append(line.strip())
                if len(job["stderr_lines"]) > 50:
                    job["stderr_lines"].pop(0)

                # Parse progress stats
                parse_progress_line(line, job)

                # Send progress to server
                safe_send(json.dumps({
                    "type": "progress",
                    "jobId": job_id,
                    "fps": job["fps"],
                    "speed": job["speed"],
                    "bitrate": job.get("bitrate", "N/A"),
                    "time": job["time"],
                    "percentage": job["percentage"],
                    "transcodeMode": job.get("transcodeMode", "cpu")
                }))

                # Always forward raw stderr back to server so Serviio can parse progress and monitor health
                job_id_bytes = job_id.encode('utf-8')
                header = bytes([len(job_id_bytes)]) + job_id_bytes + bytes([0x04])
                safe_send(header + line.encode('utf-8'), opcode=0x02)

    t_stdout = threading.Thread(target=relay_stdout, daemon=True)
    t_stderr = threading.Thread(target=parse_stderr, daemon=True)
    t_stdout.start()
    t_stderr.start()

    # Thread 3: Sync HLS files in real-time
    if is_hls_job and hls_temp_dir:
        def sync_hls_files():
            synced_segments = set()
            playlist_path = os.path.join(hls_temp_dir, "playlist.m3u8")
            stf_folder = os.path.basename(hls_temp_dir)
            
            while proc.poll() is None:
                time.sleep(0.1)
                if not os.path.exists(playlist_path):
                    continue
                
                try:
                    with open(playlist_path, "r", encoding="utf-8") as f:
                        playlist_content = f.read()
                except Exception:
                    continue
                
                safe_send(json.dumps({
                    "type": "sync_file",
                    "jobId": job_id,
                    "folder": stf_folder,
                    "file": "playlist.m3u8",
                    "content": base64.b64encode(playlist_content.encode("utf-8")).decode("utf-8")
                }))
                
                lines = playlist_content.splitlines()
                for line in lines:
                    line = line.strip()
                    if line and not line.startswith("#") and line.endswith(".ts"):
                        if line not in synced_segments:
                            segment_path = os.path.join(hls_temp_dir, line)
                            if os.path.exists(segment_path):
                                try:
                                    with open(segment_path, "rb") as f:
                                        segment_data = f.read()
                                    safe_send(json.dumps({
                                        "type": "sync_file",
                                        "jobId": job_id,
                                        "folder": stf_folder,
                                        "file": line,
                                        "content": base64.b64encode(segment_data).decode("utf-8")
                                    }))
                                    synced_segments.add(line)
                                    log_event(f"Synced segment {line} to server.")
                                except Exception as e:
                                    log_event(f"Error syncing segment {line}: {e}")
                                    
            # Final sync
            if os.path.exists(playlist_path):
                try:
                    with open(playlist_path, "r", encoding="utf-8") as f:
                        playlist_content = f.read()
                    safe_send(json.dumps({
                        "type": "sync_file",
                        "jobId": job_id,
                        "folder": stf_folder,
                        "file": "playlist.m3u8",
                        "content": base64.b64encode(playlist_content.encode("utf-8")).decode("utf-8")
                    }))
                except Exception:
                    pass
            
            # Clean up local HLS temp files
            try:
                time.sleep(1.0)
                shutil.rmtree(hls_temp_dir)
                log_event(f"Cleaned up local HLS temp directory: {hls_temp_dir}")
            except Exception as e:
                log_event(f"Failed to clean up local HLS temp directory: {e}")

        t_sync = threading.Thread(target=sync_hls_files, daemon=True)
        t_sync.start()

    # Wait for process exit
    exit_code = proc.wait()
    log_event(f"FFmpeg process for job {job_id} exited with code {exit_code}")

    if exit_code != 0:
        # Detect hardware encoding initialization failures
        is_hw_error = False
        hw_error_msg = ""
        for line in job.get("stderr_lines", []):
            if any(term in line for term in ["nvenc", "AMF_ERROR", "amf_shared", "Error while opening encoder", "Driver does not support"]):
                is_hw_error = True
                hw_error_msg = line
                break
        
        if is_hw_error and mode in ["nvidia", "amd"] and not force_cpu:
            log_event(f"Hardware encoder initialization failed: {hw_error_msg.strip()}")
            log_event("Attempting automatic self-healing fallback to CPU transcoding...")
            
            # Re-initialize the active job entry before recursing
            client_active_jobs[job_id] = {
                "thread": job.get("thread"),
                "fileName": job.get("fileName", "Stream"),
                "fps": 0,
                "speed": 0.0,
                "time": "00:00:00",
                "percentage": 0,
                "duration_seconds": job.get("duration_seconds", 0.0),
                "stderr_lines": []
            }
            run_ffmpeg(job_id, args, output_mode, output_path, force_cpu=True)
            return

        if config.get("enableDebugLog", False):
            log_event(f"--- FFmpeg stderr output for job {job_id} (Failed) ---")
            for line in job.get("stderr_lines", []):
                log_event(f"[FFmpeg-stderr] {line}")
            log_event("--- End of FFmpeg stderr ---")

    # Notify Server
    safe_send(json.dumps({"type": "exit", "jobId": job_id, "exitCode": exit_code}))

    # Cleanup job
    client_active_jobs.pop(job_id, None)

# Parse FFmpeg console progress lines
def parse_progress_line(line, job_state):
    # Check for duration
    duration_match = re.search(r"Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})", line)
    if duration_match:
        h, m, s, ms = map(int, duration_match.groups())
        job_state["duration_seconds"] = h * 3600 + m * 60 + s + ms / 100.0
        return

    # Check for progress variables
    if "fps=" in line or "time=" in line:
        fps_match = re.search(r"fps=\s*([\d\.]+)", line)
        speed_match = re.search(r"speed=\s*([\d\.]+)x", line)
        bitrate_match = re.search(r"bitrate=\s*([\d\.\w/]+)", line)
        time_match = re.search(r"time=\s*([\d\:\.]+)", line)

        if fps_match: job_state["fps"] = float(fps_match.group(1))
        if speed_match: job_state["speed"] = float(speed_match.group(1))
        if bitrate_match: job_state["bitrate"] = bitrate_match.group(1)
        if time_match:
            time_str = time_match.group(1)
            job_state["time"] = time_str
            # Calculate percentage
            if job_state.get("duration_seconds"):
                parts = time_str.split(':')
                if len(parts) == 3:
                    try:
                        h, m, s = float(parts[0]), float(parts[1]), float(parts[2])
                        current_seconds = h * 3600 + m * 60 + s
                        pct = int((current_seconds / job_state["duration_seconds"]) * 100)
                        job_state["percentage"] = min(pct, 100)
                    except ValueError:
                        pass

# WebSocket Connection handling
def start_websocket_client():
    global ws
    import websocket # websocket-client package
    
    server_url = config["serverUrl"]

    def on_message(ws_conn, message, *args, **kwargs):
        try:
            data = json.loads(message)
            if data["type"] == "start_transcode":
                job_id = data["jobId"]
                args = data["args"]
                output_mode = data.get("outputMode", "stream")
                output_path = data.get("outputPath")

                log_event(f"Received start_transcode command for job {job_id}")
                client_active_jobs[job_id] = {}
                t = threading.Thread(target=run_ffmpeg, args=(job_id, args, output_mode, output_path), daemon=True)
                client_active_jobs[job_id]["thread"] = t
                t.start()

            elif data["type"] == "stop_transcode":
                job_id = data["jobId"]
                job = client_active_jobs.get(job_id)
                if job and "process" in job:
                    log_event(f"Stopping transcode job {job_id} by request of server...")
                    job["process"].kill()

            elif data["type"] == "stdin":
                job_id = data["jobId"]
                job = client_active_jobs.get(job_id)
                if job and "process" in job:
                    raw_data = base64.b64decode(data["data"])
                    try:
                        job["process"].stdin.write(raw_data)
                        job["process"].stdin.flush()
                    except Exception:
                        pass

        except Exception as e:
            print(f"Error handling WebSocket message: {e}")

    def on_open(ws_conn, *args, **kwargs):
        log_event("Connected to Load Balancer WebSocket Server! Sending registration...")
        try:
            payload = json.dumps({
                "type": "register",
                "hostname": hostname,
                "os": "Windows" if sys.platform == "win32" else ("macOS" if sys.platform == "darwin" else "Linux"),
                "capabilities": capabilities,
                "maxConcurrentJobs": int(config.get("maxConcurrentJobs", 1))
            })
            log_event(f"Sending payload: {payload}")
            ws_conn.send(payload)
            log_event("Registration payload sent successfully.")
        except Exception as ex:
            log_event(f"Error in on_open during send: {ex}")
            log_event(traceback.format_exc())

    def on_close(ws_conn, *args, **kwargs):
        log_event("WebSocket connection closed.")
        # Kill all running jobs if disconnected
        for job_id, job in list(client_active_jobs.items()):
            if "process" in job:
                job["process"].kill()
        client_active_jobs.clear()

    def on_error(ws_conn, error, *args, **kwargs):
        log_event(f"WebSocket Error: {error}")
        log_event(traceback.format_exc())

    # Reconnection loop
    while True:
        try:
            log_event(f"Connecting to server at {server_url}...")
            ws = websocket.WebSocketApp(
                server_url,
                on_open=on_open,
                on_message=on_message,
                on_close=on_close,
                on_error=on_error
            )
            ws.run_forever(ping_interval=60, ping_timeout=30)
        except Exception as e:
            log_event(f"WebSocket running error: {e}")
            log_event(traceback.format_exc())
        time.sleep(5)

# Periodic GUI Updater loop
status_window = None
def update_gui_loop():
    if not HAS_GUI or not config.get("enableUi", True):
        return

    try:
        active_count = len(client_active_jobs)
        if active_count > 0:
            if not status_window.visible:
                status_window.show()
            status_window.update_jobs(client_active_jobs)
        else:
            if status_window.manually_opened:
                status_window.update_idle_state()
            else:
                if status_window.visible:
                    status_window.hide()
    except Exception as e:
        print(f"GUI Update loop error: {e}")

    root.after(200, update_gui_loop)

# Main entry point
if __name__ == "__main__":
    # Start WebSocket client in background thread
    ws_thread = threading.Thread(target=start_websocket_client, daemon=True)
    ws_thread.start()

    # GUI mainloop
    if HAS_GUI and config.get("enableUi", True):
        root = tk.Tk()
        root.withdraw() # Hide primary window
        
        status_window = StatusOverlay(root)

        # Setup System Tray Icon
        def show_overlay_action(icon, item):
            root.after(0, lambda: status_window.show(manual=True))

        def hide_overlay_action(icon, item):
            root.after(0, status_window.hide)

        def exit_action(icon, item):
            icon.stop()
            root.quit()
            os._exit(0)

        tray_menu = pystray.Menu(
            pystray.MenuItem("Show Status Overlay", show_overlay_action),
            pystray.MenuItem("Hide Status Overlay", hide_overlay_action),
            pystray.MenuItem("Exit Client", exit_action)
        )
        
        tray_image = create_icon_image()
        tray_icon = pystray.Icon("transcoder_client", tray_image, "FFmpeg Transcoder Client", menu=tray_menu)
        
        # Start pystray in a thread
        tray_thread = threading.Thread(target=tray_icon.run, daemon=True)
        tray_thread.start()

        # Start periodic GUI updater
        root.after(200, update_gui_loop)
        
        print("Client GUI Started. System tray icon is active.")
        root.mainloop()
    else:
        print("Client starting in Headless mode. Press Ctrl+C to exit.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("Exiting...")
