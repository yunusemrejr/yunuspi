#!/usr/bin/env python3
"""Authenticated loopback-only Kompress selector. Never returns generated claims."""
import argparse,json,hmac,re,signal,threading,stat,time
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from lib.paragraph_selector import ParagraphSelector,release_workspace
UNKNOWN={'version':1,'status':'UNKNOWN'}

def strict_object(pairs):
 result={}
 for key,value in pairs:
  if key in result:raise ValueError('Duplicate key')
  result[key]=value
 return result

class Server(ThreadingHTTPServer):
 daemon_threads=True
 request_queue_size=4
 allow_reuse_address=False
 def __init__(self,address,selector,key):
  self.selector=selector;self.key=key;self.last_inference=-float("inf");self.inference=threading.BoundedSemaphore(1);self.requests=threading.BoundedSemaphore(8)
  super().__init__(address,Handler)
 def process_request(self,request,client_address):
  request.settimeout(1.0)
  if not self.requests.acquire(blocking=False):
   try:request.sendall(b'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
   except OSError:pass
   self.shutdown_request(request);return
  try:super().process_request(request,client_address)
  except Exception:self.requests.release();raise
 def process_request_thread(self,request,client_address):
  try:super().process_request_thread(request,client_address)
  finally:self.requests.release()
 def handle_error(self,request,client_address):pass

class Handler(BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*args):pass
 def send_json(self,status,body,inference=None):
  data=json.dumps(body,separators=(',',':')).encode('ascii')
  try:
   self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.send_header('Connection','close')
   # Tells clients whether a refusal spent inference, so a gate refusal needs no cooldown.
   if inference is not None:self.send_header('X-Kompress-Inference','1' if inference else '0')
   self.end_headers();self.wfile.write(data)
  except OSError:pass
  self.close_connection=True
 def authorized(self):
  values=self.headers.get_all('Authorization',[])
  return len(values)==1 and values[0].isascii() and hmac.compare_digest(values[0],'Bearer '+self.server.key)
 def do_GET(self):
  if not self.authorized():return self.send_json(401,UNKNOWN)
  if self.path!='/health':return self.send_json(404,UNKNOWN)
  return self.send_json(200,{'version':1,'ready':True})
 def do_POST(self):
  if not self.authorized():return self.send_json(401,UNKNOWN)
  if self.path!='/select':return self.send_json(404,UNKNOWN)
  lengths=self.headers.get_all('Content-Length',[])
  if self.headers.get('Transfer-Encoding') or len(lengths)!=1 or not re.fullmatch(r'[0-9]{1,5}',lengths[0]):return self.send_json(400,UNKNOWN)
  size=int(lengths[0])
  if not 1<=size<=8192:return self.send_json(413,UNKNOWN)
  if not self.server.inference.acquire(blocking=False):return self.send_json(503,UNKNOWN,False)
  # Release the slot before answering, so a client's immediate next request
  # after a refusal is not turned away as busy.
  try:status,body,inference=self.selection(size)
  finally:release_workspace();self.server.inference.release()
  return self.send_json(status,body,inference)
 def selection(self,size):
  try:
   raw=self.rfile.read(size)
   if len(raw)!=size:return 400,UNKNOWN,False
   body=json.loads(raw.decode('utf8'),object_pairs_hook=strict_object)
   if not isinstance(body,dict) or set(body)!={'version','raw'} or type(body['version']) is not int or body['version']!=1 or not isinstance(body['raw'],str):return 400,UNKNOWN,False
   # The ten-second slot bounds actual inference; shape, size and token-window
   # refusals are answered without spending it.
   def admit():
    now=time.monotonic()
    if now-self.server.last_inference<10:return False
    self.server.last_inference=now;return True
   result=self.server.selector.select(body['raw'],admit)
   if result.get('applied'):return 200,{'version':1,'status':'SELECT','sourceHash':result['sha256'],'keep':result['kept_ids']},True
   if result.get('reason')=='rate_limited':return 429,UNKNOWN,False
   return 200,UNKNOWN,result.get('inference',True)
  except (ValueError,UnicodeError,TimeoutError,OSError):return 400,UNKNOWN,None
  except Exception:return 200,UNKNOWN,None

def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--model',type=Path,required=True,help='Pinned 69.5 MB Gather/MatMul INT8 ONNX')
 parser.add_argument('--tokenizer',type=Path,required=True,help='Pinned local tokenizer.json')
 parser.add_argument('--key-file',type=Path,required=True,help='Owner-only file containing a 32-256 character bearer key')
 parser.add_argument('--port',type=int,default=18736,choices=[0,18736],help='127.0.0.1 port; 0 selects a temporary port for offline tests')
 args=parser.parse_args()
 mode=args.key_file.stat().st_mode
 if not stat.S_ISREG(mode) or mode&0o077:parser.error('Key file must be owner-only and regular')
 if args.key_file.stat().st_size>257:parser.error('Invalid key file size')
 key=args.key_file.read_text().strip()
 if not re.fullmatch(r'[A-Za-z0-9_-]{32,256}',key):parser.error('Invalid key file')
 selector=ParagraphSelector(args.model,args.tokenizer)
 # Warm the shared engine once, before admitting clients. No request-rate slot
 # is spent and no per-session warmup competes with useful inference.
 background='General background prose describes an ordinary workspace with assorted familiar concepts and broad introductory discussion for readers exploring the surrounding subject in a leisurely manner.'
 selector.select('\n\n'.join([background]*5));release_workspace()
 server=Server(('127.0.0.1',args.port),selector,key);server.timeout=.2
 stopping=threading.Event()
 def stop(*_):stopping.set()
 signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
 # Startup contains no request data or authentication material.
 print(json.dumps({'version':1,'ready':True,'port':server.server_port}),flush=True)
 try:
  while not stopping.is_set():server.handle_request()
 finally:
  server.server_close()
  # Active bounded inference completes before normal termination.
  if server.inference.acquire(timeout=2):server.inference.release()
if __name__=='__main__':main()
