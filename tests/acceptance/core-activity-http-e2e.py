"""Compiled core gateway activity over real loopback HTTP, with synthetic upstream."""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.dont_write_bytecode = True

from owned_python_fixture import cleanup_owned_fixture, create_owned_fixture, fresh_receipt_path, write_receipt


PURPOSE = "compiled-core-activity-http-fixture"
SYNTHETIC_MODEL = "gpt-6.1-sol"


class SyntheticServer(http.server.ThreadingHTTPServer):
    daemon_threads = False

    def __init__(self, owner_id, long_idle_seconds):
        self.stop_event = threading.Event()
        self.long_idle_seconds = long_idle_seconds
        self.secret = "synthetic-core-http-credential-" + owner_id
        self.seen = []
        super().__init__(("127.0.0.1", 0), Upstream)


class Upstream(http.server.BaseHTTPRequestHandler):
    timeout = 10

    def do_POST(self):
        model = SYNTHETIC_MODEL
        secret = self.server.secret
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.seen.append({'model':body.get('model'),'effort':body.get('reasoning',{}).get('effort'),'authenticated':self.headers.get('Authorization')=='Bearer '+secret})
        mode=body.get('input')
        if mode=='complete':
            response={'id':'synthetic-response','object':'response','status':'completed','model':model+'-dated','reasoning':{'effort':'high'},'output':[{'type':'message','role':'assistant','content':[{'type':'output_text','text':'合成回复'}]}],'usage':{'input_tokens':7,'output_tokens':4,'input_tokens_details':{'cached_tokens':3}}}
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
        elif isinstance(mode, str) and mode.startswith('long-work-'):
            events=[{'type':'response.output_text.delta','delta':'part'}]*24
            events.append({'type':'response.completed','response':{'status':'completed','model':model,'usage':{'input_tokens':200,'output_tokens':10,'input_tokens_details':{'cached_tokens':150}}}})
            frames=[('data: '+json.dumps(event)+'\n\n').encode() for event in events]
            self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(sum(map(len,frames))));self.end_headers()
            for frame in frames:
                self.wfile.write(frame)
                self.wfile.flush()
                if self.server.stop_event.wait(.1):
                    return
            return
        elif mode=='long-idle':
            first=b'data: {"type":"response.output_text.delta","delta":"first"}\n\n'
            final=b'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'
            self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(first)+len(final)));self.end_headers()
            self.wfile.write(first)
            self.wfile.flush()
            if self.server.stop_event.wait(self.server.long_idle_seconds):
                return
            self.wfile.write(final);self.wfile.flush()
            return
        else:
            wire=b'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":7,"output_tokens":4}}}\n\n'
            content='text/event-stream'
        self.send_response(200);self.send_header('Content-Type',content);self.send_header('Content-Length',str(len(wire)));self.end_headers()
        for index in range(0,len(wire),11):
            self.wfile.write(wire[index:index+11]);self.wfile.flush()
    def log_message(self,*_):
        pass

def fixture_environment(root):
    environment = dict(os.environ)
    paths = {
        "AE_SWITCH_PORTABLE_ROOT": "portable",
        "HOME": "home",
        "USERPROFILE": "home",
        "APPDATA": "appdata",
        "LOCALAPPDATA": "localappdata",
        "TEMP": "tmp",
        "TMP": "tmp",
        "TMPDIR": "tmp",
        "XDG_CONFIG_HOME": "config",
        "XDG_DATA_HOME": "data",
        "XDG_STATE_HOME": "state",
        "XDG_CACHE_HOME": "cache",
    }
    for name, relative in paths.items():
        value = root / relative
        value.mkdir(exist_ok=True)
        environment[name] = str(value)
    environment["NO_PROXY"] = "127.0.0.1,localhost,::1"
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]:
        environment.pop(name, None)
    return environment


def stop_gateway(process):
    if process is None or process.poll() is not None:
        return
    try:
        process.terminate()
    except OSError:
        if process.poll() is not None:
            return
        raise
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def main():
    workspace = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--long-idle-seconds", type=int, choices=[0, 95], default=0)
    parser.add_argument("--report", type=Path, help="Fresh receipt file under artifacts/acceptance")
    options = parser.parse_args()
    binary = options.binary.resolve(strict=True)
    if binary.drive.lower() != "g:" or not binary.is_relative_to(workspace) or not binary.is_file():
        parser.error("binary must be a file inside the G: workspace")
    if options.report is not None:
        try:
            options.report = fresh_receipt_path(options.report)
        except (ValueError, OSError):
            parser.error("report must be a fresh JSON file under artifacts/acceptance")

    binary_sha256 = hashlib.sha256(binary.read_bytes()).hexdigest()
    root, identifier = create_owned_fixture(workspace, PURPOSE)
    report_path = options.report or workspace / "artifacts/acceptance" / f"compiled-core-activity-{identifier}.json"
    report = {
        "ownerId": identifier,
        "binarySha256": binary_sha256,
        "scope": "compiled native core and actual loopback HTTP; synthetic upstream, no official client or model inference",
        "passed": False,
        "checks": [],
        "realUpstreamInferenceExecuted": False,
        "ownedRootRetained": True,
        "ownedRootRemoved": False,
    }
    upstream = None
    thread = None
    process = None

    try:
        environment = fixture_environment(root)
        portable = root / "portable"
        core = portable / "AE-Switch-core.exe"
        shutil.copy2(binary, core)
        upstream = SyntheticServer(identifier, options.long_idle_seconds)
        thread = threading.Thread(target=upstream.serve_forever)
        thread.start()
        model = SYNTHETIC_MODEL
        secret = upstream.secret
        seen = upstream.seen
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        def call(command, payload=None):
            result = subprocess.run(
                [str(core), command],
                input=None if payload is None else json.dumps(payload),
                text=True, encoding="utf-8", capture_output=True, env=environment,
                cwd=portable, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW,
            )
            if result.returncode:
                raise RuntimeError("native-cli-command-failed")
            return json.loads(result.stdout)

        def request(route, path, body=None, headers=None, method=None, timeout=8):
            data = None if body is None else json.dumps(body).encode()
            headers = {"Authorization": "Bearer " + route["token"], **(headers or {})}
            if body is not None:
                headers["Content-Type"] = "application/json"
            req = urllib.request.Request(
                f"http://127.0.0.1:{route['port']}" + path,
                data=data, headers=headers, method=method,
            )
            with opener.open(req, timeout=timeout) as response:
                return response.status, response.read()

        provider=call('save-provider',{'family':'codex','name':'Synthetic HTTP fixture','baseUrl':f'http://127.0.0.1:{upstream.server_port}','apiKey':secret,'model':model,'authMode':'bearer','reasoningEffort':'ultra','codexOptions':{'upstreamProtocol':'openai','models':[{'id':model,'enabled':True,'reasoningEfforts':['ultra']}]}})
        native=portable/'native-fixture';native.mkdir()
        executable=native/'client.exe';executable.write_text('never executed',encoding='utf-8')
        profile={'directory':str(native),'homeDirectory':str(native),'workspaceDirectory':str(native),'executablePath':str(executable)}
        call('configure-profile',{'agentId':'codex','providerId':provider['id'],'model':model,'profile':profile})
        route=json.loads((portable/'data/protocol-bridge.json').read_text(encoding='utf-8'))
        process = subprocess.Popen(
            [str(core), "serve"], env=environment, cwd=portable,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
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
            if mode=='complete':
                row=snapshot['records'][0]
                assert row['configuredModel']==model and row['configuredEffort']=='ultra'
                assert row['reportedModel']==model+'-dated' and row['reportedEffort']=='high'
                assert row['usage']['cachedTokens']==3
            assert secret.encode() not in result.stdout and b'127.0.0.1' not in result.stdout and '合成回复'.encode() not in result.stdout
        assert len(seen)==5 and all(item['authenticated'] and item['model']==model and item['effort']=='ultra' for item in seen)
        report['checks'].extend(['five actual HTTP calls preserve model and selected effort','completed failed incomplete interrupted states reflect response protocol','reported token usage observed without recording credentials or content','activity CLI works while the gateway Store remains locked'])
        with ThreadPoolExecutor(max_workers=3) as pool:
            futures=[pool.submit(request,route,'/agents/selected:codex/v1/responses',{'model':model,'input':f'long-work-{index}','reasoning':{'effort':'low'},'stream':True}) for index in range(3)]
            time.sleep(.9)
            _,active=request(route,'/activity/codex')
            assert sum(item['state']=='in_progress' for item in json.loads(active)['records'])==3
            assert all(b'response.completed' in future.result()[1] for future in futures)
        assert len(seen)==8 and all(item['authenticated'] and item['model']==model and item['effort']=='ultra' for item in seen)
        _,finished=request(route,'/activity/codex')
        assert all(row['state']=='completed' and row['usage']['cachedTokens']==150 and row['reportedModel']==model for row in json.loads(finished)['records'][:3])
        report['checks'].append('three concurrent progressive streams retain exact selected model and effort and report cache usage')
        if options.long_idle_seconds:
            started=time.monotonic()
            _,wire=request(route,'/agents/selected:codex/v1/responses',{'model':model,'input':'long-idle','stream':True},timeout=options.long_idle_seconds+15)
            assert b'response.completed' in wire and time.monotonic()-started>=options.long_idle_seconds
            report['checks'].append('real compiled gateway finishes streaming after a 95-second upstream idle gap')
        try: request(route,'/activity/codex',headers={'Origin':'http://browser.invalid'})
        except urllib.error.HTTPError as error: assert error.code==401
        else: raise AssertionError('browser-origin-not-rejected')
        _,body=request(route,'/activity/codex',method='DELETE')
        assert json.loads(body)['records']==[]
        report['checks'].append('browser origins rejected and authenticated clear removes only metadata')
        report['passed']=True
    except Exception:
        report["failure"] = "compiled-core-http-check-failed"
    finally:
        teardown_failures = []
        try:
            stop_gateway(process)
        except (OSError, subprocess.SubprocessError):
            teardown_failures.append("gateway-exit-failed")
        report["ownedProcessesExited"] = process is None or process.poll() is not None
        if upstream is not None:
            upstream.stop_event.set()
            try:
                if thread is not None and thread.is_alive():
                    upstream.shutdown()
                    thread.join(5)
                upstream.server_close()
            except OSError:
                teardown_failures.append("synthetic-server-close-failed")
        report["syntheticServerExited"] = (thread is None or not thread.is_alive()) and not any(
            failure == "synthetic-server-close-failed" for failure in teardown_failures
        )

        if report["ownedProcessesExited"] and report["syntheticServerExited"]:
            try:
                cleanup_owned_fixture(root, identifier, PURPOSE)
                report["ownedRootRemoved"] = not root.exists()
                report["ownedRootRetained"] = not report["ownedRootRemoved"]
            except (OSError, RuntimeError, ValueError) as failure:
                teardown_failures.append(type(failure).__name__)
        if not report["ownedRootRemoved"]:
            teardown_failures.append("owned-fixture-retained")
        if teardown_failures:
            report["passed"] = False
            report["cleanupFailures"] = teardown_failures
        write_receipt(report_path, report)
        print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
