/** python extractor over the committed ops-repo fixture — pure, no DB. */
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  endpointQName, eventChannelQName, normalizeHttpMethod, serviceIdentity, serviceSourceQName,
} from '../graph/contracts.js';
import { pythonExtractor } from '../graph/extractors/python.js';
import type { ExtractorOutput } from '../graph/types.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ops-repo');
const IDENTITY = serviceIdentity(FIXTURE);

let out: ExtractorOutput;

beforeAll(async () => {
  out = await pythonExtractor.extract({ projectId: 'unused', repoPaths: [FIXTURE] });
});

const node = (kind: string, qn: string) => out.nodes.find((n) => n.kind === kind && n.qualifiedName === qn);
const edge = (rel: string, fromQn: string, toQn: string) =>
  out.edges.find((e) => e.relation === rel && e.from.qualifiedName === fromQn && e.to.qualifiedName === toQn);

const JOB = serviceSourceQName(IDENTITY.id, 'ops-repo/tools/job.py');
const DB = serviceSourceQName(IDENTITY.id, 'ops-repo/lib/db.py');
const CONTRACT_FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cross-service', 'python-api');

async function extractSource(source: string): Promise<ExtractorOutput> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-python-contract-'));
  fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname = "python-api"\n');
  fs.writeFileSync(path.join(root, 'app.py'), source);
  try {
    return await pythonExtractor.extract({ projectId: 'unused', repoPaths: [root] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('python extractor', () => {
  it('partitions same-path nested Python services independent of root order', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-python-owned-'));
    const child = path.join(parent, 'child');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-python-outside-'));
    try {
      fs.mkdirSync(child, { recursive: true });
      fs.writeFileSync(path.join(parent, 'pyproject.toml'), '[project]\nname = "parent-service"\n');
      fs.writeFileSync(path.join(child, 'pyproject.toml'), '[project]\nname = "child-service"\n');
      fs.writeFileSync(path.join(parent, 'app.py'), 'def parent_only():\n    pass\n');
      fs.writeFileSync(path.join(child, 'app.py'), 'def child_only():\n    pass\n');
      fs.writeFileSync(path.join(parent, 'imports_child.py'), 'import child.mod\nimport linked\nimport outside\n');
      fs.writeFileSync(path.join(child, 'mod.py'), 'def child_module():\n    pass\n');
      fs.writeFileSync(path.join(outside, 'outside.py'), 'def outside_module():\n    pass\n');
      fs.symlinkSync(path.join(child, 'mod.py'), path.join(parent, 'linked.py'));
      fs.symlinkSync(path.join(outside, 'outside.py'), path.join(parent, 'outside.py'));
      const forward = await pythonExtractor.extract({ projectId: 'x', repoPaths: [parent, child] });
      const reverse = await pythonExtractor.extract({ projectId: 'x', repoPaths: [child, parent] });
      const signature = (value: ExtractorOutput): string[] => value.nodes.map((entry) => entry.qualifiedName).sort();
      expect(signature(forward)).toEqual(signature(reverse));
      expect(forward.nodes.filter((entry) => entry.kind === 'file' && entry.filePath === fs.realpathSync.native(path.join(child, 'app.py')))).toHaveLength(1);
      const parentFile = serviceSourceQName(serviceIdentity(parent).id, `${path.basename(parent)}/app.py`);
      const childFile = serviceSourceQName(serviceIdentity(child).id, 'child/app.py');
      const parentImportFile = serviceSourceQName(serviceIdentity(parent).id, `${path.basename(parent)}/imports_child.py`);
      const childModule = serviceSourceQName(serviceIdentity(child).id, 'child/mod.py');
      const fabricatedParentModule = serviceSourceQName(serviceIdentity(parent).id, `${path.basename(parent)}/child/mod.py`);
      expect(forward.nodes.some((entry) => entry.qualifiedName === `${parentFile}#parent_only`)).toBe(true);
      expect(forward.nodes.some((entry) => entry.qualifiedName === `${childFile}#child_only`)).toBe(true);
      expect(forward.nodes.some((entry) => entry.qualifiedName === `${parentFile}#child_only`)).toBe(false);
      expect(forward.edges.some((entry) => entry.relation === 'imports' && entry.from.qualifiedName === parentImportFile && entry.to.qualifiedName === childModule)).toBe(true);
      expect(reverse.edges.some((entry) => entry.relation === 'imports' && entry.from.qualifiedName === parentImportFile && entry.to.qualifiedName === childModule)).toBe(true);
      expect(forward.edges.some((entry) => entry.to.qualifiedName === fabricatedParentModule)).toBe(false);
      expect(reverse.edges.some((entry) => entry.to.qualifiedName === fabricatedParentModule)).toBe(false);
      expect(JSON.stringify(forward.edges)).not.toContain(`${path.basename(parent)}/linked.py`);
      expect(JSON.stringify(forward.edges)).not.toContain('outside.py');
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
  it('emits file nodes; __main__ files get the entrypoint flag', () => {
    expect(node('file', JOB)?.metadata).toMatchObject({ entrypoint: true });
    expect(node('file', DB)?.metadata).toEqual({});
  });

  it('resolves dotted imports to file→file edges', () => {
    expect(edge('imports', JOB, DB)).toBeDefined();
  });

  it('emits function/class nodes with defines edges', () => {
    expect(node('function', `${JOB}#run`)).toBeDefined();
    expect(node('class', `${JOB}#Runner`)).toBeDefined();
    expect(node('function', `${DB}#save_workout`)).toBeDefined();
    expect(edge('defines', DB, `${DB}#save_workout`)).toBeDefined();
  });

  it('emits shallow same-file calls edges (inferred)', () => {
    const call = edge('calls', JOB, `${JOB}#run`);
    expect(call).toBeDefined();
    expect(call?.confidence).toBe('inferred');
  });

  it('extracts literal FastAPI, APIRouter, and Flask endpoints with function ownership', async () => {
    const result = await pythonExtractor.extract({ projectId: 'unused', repoPaths: [CONTRACT_FIXTURE] });
    const identity = serviceIdentity(CONTRACT_FIXTURE);
    const file = serviceSourceQName(identity.id, 'python-api/app.py');
    const expected = [
      ['GET', '/users/{}', 'get_user'],
      ['POST', '/v1/users', 'create_user'],
      ['GET', '/files/{**}/done', 'files'],
      ['HEAD', '/files/{**}/done', 'files'],
      ['GET', '/health', 'health'],
    ];
    for (const [method, route, owner] of expected) {
      const normalizedMethod = normalizeHttpMethod(method);
      expect(normalizedMethod).not.toBeNull();
      if (normalizedMethod === null) continue;
      const qn = endpointQName(identity.id, normalizedMethod, route);
      const endpoint = result.nodes.find((entry) => entry.kind === 'endpoint' && entry.qualifiedName === qn);
      expect(endpoint?.filePath).toBeUndefined();
      expect(endpoint?.metadata).toEqual({
        contract: 'http-endpoint-v1', service_id: identity.id,
        service_aliases: identity.aliases, method, path: route,
      });
      expect(result.edges).toContainEqual({
        from: { kind: 'function', qualifiedName: `${file}#${owner}` },
        to: { kind: 'endpoint', qualifiedName: qn }, relation: 'serves_route',
      });
    }
    expect(result.nodes.filter((entry) => entry.kind === 'endpoint')).toHaveLength(expected.length);
  });

  it('extracts requests/httpx/aiohttp observations without retaining private inputs', async () => {
    const result = await pythonExtractor.extract({ projectId: 'unused', repoPaths: [CONTRACT_FIXTURE] });
    const calls = result.nodes.filter((entry) => entry.kind === 'http_call');
    expect(calls).toHaveLength(4);
    expect(calls.map((entry) => entry.metadata)).toEqual(expect.arrayContaining([
      expect.objectContaining({ target_host: 'php-api', method: 'GET', path: '/wp-json/acme/v1/tip' }),
      expect.objectContaining({ target_host: 'php-api', method: 'PATCH', path: '/wp-json/acme/v1/tip' }),
      expect.objectContaining({ target_host: 'php-api', method: 'GET', path: '/item/42' }),
      expect.objectContaining({ target_host: 'php-api', method: 'DELETE', path: '/item/42' }),
    ]));
    for (const call of calls) {
      expect(Object.keys(call.metadata ?? {}).sort()).toEqual(['contract', 'method', 'path', 'source_service', 'target_host']);
    }
    expect(JSON.stringify(calls)).not.toContain('token=discarded');
    expect(JSON.stringify(calls)).not.toContain('#discarded');
    expect(JSON.stringify(calls)).not.toContain('secret');
  });

  it('extracts literal Celery and Kafka emit/listen channels', async () => {
    const result = await pythonExtractor.extract({ projectId: 'unused', repoPaths: [CONTRACT_FIXTURE] });
    const identity = serviceIdentity(CONTRACT_FIXTURE);
    const file = serviceSourceQName(identity.id, 'python-api/app.py');
    const kafkaCreated = eventChannelQName('kafka', 'orders.created');
    const kafkaPaid = eventChannelQName('kafka', 'orders.paid');
    const celeryTask = eventChannelQName('celery', 'orders.reconcile');
    expect(kafkaCreated).not.toBeNull();
    expect(kafkaPaid).not.toBeNull();
    expect(celeryTask).not.toBeNull();
    expect(result.edges).toContainEqual({ from: { kind: 'file', qualifiedName: file }, to: { kind: 'event_channel', qualifiedName: kafkaCreated }, relation: 'listens_on' });
    expect(result.edges).toContainEqual({ from: { kind: 'function', qualifiedName: `${file}#files` }, to: { kind: 'event_channel', qualifiedName: kafkaCreated }, relation: 'emits' });
    expect(result.edges).toContainEqual({ from: { kind: 'function', qualifiedName: `${file}#files` }, to: { kind: 'event_channel', qualifiedName: kafkaPaid }, relation: 'listens_on' });
    expect(result.edges).toContainEqual({ from: { kind: 'function', qualifiedName: `${file}#reconcile` }, to: { kind: 'event_channel', qualifiedName: celeryTask }, relation: 'listens_on' });
    expect(result.edges).toContainEqual({ from: { kind: 'function', qualifiedName: `${file}#reconcile` }, to: { kind: 'event_channel', qualifiedName: celeryTask }, relation: 'emits' });
  });

  it('applies the first-rejection tally exactly once per supported dynamic observation', async () => {
    const result = await extractSource(`
import requests
from fastapi import FastAPI, APIRouter
from flask import Flask
from kafka import KafkaProducer, KafkaConsumer
from celery import Celery
url = "https://api/users"
method = "POST"
route = "/users"
topic = "orders.created"
prefix = "/v1"
app = FastAPI()
router = APIRouter(prefix=prefix)
flask_app = Flask(__name__)
producer = KafkaProducer()
consumer = KafkaConsumer()
celery = Celery("worker")
requests.get(url)
requests.request(method, "https://api/users")
@app.get(route)
def a(): pass
@router.post("/users")
def b(): pass
@flask_app.route("/health", methods=method)
def c(): pass
producer.send(topic)
consumer.subscribe(["orders.created", topic])
celery.send_task(topic)
`);
    expect(result.contractSkips).toEqual({
      dynamic_http_url: 1,
      dynamic_http_method: 2,
      dynamic_http_route: 2,
      dynamic_event_channel: 3,
    });
    expect(result.nodes.filter((entry) => entry.kind === 'endpoint' || entry.kind === 'http_call' || entry.kind === 'event_channel')).toHaveLength(0);
  });

  it('classifies each dynamic rejection independently', async () => {
    const cases = [
      {
        source: 'import requests\nurl = "https://api/users"\nrequests.get(url)\n',
        skips: { dynamic_http_url: 1, dynamic_http_method: 0, dynamic_http_route: 0, dynamic_event_channel: 0 },
      },
      {
        source: 'import requests\nmethod = "POST"\nrequests.request(method, "https://api/users")\n',
        skips: { dynamic_http_url: 0, dynamic_http_method: 1, dynamic_http_route: 0, dynamic_event_channel: 0 },
      },
      {
        source: 'from fastapi import FastAPI\nroute = "/users"\napp = FastAPI()\n@app.get(route)\ndef f(): pass\n',
        skips: { dynamic_http_url: 0, dynamic_http_method: 0, dynamic_http_route: 1, dynamic_event_channel: 0 },
      },
      {
        source: 'from kafka import KafkaProducer\ntopic = "orders.created"\nproducer = KafkaProducer()\nproducer.send(topic)\n',
        skips: { dynamic_http_url: 0, dynamic_http_method: 0, dynamic_http_route: 0, dynamic_event_channel: 1 },
      },
    ];
    for (const entry of cases) {
      const result = await extractSource(entry.source);
      expect(result.contractSkips).toEqual(entry.skips);
    }
  });

  it('dedupes a canonical endpoint node while retaining distinct provider owners', async () => {
    const result = await extractSource(`
from fastapi import FastAPI
app = FastAPI()
@app.get("/health")
def health_one(): pass
@app.get("/health/")
def health_two(): pass
`);
    const endpoints = result.nodes.filter((entry) => entry.kind === 'endpoint');
    expect(endpoints).toHaveLength(1);
    expect(result.edges.filter((entry) => entry.relation === 'serves_route')).toHaveLength(2);
  });

  it('ignores unrelated, invalid literal, cross-file, and reassigned receivers without tallying', async () => {
    const result = await extractSource(`
import requests
from fastapi import FastAPI
from flask import Flask
from kafka import KafkaProducer
app = FastAPI()
flask_app = Flask(__name__)
producer = KafkaProducer()
requests.get("/relative")
requests.get("ftp://api/users")
requests.get("https://user:pass@api/users")
requests.request("TRACE", "https://api/users")
other.get("https://api/users")
app = object()
producer = object()
@app.get("/users")
def no_route(): pass
@flask_app.route("/x/<regex(foo):id>")
def unsupported(): pass
producer.send("orders.created")
`);
    expect(result.contractSkips).toEqual({
      dynamic_http_url: 0, dynamic_http_method: 0,
      dynamic_http_route: 0, dynamic_event_channel: 0,
    });
    expect(result.nodes.filter((entry) => entry.kind === 'endpoint' || entry.kind === 'http_call' || entry.kind === 'event_channel')).toHaveLength(0);
  });

  it('keeps provenance inside lexical scopes and respects parameter shadowing', async () => {
    const result = await extractSource(`
import requests
import httpx
import aiohttp
def parameter_shadow(requests):
    requests.get("https://wrong.invalid/parameter-shadow")
def defining_scope():
    import httpx as local_httpx
    local_client = local_httpx.Client()
    local_client.get("https://valid.test/local-client")
    def nested_scope():
        local_client.get("https://valid.test/nested-client")
def sibling_scope():
    local_client.get("https://wrong.invalid/cross-scope-client")
    local_httpx.get("https://wrong.invalid/cross-scope-import")
local_httpx.get("https://wrong.invalid/leaked-local-import")
`);
    const calls = result.nodes.filter((entry) => entry.kind === 'http_call');
    expect(calls.map((entry) => entry.metadata?.path).sort()).toEqual(['/local-client', '/nested-client']);
    expect(JSON.stringify(calls)).not.toContain('wrong.invalid');
  });

  it('invalidates name and callable-member writes without killing sibling members', async () => {
    const result = await extractSource(`
import requests
import httpx
from fastapi import FastAPI
from kafka import KafkaProducer
requests.get("https://valid.test/before-delete")
del requests
requests.get("https://wrong.invalid/after-delete")
httpx.get("https://valid.test/before-augmented")
httpx += replacement
httpx.get("https://wrong.invalid/after-augmented")
import requests as req
req.get("https://valid.test/before-member")
req.get = replacement
req.get("https://wrong.invalid/after-member")
req.post("https://valid.test/sibling-member")
app = FastAPI()
@app.get("/valid-before-member")
def valid_route(): pass
app.get = replacement
@app.get("/wrong-overwritten-route-member")
def wrong_route(): pass
producer = KafkaProducer()
producer.send("valid.before.member")
producer.send = replacement
producer.send("wrong.overwritten-producer-send")
`);
    const serialized = JSON.stringify(result.nodes);
    expect(serialized).toContain('/before-delete');
    expect(serialized).toContain('/before-augmented');
    expect(serialized).toContain('/before-member');
    expect(serialized).toContain('/sibling-member');
    expect(serialized).toContain('/valid-before-member');
    expect(serialized).toContain('valid.before.member');
    expect(serialized).not.toContain('wrong.invalid');
    expect(serialized).not.toContain('wrong-overwritten');
  });

  it('keeps a receiver live through its assignment RHS and invalidates it afterward', async () => {
    const result = await extractSource(`
import httpx
client = httpx.Client()
client = client.get("https://valid.test/rhs-before-invalidation")
client.get("https://wrong.invalid/after-invalidation")
`);
    const calls = result.nodes.filter((entry) => entry.kind === 'http_call');
    expect(calls).toHaveLength(1);
    expect(calls[0].metadata?.path).toBe('/rhs-before-invalidation');
  });

  it('requires exact supported module paths instead of root-package prefixes', async () => {
    const result = await extractSource(`
import requests as req
import requests.auth as auth
from httpx._models import get as model_get
from aiohttp.client import request as client_request
from fastapi.routing import APIRouter
from celery.app import Celery
from kafka.consumer import KafkaConsumer
req.get("https://valid.test/exact-module")
auth.get("https://wrong.invalid/submodule-module")
model_get("https://wrong.invalid/submodule-function")
client_request("GET", "https://wrong.invalid/submodule-aiohttp")
`);
    const calls = result.nodes.filter((entry) => entry.kind === 'http_call');
    expect(calls).toHaveLength(1);
    expect(calls[0].metadata?.path).toBe('/exact-module');
  });

  it('does not promote nested calls inside unrelated decorators to providers', async () => {
    const result = await extractSource(`
from fastapi import FastAPI
app = FastAPI()
@discard(app.get("/wrong-nested-decorator-call"))
def wrong(): pass
@app.get("/valid-direct-decorator")
def valid(): pass
`);
    const endpoints = result.nodes.filter((entry) => entry.kind === 'endpoint');
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].metadata?.path).toBe('/valid-direct-decorator');
  });

  it('decodes Python escapes and rejects decoded controls without fabricating identities', async () => {
    const result = await extractSource(String.raw`
import requests
from kafka import KafkaProducer
producer = KafkaProducer()
requests.get("https://api/users\n")
requests.get("https://api/\x75sers")
producer.send("orders\ncreated")
producer.send("orders\x2ecreated")
producer.send(r"orders\x2ecreated")
`);
    const calls = result.nodes.filter((entry) => entry.kind === 'http_call');
    expect(calls).toHaveLength(1);
    expect(calls[0].metadata?.path).toBe('/users');
    const channels = result.nodes.filter((entry) => entry.kind === 'event_channel').map((entry) => entry.name).sort();
    expect(channels).toEqual(['orders.created', 'orders\\x2ecreated']);
    expect(result.contractSkips).toEqual({
      dynamic_http_url: 0, dynamic_http_method: 0,
      dynamic_http_route: 0, dynamic_event_channel: 0,
    });
  });

  it('treats every Python 3 comprehension target as a lexical shadow', async () => {
    const result = await extractSource(`
import requests
requests.get("https://valid.test/enclosing-module")
[requests.get("https://wrong.invalid/list-shadow") for requests in clients]
{requests.get("https://wrong.invalid/set-shadow") for requests in clients}
{key: requests.get("https://wrong.invalid/dict-shadow") for key, requests in pairs}
(requests.get("https://wrong.invalid/generator-shadow") for requests in clients)
[requests.get("https://wrong.invalid/nested-clause") for requests in clients for item in requests]
`);
    const calls = result.nodes.filter((entry) => entry.kind === 'http_call');
    expect(calls).toHaveLength(1);
    expect(calls[0].metadata?.path).toBe('/enclosing-module');
  });

  it('quarantines capabilities whose members may be mutated by deferred code', async () => {
    const sibling = await extractSource(`
import requests
def mutator():
    requests.get = replacement
def observer():
    requests.get("https://valid.test/sibling-observer")
def enclosing():
    def nested_mutator():
        requests.post = replacement
    requests.post("https://valid.test/enclosing-observer")
`);
    expect(sibling.nodes.filter((entry) => entry.kind === 'http_call')).toHaveLength(0);

    const classBody = await extractSource(`
import requests
class Mutator:
    requests.get = replacement
requests.get("https://wrong.invalid/class-body-effect")
requests.post("https://valid.test/class-sibling-member")
`);
    const calls = classBody.nodes.filter((entry) => entry.kind === 'http_call');
    expect(calls).toHaveLength(1);
    expect(calls[0].metadata?.path).toBe('/class-sibling-member');
  });

  it('quarantines global and nonlocal capabilities mutated by deferred code', async () => {
    const result = await extractSource(`
import requests
import httpx
def global_scope():
    global requests
    requests.get("https://valid.test/global-before-write")
    requests = replacement
    requests.get("https://wrong.invalid/global-after-write")
def outer_scope():
    client = httpx.Client()
    def inner_scope():
        nonlocal client
        client.get("https://valid.test/nonlocal-before-write")
        client += replacement
        client.get("https://wrong.invalid/nonlocal-after-write")
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')).toHaveLength(0);
  });

  it('limits aiohttp module provenance to request while allowing ClientSession verbs', async () => {
    const result = await extractSource(`
import aiohttp
from requests import get as aio_get
from aiohttp import request as aio_request
from aiohttp import get as aio_get
session = aiohttp.ClientSession()
aiohttp.request("GET", "https://valid.test/module-request")
aio_request("POST", "https://valid.test/imported-request")
session.get("https://valid.test/session-get")
aiohttp.get("https://wrong.invalid/module-get")
aio_get("https://wrong.invalid/imported-get")
`);
    const paths = result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path).sort();
    expect(paths).toEqual(['/imported-request', '/module-request', '/session-get']);
  });

  it('preserves exact provenance through transparent parentheses', async () => {
    const result = await extractSource(`
import requests
import httpx
from fastapi import FastAPI
client = (httpx.Client())
alias = (requests)
app = (FastAPI())
client.get("https://valid.test/parenthesized-constructor")
alias.get("https://valid.test/parenthesized-alias")
(requests).get("https://valid.test/parenthesized-receiver")
@(app.get("/parenthesized-decorator"))
def route(): pass
`);
    const serialized = JSON.stringify(result.nodes);
    expect(serialized).toContain('/parenthesized-constructor');
    expect(serialized).toContain('/parenthesized-alias');
    expect(serialized).toContain('/parenthesized-receiver');
    expect(serialized).toContain('/parenthesized-decorator');
  });

  it('decodes bounded named escapes and adjacent static literals', async () => {
    const result = await extractSource(String.raw`
import requests
from fastapi import FastAPI
from kafka import KafkaProducer
app = FastAPI()
producer = KafkaProducer()
requests.get("https://valid.test/\N{LATIN SMALL LETTER U}sers")
requests.get("https://valid.test/" "adjacent-url")
requests.get("https://valid.test/control\N{LINE FEED}")
@app.get("/adjacent" "/route")
def adjacent_route(): pass
producer.send("orders\N{FULL STOP}created")
producer.send("orders." "adjacent")
`);
    const serialized = JSON.stringify(result.nodes);
    expect(serialized).toContain('/users');
    expect(serialized).toContain('/adjacent-url');
    expect(serialized).toContain('/adjacent/route');
    expect(serialized).toContain('orders.created');
    expect(serialized).toContain('orders.adjacent');
    expect(serialized).not.toContain('control');
    expect(result.contractSkips).toEqual({
      dynamic_http_url: 0, dynamic_http_method: 0,
      dynamic_http_route: 0, dynamic_event_channel: 0,
    });
  });

  it('rejects dynamic provider keyword expansions but accepts explicit contract keys', async () => {
    const result = await extractSource(`
from fastapi import FastAPI, APIRouter
from flask import Flask
options = {}
app = FastAPI()
router = APIRouter(**options)
fixed_router = APIRouter(prefix="/v1", **options)
flask_app = Flask(__name__)
@router.get("/wrong-dynamic-prefix")
def dynamic_prefix(): pass
@fixed_router.get("/fixed-prefix", **options)
def fixed_prefix(): pass
@flask_app.route("/wrong-dynamic-methods", **options)
def dynamic_methods(): pass
@flask_app.route("/fixed-methods", methods=["GET"], **options)
def fixed_methods(): pass
@app.get("/unrelated-options", **options)
def unrelated_options(): pass
`);
    const paths = result.nodes.filter((entry) => entry.kind === 'endpoint')
      .map((entry) => entry.metadata?.path).sort();
    expect(paths).toEqual(['/fixed-methods', '/unrelated-options', '/v1/fixed-prefix']);
    expect(result.contractSkips).toEqual({
      dynamic_http_url: 0, dynamic_http_method: 1,
      dynamic_http_route: 1, dynamic_event_channel: 0,
    });
  });

  it('skips class scope in comprehension bodies and exports walrus bindings to the containing scope', async () => {
    const result = await extractSource(`
import requests
import httpx
class C:
    import requests as client
    visible_first_iterable = [item for item in client.get("https://valid.test/class-first-iterable")]
    hidden_body = [client.get("https://wrong.invalid/class-comprehension-body") for _ in [0]]
[(alias := requests) for _ in [0]]
alias.get("https://valid.test/walrus-module-scope")
def function_scope():
    [[(client := httpx.Client()) for _ in [0]] for _ in [0]]
    client.get("https://valid.test/walrus-function-scope")
`);
    const paths = result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path).sort();
    expect(paths).toEqual(['/class-first-iterable', '/walrus-function-scope', '/walrus-module-scope']);
  });

  it('propagates one proven RHS across every chained simple-assignment target', async () => {
    const result = await extractSource(`
import requests
import httpx
from fastapi import FastAPI
from kafka import KafkaProducer
first = second = httpx.Client()
alias_one = alias_two = requests
app_one = app_two = FastAPI()
producer_one = producer_two = KafkaProducer()
first.get("https://valid.test/chained-first")
second.get("https://valid.test/chained-second")
alias_one.get("https://valid.test/chained-alias-one")
alias_two.get("https://valid.test/chained-alias-two")
@app_one.get("/chained-app-one")
def app_one_route(): pass
@app_two.get("/chained-app-two")
def app_two_route(): pass
producer_one.send("orders.chained.one")
producer_two.send("orders.chained.two")
first = second = replacement
first.get("https://wrong.invalid/chained-invalidated-first")
second.get("https://wrong.invalid/chained-invalidated-second")
`);
    const serialized = JSON.stringify(result.nodes);
    for (const expected of [
      '/chained-first', '/chained-second', '/chained-alias-one', '/chained-alias-two',
      '/chained-app-one', '/chained-app-two', 'orders.chained.one', 'orders.chained.two',
    ]) expect(serialized).toContain(expected);
    expect(serialized).not.toContain('wrong.invalid');
  });

  it('invalidates receiver provenance for binding-bearing match captures', async () => {
    const result = await extractSource(`
import requests
plain = sequence = mapping = class_arg = guard_name = requests
plain.get("https://valid.test/before-match-captures")
match value:
    case plain:
        plain.get("https://wrong.invalid/plain-capture")
match value:
    case [sequence, *rest]:
        sequence.get("https://wrong.invalid/sequence-capture")
match value:
    case {"x": mapping, **mapping_rest}:
        mapping.get("https://wrong.invalid/mapping-capture")
match value:
    case Widget(class_arg, key=other) as whole:
        class_arg.get("https://wrong.invalid/class-capture")
match value:
    case guard_name if guard_name.get("https://wrong.invalid/guard-capture"):
        pass
plain.get("https://wrong.invalid/after-match-capture")
`);
    const calls = result.nodes.filter((entry) => entry.kind === 'http_call');
    expect(calls).toHaveLength(1);
    expect(calls[0].metadata?.path).toBe('/before-match-captures');
  });

  it('unwraps parenthesized literal method and topic collections', async () => {
    const result = await extractSource(`
from flask import Flask
from kafka import KafkaConsumer
app = Flask(__name__)
consumer = KafkaConsumer()
@app.route("/wrapped-methods", methods=((["GET", "HEAD"])))
def wrapped_methods(): pass
consumer.subscribe((("orders.one", "orders.two")))
`);
    const serialized = JSON.stringify(result.nodes);
    expect(serialized).toContain('GET /wrapped-methods');
    expect(serialized).toContain('HEAD /wrapped-methods');
    expect(serialized).toContain('orders.one');
    expect(serialized).toContain('orders.two');
    expect(result.contractSkips).toEqual({
      dynamic_http_url: 0, dynamic_http_method: 0,
      dynamic_http_route: 0, dynamic_event_channel: 0,
    });
  });

  it('treats unsupported valid named-Unicode literals as static without dynamic tallies', async () => {
    const result = await extractSource(String.raw`
import requests
from fastapi import FastAPI
from kafka import KafkaProducer
app = FastAPI()
producer = KafkaProducer()
requests.get("https://valid.test/\N{LATIN SMALL LETTER A WITH ACUTE}")
@app.get("/\N{SNOWMAN}")
def named_route(): pass
producer.send("orders.\N{SNOWMAN}")
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call' || entry.kind === 'endpoint' || entry.kind === 'event_channel')).toHaveLength(0);
    expect(result.contractSkips).toEqual({
      dynamic_http_url: 0, dynamic_http_method: 0,
      dynamic_http_route: 0, dynamic_event_channel: 0,
    });
  });

  it('requires explicit literal methods for generic request APIs without fabricating GET', async () => {
    const result = await extractSource(`
import requests
import httpx
import aiohttp
from requests import request as direct_request
requests_client = requests.Session()
httpx_client = httpx.Client()
aiohttp_client = aiohttp.ClientSession()
options = {}
requests.request("GET", "https://valid.test/requests-module")
httpx.request(method="POST", url="https://valid.test/httpx-module")
aiohttp.request("PUT", "https://valid.test/aiohttp-module")
direct_request("PATCH", "https://valid.test/direct-import")
requests_client.request("DELETE", "https://valid.test/requests-client")
httpx_client.request("HEAD", "https://valid.test/httpx-client")
aiohttp_client.request("OPTIONS", "https://valid.test/aiohttp-client")
requests.request(url="https://wrong.invalid/missing-method")
httpx_client.request(url="https://wrong.invalid/expanded-method", **options)
aiohttp.request(**options)
requests.request(123, "https://wrong.invalid/static-method")
`);
    const paths = result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path).sort();
    expect(paths).toEqual([
      '/aiohttp-client', '/aiohttp-module', '/direct-import', '/httpx-client',
      '/httpx-module', '/requests-client', '/requests-module',
    ]);
    expect(result.contractSkips).toEqual({
      dynamic_http_url: 1, dynamic_http_method: 1,
      dynamic_http_route: 0, dynamic_event_channel: 0,
    });
  });

  it('does not count absent or statically unsupported contract inputs as dynamic', async () => {
    const result = await extractSource(`
import requests
from fastapi import FastAPI, APIRouter
from flask import Flask
from celery import Celery
from kafka import KafkaProducer, KafkaConsumer
app = FastAPI()
router = APIRouter(prefix=None)
flask_app = Flask(__name__)
celery = Celery("worker")
producer = KafkaProducer()
consumer = KafkaConsumer()
requests.get(None)
requests.get()
requests.request(123, "https://wrong.invalid/static-method")
requests.request()
@app.get(123)
def numeric_route(): pass
@app.get()
def missing_route(): pass
@router.get("/unsupported-prefix")
def unsupported_prefix(): pass
@flask_app.route("/static-methods", methods=[123])
def static_methods(): pass
@celery.task()
def unnamed_task(): pass
producer.send(123)
producer.send()
consumer.subscribe([123])
consumer.subscribe()
KafkaConsumer(123)
`);
    const contracts = result.nodes.filter((entry) =>
      entry.kind === 'http_call' || entry.kind === 'endpoint' || entry.kind === 'event_channel');
    expect(contracts).toHaveLength(0);
    expect(result.contractSkips).toEqual({
      dynamic_http_url: 0, dynamic_http_method: 0,
      dynamic_http_route: 0, dynamic_event_channel: 0,
    });

    const expanded = await extractSource(`
import requests
from fastapi import FastAPI
from flask import Flask
from celery import Celery
from kafka import KafkaProducer, KafkaConsumer
options = {}
app = FastAPI()
flask_app = Flask(__name__)
celery = Celery("worker")
producer = KafkaProducer()
consumer = KafkaConsumer()
requests.get(**options)
@app.get(**options)
def dynamic_route(): pass
@flask_app.route("/dynamic-method", **options)
def dynamic_method(): pass
@celery.task(**options)
def dynamic_task(): pass
producer.send(**options)
consumer.subscribe(**options)
`);
    expect(expanded.contractSkips).toEqual({
      dynamic_http_url: 1, dynamic_http_method: 1,
      dynamic_http_route: 1, dynamic_event_channel: 3,
    });
  });

  it('invalidates provenance when Python type aliases bind service names', async () => {
    const result = await extractSource(`
import requests
import requests as GenericParameter
import requests as class_target
requests.get("https://valid.test/module-before-type-alias")
type requests = int
requests.get("https://wrong.invalid/module-after-type-alias")
type Alias[GenericParameter] = list[GenericParameter]
GenericParameter.get("https://valid.test/generic-parameter-is-not-a-write")
def function_scope():
    requests.get("https://wrong.invalid/function-before-local-type-alias")
    type requests = int
    requests.get("https://wrong.invalid/function-after-local-type-alias")
class ClassScope:
    class_target.get("https://valid.test/class-before-type-alias")
    type class_target = int
    class_target.get("https://wrong.invalid/class-after-type-alias")
`);
    const paths = result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path).sort();
    expect(paths).toEqual([
      '/class-before-type-alias', '/generic-parameter-is-not-a-write', '/module-before-type-alias',
    ]);
  });

  it('skips lambda bodies while retaining eager default expressions', async () => {
    const result = await extractSource(`
import requests
import httpx
class ClassScope:
    import requests as class_requests
    import httpx as default_client
    hidden = lambda: class_requests.get("https://wrong.invalid/class-local-lambda")
    global_visible = lambda: requests.get("https://valid.test/module-global-lambda")
    requests = replacement
    shadow_still_global = lambda: requests.get("https://valid.test/class-shadow-skipped")
    default_runs_in_class = lambda value=default_client.get("https://valid.test/class-default-expression"): value
def enclosing_function():
    client = httpx.Client()
    return lambda: client.get("https://valid.test/function-enclosed-lambda")
`);
    const paths = result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path).sort();
    expect(paths).toEqual(['/class-default-expression']);
  });

  it('skips every enclosing class namespace for nested class bodies and member writes', async () => {
    const result = await extractSource(`
import requests
class Outer:
    import requests as outer_client
    class Middle:
        class Inner:
            outer_client.get("https://wrong.invalid/outer-class-lookup")
            requests.get("https://valid.test/nested-class-module-lookup")
            requests.get = replacement
requests.get("https://wrong.invalid/module-member-after-nested-write")
def enclosing_function():
    import httpx as function_client
    class Outer:
        import requests as outer_client
        class Middle:
            class Inner:
                function_client.get("https://valid.test/nested-class-function-closure")
                outer_client.get("https://wrong.invalid/nested-outer-class-lookup")
`);
    const paths = result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path).sort();
    expect(paths).toEqual(['/nested-class-function-closure', '/nested-class-module-lookup']);
  });

  it('skips PEP 695 lazy type expressions while retaining ordinary runtime bodies and defaults', async () => {
    const result = await extractSource(`
import requests
import requests as class_client
import requests as function_client
import requests as bound_client
import requests as positive_client
import requests as default_client
type Alias[requests] = tuple[requests.get("https://wrong.invalid/type-alias-parameter")]
type requests = requests.get("https://wrong.invalid/recursive-alias-name")
type BoundAlias[T: bound_client.get("https://valid.test/type-parameter-bound")] = T
class Generic[class_client]:
    class_client.get("https://wrong.invalid/generic-class-body")
class PositiveClass[T]:
    positive_client.get("https://valid.test/generic-class-global")
def generic[function_client](value: function_client.get("https://wrong.invalid/generic-parameter-annotation")) -> function_client.get("https://wrong.invalid/generic-return-annotation"):
    function_client.get("https://wrong.invalid/generic-function-body")
def positive_function[T]():
    positive_client.get("https://valid.test/generic-function-global")
def default_function[default_client](value=default_client.get("https://valid.test/generic-function-default")):
    pass
`);
    const paths = result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path).sort();
    expect(paths).toEqual([
      '/generic-class-global', '/generic-function-default', '/generic-function-global',
    ]);
  });

  it('classifies Ellipsis as static unsupported at every Python contract input', async () => {
    const result = await extractSource(`
import requests
from fastapi import FastAPI, APIRouter
from flask import Flask
from celery import Celery
from kafka import KafkaProducer, KafkaConsumer
app = FastAPI()
router = APIRouter(prefix=...)
flask_app = Flask(__name__)
celery = Celery("worker")
producer = KafkaProducer()
consumer = KafkaConsumer()
requests.get(...)
requests.request(..., "https://wrong.invalid/ellipsis-method")
@app.get(...)
def ellipsis_route(): pass
@router.get("/ellipsis-prefix")
def ellipsis_prefix(): pass
@flask_app.route("/ellipsis-methods", methods=[...])
def ellipsis_methods(): pass
@celery.task(name=...)
def ellipsis_task(): pass
producer.send(...)
consumer.subscribe([...])
KafkaConsumer(...)
`);
    const contracts = result.nodes.filter((entry) =>
      entry.kind === 'http_call' || entry.kind === 'endpoint' || entry.kind === 'event_channel');
    expect(contracts).toHaveLength(0);
    expect(result.contractSkips).toEqual({
      dynamic_http_url: 0, dynamic_http_method: 0,
      dynamic_http_route: 0, dynamic_event_channel: 0,
    });
  });

  it('retains generic-class type parameters below ordinary class namespaces', async () => {
    const result = await extractSource(`
import requests
import httpx
class Generic[requests]:
    def method(self):
        requests.get("https://wrong.invalid/generic-class-method")
    callback = lambda: requests.get("https://wrong.invalid/generic-class-lambda")
    values = [requests.get("https://wrong.invalid/generic-class-comprehension") for _ in [0]]
    class Nested:
        requests.get("https://wrong.invalid/generic-class-nested-class")
    class Inner[httpx]:
        requests.get("https://wrong.invalid/outer-generic-parameter")
        httpx.get("https://wrong.invalid/inner-generic-parameter")
httpx.get("https://valid.test/unshadowed-module-control")
`);
    const paths = result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path);
    expect(paths).toEqual(['/unshadowed-module-control']);
  });

  it('quarantines a module member mutated through any deferred alias', async () => {
    const result = await extractSource(`
import requests as first, requests as second
first.get = replacement
second.get("https://wrong.invalid/same-statement-alias")
import requests as third
third.get("https://wrong.invalid/reimported-alias")
import fastapi as fastapi_one, fastapi as fastapi_two
fastapi_one.FastAPI = replacement
app = fastapi_two.FastAPI()
@app.get("/wrong-provider-alias")
def wrong_provider(): pass
import kafka as kafka_one, kafka as kafka_two
kafka_one.KafkaProducer = replacement
producer = kafka_two.KafkaProducer()
producer.send("wrong.module.alias")
import httpx
def uncertain_execution():
    import httpx as local_httpx
    local_httpx.get = replacement
    httpx.get("https://wrong.invalid/function-shared-alias")
httpx.get("https://valid.test/function-scope-does-not-escape")
`);
    const contracts = result.nodes.filter((entry) =>
      entry.kind === 'http_call' || entry.kind === 'endpoint' || entry.kind === 'event_channel');
    expect(contracts).toHaveLength(0);
  });

  it('recursively invalidates composite store targets and propagates only eager comprehensions', async () => {
    const assignment = await extractSource(`
import requests
import httpx
requests_client = requests
first_client = httpx.Client()
second_client = httpx.Client()
(requests_client.get, other) = replacements
[first_client.get, another] = replacements
requests_client.get("https://wrong.invalid/tuple-assignment")
requests_client.post("https://valid.test/tuple-sibling")
first_client.get("https://wrong.invalid/list-assignment")
second_client.get("https://valid.test/instance-partition")
`);
    expect(assignment.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path).sort())
      .toEqual(['/instance-partition', '/tuple-sibling']);

    const controlFlow = await extractSource(`
import requests
import httpx
import aiohttp
for requests.get, other in values:
    requests.get("https://wrong.invalid/destructured-loop-body")
requests.get("https://wrong.invalid/destructured-loop-after")
with ctx() as (httpx.get, other):
    httpx.get("https://wrong.invalid/destructured-with-body")
httpx.get("https://wrong.invalid/destructured-with-after")
del aiohttp.request, other
aiohttp.request("GET", "https://wrong.invalid/multi-delete")
`);
    expect(controlFlow.nodes.filter((entry) => entry.kind === 'http_call')).toHaveLength(0);

    const comprehensions = await extractSource(`
import requests
import httpx
[None for requests.get in [replacement]]
requests.get("https://wrong.invalid/eager-comprehension-after")
requests.post("https://valid.test/eager-sibling-control")
pending = (httpx.get("https://wrong.invalid/generator-body") for httpx.get in values)
httpx.get("https://valid.test/generator-does-not-propagate")
`);
    expect(comprehensions.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path).sort())
      .toEqual(['/eager-sibling-control', '/generator-does-not-propagate']);
  });

  it('treats unsupported nested attribute stores as terminal without killing callable members', async () => {
    const result = await extractSource(`
import requests
import fastapi
import kafka
requests.get.review_marker = replacement
requests.get("https://valid.test/nested-http-member")
fastapi.FastAPI.review_marker = replacement
app = fastapi.FastAPI()
@app.get("/nested-provider-member")
def nested_provider(): pass
kafka.KafkaProducer.review_marker = replacement
producer = kafka.KafkaProducer()
producer.send("nested.event.member")
(requests.post, other) = replacements
requests.post("https://wrong.invalid/direct-composite-member")
`);
    const serialized = JSON.stringify(result.nodes);
    expect(serialized).toContain('/nested-http-member');
    expect(serialized).toContain('/nested-provider-member');
    expect(serialized).toContain('nested.event.member');
    expect(serialized).not.toContain('direct-composite-member');
  });

  it('orders each comprehension iterable before its own member target phase', async () => {
    const sources = await Promise.all([
      extractSource(`
import requests
[None for first in [0] for requests.get in [requests.get("https://valid.test/list-second-iterable")]]
`),
      extractSource(`
import httpx
{None for first in [0] for second in [0] for httpx.get in [httpx.get("https://valid.test/set-third-iterable")]}
`),
      extractSource(`
import aiohttp
{None: None for first in [0] for aiohttp.request in [aiohttp.request("GET", "https://valid.test/dict-second-iterable")]}
`),
      extractSource(`
import requests
pending = (None for first in [0] for requests.get in [requests.get("https://valid.test/generator-second-iterable")])
requests.get("https://valid.test/generator-still-contained")
`),
      extractSource(`
import requests
alias = requests
class Holder: pass
[None for alias.get in (alias := Holder())]
requests.get("https://valid.test/comprehension-rhs-rebind")
`),
      extractSource(`
import requests
[requests.get("https://wrong.invalid/list-body-after-target") for requests.get in [replacement] if requests.get("https://wrong.invalid/list-filter-after-target")]
`),
    ]);
    const paths = sources.flatMap((result) => result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path)).sort();
    expect(paths).toEqual([
      '/comprehension-rhs-rebind', '/dict-second-iterable', '/generator-still-contained',
      '/list-second-iterable', '/set-third-iterable',
    ]);
  });

  it('resolves member-store receivers after RHS effects and earlier chained targets', async () => {
    const result = await extractSource(`
import requests
import httpx
import aiohttp
alias = requests
class Holder: pass
alias.get = (alias := Holder())
requests.get("https://valid.test/member-rhs-rebind")
ordered = httpx
ordered = ordered.get = requests
requests.get("https://wrong.invalid/chained-target-order")
httpx.get("https://valid.test/chained-sibling-module")
context_alias = httpx
with (context_alias := Holder()) as context_alias.get:
    pass
httpx.get("https://valid.test/with-rhs-rebind")
loop_alias = aiohttp
for loop_alias.request in (loop_alias := Holder()):
    pass
aiohttp.request("GET", "https://valid.test/for-rhs-rebind")
`);
    const paths = result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path).sort();
    expect(paths).toEqual([
      '/chained-sibling-module', '/for-rhs-rebind', '/member-rhs-rebind', '/with-rhs-rebind',
    ]);
  });

  it('keeps live provenance through bare annotations without losing local shadow rules', async () => {
    const result = await extractSource(`
import requests
import httpx
requests: object
requests.get("https://valid.test/bare-module-name-annotation")
alias = httpx
alias.get: object
alias.get("https://valid.test/bare-member-annotation")
def existing_local():
    import requests as local
    local: object
    local.get("https://valid.test/bare-function-name-annotation")
def prebinding_shadow():
    requests: object
    requests.get("https://wrong.invalid/bare-function-prebinding-shadow")
class ClassScope:
    import httpx as local
    local: object
    local.get("https://valid.test/bare-class-name-annotation")
`);
    const paths = result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path).sort();
    expect(paths).toEqual([
      '/bare-class-name-annotation', '/bare-member-annotation', '/bare-module-name-annotation',
    ]);
  });

  it('evaluates executable value annotations after the RHS and ordered target stores', async () => {
    const result = await extractSource(`
import requests
import httpx
from fastapi import FastAPI
from kafka import KafkaProducer
alias = requests
alias.get = replacement
alias: alias.get("https://valid.test/annotation-call-after-store") = httpx
alias.get("https://valid.test/annotation-name-after-store")
receiver = requests
receiver.get: (receiver := httpx) = replacement
requests.get("https://wrong.invalid/annotation-old-receiver")
httpx.get("https://valid.test/annotation-new-alias")
app: (app := FastAPI()) = replacement
@app.get("/annotation-provider-effect")
def annotation_provider(): pass
producer: producer.send("orders.annotation.phase") = KafkaProducer()
`);
    const paths = result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path).sort();
    expect(paths).toEqual([
      '/annotation-call-after-store', '/annotation-name-after-store', '/annotation-new-alias',
    ]);
    expect(JSON.stringify(result.nodes)).toContain('/annotation-provider-effect');
    expect(JSON.stringify(result.nodes)).toContain('orders.annotation.phase');
  });

  it('skips local and future-deferred annotations while retaining RHS execution', async () => {
    const [local, eager, deferred] = await Promise.all([
      extractSource(`
import requests
import httpx
from kafka import KafkaProducer
producer = KafkaProducer()
def local_annotations():
    alias = requests
    value: (alias := httpx) = requests.get("https://valid.test/local-annotation-rhs")
    bare: requests.get("https://wrong.invalid/local-bare-annotation")
    event: producer.send("wrong.local.annotation")
    alias.get("https://valid.test/local-annotation-not-executed")
`),
      extractSource(`
import requests
module_value: requests.get("https://valid.test/eager-module-annotation") = 1
class EagerClass:
    class_value: requests.get("https://valid.test/eager-class-annotation") = 1
`),
      extractSource(`
from __future__ import annotations
import requests
from kafka import KafkaProducer
producer = KafkaProducer()
module_value: requests.get("https://wrong.invalid/deferred-module-annotation") = requests.get("https://valid.test/deferred-module-rhs")
class DeferredClass:
    class_value: requests.get("https://wrong.invalid/deferred-class-annotation") = 1
    event_value: producer.send("wrong.deferred.annotation") = 1
def deferred_function(value: requests.get("https://wrong.invalid/deferred-parameter")) -> requests.get("https://wrong.invalid/deferred-return"):
    pass
`),
    ]);
    const paths = [local, eager, deferred].flatMap((result) => result.nodes
      .filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path)).sort();
    expect(paths).toEqual([
      '/deferred-module-rhs', '/eager-class-annotation', '/eager-module-annotation',
      '/local-annotation-not-executed', '/local-annotation-rhs',
    ]);
    expect([local, eager, deferred].flatMap((result) => result.nodes)
      .filter((entry) => entry.kind === 'event_channel')).toHaveLength(0);
  });

  it('orders nested for and with target stores from left to right', async () => {
    const result = await extractSource(`
import requests
import httpx
import aiohttp
alias = httpx
for alias, alias.get in [(requests, replacement)]:
    pass
httpx.get("https://valid.test/for-composite-old-receiver")
with_alias = aiohttp
with Manager() as [with_alias, with_alias.request]:
    pass
aiohttp.request("GET", "https://valid.test/with-composite-old-receiver")
nested_alias = requests
for [first, [nested_alias, nested_alias.get]] in values:
    pass
requests.get("https://valid.test/nested-composite-old-receiver")
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path).sort())
      .toEqual([
        '/for-composite-old-receiver', '/nested-composite-old-receiver',
        '/with-composite-old-receiver',
      ]);
  });

  it('invalidates exception aliases after ordinary and grouped handlers', async () => {
    const result = await extractSource(`
import requests
from kafka import KafkaProducer
try:
    raise Exception()
except Exception as alias:
    alias = requests
    alias.get("https://valid.test/exception-alias-in-handler")
alias.get("https://wrong.invalid/exception-alias-after-handler")
try:
    raise ExceptionGroup("group", [Exception()])
except* Exception as event_alias:
    event_alias = KafkaProducer()
    event_alias.send("orders.exception.in-handler")
event_alias.send("wrong.exception.after-handler")
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path)).toEqual(['/exception-alias-in-handler']);
    expect(result.nodes.filter((entry) => entry.kind === 'event_channel')
      .map((entry) => entry.name)).toEqual(['orders.exception.in-handler']);
  });

  it('resolves deferred function, lambda, and generator bodies after their defining stores', async () => {
    const result = await extractSource(`
from requests import get
from fastapi import FastAPI
import requests
import httpx
def get(url):
    if False: get("https://wrong.invalid/function-definition-shadow")
def FastAPI():
    app = FastAPI()
    @app.get("/wrong-function-provider-shadow")
    def route(): pass
get = lambda: get("https://wrong.invalid/lambda-assignment-shadow")
requests = (requests.get("https://wrong.invalid/generator-assignment-shadow") for item in [0])
def nested_scope():
    from httpx import get
    def get(url):
        if False: get("https://wrong.invalid/nested-function-definition-shadow")
httpx.get("https://valid.test/deferred-body-sibling-control")
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path)).toEqual(['/deferred-body-sibling-control']);
    expect(result.nodes.filter((entry) => entry.kind === 'endpoint')).toHaveLength(0);
  });

  it('evaluates function defaults while conservatively skipping annotation contracts', async () => {
    const result = await extractSource(`
import requests
from fastapi import FastAPI
from kafka import KafkaProducer
class Holder: pass
alias = requests
def configured(value: (alias := requests) = (alias := Holder())): pass
alias.get("https://valid.test/function-annotation-final-binding")
call_alias = requests
def call_order(value: call_alias.get("https://wrong.invalid/function-annotation-before-default") = (call_alias := Holder())): pass
producer = Holder()
def event_order(value: producer.send("orders.function.annotation") = (producer := KafkaProducer())): pass
app = Holder()
def provider_order(value: (app := FastAPI()) = (app := Holder())): pass
@app.get("/function-annotation-provider")
def provider_route(): pass
`);
    expect(result.nodes.filter((entry) =>
      entry.kind === 'http_call' || entry.kind === 'endpoint' || entry.kind === 'event_channel')).toHaveLength(0);
  });

  it('evaluates assignment, loop, and comprehension target calls after prerequisites', async () => {
    const result = await extractSource(`
import requests
from kafka import KafkaProducer
class Holder: pass
alias = requests
alias.get("https://wrong.invalid/assignment-target-before-rhs").value = (alias := Holder())
alias = Holder()
alias.get("https://valid.test/assignment-target-after-rhs").value = (alias := requests)
alias = requests
for alias.get("https://wrong.invalid/for-target-before-iterable").value in (alias := Holder()): pass
alias = Holder()
for alias.get("https://valid.test/for-target-after-iterable").value in (alias := requests): pass
alias = requests
[None for alias.get("https://wrong.invalid/comprehension-target-before-iterable").value in (alias := Holder())]
alias = Holder()
[None for alias.get("https://valid.test/comprehension-target-after-iterable").value in (alias := requests)]
producer = Holder()
producer.send("orders.target.phase").value = (producer := KafkaProducer())
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path).sort()).toEqual([
      '/assignment-target-after-rhs', '/for-target-after-iterable',
    ]);
    expect(result.nodes.filter((entry) => entry.kind === 'event_channel')
      .map((entry) => entry.name)).toEqual(['orders.target.phase']);
  });

  it('runs comprehension filters and later iterables before bodies', async () => {
    const result = await extractSource(`
import requests
from kafka import KafkaProducer
class Holder: pass
alias = requests
[alias.get("https://wrong.invalid/comprehension-filter-before-body") for _ in [0] if (alias := Holder())]
alias = Holder()
[alias.get("https://valid.test/comprehension-filter-establishes-body") for _ in [0] if (alias := requests)]
alias = requests
[alias.get("https://wrong.invalid/comprehension-inner-iterable-before-body") for _ in [0] for x in (alias := Holder())]
alias = requests
pending = (alias.get("https://wrong.invalid/generator-filter-before-body") for _ in [0] if (alias := Holder()))
producer = Holder()
[producer.send("orders.comprehension.filter") for _ in [0] if (producer := KafkaProducer())]
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')).toHaveLength(0);
    expect(result.nodes.filter((entry) => entry.kind === 'event_channel')).toHaveLength(0);
  });

  it('runs conditional-expression conditions before either conservative branch', async () => {
    const result = await extractSource(`
import requests
from kafka import KafkaProducer
class Holder: pass
alias = requests
alias.get("https://wrong.invalid/conditional-condition-before-consequence") if (alias := Holder()) else None
alias = Holder()
alias.get("https://valid.test/conditional-condition-establishes-consequence") if (alias := requests) else None
producer = Holder()
producer.send("orders.conditional.condition") if (producer := KafkaProducer()) else None
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path)).toEqual(['/conditional-condition-establishes-consequence']);
    expect(result.nodes.filter((entry) => entry.kind === 'event_channel')
      .map((entry) => entry.name)).toEqual(['orders.conditional.condition']);
  });

  it('keeps explicit class deletion fallback and fails closed at handler joins', async () => {
    const result = await extractSource(`
import requests
from kafka import KafkaProducer
producer = KafkaProducer()
class ExplicitDelete:
    requests = object()
    del requests
    requests.get("https://valid.test/class-delete-global-fallback")
class ExceptionDelete:
    try: raise Exception()
    except Exception as requests: pass
    requests.get("https://valid.test/class-except-global-fallback")
class GroupedExceptionDelete:
    try: raise ExceptionGroup("group", [Exception()])
    except* Exception as producer: pass
    producer.send("orders.class-except-global-fallback")
class UnknownStillShadows:
    requests = object()
    requests.get("https://wrong.invalid/class-unknown-still-shadows")
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path).sort()).toEqual([
      '/class-delete-global-fallback',
    ]);
    expect(result.nodes.filter((entry) => entry.kind === 'event_channel')
      .map((entry) => entry.name)).toEqual([]);
  });

  it('routes eager class global and nonlocal writes to their execution targets', async () => {
    const result = await extractSource(`
import requests
import httpx
from kafka import KafkaProducer
class Holder: pass
class GlobalHttpWrite:
    global requests
    requests = Holder()
requests.get("https://wrong.invalid/class-global-write-escapes")
httpx.get("https://valid.test/class-global-sibling-control")
producer = KafkaProducer()
class GlobalEventWrite:
    global producer
    producer = Holder()
producer.send("wrong.class.global.event")
def enclosing():
    alias = httpx
    event_alias = KafkaProducer()
    class NonlocalWrites:
        nonlocal alias, event_alias
        alias = Holder()
        event_alias = Holder()
    alias.get("https://wrong.invalid/class-nonlocal-write-escapes")
    event_alias.send("wrong.class.nonlocal.event")
def enclosing_global():
    class NestedGlobalWrite:
        global httpx
        httpx = Holder()
        httpx.get("https://wrong.invalid/nested-class-global-inside")
    httpx.get("https://wrong.invalid/nested-class-global-after")
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path)).toEqual(['/class-global-sibling-control']);
    expect(result.nodes.filter((entry) => entry.kind === 'event_channel')).toHaveLength(0);
  });

  it('keeps enclosing lexical bindings ahead of nested class global overlays', async () => {
    const result = await extractSource(`
import requests
import httpx
from fastapi import FastAPI
from kafka import KafkaProducer
class Holder: pass
def local_collision():
    requests = httpx
    class GlobalWrite:
        global requests
        requests = Holder()
    requests.get("https://valid.test/class-global-enclosing-local")
local_collision()
def parameter_collision(requests=httpx):
    class GlobalWrite:
        global requests
        requests = Holder()
    requests.get("https://valid.test/class-global-parameter")
parameter_collision()
def argument_collision(client):
    class GlobalWrite:
        global client
        client = Holder()
    client.get("https://valid.test/class-global-argument")
argument_collision(httpx)
def nonlocal_collision():
    alias = httpx
    def inner():
        nonlocal alias
        class GlobalWrite:
            global alias
            alias = Holder()
        alias.get("https://valid.test/class-global-nonlocal")
    inner()
nonlocal_collision()
def provider_collision():
    app = FastAPI()
    class GlobalWrite:
        global app
        app = Holder()
    @app.get("/class-global-provider-local")
    def route(): pass
provider_collision()
def event_collision():
    producer = KafkaProducer()
    class GlobalWrite:
        global producer
        producer = Holder()
    producer.send("orders.class-global-local")
event_collision()
def no_local_collision():
    class GlobalWrite:
        global httpx
        httpx = Holder()
    httpx.get("https://wrong.invalid/class-global-no-local")
no_local_collision()
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path)).toEqual(['/class-global-enclosing-local']);
    expect(result.nodes.filter((entry) => entry.kind === 'endpoint')
      .map((entry) => entry.metadata?.path)).toEqual(['/class-global-provider-local']);
    expect(result.nodes.filter((entry) => entry.kind === 'event_channel')
      .map((entry) => entry.name)).toEqual(['orders.class-global-local']);
  });

  it('does not re-evaluate deferred bodies at invocation or generator-consumption sites', async () => {
    const result = await extractSource(`
import requests
from fastapi import FastAPI
from kafka import KafkaProducer
class Holder: pass
alias = requests
def invoked_in_both_states():
    alias.get("https://valid.test/function-before-rebind")
invoked_in_both_states()
alias = Holder()
invoked_in_both_states()
stale = requests
def invoked_after_rebind():
    stale.get("https://wrong.invalid/function-after-rebind")
stale = Holder()
invoked_after_rebind()
late = Holder()
def invoked_after_capability():
    late.get("https://valid.test/function-late-capability")
late = requests
invoked_after_capability()
lambda_stale = requests
callback = lambda: lambda_stale.get("https://wrong.invalid/lambda-after-rebind")
lambda_stale = Holder()
callback()
lambda_late = Holder()
late_callback = lambda: lambda_late.get("https://valid.test/lambda-late-capability")
lambda_late = requests
late_callback()
generator_stale = requests
pending = (generator_stale.get("https://wrong.invalid/generator-after-rebind") for _ in [0])
generator_stale = Holder()
list(pending)
generator_late = Holder()
late_pending = (generator_late.get("https://valid.test/generator-late-capability") for _ in [0])
generator_late = requests
list(late_pending)
app = Holder()
def install_route():
    @app.get("/deferred-provider-late-capability")
    def route(): pass
app = FastAPI()
install_route()
producer = Holder()
def emit_event():
    producer.send("orders.deferred.late-capability")
producer = KafkaProducer()
emit_event()
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')).toHaveLength(0);
    expect(result.nodes.filter((entry) => entry.kind === 'endpoint')).toHaveLength(0);
    expect(result.nodes.filter((entry) => entry.kind === 'event_channel')).toHaveLength(0);
  });

  it('requires stable callable, generator, and builtin-consumer provenance', async () => {
    const result = await extractSource(`
import requests
import httpx
class Holder: pass
task_alias = requests
def task(): task_alias.get("https://valid.test/uninvoked-original-fallback")
task_alias = Holder()
task = lambda: None
task()
late_alias = Holder()
def late_task(): late_alias.get("https://wrong.invalid/rebound-callable-late-capability")
late_alias = requests
late_task = lambda: None
late_task()
generator_alias = Holder()
pending = (generator_alias.get("https://wrong.invalid/replaced-generator") for _ in [0])
generator_alias = requests
pending = []
list(pending)
shadow_alias = Holder()
shadowed = (shadow_alias.get("https://wrong.invalid/shadowed-consumer") for _ in [0])
shadow_alias = requests
list = lambda value: None
list(shadowed)
httpx.get("https://valid.test/provenance-control")
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path)).toEqual(['/provenance-control']);
  });

  it('resolves explicit invocation arguments in caller scope with per-call object identity', async () => {
    const result = await extractSource(`
import requests
import httpx
from fastapi import APIRouter
from kafka import KafkaProducer
class Holder: pass
def invoke(client, producer):
    client.get("https://valid.test/class-local-argument")
    producer.send("orders.class-local-argument")
requests = Holder()
class Caller:
    requests = httpx
    producer = KafkaProducer()
    invoke(producer=producer, client=requests)
def install(app):
    @app.get("/route")
    def route(): pass
    app.get = Holder()
install(APIRouter(prefix="/one"))
install(APIRouter(prefix="/two"))
shared = APIRouter(prefix="/shared")
install(shared)
install(shared)
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')).toHaveLength(0);
    expect(result.nodes.filter((entry) => entry.kind === 'event_channel')).toHaveLength(0);
    expect(result.nodes.filter((entry) => entry.kind === 'endpoint')).toHaveLength(0);
  });

  it('deduplicates dynamic rejection tallies across repeated deferred invocations', async () => {
    const result = await extractSource(`
import requests
from flask import Flask
from kafka import KafkaProducer
def dynamic_http(url): requests.get(url)
dynamic_http(first)
dynamic_http(second)
def mixed_http(url): requests.get(url)
mixed_http(dynamic)
mixed_http("https://valid.test/mixed-deferred")
def dynamic_event(topic):
    producer = KafkaProducer()
    producer.send(topic)
dynamic_event(first_topic)
dynamic_event(second_topic)
def dynamic_route(route):
    app = Flask(__name__)
    @app.route(route)
    def handler(): pass
dynamic_route(first_route)
dynamic_route(second_route)
`);
    expect(result.contractSkips).toEqual({
      dynamic_http_url: 2, dynamic_http_method: 0,
      dynamic_http_route: 1, dynamic_event_channel: 1,
    });
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')).toHaveLength(0);
  });

  it('applies nested class global overlays to enclosing global reads', async () => {
    const result = await extractSource(`
import requests
from fastapi import FastAPI
from kafka import KafkaProducer
class Holder: pass
app = FastAPI()
producer = KafkaProducer()
def outer():
    global requests, app, producer
    class Write:
        global requests, app, producer
        requests = Holder()
        app = Holder()
        producer = Holder()
    requests.get("https://wrong.invalid/enclosing-global-after-class")
    @app.get("/wrong-enclosing-global-provider")
    def route(): pass
    producer.send("wrong.enclosing.global.event")
outer()
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')).toHaveLength(0);
    expect(result.nodes.filter((entry) => entry.kind === 'endpoint')).toHaveLength(0);
    expect(result.nodes.filter((entry) => entry.kind === 'event_channel')).toHaveLength(0);
  });

  it('executes a bounded generator stream without restarting exhausted bodies', async () => {
    const result = await extractSource(`
import requests
class Holder: pass
alias = Holder()
pending = (alias.get("https://wrong.invalid/exhausted-full-consumer") for _ in [0])
list(pending)
alias = requests
list(pending)
next_alias = Holder()
stepped = (next_alias.get("https://wrong.invalid/exhausted-next-consumer") for _ in [0])
next(stepped)
next_alias = requests
next(stepped)
late_alias = Holder()
late = (late_alias.get("https://valid.test/second-next-valid") for _ in [0, 1])
next(late)
late_alias = requests
next(late)
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')).toHaveLength(0);
  });

  it('propagates proven invocation timing through deferred callers and excludes annotations', async () => {
    const result = await extractSource(`
from __future__ import annotations
import requests
class Holder: pass
late = Holder()
def inner(): late.get("https://valid.test/nested-caller-late")
def middle(): inner()
def outer(): middle()
late = requests
outer()
stale = requests
def stale_inner(): stale.get("https://wrong.invalid/nested-caller-stale")
def stale_outer(): stale_inner()
stale = Holder()
stale_outer()
annotation_alias = Holder()
def annotation_only(): annotation_alias.get("https://wrong.invalid/future-annotation-invocation")
annotation_alias = requests
value: annotation_only()
def local_annotation():
    local_value: annotation_only()
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')).toHaveLength(0);
  });

  it('fails closed for the nine pass-13 interprocedural and lazy-execution defect families', async () => {
    const cases = [
      `
import requests
class Holder: pass
alias = Holder()
def inner(url): requests.get(url)
def outer(url): inner(url)
outer("https://wrong.invalid/nested-argument")
`,
      `
import requests
def task(url="https://wrong.invalid/literal-default"): requests.get(url)
task()
`,
      `
import requests
def task(client=requests): client.get("https://wrong.invalid/kwargs-default")
task(**options)
`,
      `
import requests
from fastapi import FastAPI
class Holder: pass
app = FastAPI()
def poison(receiver): receiver.get = Holder()
poison(app)
@app.get("/wrong-invoked-member")
def route(): pass
def called():
    global requests
    requests = Holder()
called()
requests.get("https://wrong.invalid/invoked-global")
`,
      `
import requests
def stream():
    yield requests.get("https://wrong.invalid/generator-function")
pending = stream()
list(pending)
`,
      `
import requests
pending = (requests.get("https://wrong.invalid/generator-expression") for _ in [0])
`,
      `
import requests
class Holder: pass
alias = Holder()
pending = (alias.get("https://wrong.invalid/generator-exhaustion") for _ in {0, 0})
next(pending)
alias = requests
next(pending)
`,
      `
import requests
type Alias = requests.get("https://wrong.invalid/lazy-type-alias")
def generic[T: requests.get("https://wrong.invalid/lazy-type-bound")](): pass
`,
      `
import requests
class Holder: pass
def replace(fn): return lambda: None
alias = Holder()
@replace
def task(): alias.get("https://wrong.invalid/decorated-callable")
alias = requests
task()
`,
    ];
    for (const [index, source] of cases.entries()) {
      const result = await extractSource(source);
      expect(result.nodes.filter((entry) =>
        entry.kind === 'http_call' || entry.kind === 'endpoint' || entry.kind === 'event_channel'), `case ${index + 1}`)
        .toHaveLength(0);
    }
  });

  it('fails closed when control-flow joins cannot prove one receiver provenance', async () => {
    const result = await extractSource(`
import requests
class Holder: pass

if condition:
    requests.get("https://valid.test/branch-local-direct")

if_alias = Holder()
if condition:
    if_alias = Holder()
else:
    if_alias = requests
if_alias.get("https://wrong.invalid/if-else-join")

conditional_alias = Holder()
conditional_alias = requests if condition else Holder()
conditional_alias.get("https://wrong.invalid/conditional-join")

and_alias = Holder()
condition and (and_alias := requests)
and_alias.get("https://wrong.invalid/and-join")

or_alias = Holder()
condition or (or_alias := requests)
or_alias.get("https://wrong.invalid/or-join")

for_alias = Holder()
for item in values:
    for_alias = requests
for_alias.get("https://wrong.invalid/for-join")

while_alias = Holder()
while condition:
    while_alias = requests
while_alias.get("https://wrong.invalid/while-join")

try_alias = Holder()
try:
    try_alias = requests
except Exception:
    pass
try_alias.get("https://wrong.invalid/try-join")

match_alias = Holder()
match value:
    case 1:
        match_alias = requests
match_alias.get("https://wrong.invalid/match-join")
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path)).toEqual(['/branch-local-direct']);
  });

  it('retains convergent mandatory control-flow provenance after conservative joins', async () => {
    const result = await extractSource(`
import requests
class Holder: pass

same_alias = Holder()
if condition:
    same_alias = requests
else:
    same_alias = requests
same_alias.get("https://valid.test/identical-if")

condition_alias = Holder()
if (condition_alias := requests):
    condition_alias = requests
condition_alias.get("https://valid.test/condition-and-body")

left_alias = Holder()
(left_alias := requests) and None
left_alias.get("https://valid.test/boolean-left")

iterable_alias = Holder()
for item in (iterable_alias := requests):
    pass
iterable_alias.get("https://valid.test/iterable-effect")

while_alias = Holder()
while (while_alias := requests) and False:
    pass
while_alias.get("https://valid.test/while-condition")

finally_alias = Holder()
try:
    pass
finally:
    finally_alias = requests
finally_alias.get("https://valid.test/finally-effect")
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path).sort()).toEqual([
        '/boolean-left', '/condition-and-body', '/finally-effect',
        '/identical-if', '/iterable-effect', '/while-condition',
      ]);
  });

  it('keeps nested class member effects inside their branch until the join', async () => {
    const result = await extractSource(`
import requests
import httpx
if condition:
    class Mutator:
        requests.get = replacement
else:
    requests.get("https://valid.test/nested-class-other-branch")
requests.get("https://wrong.invalid/nested-class-after-join")
requests.post("https://valid.test/nested-class-sibling-after")
httpx.get("https://valid.test/nested-class-other-receiver")
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path).sort()).toEqual([
        '/nested-class-other-branch', '/nested-class-other-receiver',
        '/nested-class-sibling-after',
      ]);
  });

  it('propagates nested join member effects one enclosing branch at a time', async () => {
    const result = await extractSource(`
import requests
import httpx
if outer_condition:
    if inner_condition:
        class Mutator:
            requests.get = replacement
else:
    requests.get("https://valid.test/outer-other-branch")
requests.get("https://wrong.invalid/outer-after-join")
requests.post("https://valid.test/outer-sibling-member")
httpx.get("https://valid.test/outer-other-receiver")
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path).sort()).toEqual([
        '/outer-other-branch', '/outer-other-receiver', '/outer-sibling-member',
      ]);
  });

  it('retains eager generator creation inputs without executing the deferred body', async () => {
    const result = await extractSource(`
import requests
pending = (requests.get("https://wrong.invalid/deferred-body") for _ in [requests.get("https://valid.test/eager-first-iterable")])
`);
    expect(result.nodes.filter((entry) => entry.kind === 'http_call')
      .map((entry) => entry.metadata?.path)).toEqual(['/eager-first-iterable']);
  });
});
