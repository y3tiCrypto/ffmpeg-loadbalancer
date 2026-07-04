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

def log_event(msg):
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    log_line = f"[{timestamp}] {msg}\n"
    print(msg)
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
def run_ffmpeg(job_id, args, output_mode, output_path):
    global ws
    job = client_active_jobs.get(job_id)
    if not job: return

    # Rewrite codecs based on config mode
    rewritten_args = list(args)
    mode = config["transcoderMode"]
    
    # Fallback checking
    if mode == "nvidia" and not capabilities["nvidia"]:
        log_event("Nvidia GPU not detected. Falling back to CPU.")
        mode = "cpu"
    elif mode == "amd" and not capabilities["amd"]:
        log_event("AMD GPU not detected. Falling back to CPU.")
        mode = "cpu"

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
    cmd = [config["ffmpegPath"]] + rewritten_args[1:] # Skip dummy executable path
    log_event(f"Executing: {' '.join(cmd)}")

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.PIPE,
            bufsize=1024 * 64
        )
        job["process"] = proc
    except Exception as e:
        log_event(f"Failed to start FFmpeg: {e}")
        # Send fail exit code
        if ws:
            ws.send(json.dumps({"type": "exit", "jobId": job_id, "exitCode": 1}))
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
            try:
                ws.send(header + chunk, opcode=0x02) # Binary frame
            except Exception as e:
                log_event(f"Error sending stdout chunk: {e}")
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

                # Store stderr lines for troubleshooting
                job.setdefault("stderr_lines", []).append(line.strip())
                if len(job["stderr_lines"]) > 50:
                    job["stderr_lines"].pop(0)

                # Parse progress stats
                parse_progress_line(line, job)

                # Send progress to server
                try:
                    ws.send(json.dumps({
                        "type": "progress",
                        "jobId": job_id,
                        "fps": job["fps"],
                        "speed": job["speed"],
                        "bitrate": job.get("bitrate", "N/A"),
                        "time": job["time"],
                        "percentage": job["percentage"]
                    }))
                except Exception:
                    pass

                # Also forward raw stderr as logs back to server console
                job_id_bytes = job_id.encode('utf-8')
                header = bytes([len(job_id_bytes)]) + job_id_bytes + bytes([0x04])
                try:
                    ws.send(header + line.encode('utf-8'), opcode=0x02)
                except Exception:
                    pass

    t_stdout = threading.Thread(target=relay_stdout, daemon=True)
    t_stderr = threading.Thread(target=parse_stderr, daemon=True)
    t_stdout.start()
    t_stderr.start()

    # Wait for process exit
    exit_code = proc.wait()
    log_event(f"FFmpeg process for job {job_id} exited with code {exit_code}")

    if exit_code != 0:
        log_event(f"--- FFmpeg stderr output for job {job_id} (Failed) ---")
        for line in job.get("stderr_lines", []):
            log_event(f"[FFmpeg-stderr] {line}")
        log_event("--- End of FFmpeg stderr ---")

    # Notify Server
    try:
        ws.send(json.dumps({"type": "exit", "jobId": job_id, "exitCode": exit_code}))
    except Exception:
        pass

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
                "capabilities": capabilities
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
            ws.run_forever(ping_interval=10, ping_timeout=5)
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

        def exit_action(icon, item):
            icon.stop()
            root.quit()
            os._exit(0)

        tray_menu = pystray.Menu(
            pystray.MenuItem("Show Status Overlay", show_overlay_action),
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
