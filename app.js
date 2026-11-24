// EXCALIBUR-Medic in the browser: the Pi runtime under Pyodide, the model under wllama.
import { loadPyodide } from './vendor/pyodide/pyodide.mjs';
import { Wllama } from './vendor/wllama/index.js';

// pinned so the code, the prebuilt index and the model always match
const RUNTIME_COMMIT = 'b2d03386612fe194a941bb450161fce872216975';
const RUNTIME = `https://raw.githubusercontent.com/Sandalots/excalibur-medic/${RUNTIME_COMMIT}`;

// the deployed GGUF, split by llama-gguf-split into parts under
// 512 MB, which Safari needs; wllama finds the other parts from the first one's name
const MODEL_URL = new URL('./model/excalibur-medic-1b-Q4_K_M-00001-of-00003.gguf', import.meta.url).href;

// the runtime's generation settings on the Pi
const GENERATION = { max_tokens: 500, temperature: 0, top_p: 0.9, repeat_penalty: 1.1 };

const REFUSAL = 'I do not have a reference for that in my medical corpus, so I cannot answer ' +
  'it reliably. If this is a clinical question, please consult a clinician or a current ' +
  'medical reference.';

// one or two of each path: grounded answers, a brand name, label quotes, a clarifying
// question, and a refusal
const EXAMPLES = [
  'What are the symptoms of hypothyroidism?', 'What causes gout?',
  'Is cystic fibrosis inherited?', 'What is Lipitor?', 'What is the dose of metformin?',
  'Who should not take warfarin?', 'What causes kidney stones?', 'How do I fix a bicycle puncture?',
];

// each checked against the runtime to take the path its heading describes
const MORE = [
  ['What a condition is', [
    'What is sarcoidosis?', "What is Alzheimer's disease?", 'What is fibromyalgia?', 'What is PTSD?',
  ]],
  ['Symptoms', [
    "What are the symptoms of Parkinson's disease?", 'What are the symptoms of asthma?',
    'What are the symptoms of shingles?', "What are the symptoms of Crohn's disease?",
  ]],
  ['Causes', [
    'What causes osteoporosis?', 'What causes anemia?', 'What causes glaucoma?',
    'What causes psoriasis?',
  ]],
  ['Treatment', [
    'What are the treatments for depression?', 'What are the treatments for COPD?',
    'What are the treatments for rheumatoid arthritis?',
  ]],
  ['Diagnosis and risk', [
    'How to diagnose multiple sclerosis?', 'How to diagnose celiac disease?',
    'Who is at risk for type 2 diabetes?', 'Who is at risk for breast cancer?',
    'Who is at risk for heart failure?',
  ]],
  ['Inheritance and outlook', [
    'Is sickle cell disease inherited?', 'Is Huntington disease inherited?',
    'Is Marfan syndrome inherited?', 'What is the outlook for narcolepsy?',
    'What is the outlook for multiple sclerosis?',
  ]],
  ['Medicines by brand or UK name', [
    'What is Tylenol?', 'What is paracetamol?', 'What is Advil?', 'What is Zocor?',
    'What is salbutamol?', 'What is metformin?',
  ]],
  ['Quoted word for word from the drug label', [
    'What are the side effects of atorvastatin?', 'What are the side effects of metformin?',
    'Is lisinopril safe in pregnancy?', 'What are the warnings for ibuprofen?',
    'What are the warnings for paracetamol?', 'What drugs interact with warfarin?',
    'What drugs interact with simvastatin?', 'Who should not take metformin?',
  ]],
  ['Quoted from a table of symptom frequencies', ['What are the symptoms of lupus?']],
  ['Tests and procedures', ['What is an MRI?', 'What is a colonoscopy?']],
  ['Things it should refuse', [
    'Should I stop taking my blood pressure tablets?', 'What should I do about my chest pain?',
    'What is the capital of France?', 'What is the weather like in Aberdeen?',
    'What is the best laptop for programming?', 'Can you write me a poem?',
  ]],
];

const $ = (id) => document.getElementById(id);
const asset = (path) => new URL(path, import.meta.url).href;

let plan = null;        // bridge.plan(), once Python is ready
let wllama = null;      // the model, once loaded
let busy = false;

// ---------- small DOM helpers (text only, so nothing from a document is run as HTML)
function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

// first line says what happened (with **bold** spans), the second gives the numbers
function setStatus(text, stats = '', stop = false) {
  const s = $('status');
  s.textContent = '';
  s.hidden = !text;
  s.className = stop ? 'stop' : '';
  text.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
    if (part.startsWith('**')) s.append(el('strong', part.slice(2, -2)));
    else s.append(part);
  });
  if (stats) s.append(el('span', stats, 'stats'));
}

// a labelled block: 'reasoning' is quieter, 'final' carries the answer
function block(kind, label, ...children) {
  const b = el('section', undefined, `block ${kind}`);
  b.append(el('p', label, 'eyebrow'), ...children);
  return b;
}

function seconds(ms) { return `${(ms / 1000).toFixed(1)} s`; }

function showSource(passage) {
  $('source-box').hidden = !passage;
  $('source').textContent = passage || '';
}

function section(raw, tag) {
  const m = raw.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)(?:</${tag}>|$)`));
  return m ? m[1].trim() : '';
}

function renderGenerated(raw) {
  const box = $('answer');
  box.textContent = '';
  const reasoning = section(raw, 'reasoning');
  const answer = section(raw, 'answer');
  box.append(block('reasoning', 'Reasoning', el('p', reasoning || '…')));
  if (answer || raw.includes('<answer>')) box.append(block('final', 'Answer', el('p', answer || '…')));
}

// Loading
async function fetchOk(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
  return r;
}

async function gunzip(response) {
  const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function startSearch() {
  const py = await loadPyodide({ indexURL: asset('./vendor/pyodide/') });

  const [code, drugs, topics, bridge, index] = await Promise.all([
    fetchOk(`${RUNTIME}/excalibur_inference.py`).then((r) => r.text()),
    fetchOk(`${RUNTIME}/artifacts/drug_aliases.json`).then((r) => r.text()),
    fetchOk(`${RUNTIME}/artifacts/topic_aliases.json`).then((r) => r.text()),
    fetchOk(asset('./bridge.py')).then((r) => r.text()),
    fetchOk(asset('./data/index.pkl.gz')).then(gunzip),
  ]);

  py.FS.mkdirTree('/app/artifacts');
  py.FS.writeFile('/app/excalibur_inference.py', code);
  py.FS.writeFile('/app/artifacts/drug_aliases.json', drugs);
  py.FS.writeFile('/app/artifacts/topic_aliases.json', topics);
  py.FS.writeFile('/app/bridge.py', bridge);
  py.FS.writeFile('/app/index.pkl', index);

  py.runPython("import sys; sys.path.insert(0, '/app')");
  const bridgeModule = py.pyimport('bridge');
  plan = (q) => JSON.parse(bridgeModule.plan(q));

  $('question').placeholder = 'Ask a medical question';
  $('ask').disabled = false;
}

async function loadModel() {
  if (wllama || busy) return;
  const button = $('load-model');
  button.disabled = true;
  const bar = $('progress');
  bar.hidden = false;
  bar.removeAttribute('value');
  $('model-state').textContent = 'Starting…';

  try {
    // wllama picks its compatibility build when the browser lacks JSPI or 64-bit memory. Its
    // memory check only builds a JS Memory object, which Safari allows even though its engine
    // cannot compile 64-bit-memory code, so the main build then fails inside the worker. Ask
    // the engine itself to validate a tiny 64-bit-memory module, and force compatibility mode
    // when it can't. (?compat forces it too, for testing in Chromium.)
    const memory64 = WebAssembly.validate(new Uint8Array(
      [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x04, 0x01]));
    if (!memory64 || new URLSearchParams(location.search).has('compat')) delete WebAssembly.Suspending;
    // ?debug prints wllama's and llama.cpp's own log lines to the console
    const debug = new URLSearchParams(location.search).has('debug');
    const w = new Wllama({ default: asset('./vendor/wllama/wllama.wasm') },
      { suppressNativeLog: !debug, parallelDownloads: 3 });
    if (debug) {
      console.log('[excalibur] browser:', navigator.userAgent);
      console.log('[excalibur] isolated:', self.crossOriginIsolated, 'WebGPU:', !!navigator.gpu,
        'memory64:', memory64, 'compatibility build:', !WebAssembly.Suspending,
        'threads:', navigator.hardwareConcurrency);
    }
    // Safari lacks JSPI and 64-bit memory, so it uses this build, served from here, not a CDN
    w.setCompat({
      worker: asset('./vendor/wllama-compat/wllama.js'),
      wasm: asset('./vendor/wllama-compat/wllama.wasm')
    });
    // ?cpu forces the CPU path, as on browsers without WebGPU. The compatibility build also
    // runs on the CPU: with Safari's WebGPU it aborts when reading results back from the GPU
    // (ggml_backend_webgpu_buffer_get_tensor), on the first answer
    const compatBuild = !WebAssembly.Suspending;
    const cpuOnly = compatBuild || new URLSearchParams(location.search).has('cpu');
    // a failure inside wllama's worker surfaces only as an unhandled rejection, which would
    // otherwise leave the page waiting forever; treat one during loading as a load failure
    let onFail, slowTimer;
    const failed = new Promise((_, reject) => {
      onFail = (e) => reject(e.reason || new Error('model worker failed'));
      window.addEventListener('unhandledrejection', onFail);
    });
    const loading = w.loadModelFromUrl(MODEL_URL, {
      n_ctx: 2048,
      n_parallel: 1,            // one question at a time, so one sequence's worth of memory
      ...(cpuOnly ? { n_gpu_layers: 0 } : {}),
      jinja: true,
      prefill_assistant: true,
      useCache: true,
      progressCallback: ({ loaded, total }) => {
        if (!total) return;
        bar.max = total;
        bar.value = loaded;
        if (loaded < total) {
          $('model-state').textContent =
            `Downloading ${Math.round(loaded / 1e6)} of ${Math.round(total / 1e6)} MB`;
        } else if (!slowTimer) {
          $('model-state').textContent = 'Loading into memory…';
          slowTimer = setTimeout(() => {
            $('model-state').textContent =
              'Still loading… this browser is slow at this step. Chrome or Edge is faster.';
          }, 90000);
        }
      },
    });
    try {
      await Promise.race([loading, failed]);
    } finally {
      window.removeEventListener('unhandledrejection', onFail);
      clearTimeout(slowTimer);
    }
    wllama = w;
    bar.hidden = true;
    $('model-state').textContent = w.isSupportWebGPU() && !cpuOnly
      ? 'Ready · GPU acceleration'
      : 'Ready · CPU acceleration. For GPU acceleration, use Chrome, Edge or another Chromium browser.';
  } catch (err) {
    console.error(err);
    bar.hidden = true;
    $('model-state').textContent = '';
    $('model-state').append(el('span', 'Could not load the model in this browser. ', 'muted'));
    const retry = el('button', 'Try again', 'secondary');
    retry.onclick = () => { $('model-state').textContent = ''; $('model-state').append(button); button.disabled = false; loadModel(); };
    $('model-state').append(retry);
  }
}

// Answering
async function preview(p) {
  // the one-line introduction, written by the model inside a grammar, exactly as on the Pi
  if (!wllama || !p.preview) return p.fallback;
  try {
    const r = await wllama.createCompletion({
      prompt: p.preview.prompt, grammar: p.preview.grammar, max_tokens: 160, temperature: 0,
    });
    const out = (r.choices?.[0]?.text || '').trim();
    return out.startsWith('This is the ') && out.endsWith('.') ? out : p.fallback;
  } catch (err) {
    console.error(err);
    return p.fallback;
  }
}

async function ask(question) {
  question = question.trim();
  if (!question || !plan || busy) return;
  busy = true;
  $('ask').disabled = true;
  $('result').hidden = false;
  $('asked').textContent = question;
  $('answer').textContent = '';
  showSource('');
  setStatus('Searching…');

  try {
    const p = plan(question);
    const box = $('answer');
    const search = `search ${p.ms} ms`;

    if (p.kind === 'verbatim') {
      const where = p.is_table ? 'the source' : 'the FDA drug label';
      setStatus(`**Quoted word for word from ${where}:** ${p.title}`, search);
      const started = performance.now();
      const intro = await preview(p);
      const caveat = p.is_table
        ? 'Frequencies are per sign, not for the condition as a whole. They come from studies ' +
        'of small numbers of patients and are rough estimates.'
        : 'This is general labelling, not advice for you. Doses depend on kidney and liver ' +
        'function, age, weight, pregnancy and other medicines. Check with a clinician or pharmacist.';
      const label = p.is_table ? 'Answer, quoted from the source' : 'Answer, quoted from the drug label';
      box.append(block('final', label, el('p', intro), el('div', p.body, 'quote'), el('p', caveat, 'note')));
      setStatus(`**Quoted word for word from ${where}:** ${p.title}`,
        wllama ? `${search} · introduction written by the model in ${seconds(performance.now() - started)}`
          : `${search} · model not used`);
      showSource(p.passage);

    } else if (p.kind === 'clarify') {
      setStatus('**Asked which one you mean** rather than guessing.', `${search} · model not used`);
      const intro = el('p', 'There is no general entry for ');
      intro.append(el('strong', p.condition), ', but these more specific ones are indexed:');
      const list = el('ul');
      p.options.forEach((o) => list.append(el('li', o)));
      box.append(block('final', 'Which one did you mean?', intro, list));

    } else if (p.kind === 'refuse') {
      setStatus('**Refused:** no suitable source was found, so the model was not used.', search, true);
      const answer = block('final', 'Answer', el('p', REFUSAL));
      if (p.spelling.length) {
        answer.append(el('p', `One word is close to one in the corpus. Did you mean: ${p.spelling.join(', ')}?`, 'note'));
      }
      box.append(answer);

    } else if (!wllama) {
      setStatus('');
      box.append(el('p', 'Load the model above to get an answer to this question.', 'muted'));

    } else {
      setStatus(`**Grounded in:** ${p.title}`, `${search} · writing…`);
      showSource(p.passage);
      const started = performance.now();
      let firstToken = null;
      // wllama echoes the prefilled "<reasoning>" back in the stream; add it only if absent
      let streamed = '';
      const full = () => (streamed.trimStart().startsWith('<reasoning>') ? streamed : '<reasoning>\n' + streamed);
      let timings = null;
      const stream = await wllama.createChatCompletion({
        messages: [...p.messages, { role: 'assistant', content: '<reasoning>\n' }],
        stream: true,
        ...GENERATION,
      });
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          if (firstToken === null) firstToken = performance.now() - started;
          streamed += delta;
          renderGenerated(full());
        }
        if (chunk.timings) timings = chunk.timings;
      }
      renderGenerated(full());
      const stats = [search];
      if (timings?.predicted_n) {
        stats.push(`${timings.predicted_n} tokens at ${timings.predicted_per_second.toFixed(1)} tokens/s`);
      }
      if (firstToken !== null) stats.push(`first token ${seconds(firstToken)}`);
      stats.push(`${seconds(performance.now() - started)} total`);
      setStatus(`**Grounded in:** ${p.title}`, stats.join(' · '));
    }
  } catch (err) {
    console.error(err);
    setStatus('**Something went wrong in this browser.** Try reloading the page.', '', true);
  } finally {
    busy = false;
    $('ask').disabled = false;
  }
}

// Wiring
function chip(q, scroll = false) {
  const b = el('button', q);
  b.type = 'button';
  b.onclick = () => {
    $('question').value = q;
    if (scroll) $('ask-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    ask(q);
  };
  return b;
}

EXAMPLES.forEach((q) => $('examples').append(chip(q)));
MORE.forEach(([heading, questions]) => {
  const row = el('div', undefined, 'chips');
  questions.forEach((q) => row.append(chip(q, true)));
  $('more').append(el('h3', heading), row);
});
$('ask-form').addEventListener('submit', (e) => { e.preventDefault(); ask($('question').value); });
$('load-model').addEventListener('click', loadModel);

startSearch().catch((err) => {
  console.error(err);
  $('question').placeholder = 'Could not start in this browser. Try a recent Chrome or Edge.';
});
