"""Explicitly launched native Depth Pro 2 worker; loads only a locally compiled, verified model."""
import ctypes
import os
import sys

if len(sys.argv) != 6:
    raise SystemExit("Usage: depth-service.py library.dylib service-name token compiled.mlmodelc function")
print(f"PYTHON_DEPTH_SERVICE pid={os.getpid()} python={sys.version.split()[0]}", flush=True)
library = ctypes.CDLL(sys.argv[1])
library.loom_depth_serve.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p]
library.loom_depth_serve.restype = ctypes.c_int
raise SystemExit(library.loom_depth_serve(*(argument.encode() for argument in sys.argv[2:])))
