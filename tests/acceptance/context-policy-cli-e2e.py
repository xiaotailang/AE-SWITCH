"""Current compiled CLI, eight owned profiles, no inference or external clients."""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
from threading import Thread
import time
import tomllib

sys.dont_write_bytecode = True
w = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--binary', type=Path, required=True)
parser.add_argument('--report', type=Path, required=True)
args = parser.parse_args()
spec = importlib.util.spec_from_file_location('ae_cli_context_fixture', Path(__file__).with_name('core-features-cli-e2e.py'))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
require = fixtures.require
try:
    report_file = fixtures.receipt_path(args.report)
except fixtures.CheckFailure as error:
    print(json.dumps({'passed': False, 'failure': str(error)}))
    raise SystemExit(1) from None
harness = None
server = None
server_thread = None
setup_cleanup = None
requests = []
models = [{'id': fixtures.MODEL, 'enabled': True, 'context_window': 1050000,
           'supported_reasoning_levels': ['xhigh'], 'context_policy': {
               'standard_context_window': 272000, 'long_context_window': 1050000,
               'input_multiplier': 2, 'output_multiplier': 1.5}}]
result = {'scope': 'Current compiled core context settings with eight synthetic native profiles; no real upstream or official client execution',
          'passed': False, 'checks': [], 'model': 'gpt-6.1-sol', 'reasoningEffort': 'xhigh',
          'inferenceRequests': 0, 'officialClientsExecuted': False, 'allMutableDataOnG': True,
          'recordedAt': datetime.now(timezone.utc).isoformat()}
started = time.monotonic()


def configure(agent, provider):
    return harness.command('configure-profile', payload={
        'agentId': agent, 'providerId': provider, 'model': fixtures.MODEL,
        'profile': harness.profiles[agent],
    })


def verify_snapshot(value, long=False):
    expected = {'model': fixtures.MODEL, 'longContextEnabled': long, 'contextWindow': 1050000 if long else 272000,
                'autoCompactTokenLimit': 840000 if long else 217600, 'compactPercent': 80}
    if long:
        expected['capabilityScope'] = provider_input['codexOptions']['models'][0]['contextCapabilities']['credentialScope']
    require(value == expected, 'native_applied_context_snapshot_mismatch')


class ModelServer(ThreadingHTTPServer):
    daemon_threads = False


class ModelEndpoint(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        requests.append(self.path)
        body = json.dumps({'object': 'list', 'data': models}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


try:
    harness = fixtures.Harness(fixtures.g_path(args.binary), w)
    result.update(ownerId=harness.owner_id, binarySha256=harness.binary_sha256)
    for agent in fixtures.AGENTS:
        harness.fixture(agent)
    server = ModelServer(('127.0.0.1', 0), ModelEndpoint)
    server_thread = Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    endpoint = f'http://127.0.0.1:{server.server_port}/v1'
    credentials = harness.portable / 'synthetic-model-query.txt'
    credentials.write_text('端点：' + endpoint + '\napi-key: ' + 'ae-context-synthetic-' + harness.owner_id, encoding='utf-8')
    provider = harness.command('discover', str(credentials))
    require(requests == ['/v1/models'], 'models_not_queried_from_actual_endpoint')
    provider_input = {field: provider[field] for field in (
        'id', 'family', 'name', 'baseUrl', 'model', 'authMode', 'codexOptions')}
    provider_input['reasoningEffort'] = 'xhigh'
    provider = harness.command('save-provider', payload=provider_input)
    provider_id = provider['id']
    for agent in fixtures.AGENTS:
        configured = configure(agent, provider_id)
        verify_snapshot(configured.get('contextPolicy'))
        require(configured.get('reasoningEffort') == 'xhigh', 'context_policy_changed_explicit_reasoning')
    result['checks'].append('eight_clients_default_to_short_context_and_eighty_percent')
    codex = tomllib.loads(harness.main_paths['codex'].read_text(encoding='utf-8'))
    require(codex['model_context_window'] == 272000 and codex['model_auto_compact_token_limit'] == 217600,
            'codex_native_window_or_compaction_not_written')
    for agent, key in [('hermes', 'context_length'), ('oh_my_pi', 'contextWindow')]:
        text = harness.main_paths[agent].read_text(encoding='utf-8')
        require(key in text and '272000' in text, 'native_context_limit_not_written')
    opencode = json.loads(harness.main_paths['opencode'].read_text(encoding='utf-8'))
    require(opencode['provider']['ae_switch']['models'][fixtures.MODEL]['limit']['context'] == 272000,
            'opencode_model_context_not_written')
    require(opencode['compaction']['reserved'] == 54400, 'opencode_reserved_context_not_written')
    workbuddy = json.loads(harness.main_paths['workbuddy'].read_text(encoding='utf-8'))
    workbuddy = workbuddy.get('models') if isinstance(workbuddy, dict) else workbuddy
    require(next(row for row in workbuddy if row['id'] == fixtures.MODEL)['maxInputTokens'] == 272000,
            'workbuddy_native_input_limit_not_written')
    zcode = json.loads(harness.main_paths['zcode'].read_text(encoding='utf-8'))
    rules = zcode['config']['modelConfigRules']['providerModelRules']
    require(any(row['providerId'] == 'ae_switch' and row['modelId'] == fixtures.MODEL and row['config']['properties']['contextWindow'] == 272000 for row in rules),
            'zcode_exact_model_window_not_written')
    dsh = harness.main_paths['deepseek_harness'].read_text(encoding='utf-8')
    require('contextWindow' in dsh and '272000' in dsh and 'thresholdRatio' in dsh and '0.8' in dsh,
            'deepseek_native_context_or_compaction_not_written')
    result['checks'].append('all_eight_native_context_configurations_read_back')
    saved = harness.saved_profile('Synthetic short context combination')
    for entry in saved['entries']:
        verify_snapshot(entry.get('contextPolicy'))
    result['checks'].append('named_combination_captures_nonsecret_context_policy')
    provider_input['id'] = provider_id
    provider_input['apiKey'] = None
    provider_input['codexOptions']['contextPolicy'] = {'model': fixtures.MODEL, 'longContextEnabled': True, 'compactPercent': 80}
    harness.command('save-provider', payload=provider_input)
    overview = harness.command('overview')
    for entry in overview['hub']['agents']:
        verify_snapshot(entry.get('contextPolicy'))
    result['checks'].append('editing_shared_provider_does_not_enable_existing_clients')
    verify_snapshot(configure('codex', provider_id).get('contextPolicy'), True)
    codex = tomllib.loads(harness.main_paths['codex'].read_text(encoding='utf-8'))
    require(codex['model_context_window'] == 1050000 and codex['model_auto_compact_token_limit'] == 840000,
            'codex_explicit_long_context_not_applied')
    result['checks'].append('explicit_enable_writes_long_window_and_eighty_percent')
    harness.apply_profile(saved)
    for entry in harness.command('overview')['hub']['agents']:
        verify_snapshot(entry.get('contextPolicy'))
    result['checks'].append('named_profile_apply_restores_short_context_in_one_transaction')
    for agent in fixtures.AGENTS:
        preview = harness.command('preview-disconnect', agent)
        harness.command('disconnect-agent', payload={'agentId': agent, 'previewToken': preview['previewToken']})
    for path, before in harness.originals.items():
        require((path.read_bytes() if path.exists() else None) == before, 'disconnect_did_not_restore_original_bytes')
    for path, before in harness.histories.items():
        require(path.read_bytes() == before, 'history_bytes_changed')
    result['checks'].append('eight_disconnects_restore_original_configuration_and_history_bytes')
    for field, replacement in [('baseUrl', endpoint + '/different'), ('apiKey', 'rotated-synthetic-key'), ('authMode', 'x-api-key')]:
        changed = {**provider_input, field: replacement}
        harness.command('save-provider', payload=changed, expected_error='invalid_context_policy')
    result['checks'].append('stale_endpoint_key_and_auth_declarations_cannot_be_reused')
    models[0].pop('context_policy')
    unknown = harness.command('discover', str(credentials))
    unknown_input = {field: unknown[field] for field in ('id', 'family', 'name', 'baseUrl', 'model', 'authMode', 'codexOptions')}
    unknown_input.update(reasoningEffort='xhigh')
    unknown_input['codexOptions']['contextPolicy'] = {'model': fixtures.MODEL, 'longContextEnabled': True, 'compactPercent': 80}
    harness.command('save-provider', payload=unknown_input, expected_error='invalid_context_policy')
    result['checks'].append('official_model_name_and_large_maximum_do_not_authorize_custom_endpoint_pricing')
    models[0]['context_policy'] = {'standard_context_window': 64000, 'long_context_window': 400000, 'surcharge': False}
    flat = harness.command('discover', str(credentials))
    configured = configure('codex', flat['id'])
    require(configured['contextPolicy'] == {'model': fixtures.MODEL, 'longContextEnabled': False,
        'compactPercent': 80, 'contextWindow': 400000, 'autoCompactTokenLimit': 320000}, 'flat_rate_capacity_or_default_mismatch')
    preview = harness.command('preview-disconnect', 'codex')
    harness.command('disconnect-agent', payload={'agentId':'codex','previewToken':preview['previewToken']})
    for path, before in harness.originals.items():
        require((path.read_bytes() if path.exists() else None) == before, 'flat_rate_disconnect_did_not_restore_original_bytes')
    result['checks'].append('confirmed_flat_rate_endpoint_uses_its_real_window_without_paid_opt_in')
    result['passed'] = True
except fixtures.FixtureSetupFailure as error:
    harness, setup_cleanup = error.harness, error.harness.cleanup
    result['failure'] = str(error)
except fixtures.CheckFailure as error:
    result['failure'] = str(error)
except Exception as error:
    result['failureType'] = type(error).__name__
    trace = error.__traceback__
    result['failureLines'] = []
    while trace:
        if Path(trace.tb_frame.f_code.co_filename) == Path(__file__):
            result['failureLines'].append(trace.tb_lineno)
        trace = trace.tb_next
finally:
    try:
        if server:
            if server_thread and server_thread.ident is not None:
                server.shutdown()
                server_thread.join()
            server.server_close()
    except Exception:
        result['passed'] = False
        result['failure'] = result.get('failure') or 'fixture_model_server_stop_failed'
        setup_cleanup = {'passed': False, 'removed': False, 'created': harness is not None,
                         'failure': 'fixture_model_server_stop_failed'}
    result['elapsedSeconds'] = round(time.monotonic() - started, 3)
    if harness:
        result.update(ownerId=harness.owner_id, binarySha256=harness.binary_sha256,
                      cliCommands=harness.command_count)
    cleanup = setup_cleanup if setup_cleanup is not None else fixtures.finish_owned_fixture(harness)
    result['cleanup'] = cleanup
    result['ownedRootRetainedForGuardedCleanup'] = cleanup['created'] and not cleanup['removed']
    if not cleanup['passed']:
        result['passed'] = False
        result['failure'] = result.get('failure') or 'owned_cleanup_not_proved'
    try:
        fixtures.write_receipt(report_file, result)
    except Exception:
        result['passed'] = False
        result['receiptFailure'] = 'acceptance_receipt_not_written'
    print(json.dumps(result), flush=True)
raise SystemExit(0 if result['passed'] else 1)
