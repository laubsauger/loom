#include <node_api.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#include <xpc/xpc.h>
#include <stdexcept>
#include <unistd.h>
#include <atomic>

static xpc_connection_t connection;
static IOSurfaceRef surface;
static uint32_t sequence;
static uint64_t producerPid;
static std::atomic<bool> terminal{false};

static xpc_object_t request(const char *op, uint32_t format = 0) {
  if (terminal.load()) throw std::runtime_error("Producer connection lost; new session required");
  if (!connection) {
    const char *name = getenv("SHADERLOOM_PROOF_SERVICE");
    if (!name) throw std::runtime_error("Missing producer service");
    connection = xpc_connection_create_mach_service(name, nullptr, 0);
    xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
      if (xpc_get_type(event) == XPC_TYPE_ERROR) {
        terminal.store(true);
        // XPC may otherwise reconnect to a fresh, empty producer on the next send.
        xpc_connection_cancel(connection);
      }
    });
    xpc_connection_activate(connection);
  }
  const char *token = getenv("SHADERLOOM_PROOF_TOKEN");
  if (!token) throw std::runtime_error("Missing producer token");
  xpc_object_t message = xpc_dictionary_create(nullptr, nullptr, 0);
  xpc_dictionary_set_string(message, "token", token);
  xpc_dictionary_set_string(message, "op", op);
  xpc_dictionary_set_uint64(message, "sequence", sequence);
  xpc_dictionary_set_uint64(message, "format", format);
  dispatch_semaphore_t ready = dispatch_semaphore_create(0);
  __block xpc_object_t response = nil;
  xpc_connection_send_message_with_reply(connection, message,
    dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^(xpc_object_t reply) {
      response = reply;
      dispatch_semaphore_signal(ready);
    });
  // Synchronous only in this serial correctness lab; never on the app frame path.
  if (dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC))) {
    terminal.store(true);
    xpc_connection_cancel(connection);
    throw std::runtime_error("Producer reply timeout");
  }
  if (!response || xpc_get_type(response) != XPC_TYPE_DICTIONARY) {
    terminal.store(true);
    xpc_connection_cancel(connection);
    throw std::runtime_error("Producer connection failed");
  }
  const char *error = xpc_dictionary_get_string(response, "error");
  if (error) throw std::runtime_error(error);
  const uint64_t pid = xpc_dictionary_get_uint64(response, "producerPid");
  if (pid == 0 || pid == (uint64_t)getpid() || (producerPid && producerPid != pid) ||
      xpc_connection_get_euid(connection) != geteuid() ||
      pid != (uint64_t)xpc_connection_get_pid(connection) ||
      xpc_dictionary_get_uint64(response, "sequence") != sequence)
    throw std::runtime_error("Producer identity/sequence changed");
  producerPid = pid;
  return response;
}

static napi_value prepare(napi_env env, napi_callback_info info) {
  try {
    if (surface) throw std::runtime_error("Unreleased consumer surface");
    size_t argc = 2;
    napi_value args[2];
    uint32_t format, frame;
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 2 ||
        napi_get_value_uint32(env, args[0], &format) != napi_ok ||
        napi_get_value_uint32(env, args[1], &frame) != napi_ok || format > 1 || frame != sequence)
      throw std::runtime_error("Invalid prepare arguments");
    xpc_object_t reply = request("prepare", format);
    xpc_object_t capability = xpc_dictionary_get_value(reply, "surface");
    if (!capability) throw std::runtime_error("Producer returned no surface capability");
    surface = IOSurfaceLookupFromXPCObject(capability);
    if (!surface || IOSurfaceGetWidth(surface) != 64 || IOSurfaceGetHeight(surface) != 64 ||
        IOSurfaceGetBytesPerElement(surface) != (format == 0 ? 4 : 8))
      throw std::runtime_error("Invalid imported surface layout");
    napi_value handle;
    if (napi_create_buffer_copy(env, sizeof(surface), &surface, nullptr, &handle) != napi_ok)
      throw std::runtime_error("Cannot encode local IOSurfaceRef");
    return handle;
  } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}

static napi_value release(napi_env env, napi_callback_info) {
  try {
    if (!surface) throw std::runtime_error("No consumer surface to release");
    // JS calls this only after allReferencesReleased AND verification.
    CFRelease(surface);
    surface = nullptr;
    xpc_object_t reply = request("release");
    if (xpc_dictionary_get_uint64(reply, "released") != sequence + 1)
      throw std::runtime_error("Producer did not acknowledge release");
    sequence++;
    napi_value value;
    napi_get_undefined(env, &value);
    return value;
  } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}

static napi_value dispose(napi_env env, napi_callback_info) {
  try {
    if (surface || sequence != 24) throw std::runtime_error("Incomplete consumer stream");
    xpc_object_t reply = request("finish");
    if (xpc_dictionary_get_uint64(reply, "released") != 24) throw std::runtime_error("Unacknowledged releases");
    xpc_connection_cancel(connection);
    napi_value value;
    napi_create_double(env, producerPid, &value);
    return value;
  } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}

static napi_value status(napi_env env, napi_callback_info) {
  napi_value value, pid, lost;
  napi_create_object(env, &value);
  napi_create_double(env, producerPid, &pid);
  napi_get_boolean(env, terminal.load(), &lost);
  napi_set_named_property(env, value, "producerPid", pid);
  napi_set_named_property(env, value, "terminal", lost);
  return value;
}

static napi_value abortSession(napi_env env, napi_callback_info) {
  if (surface) {
    napi_throw_error(env, nullptr, "Release local surface before aborting session");
    return nullptr;
  }
  terminal.store(true);
  if (connection) xpc_connection_cancel(connection);
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"prepare", nullptr, prepare, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"release", nullptr, release, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"status", nullptr, status, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"abort", nullptr, abortSession, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"dispose", nullptr, dispose, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, 5, methods);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
