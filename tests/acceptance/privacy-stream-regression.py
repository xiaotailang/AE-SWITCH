"""Verify binary stream boundaries and overlapping secret categories in memory."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path

spec=importlib.util.spec_from_file_location('private_auditor',Path(__file__).with_name('audit-private-artifacts.py'))
auditor=importlib.util.module_from_spec(spec)
spec.loader.exec_module(auditor)
checks=[]
for encoding in ['utf-8','utf-16-le','utf-16-be']:
    pattern='synthetic-private-value-only'.encode(encoding)
    body=b'\0'*(4*1024*1024-len(pattern)//2)+pattern+b'\0'*127
    length,digest,categories=auditor.audit_stream(io.BytesIO(body),None,{pattern:'known_key'},len(pattern)-1)
    assert length==len(body) and digest==hashlib.sha256(body).hexdigest()
    assert categories==['known_key']
    checks.append({'name':'cross_chunk_binary_secret_'+encoding,'passed':True})
patterns={b'overlapping-synthetic-secret':'known_key',b'synthetic-secret':'private_endpoint'}
body=b'overlapping-synthetic-secret'
_,_,categories=auditor.audit_stream(io.BytesIO(body),None,patterns,max(map(len,patterns))-1)
assert categories==['known_key','private_endpoint']
checks.append({'name':'overlapping_categories_are_both_reported','passed':True})
body=b'\0'*(4*1024*1024+1)
length,digest,categories=auditor.audit_stream(io.BytesIO(body),None,patterns,max(map(len,patterns))-1)
assert categories==[] and length==len(body) and digest==hashlib.sha256(body).hexdigest()
checks.append({'name':'clean_zero_filled_binary_is_not_a_secret_match','passed':True})
print(json.dumps({'passed':True,'checks':checks,'realCredentialsUsed':False,'diskFixtureDataCreated':False}))
