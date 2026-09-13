"""Explicitly launched native Vision worker; no packages or models downloaded."""
import ctypes
import os
import sys

if len(sys.argv) != 4:
    raise SystemExit("Usage: vision-service.py library.dylib service-name token")
print(f"PYTHON_VISION_SERVICE pid={os.getpid()} python={sys.version.split()[0]}", flush=True)
library = ctypes.CDLL(sys.argv[1])
library.loom_vision_serve.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
library.loom_vision_serve.restype = ctypes.c_int
raise SystemExit(library.loom_vision_serve(sys.argv[2].encode(), sys.argv[3].encode()))
