#include <cstddef>
#include <cstdlib>
#include <Processing.NDI.Lib.h>
#include <array>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <iomanip>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

void validateNdiGpuSurface(const NDIlib_video_frame_v2_t& frame);

// Original test code. SDK headers/runtime stay outside this repository.
// This is a CPU-buffer codec proof, not an Electron/GPU zero-copy benchmark.
namespace {
constexpr int width = 1920, height = 1080, stride = width * 4 + 64;
using Clock = std::chrono::steady_clock;
void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
void checkInitialCompletion(uint32_t unique, Clock::duration elapsed) {
  if (unique == 120) require(elapsed < std::chrono::seconds(15),
    "NDI first 120 unique frames completed after the 15-second deadline");
}
struct Runtime {
  Runtime() { require(NDIlib_initialize(), "NDI initialization failed"); }
  ~Runtime() { NDIlib_destroy(); }
};
struct Sender {
  NDIlib_send_instance_t value;
  explicit Sender(const char* name) {
    NDIlib_send_create_t settings;
    settings.p_ndi_name = name;
    settings.clock_video = true;
    settings.clock_audio = false;
    value = NDIlib_send_create(&settings);
    require(value != nullptr, "NDI sender creation failed");
  }
  ~Sender() { NDIlib_send_destroy(value); }
};
struct Receiver {
  NDIlib_recv_instance_t value;
  explicit Receiver(const NDIlib_source_t& source) {
    NDIlib_recv_create_v3_t settings;
    settings.source_to_connect_to = source;
    settings.color_format = NDIlib_recv_color_format_BGRX_BGRA;
    settings.bandwidth = NDIlib_recv_bandwidth_highest;
    settings.allow_video_fields = false;
    settings.p_ndi_recv_name = "Loom synthetic roundtrip oracle";
    value = NDIlib_recv_create_v3(&settings);
    require(value != nullptr, "NDI receiver creation failed");
  }
  ~Receiver() { NDIlib_recv_destroy(value); }
};
struct Captured {
  NDIlib_recv_instance_t receiver;
  NDIlib_video_frame_v2_t frame;
  ~Captured() { if (frame.p_data) NDIlib_recv_free_video_v2(receiver, &frame); }
};
void fill(std::vector<uint8_t>& pixels, uint32_t sequence) {
  // Three distinct rows, repeated vertically. Do not recompute the same barcode
  // for every pixel of every row; this generator is not the workload under test.
  for (const int y : {0, height / 4, height / 2}) {
    for (int x = 0; x < width; x++) {
      auto* p = pixels.data() + y * stride + x * 4;
      if (y < height / 2) {
        const bool bit = ((sequence >> (x * 32 / width)) & 1) != 0;
        p[0] = p[1] = p[2] = (bit != (y >= height / 4)) ? 255 : 0;
      } else {
        p[0] = 0; p[1] = x >= width / 2 ? 255 : 0; p[2] = x < width / 2 ? 255 : 0;
      }
      p[3] = 255;
    }
  }
  for (int y = 1; y < height; y++) {
    const int source = y < height / 4 ? 0 : y < height / 2 ? height / 4 : height / 2;
    if (y != source) std::memcpy(pixels.data() + y * stride, pixels.data() + source * stride, width * 4);
  }
}
uint32_t validate(const NDIlib_video_frame_v2_t& frame, bool encodedTimecode = true) {
  require(frame.xres == width && frame.yres == height, "NDI changed frame dimensions");
  require(frame.frame_format_type == NDIlib_frame_format_type_progressive, "NDI returned fielded video");
  require(frame.FourCC == NDIlib_FourCC_video_type_BGRA || frame.FourCC == NDIlib_FourCC_video_type_BGRX,
    "NDI returned unsupported pixel format");
  require(frame.line_stride_in_bytes >= width * 4, "NDI returned invalid row stride");
  const auto pixel = [&](int x, int y) { return frame.p_data + y * frame.line_stride_in_bytes + x * 4; };
  const auto near = [&](int x, int y, int b, int g, int r) {
    const auto* p = pixel(x, y);
    // NDI High Bandwidth is lossy. Interiors must remain within 24/255;
    // this tolerance does not authorize precision changes in graph rendering.
    require(std::abs(int(p[0]) - b) <= 24 && std::abs(int(p[1]) - g) <= 24 &&
      std::abs(int(p[2]) - r) <= 24, "NDI barcode/orientation/channel corruption");
    if (frame.FourCC == NDIlib_FourCC_video_type_BGRA) require(p[3] == 255, "NDI lost opaque alpha");
  };
  uint32_t sequence = 0;
  for (int bit = 0; bit < 32; bit++) {
    const int x = (2 * bit + 1) * width / 64;
    const int value = pixel(x, height / 8)[0] >= 128 ? 255 : 0;
    near(x, height / 8, value, value, value);
    near(x, 3 * height / 8, 255 - value, 255 - value, 255 - value);
    if (value) sequence |= uint32_t(1) << bit;
  }
  near(width / 4, 3 * height / 4, 0, 0, 255);
  near(3 * width / 4, 3 * height / 4, 0, 255, 0);
  if (encodedTimecode) require(frame.timecode == int64_t(sequence) * 10000000 / 60, "NDI pixels/timecode mismatch");
  else require(frame.timecode > 0 && frame.timecode != NDIlib_send_timecode_synthesize, "NDI app transport has no resolved timecode");
  return sequence;
}

void testOracle() {
  // A capture/oracle may begin inside the startup window and complete outside it.
  // Simulate that crossing without sleeps; acceptance is checked after frame 120.
  checkInitialCompletion(120, std::chrono::seconds(15) - std::chrono::nanoseconds(1));
  for (const auto elapsed : {std::chrono::seconds(15), std::chrono::seconds(16)}) {
    bool rejected = false;
    try { checkInitialCompletion(120, elapsed); } catch (const std::runtime_error&) { rejected = true; }
    require(rejected, "NDI startup oracle accepted a delayed 120th frame");
  }
  checkInitialCompletion(121, std::chrono::seconds(16)); // Continuous runs may exceed startup window.
  std::vector<uint8_t> pixels(stride * height, 13);
  constexpr uint32_t sequence = 0xA55A3CC3;
  fill(pixels, sequence);
  // Byte-for-byte reference for the row reuse, including untouched row padding.
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      const auto* p = pixels.data() + y * stride + x * 4;
      const bool bit = ((sequence >> (x * 32 / width)) & 1) != 0;
      const int gray = (bit != (y >= height / 4)) ? 255 : 0;
      require(p[0] == (y < height / 2 ? gray : 0) &&
        p[1] == (y < height / 2 ? gray : x >= width / 2 ? 255 : 0) &&
        p[2] == (y < height / 2 ? gray : x < width / 2 ? 255 : 0) && p[3] == 255,
        "NDI optimized generator changed pixel bytes");
    }
    for (int byte = width * 4; byte < stride; byte++)
      require(pixels[y * stride + byte] == 13, "NDI generator overwrote row padding");
  }
  NDIlib_video_frame_v2_t frame;
  frame.xres = width; frame.yres = height;
  frame.FourCC = NDIlib_FourCC_video_type_BGRA;
  frame.frame_format_type = NDIlib_frame_format_type_progressive;
  frame.line_stride_in_bytes = stride; frame.p_data = pixels.data();
  frame.timecode = int64_t(sequence) * 10000000 / 60;
  require(validate(frame) == sequence, "NDI oracle cannot decode its control");
  const auto rejects = [&](NDIlib_video_frame_v2_t broken) {
    bool rejected = false;
    try { validate(broken); } catch (const std::runtime_error&) { rejected = true; }
    require(rejected, "NDI oracle accepted a deliberately corrupted frame");
  };
  auto broken = frame; broken.xres--; rejects(broken);
  broken = frame; broken.FourCC = NDIlib_FourCC_video_type_RGBA; rejects(broken);
  broken = frame; broken.timecode++; rejects(broken);
  broken = frame; broken.line_stride_in_bytes = width * 4; rejects(broken);
  broken = frame; broken.frame_format_type = NDIlib_frame_format_type_field_0; rejects(broken);
  auto* red = pixels.data() + (3 * height / 4) * stride + (width / 4) * 4;
  red[0] = 255; red[2] = 0; rejects(frame);
  red[0] = 0; red[2] = 255; red[3] = 0; rejects(frame);
  red[3] = 255;
  require(validate(frame) == sequence, "NDI oracle did not recover its control");
}
}

int main(int argc, char** argv) {
  try {
    require(argc == 3 || argc == 4, "Expected --send[-restarted] name, --receive exact-name or --receive-app[-cpu] exact-name [seconds]");
    const bool cpuMeasurement = std::string(argv[1]) == "--receive-app-cpu";
    const bool appSource = std::string(argv[1]) == "--receive-app" || cpuMeasurement;
    require(!cpuMeasurement || argc == 4, "CPU-only NDI measurement requires an explicit duration");
    int duration = 0;
    if (argc == 4) {
      const std::string argument(argv[3]);
      require(appSource && !argument.empty() && argument.find_first_not_of("0123456789") == std::string::npos,
        "NDI duration is only supported for app receive and must be an integer");
      duration = std::stoi(argument);
      require(duration >= 1 && duration <= 600, "NDI duration must be from 1 to 600 seconds");
    }
    testOracle();
    Runtime runtime;
    const bool restarted = std::string(argv[1]) == "--send-restarted";
    const bool sending = std::string(argv[1]) == "--send" || restarted;
    require(sending || appSource || std::string(argv[1]) == "--receive", "Invalid NDI proof mode");
    if (sending) {
      Sender sender(argv[2]);
      const auto* source = NDIlib_send_get_source_name(sender.value);
      require(source && source->p_ndi_name, "NDI sender has no source identity");
      std::atomic<bool> stop{false};
      std::atomic<uint32_t> sent{0};
      double fillMs = 0, sendMs = 0;
      std::array<std::vector<uint8_t>, 2> buffers{
        std::vector<uint8_t>(stride * height, 13), std::vector<uint8_t>(stride * height, 13)};
      std::thread producer([&] {
        NDIlib_video_frame_v2_t frame;
        frame.xres = width; frame.yres = height;
        frame.FourCC = NDIlib_FourCC_video_type_BGRA;
        frame.frame_rate_N = 60; frame.frame_rate_D = 1;
        frame.picture_aspect_ratio = float(width) / height;
        frame.frame_format_type = NDIlib_frame_format_type_progressive;
        frame.line_stride_in_bytes = stride;
        // The high barcode bit distinguishes restarted video from a retained
        // stale graph texture without changing resolution or the pixel oracle.
        uint32_t sequence = restarted ? 0x80000001u : 1u;
        while (!stop.load()) {
          auto& pixels = buffers[sequence % 2];
          const auto fillStart = Clock::now();
          fill(pixels, sequence);
          const auto sendStart = Clock::now();
          fillMs += std::chrono::duration<double, std::milli>(sendStart - fillStart).count();
          frame.p_data = pixels.data();
          frame.timecode = int64_t(sequence) * 10000000 / 60;
          // A new async submission synchronizes the previous buffer before reuse.
          NDIlib_send_send_video_async_v2(sender.value, &frame);
          sendMs += std::chrono::duration<double, std::milli>(Clock::now() - sendStart).count();
          sent.fetch_add(1); sequence++;
        }
        NDIlib_send_send_video_async_v2(sender.value, nullptr); // Drain before buffers retire.
      });
      std::cout << "{\"name\":" << std::quoted(source->p_ndi_name) << "}" << std::endl;
      std::string command;
      std::getline(std::cin, command);
      stop.store(true); producer.join();
      require(command == "STOP", "NDI sender lost its owning launcher");
      std::cout << "{\"drained\":true,\"sent\":" << sent.load()
        << ",\"fillMs\":" << fillMs << ",\"sendMs\":" << sendMs
        << ",\"senderBuffers\":2,\"senderStride\":" << stride << "}" << std::endl;
      return 0;
    }
    // The SDK documents exact-name discovery with a null address. Sender identity
    // need not contain an address; do not fabricate or parse its opaque URL.
    NDIlib_source_t source(argv[2], nullptr);
    Receiver receiver(source); // Exact own source; never pick an arbitrary discovered feed.
    uint32_t first = 0, last = 0, unique = 0, repeats = 0, skipped = 0;
    int64_t lastTimecode = 0;
    const auto started = Clock::now();
    auto firstReceived = started, lastUnique = started;
    std::vector<double> gaps;
    double firstFrameMs = 0, first120Ms = 0, gpuOracleMs = 0;
    while (unique < 120 || (duration && lastUnique - firstReceived < std::chrono::seconds(duration))) {
      if ((unique < 120 && Clock::now() - started >= std::chrono::seconds(15)) ||
          Clock::now() - lastUnique >= std::chrono::seconds(15)) {
        std::cerr << "NDI_RECEIVE_PROGRESS {\"unique\":" << unique << ",\"repeats\":" << repeats
          << ",\"skipped\":" << skipped << ",\"first\":" << first << ",\"last\":" << last << "}\n";
        require(unique >= 120, "NDI did not deliver 120 unique full-HD frames within 15 seconds");
        throw std::runtime_error("NDI unique frame delivery stalled for 15 seconds");
      }
      Captured captured{receiver.value, {}};
      const auto kind = NDIlib_recv_capture_v2(receiver.value, &captured.frame, nullptr, nullptr, 100);
      require(kind != NDIlib_frame_type_error, "NDI receive connection failed");
      if (kind != NDIlib_frame_type_video) continue;
      require(captured.frame.p_data != nullptr, "NDI returned an empty video frame");
      const uint32_t sequence = validate(captured.frame, !appSource);
      require(captured.frame.timecode >= lastTimecode, "NDI transport timecode moved backwards");
      lastTimecode = captured.frame.timecode;
      const auto gpuStart = Clock::now();
      if (!cpuMeasurement) validateNdiGpuSurface(captured.frame);
      gpuOracleMs += std::chrono::duration<double, std::milli>(Clock::now() - gpuStart).count();
      require(sequence != 0 && sequence >= last, "NDI frame sequence moved backwards");
      if (sequence == last) { repeats++; continue; }
      if (!first) {
        first = sequence;
        firstReceived = Clock::now();
        firstFrameMs = std::chrono::duration<double, std::milli>(firstReceived - started).count();
      }
      const auto received = Clock::now();
      if (last) gaps.push_back(std::chrono::duration<double, std::milli>(received - lastUnique).count());
      lastUnique = received;
      if (last) skipped += sequence - last - 1;
      last = sequence; unique++;
      checkInitialCompletion(unique, received - started);
      if (unique == 120) first120Ms = std::chrono::duration<double, std::milli>(received - started).count();
    }
    const double elapsed = std::chrono::duration<double>(Clock::now() - started).count();
    const double active = std::chrono::duration<double>(lastUnique - firstReceived).count();
    std::sort(gaps.begin(), gaps.end());
    const auto percentile = [&](double fraction) { return gaps.empty() ? 0.0 : gaps[size_t((gaps.size() - 1) * fraction)]; };
    std::cout << std::setprecision(12) << "{\"ok\":" << (unique >= 120 ? "true" : "false") << ",\"width\":" << width << ",\"height\":" << height
      << ",\"unique\":" << unique << ",\"repeats\":" << repeats << ",\"skipped\":" << skipped
      << ",\"first\":" << first << ",\"last\":" << last
      << ",\"firstFrameMs\":" << firstFrameMs << ",\"secondsIncludingConnect\":" << elapsed
      << ",\"first120Ms\":" << first120Ms
      << ",\"requestedSeconds\":" << duration << ",\"activeSeconds\":" << active
      << ",\"uniqueFps\":" << (active > 0 ? (unique - 1) / active : 0)
      << ",\"uniqueGapP50Ms\":" << percentile(0.50) << ",\"uniqueGapP95Ms\":" << percentile(0.95)
      << ",\"gpuSurfaceSamplesPerFrame\":" << (cpuMeasurement ? 0 : 66)
      << ",\"gpuOracleMs\":" << gpuOracleMs << "}" << std::endl;
    require(unique >= 120, "NDI did not deliver 120 unique full-HD frames within 15 seconds");
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "NDI_ROUNDTRIP_FAILED " << error.what() << '\n'; return 1;
  }
}
