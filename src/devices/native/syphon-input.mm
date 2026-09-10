// T1341: Electron-main-only native Syphon ingestion. No renderer Node surface.
#include <node_api.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <Metal/Metal.h>
#import <Syphon/Syphon.h>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
void check(napi_status status) {
  if (status != napi_ok) throw std::runtime_error("Syphon input N-API operation failed");
}
struct Session {
  SyphonMetalClient *client = nil;
  id<MTLDevice> device = nil;
  id<MTLCommandQueue> queue = nil;
  bool busy = false;
  bool closed = false;
  uint64_t sequence = 0;
  std::string serverUUID;
  std::string lease;
  ~Session() { [client stop]; }
};
struct Lease {
  IOSurfaceRef surface = nullptr;
  std::shared_ptr<Session> session;
  ~Lease() { if (surface) CFRelease(surface); }
};
struct State {
  std::map<std::string, std::shared_ptr<Session>> sessions;
  std::map<std::string, std::unique_ptr<Lease>> leases;
  uint64_t nextSession = 0, nextLease = 0;
};
struct Job {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::shared_ptr<State> state;
  std::shared_ptr<Session> session;
  id<MTLTexture> source = nil;
  IOSurfaceRef surface = nullptr;
  NSUInteger width = 0, height = 0;
  std::string error;
  ~Job() { if (surface) CFRelease(surface); }
};
std::shared_ptr<State> stateFor(napi_env env) {
  void *data = nullptr;
  check(napi_get_instance_data(env, &data));
  return *static_cast<std::shared_ptr<State> *>(data);
}
napi_value undefined(napi_env env) {
  napi_value value; check(napi_get_undefined(env, &value)); return value;
}
napi_value text(napi_env env, const std::string &value) {
  napi_value result; check(napi_create_string_utf8(env, value.c_str(), value.size(), &result)); return result;
}
napi_value number(napi_env env, uint64_t value) {
  napi_value result; check(napi_create_double(env, (double)value, &result)); return result;
}
void set(napi_env env, napi_value object, const char *key, napi_value value) {
  check(napi_set_named_property(env, object, key, value));
}
std::string argument(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value values[2];
  check(napi_get_cb_info(env, info, &count, values, nullptr, nullptr));
  if (count != 1) throw std::runtime_error("Expected exactly one nonempty string argument");
  size_t length = 0;
  check(napi_get_value_string_utf8(env, values[0], nullptr, 0, &length));
  if (!length || length > 4096) throw std::runtime_error("Invalid string argument length");
  std::vector<char> bytes(length + 1);
  check(napi_get_value_string_utf8(env, values[0], bytes.data(), bytes.size(), &length));
  std::string result(bytes.data(), length);
  if (result.find('\0') != std::string::npos) throw std::runtime_error("NUL in identifier");
  return result;
}
std::shared_ptr<Session> sessionFor(const std::shared_ptr<State> &state, const std::string &id) {
  auto found = state->sessions.find(id);
  if (found == state->sessions.end() || found->second->closed) throw std::runtime_error("Unknown or closed Syphon session");
  return found->second;
}
bool connected(const std::shared_ptr<Session> &session) {
  if (!session->client.isValid) return false;
  // The SDK can retain isValid after a newly opened server has retired. Its
  // directory is authoritative for the selected UUID; never substitute a name.
  for (NSDictionary *server in [SyphonServerDirectory sharedDirectory].servers) {
    NSString *uuid = server[SyphonServerDescriptionUUIDKey];
    if ([uuid isKindOfClass:NSString.class] && session->serverUUID == uuid.UTF8String) return true;
  }
  return false;
}
napi_value failure(napi_env env, const std::exception &error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}
napi_value list(napi_env env, napi_callback_info) {
  @autoreleasepool {
    try {
      napi_value result; check(napi_create_array(env, &result));
      uint32_t index = 0;
      for (NSDictionary *server in [SyphonServerDirectory sharedDirectory].servers) {
        NSString *uuid = server[SyphonServerDescriptionUUIDKey];
        if (![uuid isKindOfClass:NSString.class] || !uuid.length)
          throw std::runtime_error("Discovered Syphon server has no usable UUID");
        napi_value item; check(napi_create_object(env, &item));
        set(env, item, "id", text(env, uuid.UTF8String));
        set(env, item, "name", text(env, [server[SyphonServerDescriptionNameKey] ?: @"" UTF8String]));
        set(env, item, "app", text(env, [server[SyphonServerDescriptionAppNameKey] ?: @"" UTF8String]));
        check(napi_set_element(env, result, index++, item));
      }
      return result;
    } catch (const std::exception &error) { return failure(env, error); }
  }
}
napi_value open(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    try {
      const auto uuid = argument(env, info);
      NSDictionary *selected = nil;
      for (NSDictionary *server in [SyphonServerDirectory sharedDirectory].servers) {
        NSString *candidate = server[SyphonServerDescriptionUUIDKey];
        if ([candidate isKindOfClass:NSString.class] && uuid == candidate.UTF8String) {
          if (selected) throw std::runtime_error("Duplicate Syphon UUID");
          selected = server;
        }
      }
      if (!selected) throw std::runtime_error("Selected Syphon UUID is unavailable");
      auto session = std::make_shared<Session>();
      session->serverUUID = uuid;
      session->device = MTLCreateSystemDefaultDevice();
      session->queue = [session->device newCommandQueue];
      if (!session->device || !session->queue) throw std::runtime_error("Metal device unavailable");
      session->client = [[SyphonMetalClient alloc] initWithServerDescription:selected
        device:session->device options:nil newFrameHandler:nil];
      if (!session->client || !session->client.isValid) throw std::runtime_error("Syphon connection failed");
      auto state = stateFor(env);
      const auto id = "syphon-input-" + std::to_string(++state->nextSession);
      state->sessions.emplace(id, session);
      return text(env, id);
    } catch (const std::exception &error) { return failure(env, error); }
  }
}
void execute(napi_env, void *data) {
  auto job = static_cast<Job *>(data);
  @autoreleasepool {
    try {
      job->surface = IOSurfaceCreate((__bridge CFDictionaryRef)@{
        (NSString *)kIOSurfaceWidth: @(job->width), (NSString *)kIOSurfaceHeight: @(job->height),
        (NSString *)kIOSurfaceBytesPerElement: @4,
        (NSString *)kIOSurfacePixelFormat: @((uint32_t)0x42475241) }); // BGRA
      if (!job->surface) throw std::runtime_error("Cannot allocate owned Syphon input IOSurface");
      auto descriptor = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
        width:job->width height:job->height mipmapped:NO];
      descriptor.storageMode = MTLStorageModeShared;
      id<MTLTexture> target = [job->session->device newTextureWithDescriptor:descriptor iosurface:job->surface plane:0];
      id<MTLCommandBuffer> command = [job->session->queue commandBuffer];
      if (!target || !command) throw std::runtime_error("Cannot allocate Syphon input GPU copy");
      id<MTLBlitCommandEncoder> blit = [command blitCommandEncoder];
      if (!blit) throw std::runtime_error("Cannot encode Syphon input GPU copy");
      [blit copyFromTexture:job->source sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0, 0, 0)
        sourceSize:MTLSizeMake(job->width, job->height, 1) toTexture:target destinationSlice:0
        destinationLevel:0 destinationOrigin:MTLOriginMake(0, 0, 0)];
      [blit endEncoding]; [command commit]; [command waitUntilCompleted];
      if (command.status != MTLCommandBufferStatusCompleted)
        throw std::runtime_error(command.error ? command.error.localizedDescription.UTF8String : "Syphon input GPU copy failed");
    } catch (const std::exception &error) { job->error = error.what(); }
  }
}
void complete(napi_env env, napi_status status, void *data) {
  std::unique_ptr<Job> job(static_cast<Job *>(data));
  auto session = job->session;
  session->busy = false;
  if (session->closed) { [session->client stop]; session->client = nil; }
  try {
    if (status != napi_ok) throw std::runtime_error("Syphon input copy was cancelled");
    if (session->closed) throw std::runtime_error("Syphon session closed during acquisition");
    if (!job->error.empty()) throw std::runtime_error(job->error);
    if (!connected(session)) throw std::runtime_error("Syphon source disconnected during acquisition");
    const auto leaseId = "syphon-lease-" + std::to_string(++job->state->nextLease);
    napi_value result, handle;
    check(napi_create_object(env, &result));
    check(napi_create_buffer_copy(env, sizeof(IOSurfaceRef), &job->surface, nullptr, &handle));
    set(env, result, "handle", handle);
    set(env, result, "width", number(env, job->width));
    set(env, result, "height", number(env, job->height));
    set(env, result, "sequence", number(env, ++session->sequence));
    set(env, result, "leaseId", text(env, leaseId));
    auto lease = std::make_unique<Lease>();
    lease->surface = job->surface; job->surface = nullptr;
    lease->session = session;
    job->state->leases.emplace(leaseId, std::move(lease));
    session->lease = leaseId;
    check(napi_resolve_deferred(env, job->deferred, result));
  } catch (const std::exception &error) {
    napi_value exception;
    napi_create_error(env, nullptr, text(env, error.what()), &exception);
    napi_reject_deferred(env, job->deferred, exception);
  }
  napi_delete_async_work(env, job->work);
}
napi_value acquire(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    try {
      auto state = stateFor(env);
      auto session = sessionFor(state, argument(env, info));
      if (session->busy || !session->lease.empty()) throw std::runtime_error("Syphon session already has an acquisition or unreleased lease");
      if (!connected(session)) throw std::runtime_error("Syphon source disconnected");
      napi_value promise;
      auto job = std::make_unique<Job>();
      check(napi_create_promise(env, &job->deferred, &promise));
      if (!session->client.hasNewFrame) {
        napi_value empty; check(napi_get_null(env, &empty));
        check(napi_resolve_deferred(env, job->deferred, empty)); return promise;
      }
      job->source = [session->client newFrameImage];
      if (!job->source || job->source.pixelFormat != MTLPixelFormatBGRA8Unorm)
        throw std::runtime_error("Syphon input requires a BGRA8Unorm source texture");
      IOSurfaceRef sourceSurface = job->source.iosurface;
      if (!sourceSurface || IOSurfaceGetPixelFormat(sourceSurface) != (uint32_t)0x42475241 ||
          IOSurfaceGetBytesPerElement(sourceSurface) != 4 || IOSurfaceGetPlaneCount(sourceSurface) != 0)
        throw std::runtime_error("Syphon source IOSurface is not tested packed BGRA8");
      job->width = job->source.width; job->height = job->source.height;
      if (!job->width || !job->height) throw std::runtime_error("Syphon source dimensions are empty");
      job->state = state; job->session = session;
      check(napi_create_async_work(env, nullptr, text(env, "Syphon input GPU copy"), execute, complete, job.get(), &job->work));
      napi_status queued = napi_queue_async_work(env, job->work);
      if (queued != napi_ok) { napi_delete_async_work(env, job->work); check(queued); }
      session->busy = true;
      job.release();
      return promise;
    } catch (const std::exception &error) { return failure(env, error); }
  }
}
napi_value release(napi_env env, napi_callback_info info) {
  try {
    auto state = stateFor(env); const auto id = argument(env, info);
    auto found = state->leases.find(id);
    if (found == state->leases.end()) throw std::runtime_error("Unknown or already released Syphon lease");
    found->second->session->lease.clear();
    state->leases.erase(found);
    return undefined(env);
  } catch (const std::exception &error) { return failure(env, error); }
}
napi_value close(napi_env env, napi_callback_info info) {
  try {
    auto state = stateFor(env); const auto id = argument(env, info);
    auto session = sessionFor(state, id);
    session->closed = true;
    state->sessions.erase(id);
    if (!session->busy) { [session->client stop]; session->client = nil; }
    // Issued leases stay alive in state->leases, independent of the closed session.
    return undefined(env);
  } catch (const std::exception &error) { return failure(env, error); }
}
void finalize(napi_env, void *data, void *) {
  auto owner = static_cast<std::shared_ptr<State> *>(data);
  for (auto &entry : (*owner)->sessions) {
    auto session = entry.second; session->closed = true;
    if (!session->busy) { [session->client stop]; session->client = nil; }
  }
  // Normal desktop shutdown must retire Electron imports and release leases first.
  // Jobs hold shared state until completion; no session pointer is freed underneath GPU work.
  delete owner;
}
} // namespace

NAPI_MODULE_INIT() {
  try {
    check(napi_set_instance_data(env, new std::shared_ptr<State>(std::make_shared<State>()), finalize, nullptr));
    napi_property_descriptor methods[] = {
      {"list", nullptr, list, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"open", nullptr, open, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"acquire", nullptr, acquire, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"release", nullptr, release, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, close, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    check(napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods));
    return exports;
  } catch (const std::exception &error) { return failure(env, error); }
}
