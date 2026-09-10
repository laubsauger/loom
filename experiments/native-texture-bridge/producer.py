"""Separate Python process; native helper owns Metal textures and XPC capability IPC."""
import ctypes
import os
import sys

if len(sys.argv) != 4:
    raise SystemExit("Usage: producer.py library.dylib service-name token")

print(f"PYTHON_PRODUCER pid={os.getpid()} python={sys.version.split()[0]}", flush=True)
library = ctypes.CDLL(sys.argv[1])
library.proof_serve.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
library.proof_serve.restype = None
library.proof_serve(sys.argv[2].encode(), sys.argv[3].encode())
raise RuntimeError("Producer service unexpectedly returned")
