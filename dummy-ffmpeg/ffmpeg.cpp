#include <iostream>
#include <string>
#include <vector>
#include <thread>
#include <cstring>

#ifdef _WIN32
    #include <winsock2.h>
    #include <ws2tcpip.h>
    #include <direct.h>
    #define GetCurrentDir _getcwd
    #pragma comment(lib, "ws2_32.lib")
#else
    #include <unistd.h>
    #include <sys/socket.h>
    #include <arpa/inet.h>
    #include <netdb.h>
    #define GetCurrentDir getcwd
    #define SOCKET int
    #define INVALID_SOCKET -1
    #define SOCKET_ERROR -1
    #define closesocket close
#endif

// Packet types
const char PKT_INIT   = 0x01;
const char PKT_STDIN  = 0x02;
const char PKT_STDOUT = 0x03;
const char PKT_STDERR = 0x04;
const char PKT_EXIT   = 0x05;

// Convert 32-bit uint to network byte order
uint32_t to_big_endian(uint32_t val) {
#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
    return val;
#else
    return ((val & 0xFF000000) >> 24) |
           ((val & 0x00FF0000) >> 8)  |
           ((val & 0x0000FF00) << 8)  |
           ((val & 0x000000FF) << 24);
#endif
}

// Convert 32-bit uint from network byte order
uint32_t from_big_endian(uint32_t val) {
    return to_big_endian(val);
}

// Send all data to socket
bool send_all(SOCKET sock, const char* data, int length) {
    int total_sent = 0;
    while (total_sent < length) {
        int sent = send(sock, data + total_sent, length - total_sent, 0);
        if (sent <= 0) return false;
        total_sent += sent;
    }
    return true;
}

// Helper to escape JSON strings
std::string escape_json(const std::string& s) {
    std::string out;
    for (char c : s) {
        if (c == '"') out += "\\\"";
        else if (c == '\\') out += "\\\\";
        else if (c == '\b') out += "\\b";
        else if (c == '\f') out += "\\f";
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else if (static_cast<unsigned char>(c) < 32) {
            char buf[5];
            snprintf(buf, sizeof(buf), "\\u%04x", c);
            out += buf;
        } else {
            out += c;
        }
    }
    return out;
}

// Socket reading thread function
void receive_thread_func(SOCKET sock) {
    char type;
    while (true) {
        // Read packet type (1 byte)
        int received = recv(sock, &type, 1, 0);
        if (received <= 0) {
            // Socket closed or error
            break;
        }

        // Read packet length (4 bytes)
        uint32_t net_len;
        int len_received = 0;
        char* len_ptr = reinterpret_cast<char*>(&net_len);
        while (len_received < 4) {
            int r = recv(sock, len_ptr + len_received, 4 - len_received, 0);
            if (r <= 0) {
                break;
            }
            len_received += r;
        }
        if (len_received < 4) break;

        uint32_t payload_len = from_big_endian(net_len);

        // Read payload
        std::vector<char> payload(payload_len);
        uint32_t payload_received = 0;
        while (payload_received < payload_len) {
            int r = recv(sock, payload.data() + payload_received, payload_len - payload_received, 0);
            if (r <= 0) {
                break;
            }
            payload_received += r;
        }
        if (payload_received < payload_len) break;

        // Process packet
        if (type == PKT_STDOUT) {
            if (payload_len > 0) {
                fwrite(payload.data(), 1, payload_len, stdout);
                fflush(stdout);
            }
        } else if (type == PKT_STDERR) {
            if (payload_len > 0) {
                fwrite(payload.data(), 1, payload_len, stderr);
                fflush(stderr);
            }
        } else if (type == PKT_EXIT) {
            int exit_code = 0;
            if (payload_len >= 4) {
                uint32_t net_exit;
                std::memcpy(&net_exit, payload.data(), 4);
                exit_code = static_cast<int>(from_big_endian(net_exit));
            }
            closesocket(sock);
#ifdef _WIN32
            WSACleanup();
#endif
            std::exit(exit_code);
        }
    }
}

int main(int argc, char* argv[]) {
    // 1. Initialize Winsock/Sockets
#ifdef _WIN32
    WSADATA wsaData;
    if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) {
        std::cerr << "[ffmpeg-wrapper] Failed to initialize Winsock." << std::endl;
        return 1;
    }
#endif

    // 2. Create TCP Socket
    SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET) {
        std::cerr << "[ffmpeg-wrapper] Failed to create socket." << std::endl;
#ifdef _WIN32
        WSACleanup();
#endif
        return 1;
    }

    // 3. Connect to Load Balancer Server (127.0.0.1:4001)
    sockaddr_in serverAddr;
    serverAddr.sin_family = AF_INET;
    serverAddr.sin_port = htons(4001);
    inet_pton(AF_INET, "127.0.0.1", &serverAddr.sin_addr);

    if (connect(sock, reinterpret_cast<sockaddr*>(&serverAddr), sizeof(serverAddr)) == SOCKET_ERROR) {
        std::cerr << "[ffmpeg-wrapper] Failed to connect to Transcoder Load Balancer Server on 127.0.0.1:4001." << std::endl;
        std::cerr << "[ffmpeg-wrapper] Ensure the load balancer server is running." << std::endl;
        closesocket(sock);
#ifdef _WIN32
        WSACleanup();
#endif
        return 1;
    }

    // 4. Construct INIT JSON
    // Get current working directory
    char cwd_buf[1024];
    std::string cwd = "";
    if (GetCurrentDir(cwd_buf, sizeof(cwd_buf)) != nullptr) {
        cwd = cwd_buf;
    }

    std::string json = "{\n  \"cwd\": \"" + escape_json(cwd) + "\",\n  \"args\": [\n";
    for (int i = 0; i < argc; ++i) {
        json += "    \"" + escape_json(argv[i]) + "\"";
        if (i < argc - 1) json += ",\n";
    }
    json += "\n  ]\n}";

    // Send INIT packet (0x01)
    uint32_t json_len = static_cast<uint32_t>(json.size());
    uint32_t net_len = to_big_endian(json_len);

    if (!send_all(sock, &PKT_INIT, 1) ||
        !send_all(sock, reinterpret_cast<const char*>(&net_len), 4) ||
        !send_all(sock, json.c_str(), json_len)) {
        std::cerr << "[ffmpeg-wrapper] Failed to send INIT packet." << std::endl;
        closesocket(sock);
#ifdef _WIN32
        WSACleanup();
#endif
        return 1;
    }

    // 5. Start Receiving Thread
    std::thread receive_thread(receive_thread_func, sock);

    // 6. Handle stdin in main thread
    char stdin_buf[4096];
    while (true) {
        // Read from standard input
        size_t bytes_read = fread(stdin_buf, 1, sizeof(stdin_buf), stdin);
        if (bytes_read <= 0) {
            // EOF or error
            break;
        }

        // Send STDIN packet (0x02)
        uint32_t chunk_len = static_cast<uint32_t>(bytes_read);
        uint32_t net_chunk_len = to_big_endian(chunk_len);

        if (!send_all(sock, &PKT_STDIN, 1) ||
            !send_all(sock, reinterpret_cast<const char*>(&net_chunk_len), 4) ||
            !send_all(sock, stdin_buf, chunk_len)) {
            break;
        }
    }

    // Finished reading stdin, signal EOF by shutting down socket send side
#ifdef _WIN32
    shutdown(sock, SD_SEND);
#else
    shutdown(sock, SHUT_WR);
#endif

    // Wait for the receive thread to finish (it will exit when it receives the PKT_EXIT and calls std::exit)
    if (receive_thread.joinable()) {
        receive_thread.join();
    }

    closesocket(sock);
#ifdef _WIN32
    WSACleanup();
#endif
    return 0;
}
