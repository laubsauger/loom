"""Real Vision inference in Python; native pointers stay in this one process."""
import ctypes as c
import json
import os
import sys
import time
import threading
import hashlib

lib = c.CDLL(sys.argv[1])
pointer = c.c_void_p
lib.loom_vision_create.restype = pointer
lib.loom_vision_error.restype = c.c_char_p
lib.loom_vision_infer.argtypes = [pointer, pointer]
lib.loom_vision_infer.restype = pointer
lib.loom_vision_infer_packed.argtypes = [pointer, pointer, c.c_uint32, c.c_uint32, c.c_uint32, c.c_uint32]
lib.loom_vision_infer_packed.restype = pointer
lib.loom_vision_coverage.argtypes = [pointer]
lib.loom_vision_coverage.restype = c.c_double
lib.oracle_pack_input.argtypes = [pointer]
lib.oracle_pack_input.restype = pointer
for name in ["width", "height"]:
    getattr(lib, "oracle_" + name).argtypes = [pointer]
    getattr(lib, "oracle_" + name).restype = c.c_uint32
for name in ["release", "reset", "destroy"]:
    getattr(lib, "loom_vision_" + name).argtypes = [pointer]
    getattr(lib, "loom_vision_" + name).restype = c.c_int
lib.oracle_input.argtypes = [c.c_char_p, c.c_bool]
lib.oracle_input.restype = pointer
lib.oracle_release_input.argtypes = [pointer]
lib.oracle_unsupported_input.restype = pointer


class Stats(c.Structure):
    _fields_ = [("width", c.c_uint32), ("height", c.c_uint32),
                ("max_error", c.c_double), ("foreground", c.c_uint64)]


lib.oracle_verify.argtypes = [pointer, pointer, c.POINTER(Stats)]
lib.oracle_verify.restype = c.c_int
lib.oracle_verify_expanded.argtypes = lib.oracle_verify.argtypes
lib.oracle_verify_expanded.restype = c.c_int


def check(ok):
    if not ok:
        raise AssertionError(lib.loom_vision_error().decode())


session = lib.loom_vision_create()
check(session)
held = False
results = []
try:
    invalid = lib.oracle_unsupported_input()
    assert invalid
    try:
        check(not lib.loom_vision_infer(session, invalid))
        assert "BGRA8" in lib.loom_vision_error().decode()
    finally:
        lib.oracle_release_input(invalid)
    for blank in [False, False, True]:
        # Reset temporal state explicitly before testing a different scene.
        if blank:
            check(lib.loom_vision_reset(session) == 0)
        image = lib.oracle_input(os.fsencode(sys.argv[2]), blank)
        assert image, "Cannot decode oracle input"
        try:
            started = time.perf_counter()
            output = lib.loom_vision_infer(session, image)
            check(output)
            held = True
            elapsed = (time.perf_counter() - started) * 1000
            stats = Stats()
            assert lib.oracle_verify(session, output, c.byref(stats)) == 0, "GPU mask differs from Vision reference"
            coverage = stats.foreground / (stats.width * stats.height)
            assert lib.loom_vision_coverage(session) == coverage
            assert coverage < 0.01 if blank else coverage > 0.01, f"Incorrect person control: {coverage}"
            # A lease prevents overwrite, reset and destruction. Failed calls
            # must leave the original result intact and verifiable.
            check(not lib.loom_vision_infer(session, image))
            check(lib.loom_vision_reset(session) == -1)
            check(lib.loom_vision_destroy(session) == -1)
            assert lib.oracle_verify(session, output, c.byref(stats)) == 0
            check(lib.loom_vision_release(session) == 0)
            held = False
            check(lib.loom_vision_release(session) == -1)
            results.append({"blank": blank, "size": [stats.width, stats.height],
                            "coverage": coverage, "max_error": stats.max_error, "milliseconds": elapsed})
        finally:
            lib.oracle_release_input(image)
    check(not lib.loom_vision_infer(session, None))
    check(lib.loom_vision_reset(session) == 0)
    cross_thread = []
    def wrong_thread():
        result = lib.loom_vision_reset(session)
        cross_thread.append((result, lib.loom_vision_error().decode()))
    thread = threading.Thread(target=wrong_thread)
    thread.start()
    thread.join()
    assert cross_thread == [(-1, "Vision session belongs to another thread")]
    reference = lib.loom_vision_create()
    check(reference)
    image = lib.oracle_input(os.fsencode(sys.argv[2]), False)
    assert image
    packed = lib.oracle_pack_input(image)
    assert packed
    reference_held = False
    try:
        for width, height in [(512, 384), (1920, 1080), (777, 1001)]:
            check(lib.loom_vision_reset(session) == 0)
            check(lib.loom_vision_reset(reference) == 0)
            check(lib.loom_vision_infer(reference, image))
            reference_held = True
            output = lib.loom_vision_infer_packed(session, packed, lib.oracle_width(image), lib.oracle_height(image), width, height)
            check(output)
            held = True
            stats = Stats()
            assert lib.oracle_verify_expanded(reference, output, c.byref(stats)) == 0, "GPU unpack/expansion differs from CPU reference"
            assert lib.loom_vision_coverage(session) == stats.foreground / (width * height)
            print("LOOM_VISION_PACKED_PASS", json.dumps({"size": [width, height], "max_error": stats.max_error}), flush=True)
            check(lib.loom_vision_release(session) == 0)
            held = False
            check(lib.loom_vision_release(reference) == 0)
            reference_held = False
    finally:
        if reference_held:
            check(lib.loom_vision_release(reference) == 0)
        check(lib.loom_vision_destroy(reference) == 0)
        lib.oracle_release_input(packed)
        lib.oracle_release_input(image)
finally:
    if held:
        check(lib.loom_vision_release(session) == 0)
    check(lib.loom_vision_destroy(session) == 0)
with open(sys.argv[2], "rb") as source:
    image_hash = hashlib.file_digest(source, "sha256").hexdigest()
print("LOOM_NATIVE_VISION_PASS", json.dumps({"pid": os.getpid(), "provider": "Apple Vision balanced revision 1",
      "input_sha256": image_hash, "frames": results}), flush=True)
