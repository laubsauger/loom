// Main-process NDI adapter. Only explicit post-consent calls initialize the SDK.
#include <node_api.h>
#include <cstddef>
#include <Processing.NDI.Lib.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#include <atomic>
#include <array>
#include <chrono>
#include <cstring>
#include <map>
#include <limits>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

// Explicit build-time experiment. Baseline remains staged; never switch paths
// at runtime or silently retry a failed direct publication through staging.
#ifndef LOOM_NDI_DIRECT_OUTPUT
#define LOOM_NDI_DIRECT_OUTPUT 0
#endif
#if LOOM_NDI_DIRECT_OUTPUT != 0 && LOOM_NDI_DIRECT_OUTPUT != 1
#error "LOOM_NDI_DIRECT_OUTPUT must be 0 or 1"
#endif

namespace {
void require(bool ok, const char *message) { if (!ok) throw std::runtime_error(message); }
void check(napi_status status) { require(status == napi_ok, "NDI N-API operation failed"); }
// Finalization/error paths also retire SDK objects off the JS thread. Ordinary
// list/open/acquire/close operations run as N-API workers below.
template<class T> std::shared_ptr<T> workerOwned() {
  return std::shared_ptr<T>(new T, [](T *value) {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ delete value; });
  });
}
struct Sdk {
  std::mutex mutex;
  bool initialized = false;
  void start() {
    if (initialized) return;
    require(NDIlib_initialize(), "NDI SDK initialization failed");
    initialized = true;
  }
  ~Sdk() {
    if (initialized) NDIlib_destroy();
  }
};
struct Session {
  std::shared_ptr<Sdk> sdk;
  std::shared_ptr<std::atomic<size_t>> capacity;
  std::mutex mutex;
  NDIlib_recv_instance_t receiver = nullptr;
  std::atomic<bool> closed{false};
  bool busy = false; // JS-thread-owned, like lease and sequence.
  std::string lease;
  uint64_t sequence = 0;
  ~Session() {
    if (receiver) NDIlib_recv_destroy(receiver);
    if (capacity) --*capacity;
  }
};
struct Lease {
  IOSurfaceRef surface = nullptr;
  std::shared_ptr<Session> session;
  ~Lease() { if (surface) CFRelease(surface); }
};
struct OutputStats {
  std::atomic<uint64_t> stagingBytes{0}, stagingBuffers{0}, bufferAllocations{0}, publishedFrames{0};
  // Only the JS completion thread commits/reads a complete timing sample. Worker
  // threads write their own Job timestamps, never these cumulative fields.
  struct {
    uint64_t samples = 0, queueNs = 0, setupNs = 0, surfaceLockNs = 0, surfaceCopyNs = 0,
      surfaceUnlockNs = 0, sdkSendNs = 0,
      workerOtherNs = 0, deliveryNs = 0, totalNs = 0;
  } publicationTiming;
};
struct Job;
struct Publisher {
  std::shared_ptr<Sdk> sdk;
  std::shared_ptr<OutputStats> stats;
  std::mutex mutex;
  NDIlib_send_instance_t sender = nullptr;
  std::array<std::vector<uint8_t>, 2> buffers;
  size_t width = 0, height = 0, nextBuffer = 0;
  bool busy = false, stopping = false; // JS-thread-owned.
  napi_ref stopPromise = nullptr; // Created/deleted only on JS thread.
  std::unique_ptr<Job> stopJob; // JS-thread-owned; queued only after Publish completion.
  void clearBuffers() {
    for (auto &buffer : buffers) {
      if (buffer.capacity()) { stats->stagingBytes -= buffer.capacity(); --stats->stagingBuffers; }
      std::vector<uint8_t>().swap(buffer);
    }
    width = height = nextBuffer = 0;
  }
  void retire() {
    if (sender) {
#if LOOM_NDI_DIRECT_OUTPUT
      NDIlib_send_send_video_v2(sender, nullptr);
#else
      NDIlib_send_send_video_async_v2(sender, nullptr);
#endif
      NDIlib_send_destroy(sender); sender = nullptr;
    }
    clearBuffers();
  }
  ~Publisher();
};
struct State {
  std::shared_ptr<Sdk> sdk = workerOwned<Sdk>();
  std::map<std::string, std::shared_ptr<Session>> sessions;
  std::map<std::string, std::unique_ptr<Lease>> leases;
  std::map<std::string, std::shared_ptr<Publisher>> publishers;
  std::shared_ptr<OutputStats> outputStats = std::make_shared<OutputStats>();
  // Count through actual native destruction, not weak_ptr expiry: retirement
  // itself can wait on an SDK thread after the last JS owner has disappeared.
  std::shared_ptr<std::atomic<size_t>> capacity = std::make_shared<std::atomic<size_t>>(0);
  bool listing = false;
  uint64_t nextSession = 0, nextLease = 0;
};
enum class Operation { List, Open, Acquire, Close, Publish, Stop };
using DiagnosticClock = std::chrono::steady_clock;
uint64_t elapsedNs(DiagnosticClock::time_point start, DiagnosticClock::time_point end) {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(end - start).count());
}
struct Job {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  Operation operation;
  std::shared_ptr<State> state;
  std::shared_ptr<Session> session;
  std::shared_ptr<Publisher> publisher;
  std::string id, source, error;
  std::vector<std::string> sources;
  IOSurfaceRef surface = nullptr;
  size_t width = 0, height = 0;
  bool offline = false;
  DiagnosticClock::time_point queued, workerStarted, lockStarted, lockFinished, copyStarted, copyFinished,
    unlockStarted, unlockFinished, sendStarted, sendFinished, workerFinished, delivered;
  ~Job() { if (surface) CFRelease(surface); }
};
Publisher::~Publisher() { retire(); }
std::shared_ptr<State> stateFor(napi_env env) {
  void *data = nullptr; check(napi_get_instance_data(env, &data));
  return *static_cast<std::shared_ptr<State> *>(data);
}
napi_value text(napi_env env, const std::string &value) {
  napi_value result; check(napi_create_string_utf8(env, value.data(), value.size(), &result)); return result;
}
napi_value number(napi_env env, uint64_t value) {
  napi_value result; check(napi_create_double(env, (double)value, &result)); return result;
}
napi_value undefined(napi_env env) {
  napi_value result; check(napi_get_undefined(env, &result)); return result;
}
void set(napi_env env, napi_value object, const char *key, napi_value value) {
  check(napi_set_named_property(env, object, key, value));
}
std::string argument(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value values[2];
  check(napi_get_cb_info(env, info, &count, values, nullptr, nullptr));
  require(count == 1, "Expected exactly one nonempty string argument");
  size_t length = 0; check(napi_get_value_string_utf8(env, values[0], nullptr, 0, &length));
  require(length && length <= 4096, "Invalid NDI identifier length");
  std::vector<char> bytes(length + 1);
  check(napi_get_value_string_utf8(env, values[0], bytes.data(), bytes.size(), &length));
  std::string result(bytes.data(), length);
  require(result.find('\0') == std::string::npos, "NUL in NDI identifier");
  return result;
}
std::shared_ptr<Session> sessionFor(const std::shared_ptr<State> &state, const std::string &id) {
  const auto found = state->sessions.find(id);
  require(found != state->sessions.end() && !found->second->closed, "Unknown or closed NDI session");
  return found->second;
}
napi_value failure(napi_env env, const std::exception &error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}
void copyFrame(Job &job, const NDIlib_video_frame_v2_t &frame) {
  require(frame.FourCC == NDIlib_FourCC_video_type_BGRA || frame.FourCC == NDIlib_FourCC_video_type_BGRX,
    "NDI input requires decoded BGRA/BGRX 8-bit video");
  require(frame.frame_format_type == NDIlib_frame_format_type_progressive,
    "NDI input requires progressive video; interlaced sources are not converted");
  // Metal's supported maximum on this Apple Silicon path; no downscaling.
  require(frame.xres > 0 && frame.yres > 0 && frame.xres <= 16384 && frame.yres <= 16384,
    "NDI input dimensions must be 1 through 16384");
  job.width = frame.xres; job.height = frame.yres;
  require(frame.p_data && frame.line_stride_in_bytes >= frame.xres * 4, "Invalid NDI decoded row storage");
  job.surface = IOSurfaceCreate((__bridge CFDictionaryRef)@{
    (id)kIOSurfaceWidth: @(job.width), (id)kIOSurfaceHeight: @(job.height),
    (id)kIOSurfaceBytesPerElement: @4, (id)kIOSurfacePixelFormat: @((uint32_t)0x42475241) });
  require(job.surface, "Cannot allocate owned NDI input IOSurface");
  require(IOSurfaceLock(job.surface, 0, nullptr) == kIOReturnSuccess, "Cannot lock NDI input IOSurface");
  auto *target = static_cast<uint8_t *>(IOSurfaceGetBaseAddress(job.surface));
  const auto stride = IOSurfaceGetBytesPerRow(job.surface);
  if (!target || stride < job.width * 4) {
    IOSurfaceUnlock(job.surface, 0, nullptr);
    throw std::runtime_error("Invalid NDI input IOSurface storage");
  }
  for (size_t y = 0; y < job.height; ++y) {
    auto *row = target + y * stride;
    std::memcpy(row, frame.p_data + y * (size_t)frame.line_stride_in_bytes, job.width * 4);
    if (frame.FourCC == NDIlib_FourCC_video_type_BGRX)
      for (size_t x = 0; x < job.width; ++x) row[x * 4 + 3] = 255;
  }
  require(IOSurfaceUnlock(job.surface, 0, nullptr) == kIOReturnSuccess, "Cannot unlock NDI input IOSurface");
}
void publishFrame(Job &job) {
  auto &publisher = *job.publisher;
  if (!publisher.sender) {
    std::lock_guard<std::mutex> lock(publisher.sdk->mutex);
    publisher.sdk->start();
    NDIlib_send_create_t settings;
    settings.p_ndi_name = job.id.c_str();
    settings.clock_video = false; settings.clock_audio = false;
    publisher.sender = NDIlib_send_create(&settings);
    require(publisher.sender, "Cannot create NDI publisher");
  }
#if LOOM_NDI_DIRECT_OUTPUT
  // Every prior synchronous submission completed before this worker started;
  // resizing changes frame metadata only. There is no retained staging buffer.
  publisher.width = job.width; publisher.height = job.height;
  require(IOSurfaceGetBytesPerRow(job.surface) <= static_cast<size_t>(std::numeric_limits<int>::max()),
    "NDI output IOSurface row stride exceeds SDK integer range");
#else
  if (publisher.width != job.width || publisher.height != job.height) {
    // An asynchronous send may still read the previous-size buffer. Drain it
    // before freeing or reallocating either of the two reusable staging slots.
    NDIlib_send_send_video_async_v2(publisher.sender, nullptr);
    publisher.clearBuffers();
    for (auto &buffer : publisher.buffers) {
      buffer.resize(job.width * job.height * 4);
      publisher.stats->stagingBytes += buffer.capacity();
      ++publisher.stats->stagingBuffers; ++publisher.stats->bufferAllocations;
    }
    publisher.width = job.width; publisher.height = job.height;
  }
  auto &buffer = publisher.buffers[publisher.nextBuffer];
#endif
  job.lockStarted = DiagnosticClock::now();
  const auto locked = IOSurfaceLock(job.surface, kIOSurfaceLockReadOnly, nullptr);
  job.lockFinished = DiagnosticClock::now();
  require(locked == kIOReturnSuccess, "Cannot lock NDI output IOSurface");
  job.copyStarted = DiagnosticClock::now();
  const auto *source = static_cast<const uint8_t *>(IOSurfaceGetBaseAddress(job.surface));
  if (!source) {
    IOSurfaceUnlock(job.surface, kIOSurfaceLockReadOnly, nullptr);
    throw std::runtime_error("NDI output IOSurface has no CPU-accessible storage");
  }
  const auto sourceStride = IOSurfaceGetBytesPerRow(job.surface);
#if !LOOM_NDI_DIRECT_OUTPUT
  const auto rowBytes = job.width * 4;
  for (size_t y = 0; y < job.height; ++y)
    std::memcpy(buffer.data() + y * rowBytes, source + y * sourceStride, rowBytes);
#endif
  job.copyFinished = DiagnosticClock::now();
#if !LOOM_NDI_DIRECT_OUTPUT
  job.unlockStarted = DiagnosticClock::now();
  const auto unlocked = IOSurfaceUnlock(job.surface, kIOSurfaceLockReadOnly, nullptr);
  job.unlockFinished = DiagnosticClock::now();
  require(unlocked == kIOReturnSuccess, "Cannot unlock NDI output IOSurface");
#endif
  NDIlib_video_frame_v2_t frame;
  frame.xres = static_cast<int>(job.width); frame.yres = static_cast<int>(job.height);
  frame.FourCC = NDIlib_FourCC_video_type_BGRA;
  frame.frame_rate_N = 60; frame.frame_rate_D = 1;
  frame.picture_aspect_ratio = static_cast<float>(job.width) / static_cast<float>(job.height);
  frame.frame_format_type = NDIlib_frame_format_type_progressive;
  frame.timecode = NDIlib_send_timecode_synthesize; // Transport clock, never a graph/shader clock.
#if LOOM_NDI_DIRECT_OUTPUT
  // NDI's synchronous input API takes uint8_t*, but reads this locked surface.
  // Its documented example frees pixel memory immediately after this call.
  frame.p_data = const_cast<uint8_t *>(source);
  frame.line_stride_in_bytes = static_cast<int>(sourceStride);
  job.sendStarted = DiagnosticClock::now();
  NDIlib_send_send_video_v2(publisher.sender, &frame);
  job.sendFinished = DiagnosticClock::now();
  job.unlockStarted = DiagnosticClock::now();
  const auto unlocked = IOSurfaceUnlock(job.surface, kIOSurfaceLockReadOnly, nullptr);
  job.unlockFinished = DiagnosticClock::now();
  require(unlocked == kIOReturnSuccess, "Cannot unlock NDI output IOSurface");
#else
  frame.p_data = buffer.data(); frame.line_stride_in_bytes = static_cast<int>(rowBytes);
  // Submitting slot B synchronizes previous slot A; A is reusable next time.
  job.sendStarted = DiagnosticClock::now();
  NDIlib_send_send_video_async_v2(publisher.sender, &frame);
  job.sendFinished = DiagnosticClock::now();
  publisher.nextBuffer = 1 - publisher.nextBuffer;
#endif
  ++publisher.stats->publishedFrames;
}
void execute(napi_env, void *data) {
  auto &job = *static_cast<Job *>(data);
  if (job.operation == Operation::Publish) job.workerStarted = DiagnosticClock::now();
  struct WorkerTiming {
    Job &job;
    ~WorkerTiming() {
      if (job.operation == Operation::Publish) job.workerFinished = DiagnosticClock::now();
    }
  } timing{job};
  @autoreleasepool {
    try {
      if (job.operation == Operation::Publish || job.operation == Operation::Stop) {
        auto &publisher = *job.publisher;
        std::unique_lock<std::mutex> lock(publisher.mutex);
        if (job.operation == Operation::Stop) {
          publisher.retire();
        } else {
          publishFrame(job);
        }
        return;
      }
      if (job.operation == Operation::List || job.operation == Operation::Open) {
        auto sdk = job.state->sdk;
        std::lock_guard<std::mutex> lock(sdk->mutex);
        sdk->start();
        if (job.operation == Operation::Open) {
          NDIlib_recv_create_v3_t settings;
          // The SDK owns discovery for this exact serialized source identity.
          // A short finder snapshot cannot establish that a source is unavailable.
          settings.source_to_connect_to = NDIlib_source_t(job.source.c_str(), nullptr);
          settings.color_format = NDIlib_recv_color_format_BGRX_BGRA;
          settings.bandwidth = NDIlib_recv_bandwidth_highest;
          settings.allow_video_fields = true; // Reject fields, never silently deinterlace.
          settings.p_ndi_recv_name = "Loom NDI input";
          job.session->receiver = NDIlib_recv_create_v3(&settings);
          require(job.session->receiver, "NDI receiver creation failed");
          return;
        }
        NDIlib_find_create_t discovery;
        discovery.show_local_sources = true;
        struct Finder {
          NDIlib_find_instance_t value;
          ~Finder() { if (value) NDIlib_find_destroy(value); }
        } finder{NDIlib_find_create_v2(&discovery)};
        require(finder.value, "NDI discovery creation failed");
        NDIlib_find_wait_for_sources(finder.value, 250);
        uint32_t count = 0;
        const auto *sources = NDIlib_find_get_current_sources(finder.value, &count);
        require(!count || sources, "NDI finder returned invalid source storage");
        for (uint32_t i = 0; i < count; ++i) {
          require(sources[i].p_ndi_name && sources[i].p_ndi_name[0], "NDI source has no full name");
          job.sources.emplace_back(sources[i].p_ndi_name);
        }
      } else {
        std::lock_guard<std::mutex> lock(job.session->mutex);
        if (job.operation == Operation::Close) {
          if (job.session->receiver) NDIlib_recv_destroy(job.session->receiver);
          job.session->receiver = nullptr;
        } else {
          require(!job.session->closed, "NDI session closed during acquisition");
          NDIlib_video_frame_v2_t frame;
          const auto kind = NDIlib_recv_capture_v2(job.session->receiver, &frame, nullptr, nullptr, 16);
          if (kind == NDIlib_frame_type_video) {
            struct FrameOwner {
              NDIlib_recv_instance_t receiver;
              NDIlib_video_frame_v2_t *frame;
              ~FrameOwner() { NDIlib_recv_free_video_v2(receiver, frame); }
            } owner{job.session->receiver, &frame};
            copyFrame(job, frame);
          } else {
            // SDK source discovery/connection can report this notification before
            // its first frame. It carries no video buffer to acquire or release.
            require(kind == NDIlib_frame_type_none || kind == NDIlib_frame_type_status_change ||
              kind == NDIlib_frame_type_source_change || kind == NDIlib_frame_type_error,
              ("Unexpected NDI capture result: " + std::to_string(static_cast<int>(kind))).c_str());
            // NDI owns reconnection to the same selected source. Report offline
            // explicitly without destroying its receiver or inventing a timeout.
            // A returned video frame takes precedence over transient connection
            // state; only query connection count when capture produced no video.
            job.offline = kind == NDIlib_frame_type_error ||
              NDIlib_recv_get_no_connections(job.session->receiver) == 0;
          }
        }
      }
    } catch (const std::exception &error) { job.error = error.what(); }
  }
}
void complete(napi_env env, napi_status status, void *data) {
  std::unique_ptr<Job> job(static_cast<Job *>(data));
  if (job->operation == Operation::Publish) job->delivered = DiagnosticClock::now();
  std::string insertedLease;
  if (job->operation == Operation::List) job->state->listing = false;
  if (job->operation == Operation::Acquire) job->session->busy = false;
  if (job->operation == Operation::Publish) {
    job->publisher->busy = false;
  }
  try {
    require(status == napi_ok, "NDI operation was cancelled");
    if (!job->error.empty()) throw std::runtime_error(job->error);
    napi_value result = undefined(env);
    if (job->operation == Operation::List) {
      check(napi_create_array_with_length(env, job->sources.size(), &result));
      uint32_t index = 0;
      for (const auto &source : job->sources) {
        napi_value item; check(napi_create_object(env, &item));
        set(env, item, "id", text(env, source)); set(env, item, "name", text(env, source));
        set(env, item, "app", text(env, "NDI"));
        check(napi_set_element(env, result, index++, item));
      }
    } else if (job->operation == Operation::Open) {
      require(!job->session->closed, "NDI input closed during opening");
      result = text(env, job->id);
      job->state->sessions.emplace(job->id, job->session);
    } else if (job->operation == Operation::Acquire) {
      require(!job->session->closed, "NDI session closed during acquisition");
      if (job->offline) {
        check(napi_create_object(env, &result));
        set(env, result, "kind", text(env, "offline"));
      } else if (!job->surface) check(napi_get_null(env, &result));
      else {
        const auto id = "ndi-lease-" + std::to_string(++job->state->nextLease);
        napi_value handle; check(napi_create_object(env, &result));
        check(napi_create_buffer_copy(env, sizeof(IOSurfaceRef), &job->surface, nullptr, &handle));
        set(env, result, "handle", handle); set(env, result, "leaseId", text(env, id));
        set(env, result, "width", number(env, job->width)); set(env, result, "height", number(env, job->height));
        set(env, result, "sequence", number(env, ++job->session->sequence));
        auto lease = std::make_unique<Lease>();
        lease->session = job->session;
        lease->surface = job->surface; job->surface = nullptr;
        insertedLease = id;
        job->state->leases.emplace(id, std::move(lease));
        job->session->lease = id;
      }
    }
    check(napi_resolve_deferred(env, job->deferred, result));
    if (job->operation == Operation::Publish) {
      auto &timing = job->publisher->stats->publicationTiming;
      const auto queue = elapsedNs(job->queued, job->workerStarted);
      const auto setup = elapsedNs(job->workerStarted, job->lockStarted);
      const auto lock = elapsedNs(job->lockStarted, job->lockFinished);
      const auto copy = elapsedNs(job->copyStarted, job->copyFinished);
      const auto unlock = elapsedNs(job->unlockStarted, job->unlockFinished);
      const auto send = elapsedNs(job->sendStarted, job->sendFinished);
      const auto worker = elapsedNs(job->workerStarted, job->workerFinished);
      const auto delivery = elapsedNs(job->workerFinished, job->delivered);
      ++timing.samples;
      timing.queueNs += queue; timing.setupNs += setup;
      timing.surfaceLockNs += lock; timing.surfaceCopyNs += copy; timing.surfaceUnlockNs += unlock;
      timing.sdkSendNs += send;
      timing.workerOtherNs += worker - setup - lock - copy - unlock - send;
      timing.deliveryNs += delivery; timing.totalNs += queue + worker + delivery;
    }
  } catch (const std::exception &error) {
    if (!insertedLease.empty()) { job->state->leases.erase(insertedLease); job->session->lease.clear(); }
    if (job->operation == Operation::Open) job->state->sessions.erase(job->id);
    // Do not throw C++ through a N-API completion boundary, including teardown.
    napi_value message, exception;
    if (napi_create_string_utf8(env, error.what(), NAPI_AUTO_LENGTH, &message) == napi_ok &&
        napi_create_error(env, nullptr, message, &exception) == napi_ok)
      napi_reject_deferred(env, job->deferred, exception);
  }
  if (job->operation == Operation::Stop) {
    // Do not lose an undrained publisher when cancellation prevented retirement.
    if (status == napi_ok && job->error.empty()) job->state->publishers.erase(job->id);
    job->publisher->stopping = false;
    if (job->publisher->stopPromise) {
      napi_delete_reference(env, job->publisher->stopPromise);
      job->publisher->stopPromise = nullptr;
    }
  }
  if (job->operation == Operation::Publish && job->publisher->stopJob) {
    // Never occupy a libuv worker waiting for another queued worker. Publication
    // has completed (or failed/cancelled); only now can retirement be scheduled.
    auto stopJob = std::move(job->publisher->stopJob);
    const auto queued = napi_queue_async_work(env, stopJob->work);
    if (queued == napi_ok) stopJob.release();
    else complete(env, queued, stopJob.release()); // Reject Stop, retain undrained publisher for explicit retry.
  }
  napi_delete_async_work(env, job->work);
}
napi_value queue(napi_env env, std::unique_ptr<Job> job, napi_ref *promiseReference = nullptr,
    bool afterPublish = false) {
  napi_value promise; check(napi_create_promise(env, &job->deferred, &promise));
  check(napi_create_async_work(env, nullptr, text(env, "NDI native input"), execute, complete, job.get(), &job->work));
  if (promiseReference) {
    const auto referenceStatus = napi_create_reference(env, promise, 1, promiseReference);
    if (referenceStatus != napi_ok) { napi_delete_async_work(env, job->work); check(referenceStatus); }
  }
  if (afterPublish) {
    auto publisher = job->publisher;
    publisher->stopJob = std::move(job);
    return promise;
  }
  if (job->operation == Operation::Publish) job->queued = DiagnosticClock::now();
  const auto status = napi_queue_async_work(env, job->work);
  if (status != napi_ok) {
    napi_delete_async_work(env, job->work);
    if (promiseReference) { napi_delete_reference(env, *promiseReference); *promiseReference = nullptr; }
    check(status);
  }
  job.release(); return promise;
}
napi_value list(napi_env env, napi_callback_info info) {
  try {
    size_t count = 1; napi_value value;
    check(napi_get_cb_info(env, info, &count, &value, nullptr, nullptr));
    require(count == 0, "NDI list expects no arguments");
    auto state = stateFor(env); require(!state->listing, "NDI discovery is already in flight");
    auto job = std::make_unique<Job>(); job->operation = Operation::List; job->state = state;
    auto promise = queue(env, std::move(job)); state->listing = true; return promise;
  } catch (const std::exception &error) { return failure(env, error); }
}
napi_value open(napi_env env, napi_callback_info info) {
  try {
    auto state = stateFor(env);
    const auto name = argument(env, info);
    require(state->capacity->load() < 8, "NDI input capacity is eight sessions including retained leases");
    auto session = workerOwned<Session>(); session->sdk = state->sdk;
    session->capacity = state->capacity; ++*state->capacity;
    auto job = std::make_unique<Job>(); job->operation = Operation::Open; job->state = state;
    job->session = session; job->source = name; job->id = "ndi-input-" + std::to_string(++state->nextSession);
    return queue(env, std::move(job));
  } catch (const std::exception &error) { return failure(env, error); }
}
napi_value acquire(napi_env env, napi_callback_info info) {
  try {
    auto state = stateFor(env); auto session = sessionFor(state, argument(env, info));
    require(!session->busy && session->lease.empty(), "NDI session already has an acquisition or unreleased lease");
    auto job = std::make_unique<Job>(); job->operation = Operation::Acquire; job->state = state; job->session = session;
    auto promise = queue(env, std::move(job)); session->busy = true; return promise;
  } catch (const std::exception &error) { return failure(env, error); }
}
napi_value release(napi_env env, napi_callback_info info) {
  try {
    auto state = stateFor(env); const auto id = argument(env, info);
    const auto found = state->leases.find(id);
    require(found != state->leases.end(), "Unknown or already released NDI lease");
    auto result = undefined(env); found->second->session->lease.clear(); state->leases.erase(found); return result;
  } catch (const std::exception &error) { return failure(env, error); }
}
napi_value close(napi_env env, napi_callback_info info) {
  try {
    auto state = stateFor(env); const auto id = argument(env, info); auto session = sessionFor(state, id);
    auto job = std::make_unique<Job>(); job->operation = Operation::Close; job->state = state; job->session = session;
    // Publish cancellation before a close worker could destroy the receiver.
    // Failed queueing restores the session; no receiver was touched in that case.
    session->closed = true;
    try {
      auto promise = queue(env, std::move(job)); state->sessions.erase(id); return promise;
    } catch (...) { session->closed = false; throw; }
  } catch (const std::exception &error) { return failure(env, error); }
}
napi_value publish(napi_env env, napi_callback_info info) {
  std::shared_ptr<State> state;
  std::shared_ptr<Publisher> publisher;
  std::string name;
  bool inserted = false;
  try {
    size_t count = 3; napi_value args[3];
    check(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    require(count == 2, "NDI publish expects local IOSurfaceRef buffer and publisher name");
    void *bytes = nullptr; size_t length = 0;
    check(napi_get_buffer_info(env, args[0], &bytes, &length));
    require(length == sizeof(IOSurfaceRef), "Expected local IOSurfaceRef buffer");
    IOSurfaceRef surface; std::memcpy(&surface, bytes, sizeof(surface));
    require(surface, "NDI output IOSurface is null");
    auto job = std::make_unique<Job>();
    CFRetain(surface); job->surface = surface;
    job->width = IOSurfaceGetWidth(surface); job->height = IOSurfaceGetHeight(surface);
    require(job->width && job->height && job->width <= 16384 && job->height <= 16384 &&
      IOSurfaceGetPixelFormat(surface) == (uint32_t)0x42475241 && IOSurfaceGetBytesPerElement(surface) == 4 &&
      IOSurfaceGetPlaneCount(surface) == 0 && IOSurfaceGetBytesPerRow(surface) >= job->width * 4,
      "NDI output requires packed BGRA8 and dimensions 1 through 16384");
    size_t nameLength = 0;
    check(napi_get_value_string_utf8(env, args[1], nullptr, 0, &nameLength));
    require(nameLength && nameLength <= 128, "NDI publisher name must be 1 through 128 UTF8 bytes");
    std::array<char, 129> nameBytes{};
    check(napi_get_value_string_utf8(env, args[1], nameBytes.data(), nameBytes.size(), &nameLength));
    name.assign(nameBytes.data(), nameLength);
    require(name.find('\0') == std::string::npos, "NUL in NDI publisher name");
    require(name.find_first_of("\\/:*?\"<>|") == std::string::npos,
      "NDI publisher name contains reserved characters");
    state = stateFor(env);
    const auto found = state->publishers.find(name);
    if (found != state->publishers.end()) publisher = found->second;
    else {
      require(state->publishers.size() < 4, "NDI output capacity is four publishers including retirement");
      publisher = workerOwned<Publisher>(); publisher->sdk = state->sdk; publisher->stats = state->outputStats;
      state->publishers.emplace(name, publisher); inserted = true;
    }
    require(!publisher->busy && !publisher->stopping, "NDI publisher already has a publication or retirement in flight");
    job->operation = Operation::Publish; job->state = state; job->publisher = publisher; job->id = name;
    auto promise = queue(env, std::move(job)); publisher->busy = true; return promise;
  } catch (const std::exception &error) {
    if (inserted) state->publishers.erase(name);
    return failure(env, error);
  }
}
napi_value stop(napi_env env, napi_callback_info info) {
  try {
    auto state = stateFor(env); const auto name = argument(env, info);
    require(name.size() <= 128, "NDI publisher name must be 1 through 128 UTF8 bytes");
    const auto found = state->publishers.find(name);
    if (found == state->publishers.end()) {
      napi_deferred deferred; napi_value promise;
      check(napi_create_promise(env, &deferred, &promise));
      check(napi_resolve_deferred(env, deferred, undefined(env))); return promise;
    }
    auto publisher = found->second;
    if (publisher->stopping) {
      napi_value promise; check(napi_get_reference_value(env, publisher->stopPromise, &promise)); return promise;
    }
    auto job = std::make_unique<Job>(); job->operation = Operation::Stop;
    job->state = state; job->publisher = publisher; job->id = name;
    publisher->stopping = true;
    try { return queue(env, std::move(job), &publisher->stopPromise, publisher->busy); }
    catch (...) { publisher->stopping = false; throw; }
  } catch (const std::exception &error) { return failure(env, error); }
}
napi_value outputStats(napi_env env, napi_callback_info info) {
  try {
    size_t count = 1; napi_value value;
    check(napi_get_cb_info(env, info, &count, &value, nullptr, nullptr));
    require(count == 0, "NDI output stats expects no arguments");
    const auto state = stateFor(env); napi_value result; check(napi_create_object(env, &result));
    set(env, result, "mode", text(env, LOOM_NDI_DIRECT_OUTPUT ? "direct" : "staged"));
    set(env, result, "publishers", number(env, state->publishers.size()));
    set(env, result, "stagingBytes", number(env, state->outputStats->stagingBytes));
    set(env, result, "stagingBuffers", number(env, state->outputStats->stagingBuffers));
    set(env, result, "bufferAllocations", number(env, state->outputStats->bufferAllocations));
    set(env, result, "publishedFrames", number(env, state->outputStats->publishedFrames));
    // Diagnostics only: no clocks feed frame content, cadence, buffering, or SDK
    // timecode. totalNs partitions queued-to-completion time without overlap.
    const auto &timing = state->outputStats->publicationTiming;
    napi_value publicationTiming; check(napi_create_object(env, &publicationTiming));
    set(env, publicationTiming, "samples", number(env, timing.samples));
    set(env, publicationTiming, "queueNs", number(env, timing.queueNs));
    set(env, publicationTiming, "setupNs", number(env, timing.setupNs));
    set(env, publicationTiming, "surfaceLockNs", number(env, timing.surfaceLockNs));
    set(env, publicationTiming, "surfaceCopyNs", number(env, timing.surfaceCopyNs));
    set(env, publicationTiming, "surfaceUnlockNs", number(env, timing.surfaceUnlockNs));
    set(env, publicationTiming, "sdkSendNs", number(env, timing.sdkSendNs));
    set(env, publicationTiming, "workerOtherNs", number(env, timing.workerOtherNs));
    set(env, publicationTiming, "deliveryNs", number(env, timing.deliveryNs));
    set(env, publicationTiming, "totalNs", number(env, timing.totalNs));
    set(env, result, "publicationTiming", publicationTiming);
    return result;
  } catch (const std::exception &error) { return failure(env, error); }
}
void finalize(napi_env, void *data, void *) {
  auto owner = static_cast<std::shared_ptr<State> *>(data);
  for (auto &entry : (*owner)->sessions) entry.second->closed = true;
  delete owner;
}
} // namespace

NAPI_MODULE_INIT() {
  try {
    auto owner = std::make_unique<std::shared_ptr<State>>(std::make_shared<State>());
    check(napi_set_instance_data(env, owner.get(), finalize, nullptr)); owner.release();
    napi_value input; check(napi_create_object(env, &input));
    napi_property_descriptor methods[] = {
      {"list", nullptr, list, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"open", nullptr, open, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"acquire", nullptr, acquire, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"release", nullptr, release, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, close, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    check(napi_define_properties(env, input, sizeof(methods) / sizeof(methods[0]), methods));
    set(env, exports, "input", input);
    napi_value output; check(napi_create_object(env, &output));
    napi_property_descriptor outputMethods[] = {
      {"publish", nullptr, publish, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stop", nullptr, stop, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stats", nullptr, outputStats, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    check(napi_define_properties(env, output, sizeof(outputMethods) / sizeof(outputMethods[0]), outputMethods));
    set(env, exports, "output", output); return exports;
  } catch (const std::exception &error) { return failure(env, error); }
}
