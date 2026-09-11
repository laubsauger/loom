// Test-only native publisher/readback. Never loaded by the desktop application.
#include <node_api.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <Metal/Metal.h>
#import <Syphon/Syphon.h>
#include <cstring>
#include <vector>
static SyphonMetalServer *server;
static id<MTLDevice> device;
static id<MTLTexture> texture;
static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, nullptr, message); return nullptr;
}
NAPI_MODULE_INIT() {
  napi_property_descriptor methods[] = {
    {"start", nullptr, [](napi_env env, napi_callback_info)->napi_value {
      if (server) return fail(env, "Fixture already started");
      device = MTLCreateSystemDefaultDevice();
      server = [[SyphonMetalServer alloc] initWithName:@"loom-syphon-input-fixture" device:device options:nil];
      if (!server) return fail(env, "Fixture publisher failed");
      auto descriptor = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
        width:1280 height:720 mipmapped:NO];
      descriptor.storageMode = MTLStorageModeShared;
      texture = [device newTextureWithDescriptor:descriptor];
      NSString *uuid = (NSString *)server.serverDescription[SyphonServerDescriptionUUIDKey];
      napi_value value; napi_create_string_utf8(env, uuid.UTF8String, NAPI_AUTO_LENGTH, &value); return value;
    }, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"publish", nullptr, [](napi_env env, napi_callback_info info)->napi_value {
      size_t argc=1; napi_value arg; uint32_t red=0;
      napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);
      if (!server || argc!=1 || napi_get_value_uint32(env,arg,&red)!=napi_ok || red>255)
        return fail(env,"Invalid fixture publish");
      const NSUInteger width=texture.width, height=texture.height;
      std::vector<unsigned char> pixels(width*height*4);
      for (size_t i=0;i<pixels.size();i+=4) { pixels[i]=17; pixels[i+1]=31; pixels[i+2]=red; pixels[i+3]=255; }
      [texture replaceRegion:MTLRegionMake2D(0,0,width,height) mipmapLevel:0 withBytes:pixels.data() bytesPerRow:width*4];
      id<MTLCommandQueue> queue=[device newCommandQueue]; id<MTLCommandBuffer> command=[queue commandBuffer];
      [server publishFrameTexture:texture onCommandBuffer:command imageRegion:NSMakeRect(0,0,width,height) flipped:NO];
      [command commit]; [command waitUntilCompleted];
      if(command.status!=MTLCommandBufferStatusCompleted) return fail(env,"Fixture GPU publication failed");
      napi_value result; napi_get_undefined(env,&result); return result;
    }, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"resize1080", nullptr, [](napi_env env,napi_callback_info)->napi_value {
      if(!server) return fail(env,"Fixture is not started");
      auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
        width:1920 height:1080 mipmapped:NO];
      descriptor.storageMode=MTLStorageModeShared;
      texture=[device newTextureWithDescriptor:descriptor];
      if(!texture) return fail(env,"Fixture resize allocation failed");
      napi_value result; napi_get_undefined(env,&result); return result;
    },nullptr,nullptr,nullptr,napi_default,nullptr},
    {"sample", nullptr, [](napi_env env, napi_callback_info info)->napi_value {
      size_t argc=1,length=0; napi_value arg; void *data=nullptr;
      napi_get_cb_info(env,info,&argc,&arg,nullptr,nullptr);
      if(argc!=1 || napi_get_buffer_info(env,arg,&data,&length)!=napi_ok || length!=sizeof(IOSurfaceRef))
        return fail(env,"Invalid fixture sample handle");
      IOSurfaceRef surface=nullptr; memcpy(&surface,data,sizeof(surface));
      if(!surface || IOSurfaceLock(surface,kIOSurfaceLockReadOnly,nullptr)!=kIOReturnSuccess)
        return fail(env,"Cannot lock fixture sample");
      auto p=static_cast<unsigned char *>(IOSurfaceGetBaseAddress(surface));
      unsigned char rgba[]={p[2],p[1],p[0],p[3]};
      IOSurfaceUnlock(surface,kIOSurfaceLockReadOnly,nullptr);
      napi_value result; napi_create_buffer_copy(env,4,rgba,nullptr,&result); return result;
    }, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stop", nullptr, [](napi_env env,napi_callback_info)->napi_value {
      [server stop]; server=nil; texture=nil; device=nil;
      napi_value result; napi_get_undefined(env,&result); return result;
    }, nullptr,nullptr,nullptr,napi_default,nullptr}
  };
  napi_define_properties(env,exports,sizeof(methods)/sizeof(methods[0]),methods);
  return exports;
}
