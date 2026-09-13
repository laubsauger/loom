// Electron main only. Handles are process-local IOSurfaceRef buffers, never IPC
// payloads for a renderer. XPC transfers capabilities; callbacks do not block a
// libuv worker or the JS thread. Caller must finish GPU reads before release.
#include <node_api.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <CoreVideo/CoreVideo.h>
#include <xpc/xpc.h>
#include <unistd.h>
#include <atomic>
#include <cmath>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
void require(bool ok, const char *message) { if (!ok) throw std::runtime_error(message); }
void check(napi_status status) { require(status == napi_ok, "Vision client N-API failure"); }
napi_value text(napi_env env, const std::string &s) { napi_value v; check(napi_create_string_utf8(env, s.c_str(), s.size(), &v)); return v; }
napi_value number(napi_env env, uint64_t n) { napi_value v; check(napi_create_double(env, double(n), &v)); return v; }
napi_value undefined(napi_env env) { napi_value v; check(napi_get_undefined(env, &v)); return v; }
void set(napi_env env, napi_value object, const char *key, napi_value value) { check(napi_set_named_property(env, object, key, value)); }
std::string string(napi_env env, napi_value v) {
  size_t size; check(napi_get_value_string_utf8(env, v, nullptr, 0, &size));
  require(size > 0 && size <= 4096, "Invalid Vision string argument");
  std::vector<char> bytes(size + 1); check(napi_get_value_string_utf8(env, v, bytes.data(), bytes.size(), &size));
  std::string result(bytes.data(), size); require(result.find('\0') == std::string::npos, "NUL in Vision argument"); return result;
}
struct Session {
  xpc_connection_t connection = nil;
  dispatch_queue_t queue = nil;
  std::atomic<bool> terminal{false};
  std::string id, token;
  uint64_t sequence = 0, pid = 0;
  bool busy = false;
  IOSurfaceRef input = nullptr, output = nullptr;
  ~Session() {
    if (connection) xpc_connection_cancel(connection);
    if (input) CFRelease(input);
    if (output) CFRelease(output);
  }
};
struct State { std::map<std::string, std::shared_ptr<Session>> sessions; uint64_t next = 0; };
struct Job {
  std::shared_ptr<State> state;
  std::shared_ptr<Session> session;
  std::string op, error;
  napi_deferred deferred = nullptr;
  napi_threadsafe_function completion = nullptr;
  dispatch_source_t timer = nil;
  xpc_object_t reply = nil;
  uint64_t peerPid = 0, peerUid = 0;
  bool delivered = false; // Only accessed on the session's serial XPC queue.
  bool timerResumed = false;
  ~Job() {
    // Also cover setup failures before the source was resumed. Releasing a
    // suspended dispatch source can crash rather than report the original error.
    if (timer) {
      dispatch_source_cancel(timer);
      if (!timerResumed) dispatch_resume(timer);
    }
  }
};
std::shared_ptr<State> stateFor(napi_env env) {
  void *data; check(napi_get_instance_data(env, &data)); return *static_cast<std::shared_ptr<State> *>(data);
}
uint64_t integer(xpc_object_t reply, const char *key) {
  auto value = xpc_dictionary_get_value(reply, key);
  require(value && xpc_get_type(value) == XPC_TYPE_UINT64, "Malformed Vision reply integer");
  return xpc_uint64_get_value(value);
}
void terminal(const std::shared_ptr<Session> &s) { s->terminal.store(true); xpc_connection_cancel(s->connection); }

void complete(napi_env env, napi_value, void *context, void *) {
  auto &job = *static_cast<Job *>(context);
  auto s = job.session;
  if (!env) { terminal(s); return; }
  bool acknowledged = false;
  try {
    require(job.error.empty(), job.error.c_str());
    require(job.reply && xpc_get_type(job.reply) == XPC_TYPE_DICTIONARY, "Vision connection lost; leases retained");
    const auto pid = integer(job.reply, "producerPid");
    require(pid > 0 && pid != uint64_t(getpid()) && pid == job.peerPid && job.peerUid == geteuid() &&
      (!s->pid || pid == s->pid), "Vision peer identity changed; leases retained");
    s->pid = pid;
    // An authenticated refusal is a completed request, not an uncertain timeout.
    if (const char *error = xpc_dictionary_get_string(job.reply, "error")) {
      acknowledged = true; throw std::runtime_error(error);
    }
    require(integer(job.reply, "sequence") == s->sequence, "Vision reply sequence changed; leases retained");
    napi_value result = undefined(env);
    if (job.op == "infer" || job.op == "infer-packed") {
      auto capability = xpc_dictionary_get_value(job.reply, "surface");
      require(capability != nullptr, "Missing Vision result capability; leases retained");
      s->output = IOSurfaceLookupFromXPCObject(capability);
      require(s->output && IOSurfaceGetPixelFormat(s->output) == kCVPixelFormatType_64RGBAHalf &&
        IOSurfaceGetPlaneCount(s->output) == 0 && IOSurfaceGetBytesPerElement(s->output) == 8 &&
        IOSurfaceGetWidth(s->output) > 0 && IOSurfaceGetWidth(s->output) <= 8192 &&
        IOSurfaceGetHeight(s->output) > 0 && IOSurfaceGetHeight(s->output) <= 8192,
        "Invalid Vision result layout; leases retained");
      require(integer(job.reply, "inputSurfaceId") == IOSurfaceGetID(s->input) &&
        integer(job.reply, "resultSurfaceId") == IOSurfaceGetID(s->output), "Vision surface identity changed; leases retained");
      check(napi_create_object(env, &result));
      napi_value handle; check(napi_create_buffer_copy(env, sizeof(s->output), &s->output, nullptr, &handle));
      set(env, result, "handle", handle);
      set(env, result, "width", number(env, IOSurfaceGetWidth(s->output)));
      set(env, result, "height", number(env, IOSurfaceGetHeight(s->output)));
      set(env, result, "sequence", number(env, s->sequence));
      set(env, result, "producerPid", number(env, pid));
      set(env, result, "format", text(env, "rgba16float"));
      auto coverageValue = xpc_dictionary_get_value(job.reply, "coverage");
      require(coverageValue && xpc_get_type(coverageValue) == XPC_TYPE_DOUBLE, "Missing Vision coverage");
      const double coverage = xpc_double_get_value(coverageValue);
      require(std::isfinite(coverage) && coverage >= 0 && coverage <= 1, "Invalid Vision coverage");
      napi_value coverageResult; check(napi_create_double(env, coverage, &coverageResult));
      set(env, result, "coverage", coverageResult);
    } else if (job.op == "release") {
      require(integer(job.reply, "released") == s->sequence + 1, "Missing Vision release acknowledgment; lease retained");
      CFRelease(s->output); s->output = nullptr; s->sequence++;
    } else if (job.op == "finish") {
      terminal(s); job.state->sessions.erase(s->id);
    }
    acknowledged = true;
    if (s->input) { CFRelease(s->input); s->input = nullptr; }
    s->busy = false;
    check(napi_resolve_deferred(env, job.deferred, result));
  } catch (const std::exception &error) {
    if (acknowledged && s->input) { CFRelease(s->input); s->input = nullptr; }
    if (!acknowledged) terminal(s);
    // Unknown completion retains input/output and its capacity. No timeout may
    // authorize upstream reuse or replace a consumer GPU-release callback.
    s->busy = false;
    napi_value value;
    if (napi_create_error(env, text(env, acknowledged ? "VISION_REQUEST_REFUSED" : "VISION_COMPLETION_UNCERTAIN"),
      text(env, error.what()), &value) == napi_ok)
      napi_reject_deferred(env, job.deferred, value);
  }
}
void deliver(const std::shared_ptr<Job> &job, xpc_object_t reply, const char *error = "") {
  if (job->delivered) return;
  job->delivered = true; job->reply = reply; job->error = error;
  job->peerPid = xpc_connection_get_pid(job->session->connection);
  job->peerUid = xpc_connection_get_euid(job->session->connection);
  dispatch_source_cancel(job->timer); job->timer = nil;
  auto status = napi_call_threadsafe_function(job->completion, nullptr, napi_tsfn_nonblocking);
  if (status != napi_ok && status != napi_closing) {
    terminal(job->session);
    fprintf(stderr, "VISION_CLIENT_COMPLETION_FAILED status=%d\n", status);
  }
  napi_release_threadsafe_function(job->completion, napi_tsfn_release);
}
napi_value request(napi_env env, const std::shared_ptr<State> &state, const std::shared_ptr<Session> &s,
                   const std::string &op, IOSurfaceRef input = nullptr, const uint32_t *dimensions = nullptr) {
  require(!s->terminal.load(), "Vision session is terminal; uncertain leases remain retained");
  require(!s->busy, "Vision request already in flight");
  require(s->input == nullptr, "Vision input lease is retained");
  require(op == "release" ? s->output != nullptr : s->output == nullptr,
    op == "release" ? "No Vision result to release" : "Release Vision result first");
  auto job = std::make_shared<Job>(); job->state = state; job->session = s; job->op = op;
  auto message = xpc_dictionary_create(nullptr, nullptr, 0);
  xpc_dictionary_set_string(message, "token", s->token.c_str());
  xpc_dictionary_set_string(message, "op", op.c_str());
  xpc_dictionary_set_uint64(message, "sequence", s->sequence);
  if (dimensions) {
    const char *keys[] = {"inputWidth", "inputHeight", "outputWidth", "outputHeight"};
    for (size_t i = 0; i < 4; i++) xpc_dictionary_set_uint64(message, keys[i], dimensions[i]);
  }
  if (input) {
    auto capability = IOSurfaceCreateXPCObject(input);
    require(capability != nullptr, "Cannot export Vision input capability");
    xpc_dictionary_set_value(message, "surface", capability);
  }
  job->timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, s->queue);
  require(job->timer != nil, "Cannot create Vision request timer");
  napi_value promise; check(napi_create_promise(env, &job->deferred, &promise));
  auto holder = new std::shared_ptr<Job>(job);
  auto status = napi_create_threadsafe_function(env, nullptr, nullptr, text(env, "Vision XPC reply"), 1, 1, holder,
    [](napi_env, void *data, void *) { delete static_cast<std::shared_ptr<Job> *>(data); }, job.get(), complete, &job->completion);
  if (status != napi_ok) {
    delete holder;
    dispatch_source_cancel(job->timer); dispatch_resume(job->timer); job->timer = nil;
    check(status);
  }
  if (input) s->input = (IOSurfaceRef)CFRetain(input);
  s->busy = true;
  std::weak_ptr<Job> weak = job;
  dispatch_source_set_event_handler(job->timer, ^{
    if (auto pending = weak.lock()) {
      deliver(pending, nil, "Vision reply timeout; uncertain leases retained");
      terminal(pending->session);
    }
  });
  dispatch_source_set_timer(job->timer, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC), DISPATCH_TIME_FOREVER, 0);
  job->timerResumed = true;
  dispatch_resume(job->timer);
  xpc_connection_send_message_with_reply(s->connection, message, s->queue, ^(xpc_object_t reply) { deliver(job, reply); });
  return promise;
}
napi_value open(napi_env env, napi_callback_info info) {
  try {
    napi_value args[3]; size_t count = 3; check(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    require(count == 2, "Vision open requires service and token");
    auto state = stateFor(env); require(state->sessions.size() < 8, "Vision session cap reached, including retained leases");
    const auto name = string(env, args[0]), token = string(env, args[1]);
    auto s = std::make_shared<Session>(); s->id = "vision-" + std::to_string(++state->next); s->token = token;
    s->queue = dispatch_queue_create("loom.vision.client", DISPATCH_QUEUE_SERIAL);
    s->connection = xpc_connection_create_mach_service(name.c_str(), s->queue, 0);
    std::weak_ptr<Session> weak = s;
    xpc_connection_set_event_handler(s->connection, ^(xpc_object_t event) {
      if (xpc_get_type(event) == XPC_TYPE_ERROR) if (auto current = weak.lock()) terminal(current);
    });
    xpc_connection_activate(s->connection);
    state->sessions.emplace(s->id, s);
    return text(env, s->id);
  } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
napi_value operation(napi_env env, napi_callback_info info) {
  try {
    napi_value args[7]; size_t count = 7; void *data;
    check(napi_get_cb_info(env, info, &count, args, nullptr, &data));
    const std::string op(static_cast<const char *>(data));
    require(count == (op == "infer-packed" ? 6u : op == "infer" || op == "release" ? 2u : 1u), "Invalid Vision argument count");
    auto state = stateFor(env); auto found = state->sessions.find(string(env, args[0]));
    require(found != state->sessions.end(), "Unknown Vision session"); auto s = found->second;
    if (op == "disconnect") {
      require(!s->busy && !s->input && !s->output, "Cannot disconnect with pending work or retained leases");
      terminal(s); state->sessions.erase(found); return undefined(env);
    }
    IOSurfaceRef input = nullptr;
    if (op == "release") {
      double sequence; check(napi_get_value_double(env, args[1], &sequence));
      require(std::isfinite(sequence) && sequence >= 0 && sequence <= 9007199254740991.0 &&
        std::floor(sequence) == sequence && uint64_t(sequence) == s->sequence,
        "Stale or invalid Vision result release sequence");
    }
    if (op == "infer" || op == "infer-packed") {
      bool buffer; check(napi_is_buffer(env, args[1], &buffer)); require(buffer, "Vision input requires a local handle buffer");
      void *bytes; size_t size; check(napi_get_buffer_info(env, args[1], &bytes, &size));
      require(size == sizeof(input), "Invalid Vision handle length");
      // Copies the pointer only, never image bytes. Only trusted main code calls.
      memcpy(&input, bytes, sizeof(input)); require(input != nullptr, "Missing Vision input surface");
    }
    uint32_t dimensions[4];
    if (op == "infer-packed") {
      for (size_t i = 0; i < 4; i++) {
        double value; check(napi_get_value_double(env, args[i + 2], &value));
        require(std::isfinite(value) && value > 0 && value <= 8192 && std::floor(value) == value, "Invalid Vision dimensions");
        dimensions[i] = (uint32_t)value;
      }
    }
    return request(env, state, s, op, input, op == "infer-packed" ? dimensions : nullptr);
  } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
napi_value init(napi_env env, napi_value exports) {
  auto state = new std::shared_ptr<State>(std::make_shared<State>());
  check(napi_set_instance_data(env, state, [](napi_env, void *data, void *) {
    delete static_cast<std::shared_ptr<State> *>(data);
  }, nullptr));
  napi_property_descriptor methods[] = {
    {"open", nullptr, open, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"infer", nullptr, operation, nullptr, nullptr, nullptr, napi_default, (void *)"infer"},
    {"inferPacked", nullptr, operation, nullptr, nullptr, nullptr, napi_default, (void *)"infer-packed"},
    {"release", nullptr, operation, nullptr, nullptr, nullptr, napi_default, (void *)"release"},
    {"reset", nullptr, operation, nullptr, nullptr, nullptr, napi_default, (void *)"reset"},
    {"close", nullptr, operation, nullptr, nullptr, nullptr, napi_default, (void *)"finish"},
    {"disconnect", nullptr, operation, nullptr, nullptr, nullptr, napi_default, (void *)"disconnect"}
  };
  check(napi_define_properties(env, exports, 7, methods)); return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
