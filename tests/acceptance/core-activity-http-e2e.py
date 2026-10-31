"""Compiled core gateway activity over real loopback HTTP, with synthetic upstream."""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid

workspace = Path(__file__).resolve().parents[2]
options = argparse.ArgumentParser(description=__doc__)
options.add_argument('--binary', required=True, type=Path)
options = options.parse_args()
binary = options.binary.resolve()
assert binary.drive.lower() == 'g:' and binary.is_relative_to(workspace)
identifier = uuid.uuid4().hex
root = workspace/'.cache/core-activity-http-e2e'/identifier
root.mkdir(parents=True)
(root/'owner.json').write_text(json.dumps({'id':identifier,'purpose':'compiled-core-activity-http-fixture'}),encoding='utf-8')
portable = root/'portable'
portable.mkdir()
core = portable/'AE-Switch-core.exe'
shutil.copy2(binary,core)
environment = dict(os.environ)
for name,relative in {'AE_SWITCH_PORTABLE_ROOT':'portable','HOME':'home','USERPROFILE':'home','APPDATA':'appdata','LOCALAPPDATA':'localappdata','TEMP':'tmp','TMP':'tmp','TMPDIR':'tmp','XDG_CONFIG_HOME':'config','XDG_DATA_HOME':'data','XDG_STATE_HOME':'state','XDG_CACHE_HOME':'cache'}.items():
    value=root/relative; value.mkdir(exist_ok=True); environment[name]=str(value)
environment['NO_PROXY']='127.0.0.1,localhost,::1'
for name in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']:
    environment.pop(name,None)
model='gpt-6.1-sol'
secret='synthetic-core-http-credential-'+identifier
seen=[]

class Upstream(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        seen.append({'model':body.get('model'),'effort':body.get('reasoning',{}).get('effort'),'authenticated':self.headers.get('Authorization')=='Bearer '+secret})
        mode=body.get('input')
        if mode=='complete':
            response={'id':'synthetic-response','object':'response','status':'completed','model':model,'output':[{'type':'message','role':'assistant','content':[{'type':'output_text','text':'合成回复'}]}],'usage':{'input_tokens':7,'output_tokens':4,'input_tokens_details':{'cached_tokens':3}}}
            wire=json.dumps(response,ensure_ascii=False).encode()
            content='application/json'
        elif mode=='failed':
            wire=('data: '+json.dumps({'type':'error','error':{'message':secret}},ensure_ascii=False)+'\n\n').encode()
            content='text/event-stream'
        elif mode=='incomplete':
            wire=b'data: {"type":"response.incomplete","response":{"status":"incomplete","usage":{"input_tokens":7,"output_tokens":4}}}\n\n'
            content='text/event-stream'
        elif mode=='interrupted':
            wire=b'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'
            content='text/event-stream'
        else:
            wire=b'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":7,"output_tokens":4}}}\n\n'
            content='text/event-stream'
        self.send_response(200);self.send_header('Content-Type',content);self.send_header('Content-Length',str(len(wire)));self.end_headers()
        for index in range(0,len(wire),11):
            self.wfile.write(wire[index:index+11]);self.wfile.flush()
    def log_message(self,*_):
        pass

upstream=http.server.ThreadingHTTPServer(('127.0.0.1',0),Upstream)
thread=threading.Thread(target=upstream.serve_forever,daemon=True)
thread.start()
process=None
report={'ownerId':identifier,'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'scope':'compiled native core and actual loopback HTTP; synthetic upstream, no official client or model inference','passed':False,'checks':[],'realUpstreamInferenceExecuted':False,'ownedRootRetained':True}
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))

def call(command,payload=None):
    result=subprocess.run([str(core),command],input=None if payload is None else json.dumps(payload),text=True,encoding='utf-8',stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=environment,cwd=portable,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode: raise RuntimeError('native-cli-command-failed')
    return json.loads(result.stdout)
def request(route,path,body=None,headers=None,method=None):
    data=None if body is None else json.dumps(body).encode()
    headers={'Authorization':'Bearer '+route['token'],**(headers or {})}
    if body is not None: headers['Content-Type']='application/json'
    req=urllib.request.Request(f'http://127.0.0.1:{route["port"]}'+path,data=data,headers=headers,method=method)
    with opener.open(req,timeout=8) as response: return response.status,response.read()
try:
    provider=call('save-provider',{'family':'codex','name':'Synthetic HTTP fixture','baseUrl':f'http://127.0.0.1:{upstream.server_port}','apiKey':secret,'model':model,'authMode':'bearer','reasoningEffort':'ultra','codexOptions':{'upstreamProtocol':'openai','models':[{'id':model,'enabled':True,'reasoningEfforts':['ultra']}]}})
    native=portable/'native-fixture';native.mkdir()
    executable=native/'client.exe';executable.write_text('never executed',encoding='utf-8')
    profile={'directory':str(native),'homeDirectory':str(native),'workspaceDirectory':str(native),'executablePath':str(executable)}
    call('configure-profile',{'agentId':'codex','providerId':provider['id'],'model':model,'profile':profile})
    route=json.loads((portable/'data/protocol-bridge.json').read_text(encoding='utf-8'))
    process=subprocess.Popen([str(core),'serve'],env=environment,cwd=portable,stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
    ready=False
    for _ in range(50):
        if process.poll() is not None: break
        try:
            if request(route,'/health')[0]==204: ready=True;break
        except Exception: pass
        time.sleep(.1)
    assert ready,'compiled-gateway-startup-failed'
    report['checks'].append('current compiled gateway starts isolated and authenticates')
    for mode,state in [('complete','completed'),('stream','completed'),('failed','failed'),('incomplete','incomplete'),('interrupted','interrupted')]:
        status,body=request(route,'/agents/selected:codex/v1/responses',{'model':model,'input':mode,'stream':mode!='complete'})
        assert status==200
        # Activity command requires an agent argument and reads without acquiring the serving Store lock.
        result=subprocess.run([str(core),'activity','codex'],env=environment,cwd=portable,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=8,creationflags=subprocess.CREATE_NO_WINDOW)
        assert result.returncode==0
        snapshot=json.loads(result.stdout)
        assert snapshot['records'][0]['state']==state
        if mode in ['complete','stream','incomplete']:
            assert snapshot['records'][0]['usage']['inputTokens']==7 and snapshot['records'][0]['usage']['outputTokens']==4
        assert secret.encode() not in result.stdout and b'127.0.0.1' not in result.stdout and '合成回复'.encode() not in result.stdout
    assert len(seen)==5 and all(item['authenticated'] and item['model']==model and item['effort']=='ultra' for item in seen)
    report['checks'].extend(['five actual HTTP calls preserve model and selected effort','completed failed incomplete interrupted states reflect response protocol','reported token usage observed without recording credentials or content','activity CLI works while the gateway Store remains locked'])
    try: request(route,'/activity/codex',headers={'Origin':'http://browser.invalid'})
    except urllib.error.HTTPError as error: assert error.code==401
    else: raise AssertionError('browser-origin-not-rejected')
    _,body=request(route,'/activity/codex',method='DELETE')
    assert json.loads(body)['records']==[]
    report['checks'].append('browser origins rejected and authenticated clear removes only metadata')
    report['passed']=True
except Exception:
    report['failure']='compiled-core-http-check-failed'
finally:
    if process:
        process.terminate()
        try: process.communicate(timeout=10)
        except subprocess.TimeoutExpired: process.kill();process.communicate(timeout=5)
    upstream.shutdown();upstream.server_close();thread.join(5)
    report['ownedProcessesExited']=process is None or process.poll() is not None
    (root/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report,indent=2))
raise SystemExit(0 if report['passed'] else 1)
