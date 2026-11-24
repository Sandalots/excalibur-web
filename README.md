# EXCALIBUR-Medic demo

A live demo of [EXCALIBUR-Medic](https://github.com/Sandalots/excalibur-medic), an offline
medical reference built for a 2 GB Raspberry Pi 5. A 1B model distilled from an 8B medical
teacher answers from 19,411 NIH, FDA and MedlinePlus documents, and refuses when it has no
suitable source.

Everything runs in the visitor's browser, with no server:

- **Search and safety checks:** the Pi's own `excalibur_inference.py`, loaded from the GitHub
  repository at a pinned commit and run unchanged in [Pyodide](https://pyodide.org).
  `bridge.py` only adapts its output for the page.

- **The model:** the deployed
  [GGUF](https://huggingface.co/Sandalots/Llama-3.2-EXCALIBUR-Medic-1B-GGUF), run by
  [wllama](https://github.com/ngxson/wllama) (`llama.cpp` compiled to WebAssembly) with the
  Pi's settings: temperature 0, the same prompts, and the same grammar for label introductions.

`data/index.pkl.gz` is the search index built by that runtime commit
(`get_index()` over the combined corpus), gzipped. `model/` holds the same GGUF split into
parts under 512 MB with `llama-gguf-split --split-max-size 400M`, which Safari needs.

The model is a derivative of Llama 3.2 and is distributed under the Llama 3.2 Community
License. Built with Llama. The demo code is MIT-licensed. Third-party files in `vendor/` are
listed in `vendor/NOTICE.txt`.
