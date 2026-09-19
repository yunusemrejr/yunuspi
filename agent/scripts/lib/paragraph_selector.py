"""Bounded untrusted Kompress paragraph scores. No generated text enters callers.
The worker exposes only source hashes and zero-based selected paragraph IDs.
"""
from pathlib import Path
import re,hashlib,time
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer
ort.disable_telemetry_events()
MODEL_SHA256='6cc66306aa1dfc1b2a543ae6a0e5b9a08fe418cb51002939975fbc5b6acf524a'
TOKENIZER_SHA256='6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30'

def verified_file(path,expected,max_size):
 path=Path(path)
 if not path.is_file() or path.stat().st_size>max_size:raise ValueError('Invalid model asset')
 digest=hashlib.sha256()
 with path.open('rb') as stream:
  for block in iter(lambda:stream.read(1024*1024),b''):digest.update(block)
 if digest.hexdigest()!=expected:raise ValueError('Model asset checksum mismatch')
 return path

def release_workspace():
 # This dedicated Linux worker can return freed ONNX workspace to the OS.
 try:
  import ctypes
  libc=ctypes.CDLL(None);trim=libc.malloc_trim;trim.argtypes=[ctypes.c_size_t];trim.restype=ctypes.c_int;trim(0)
 except (AttributeError,OSError):pass
THRESHOLD=.35  # calibrated on development prose; original protected tests unchanged
PROTECTED=re.compile(r'\b(?:not|no|never|none|neither|nor|without|except|unless|only|if|until|before|after|must|shall|require\w*|need\w*|should|cannot|can\x27t|don\x27t|fail\w*|error\w*|warning|blocked|pending|unresolved|unverified|unknown|uncertain\w*|may|might|could|reported|observed|said|says|claimed|according|alleged|denied|confirmed|verified|unconfirmed|current|latest|remaining|deprecated|superseded|decid\w*|decision\w*|constraint\w*|verif\w*|test\w*|pass\w*|success\w*|succeed\w*|complet\w*|cancel\w*|abort\w*|status|exit|reject\w*|hypothes\w*|changed|modified|deleted|created|next step|next action)\b|\d|https?://|[/\\]|\b\w+\.\w+\b',re.I)
DEPENDENT=re.compile(r'^(?:This|That|These|Those|It|They|He|She|However|Therefore|Otherwise|Instead|Consequently)\b',re.I)
class ParagraphSelector:
 def __init__(self,model_path,tokenizer_path):
  model_path=verified_file(model_path,MODEL_SHA256,70_000_000)
  tokenizer_path=verified_file(tokenizer_path,TOKENIZER_SHA256,4_000_000)
  opt=ort.SessionOptions();opt.enable_cpu_mem_arena=False;opt.enable_mem_pattern=False;opt.intra_op_num_threads=1;opt.inter_op_num_threads=1;opt.execution_mode=ort.ExecutionMode.ORT_SEQUENTIAL
  opt.add_session_config_entry('session.intra_op.allow_spinning','0');opt.add_session_config_entry('session.inter_op.allow_spinning','0')
  self.session=ort.InferenceSession(str(model_path),opt,providers=['CPUExecutionProvider']);self.tok=Tokenizer.from_file(str(tokenizer_path));self.tok.no_truncation();self.tok.no_padding()
 def select(self,raw):
  if not isinstance(raw,str) or not raw.isascii():return {'applied':False,'reason':'unsupported_input'}
  digest=hashlib.sha256(raw.encode()).hexdigest()
  def fallback(reason):return {'applied':False,'reason':reason,'text':raw,'sha256':digest,'spans':[[0,len(raw)]],'latency_ms':0,'scores':[]}
  if len(raw.encode())>4096 or len(raw)<800:return fallback('size')
  if '\x00' in raw or re.search(r'```|^\s*(?:[{}\[\]]|diff --git|@@|#!|at\s+\w+\s*\()',raw,re.M):return fallback('structured')
  # Paragraphs are explicit blank-line units, never heuristic sentence cuts.
  spans=[];start=0
  for match in re.finditer(r'\n[ \t]*\n+',raw):
   if raw[start:match.start()].strip():spans.append((start,match.start()))
   start=match.end()
  if raw[start:].strip():spans.append((start,len(raw)))
  if not 4<=len(spans)<=24:return fallback('paragraph_count')
  paragraphs=[raw[a:b] for a,b in spans]
  # Soft wrapping stays inside the exact blank-line paragraph span.
  if any(not re.search(r'[.!?][\"\x27)]?\s*$',p) for p in paragraphs):return fallback('paragraph_shape')
  enc=self.tok.encode(raw)
  if len(enc.ids)>512:return fallback('token_limit')
  protected={i for i,p in enumerate(paragraphs) if PROTECTED.search(p) or len(p.split())<=6}
  for i,p in enumerate(paragraphs):
   if DEPENDENT.search(p.lstrip()):protected.update(range(max(0,i-1),i+1))
  inputs={'input_ids':np.array([enc.ids],dtype=np.int64),'attention_mask':np.array([enc.attention_mask],dtype=np.int64)}
  start=time.perf_counter()
  try:logits=self.session.run(None,inputs)[0][0]
  except Exception:return fallback('inference_failure')
  elapsed=(time.perf_counter()-start)*1000
  if elapsed>400:return fallback('latency')
  if logits.shape!=(len(enc.ids),2) or not np.all(np.isfinite(logits)):return fallback('malformed_scores')
  prob=1/(1+np.exp(np.clip(logits[:,0]-logits[:,1],-50,50)))
  scores=[]
  for a,b in spans:
   indices=[i for i,(lo,hi) in enumerate(enc.offsets) if hi>lo and lo>=a and hi<=b]
   if not indices:return fallback('unmapped_paragraph')
   scores.append(float(np.mean(prob[indices])))
  kept=[i for i,v in enumerate(scores) if i in protected or v>THRESHOLD]
  if not kept:return fallback('empty')
  result='\n\n'.join(paragraphs[i] for i in kept)
  if len(raw)-len(result)<200 or len(result)>len(raw)*.8:return fallback('insufficient_saving')
  selected=[spans[i] for i in kept]
  # Defense independent of model: exact spans ordered, every protected unit kept.
  if any(i not in kept for i in protected) or result!='\n\n'.join(raw[a:b] for a,b in selected):return fallback('validation')
  return {'applied':True,'reason':'whole_paragraph_selection','text':result,'sha256':digest,'spans':selected,'latency_ms':elapsed,'scores':scores,'kept_ids':kept,'protected_ids':sorted(protected),'tokens':len(enc.ids),'omitted_paragraphs':len(paragraphs)-len(kept)}
