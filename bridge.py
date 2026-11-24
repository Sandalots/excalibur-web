"""Glue between the browser page and the unchanged EXCALIBUR-Medic runtime.

Runs inside Pyodide. excalibur_inference.py does all the retrieval and the five safety
checks exactly as on the Raspberry Pi; this file only turns its result into a plan that
the page can carry out with the model running in the browser.
"""
import json
import time
from pathlib import Path

import excalibur_inference as ei

# the runtime's defaults, as used on the Pi
MIN_SCORE, MIN_COVERAGE, MIN_TOPIC, MAX_CTX_CHARS = 2.0, 0.5, 0.4, 2600

IX = ei.BM25Index.load(Path(__file__).with_name("index.pkl"))


def _preview_request(question: str, text: str, is_table: bool):
    """The grammar-constrained request verbatim_preview() sends to llama-server."""
    topic = ei.condition_of(question)
    
    if topic:
        topic = " ".join(w if w.isupper() else w.capitalize() for w in topic.split())
        
    expected = ei._TABLE_KIND if is_table else ei.PREVIEW_KINDS.get(ei.facet_of(question) or "")
    
    if not expected:
        return None
    
    prompt = (f"{ei.PREVIEW_SYS}\n\nThe reader asked: \"{question}\"\n"
              f"They are about to be shown the {expected}"
              f"{', about ' + topic if topic else ''}. It opens:\n"
              f"{text[:400]}\n\nIntroduction:")
    
    return {"prompt": prompt, "grammar": ei._gbnf(topic, is_table, expected)}


def plan(question: str) -> str:
    t0 = time.time()
    
    msgs, grounded, options, verbatim = ei.build_messages(question, IX, MIN_SCORE, MAX_CTX_CHARS, False, MIN_COVERAGE, MIN_TOPIC)
    out = {"ms": round((time.time() - t0) * 1000, 1)}

    if verbatim:
        is_table = bool(ei.VERBATIM_SOURCE.search(verbatim))
        title, _, body = verbatim.partition("\n\n")
        
        out.update(kind="verbatim", is_table=is_table, title=title.strip(),
                   body=body or verbatim, passage=verbatim,
                   preview=_preview_request(question, verbatim, is_table),
                   fallback=ei.verbatim_preview(question, verbatim, is_table, None) or "")
        
        return json.dumps(out)

    spelling = [o.split(":", 1)[1].strip() for o in options if o.startswith("did you mean:")]

    if options and not spelling:
        out.update(kind="clarify", options=options, condition=ei.condition_of(question) or "that")
        
    elif not grounded:
        out.update(kind="refuse", spelling=spelling)
        
    else:
        user = msgs[-1]["content"]
        passage = user.split("Reference material:\n", 1)[-1].split("\n\nQuestion:", 1)[0].strip()
        out.update(kind="generate", messages=msgs, title=passage.splitlines()[0], passage=passage)
        
    return json.dumps(out)
