"""Compiled-core regression of submission-review findings; synthetic G: state only."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import time

WORKSPACE = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("review_fixture", Path(__file__).with_name("core-features-cli-e2e.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary',required=True,type=Path)
    parser.add_argument('--report',required=True,type=Path)
    args=parser.parse_args()
    binary=fixture.g_path(args.binary)
    report_file=fixture.g_path(args.report)
    assert report_file.is_relative_to(WORKSPACE) and not report_file.exists()
    owners=[];checks=[];child=None
    report={'passed':False,'scope':'Current compiled core and synthetic native profiles; no real client, network or inference',
            'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'checks':checks,'inferenceExecuted':False,'realCredentialsUsed':False,'productOrLocalCodexConfigModified':False}
    def new():
        h=fixture.Harness(binary,WORKSPACE);owners.append(h.owner)
        p=h.command('save-provider',payload={'family':'codex','name':'Synthetic review fix fixture','baseUrl':'https://invalid.example/v1',
            'apiKey':'synthetic-review-fix-only-'+h.owner_id,'model':'gpt-6.1-sol','authMode':'bearer','reasoningEffort':'xhigh',
            'codexOptions':{'upstreamProtocol':'openai','models':[{'id':'gpt-6.1-sol','enabled':True,'reasoningEfforts':['xhigh']}]}})
        return h,p['id']
    try:
        for agent in ['claude_code','opencode','codex']:
            h,p=new();h.fixture(agent)
            payload={'agentId':agent,'providerId':p,'model':'gpt-6.1-sol','profile':h.profiles[agent]}
            h.command('configure-profile',payload=payload)
            target=h.main_paths[agent]
            if agent=='codex':target.write_text(target.read_text(encoding='utf-8')+'\n[review_empty_table]\n[review_nested]\nempty = {}\nrows = [{}, {}]\n',encoding='utf-8')
            else:
                value=json.loads(target.read_text(encoding='utf-8'));value['reviewEmptyObject']={};value['reviewNested']={'empty':{},'kept':'user'};value['reviewRows']=[{},{}]
                target.write_text(json.dumps(value),encoding='utf-8')
            status=h.command('configuration-safety',agent)
            assert status['status']=='healthy' and status['canDisconnect']
            h.command('disconnect-agent',payload={'agentId':agent,'previewToken':status['previewToken']})
            if agent=='codex':
                import tomllib
                value=tomllib.loads(target.read_text(encoding='utf-8'))
                assert value['review_empty_table']=={} and value['review_nested']['empty']=={} and value['review_nested']['rows']==[{},{}]
            else:
                value=json.loads(target.read_text(encoding='utf-8'))
                assert value['reviewEmptyObject']=={} and value['reviewNested']=={'empty':{},'kept':'user'} and value['reviewRows']==[{},{}]
            assert all(path.read_bytes()==content for path,content in h.histories.items())
            checks.append({'name':'unrelated_empty_user_configuration_preserved','agentId':agent,'passed':True})
        # An actual other process owns a conflicting native write handle. The
        # product must refuse the operation and preserve all original bytes.
        h,p=new();h.fixture('claude_code')
        payload={'agentId':'claude_code','providerId':p,'model':'gpt-6.1-sol','profile':h.profiles['claude_code']}
        h.command('configure-profile',payload=payload)
        target=h.main_paths['claude_code'];before=target.read_bytes();selection=(h.data/'agent-selection.json').read_bytes()
        script=h.owner/'hold-native.ps1';ready=h.owner/'ready';release=h.owner/'release'
        script.write_text("param([string]$Target,[string]$Ready,[string]$Release)\n$ErrorActionPreference='Stop'\n$f=[IO.File]::Open($Target,'Open','ReadWrite','None')\ntry{[IO.File]::WriteAllText($Ready,'ready');$timer=[Diagnostics.Stopwatch]::StartNew();while(-not(Test-Path -LiteralPath $Release)-and $timer.Elapsed.TotalSeconds -lt 30){Start-Sleep -Milliseconds 20}}finally{$f.Dispose()}\n",encoding='utf-8')
        child=subprocess.Popen([str(WORKSPACE/'.tools/pwsh/pwsh.exe'),'-NoProfile','-File',str(script),str(target),str(ready),str(release)],env=h.environment,cwd=h.owner,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW)
        deadline=time.monotonic()+20
        while not ready.exists() and child.poll() is None and time.monotonic()<deadline:time.sleep(.02)
        assert ready.exists(),'Synthetic external writer did not acquire target'
        rejected=subprocess.run([str(h.binary),'configure-profile'],input=json.dumps(payload),capture_output=True,text=True,encoding='utf-8',env=h.environment,cwd=h.portable,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW)
        assert rejected.returncode!=0
        release.write_text('release',encoding='utf-8');child.wait(timeout=15);child=None
        assert target.read_bytes()==before and (h.data/'agent-selection.json').read_bytes()==selection
        assert all(path.read_bytes()==content for path,content in h.histories.items())
        checks.append({'name':'conflicting_external_write_handle_refused_without_state_or_history_changes','passed':True})
        acl_script=h.owner/'synthetic-acl.ps1'
        acl_script.write_text("""param([string]$Root,[switch]$Inspect)
$ErrorActionPreference='Stop'
trap { @{fixtureFailure=$_.Exception.GetType().Name}|ConvertTo-Json -Compress;exit 31 }
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$valid=$true
$observations=@()
foreach($path in @($Root,(Join-Path $Root 'uni-switch.db'))){
 $acl=Get-Acl -LiteralPath $path
 if(-not $Inspect){
  # Change only the synthetic DACL. Reapplying an entire Get-Acl descriptor
  # can request owner/SACL privileges the fixture does not need or possess.
  & icacls.exe $path '/grant' '*S-1-1-0:(RX)' '/Q' *> $null
  if($LASTEXITCODE -ne 0){throw 'Synthetic explicit ACE injection failed'}
 }else{
  $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  $valid=$valid -and $acl.AreAccessRulesProtected -and $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $sid -and $rules[0].AccessControlType -eq 'Allow'
  $observations+=@{protected=$acl.AreAccessRulesProtected;ruleCount=$rules.Count;firstRuleIsCurrentProcessUser=($rules[0].IdentityReference.Value -eq $sid)}
 }
}
if($Inspect){@{onlyCurrentProcessUser=$valid;observations=$observations}|ConvertTo-Json -Depth 4 -Compress}
""",encoding='utf-8')
        def acl(inspect):
            args=[str(WORKSPACE/'.tools/pwsh/pwsh.exe'),'-NoProfile','-File',str(acl_script),str(h.data)]
            if inspect:args.append('-Inspect')
            r=subprocess.run(args,env=h.environment,cwd=h.owner,capture_output=True,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW)
            report['aclFixtureExitCode']=r.returncode
            if r.returncode:
                try:report['aclFixtureFailure']=json.loads(r.stdout.decode('utf-8-sig')).get('fixtureFailure')
                except (ValueError,UnicodeError):pass
            assert r.returncode==0,'Synthetic ACL fixture failed'
            return json.loads(r.stdout.decode('utf-8-sig')) if inspect else None
        report['aclStage']='inject-explicit-public-permission'
        acl(False)
        report['aclBeforeInspection']=acl(True)
        assert not report['aclBeforeInspection']['onlyCurrentProcessUser']
        assert all(item['ruleCount']>1 for item in report['aclBeforeInspection']['observations'])
        report['aclStage']='compiled-core-store-open'
        h.command('list-config-profiles')
        report['aclStage']='independent-acl-inspection'
        report['aclInspection']=acl(True)
        assert report['aclInspection']['onlyCurrentProcessUser']
        checks.append({'name':'compiled_store_replaces_preexisting_explicit_public_acl_on_directory_and_database','passed':True})
        report['passed']=True
    except Exception as error:
        report['failureType']=type(error).__name__
        report['failureStage']=len(checks)
    finally:
        if child is not None:
            release.write_text('release',encoding='utf-8')
            try:child.wait(timeout=15)
            except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=10)
        cleanup=True
        for root in owners:
            marker=json.loads((root/'owner.json').read_text(encoding='utf-8'))
            assert root.is_relative_to(WORKSPACE/'.cache/core-features-cli-e2e') and marker['ownerId']==root.name and marker['purpose']=='local-synthetic-cli-fixtures'
            paths=list(root.rglob('*'))
            for path in [root,*paths]:assert not getattr(path.lstat(),'st_file_attributes',0)&stat.FILE_ATTRIBUTE_REPARSE_POINT
            for path in sorted(paths,key=lambda p:len(p.parts),reverse=True):path.rmdir() if path.is_dir() else path.unlink()
            root.rmdir();cleanup &= not root.exists()
        report['ownedFixtureRootsRemoved']=cleanup;report['fixtureCount']=len(owners)
        report_file.parent.mkdir(parents=True,exist_ok=True)
        report_file.write_text(json.dumps(report,indent=2),encoding='utf-8')
        print(json.dumps(report))
    return 0 if report['passed'] and report['ownedFixtureRootsRemoved'] else 1

if __name__=='__main__':raise SystemExit(main())
