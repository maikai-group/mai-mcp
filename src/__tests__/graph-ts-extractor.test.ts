/** ts extractor over the committed fixture repo — pure, no DB required. */
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { endpointQName, routeMatches, serviceIdentity, serviceSourceQName } from '../graph/contracts.js';
import { tsExtractor } from '../graph/extractors/ts.js';
import type { ExtractorOutput } from '../graph/types.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ts-repo');
const CROSS_FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cross-service', 'ts-client');
const IDENTITY = serviceIdentity(FIXTURE);
const source = (legacy: string): string => serviceSourceQName(IDENTITY.id, legacy);
const UTIL = source('ts-repo/src/util.ts');
const SERVER = source('ts-repo/src/server.ts');
const CARD = source('ts-repo/src/Card.tsx');
const PROFILE = source('ts-repo/app/profile/[id].tsx');

let out: ExtractorOutput;
let crossOut: ExtractorOutput;

beforeAll(async () => {
  out = await tsExtractor.extract({ projectId: 'unused', repoPaths: [FIXTURE] });
  crossOut = await tsExtractor.extract({ projectId: 'unused', repoPaths: [CROSS_FIXTURE] });
});

describe('ts service contracts', () => {
  const identity = serviceIdentity(CROSS_FIXTURE);
  const file = serviceSourceQName(identity.id, 'ts-client/src/client.ts');

  it('emits service-qualified providers, literal clients, and KafkaJS channels', () => {
    const health = endpointQName(identity.id, 'GET', '/health');
    expect(crossOut.nodes.find((entry) => entry.qualifiedName === health)?.metadata).toEqual({
      contract: 'http-endpoint-v1',
      service_id: identity.id,
      service_aliases: identity.aliases,
      method: 'GET',
      path: '/health',
    });
    expect(crossOut.nodes.find((entry) => entry.qualifiedName === endpointQName(identity.id, 'ANY', '/files/{}'))).toBeDefined();
    expect(crossOut.edges.find((entry) => entry.relation === 'serves_route' && entry.from.qualifiedName === file)).toBeDefined();

    const calls = crossOut.nodes.filter((entry) => entry.kind === 'http_call');
    expect(calls).toHaveLength(6);
    expect(calls.every((entry) => entry.qualifiedName.startsWith(`http-call:${identity.id}:`))).toBe(true);
    expect(calls.map((entry) => entry.metadata?.method).sort()).toEqual(['GET', 'GET', 'PATCH', 'POST', 'POST', 'PUT']);
    expect(JSON.stringify(calls)).not.toContain('discarded');
    expect(JSON.stringify(calls)).not.toContain('token=');
    expect(crossOut.nodes.some((entry) => entry.name.includes('ignored.invalid'))).toBe(false);

    expect(crossOut.nodes.find((entry) => entry.qualifiedName === 'event:kafka:orders.created')).toBeDefined();
    expect(crossOut.nodes.find((entry) => entry.qualifiedName === 'event:kafka:orders.paid')).toBeDefined();
    expect(crossOut.edges.some((entry) => entry.relation === 'emits' && entry.from.qualifiedName === file)).toBe(true);
    expect(crossOut.edges.some((entry) => entry.relation === 'listens_on' && entry.from.qualifiedName === file)).toBe(true);
    expect(crossOut.contractSkips).toEqual({
      dynamic_http_url: 0,
      dynamic_http_method: 0,
      dynamic_http_route: 0,
      dynamic_event_channel: 0,
    });
  });

  it('keeps equal routes distinct across services', () => {
    expect(endpointQName(identity.id, 'GET', '/health')).not.toBe(endpointQName(IDENTITY.id, 'GET', '/health'));
  });

  it('partitions same-path nested services independent of root order', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ts-owned-'));
    const child = path.join(parent, 'child');
    try {
      fs.mkdirSync(path.join(parent, 'src'), { recursive: true });
      fs.mkdirSync(path.join(child, 'src'), { recursive: true });
      fs.writeFileSync(path.join(parent, 'package.json'), '{"name":"parent-service"}');
      fs.writeFileSync(path.join(child, 'package.json'), '{"name":"child-service"}');
      fs.writeFileSync(path.join(parent, 'src', 'index.ts'), "interface AppLike { get(route: string, handler: () => void): void } const app: AppLike = { get(_r, _handler): void {} }; app.get('/health', () => undefined);\n");
      fs.writeFileSync(path.join(child, 'src', 'index.ts'), "interface AppLike { get(route: string, handler: () => void): void } const app: AppLike = { get(_r, _handler): void {} }; app.get('/health', () => undefined);\n");
      const forward = await tsExtractor.extract({ projectId: 'x', repoPaths: [parent, child] });
      const reverse = await tsExtractor.extract({ projectId: 'x', repoPaths: [child, parent] });
      const signature = (value: ExtractorOutput): string[] => value.nodes.map((entry) => entry.qualifiedName).sort();
      expect(signature(forward)).toEqual(signature(reverse));
      expect(forward.nodes.filter((entry) => entry.kind === 'file' && entry.filePath === fs.realpathSync.native(path.join(child, 'src', 'index.ts')))).toHaveLength(1);
      const parentIdentity = serviceIdentity(parent);
      const childIdentity = serviceIdentity(child);
      expect(forward.nodes.some((entry) => entry.qualifiedName === endpointQName(parentIdentity.id, 'GET', '/health'))).toBe(true);
      expect(forward.nodes.some((entry) => entry.qualifiedName === endpointQName(childIdentity.id, 'GET', '/health'))).toBe(true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('classifies the first supported dynamic rejection exactly once', async () => {
    const cases: Array<{ source: string; field: keyof NonNullable<ExtractorOutput['contractSkips']> }> = [
      { source: "const url = getUrl(); void fetch(url);", field: 'dynamic_http_url' },
      { source: "const method = getMethod(); void fetch('https://api.test/x', { method });", field: 'dynamic_http_method' },
      { source: "const route = getRoute(); interface AppLike { get(route: string, handler: () => void): void } const app: AppLike = { get(_r, _handler): void {} }; app.get(route, () => undefined);", field: 'dynamic_http_route' },
      {
        source: "import { Kafka } from 'kafkajs'; const kafka = new Kafka({}); const producer = kafka.producer(); const topic = getTopic(); void producer.send({ topic, messages: [] });",
        field: 'dynamic_event_channel',
      },
    ];
    for (const entry of cases) {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ts-contract-'));
      try {
        fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"dynamic-fixture"}');
        fs.writeFileSync(path.join(repo, 'index.ts'), entry.source);
        const result = await tsExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
        const expected = {
          dynamic_http_url: 0,
          dynamic_http_method: 0,
          dynamic_http_route: 0,
          dynamic_event_channel: 0,
        };
        expected[entry.field] = 1;
        expect(result.contractSkips).toEqual(expected);
        expect(result.nodes.filter((item) => item.kind === 'http_call' || item.kind === 'endpoint' || item.kind === 'event_channel')).toHaveLength(0);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  it('classifies proven Axios and Kafka whole-config expressions exactly once', async () => {
    const cases: Array<{ source: string; field: keyof NonNullable<ExtractorOutput['contractSkips']> }> = [
      {
        source: "import axios from 'axios'; const config = getConfig(); void axios(config);",
        field: 'dynamic_http_url',
      },
      {
        source: "import axios from 'axios'; const config = getConfig(); void axios.request(config);",
        field: 'dynamic_http_url',
      },
      {
        source: "import { Kafka } from 'kafkajs'; const kafka = new Kafka({}); const producer = kafka.producer(); const config = getConfig(); void producer.send(config);",
        field: 'dynamic_event_channel',
      },
      {
        source: "import { Kafka } from 'kafkajs'; const kafka = new Kafka({}); const consumer = kafka.consumer(); const config = getConfig(); void consumer.subscribe(config);",
        field: 'dynamic_event_channel',
      },
    ];
    for (const entry of cases) {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ts-whole-config-'));
      try {
        fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"whole-config-fixture","dependencies":{"axios":"1.0.0","kafkajs":"1.0.0"}}');
        fs.writeFileSync(path.join(repo, 'index.ts'), entry.source);
        const result = await tsExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
        const expected = {
          dynamic_http_url: 0,
          dynamic_http_method: 0,
          dynamic_http_route: 0,
          dynamic_event_channel: 0,
        };
        expected[entry.field] = 1;
        expect(result.contractSkips).toEqual(expected);
        expect(result.nodes.filter((item) => item.kind === 'http_call' || item.kind === 'event_channel')).toHaveLength(0);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  it('requires symbol identity for axios and Kafka receivers under lexical shadowing', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ts-provenance-'));
    try {
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"ts-provenance","dependencies":{"axios":"1.0.0","kafkajs":"1.0.0"}}');
      fs.writeFileSync(path.join(repo, 'index.ts'), `
import axios from 'axios';
import { Kafka } from 'kafkajs';
import * as kafkaNs from 'kafkajs';
const kafka = new Kafka({});
const producer = kafka.producer();
const consumer = kafka.consumer({});
void axios.get('https://valid.test/x');
void producer.send({ topic: 'valid.topic', messages: [] });
void consumer.subscribe({ topic: 'valid.listen' });
let reassignedRoot = new Kafka({});
reassignedRoot = { producer: () => ({ send: () => undefined }) };
const rootProducer = reassignedRoot.producer();
void rootProducer.send({ topic: 'wrong.root-reassigned', messages: [] });
let reassignedProducer = kafka.producer();
reassignedProducer = { send: () => undefined };
void reassignedProducer.send({ topic: 'wrong.producer-reassigned', messages: [] });
let reassignedConsumer = kafka.consumer({});
reassignedConsumer = { subscribe: () => undefined };
void reassignedConsumer.subscribe({ topic: 'wrong.consumer-reassigned' });
let destructuredRoot = new Kafka({});
[destructuredRoot] = [{ producer: () => ({ send: () => undefined }) }];
const destructuredRootProducer = destructuredRoot.producer();
void destructuredRootProducer.send({ topic: 'wrong.root-destructured', messages: [] });
let destructuredProducer = kafka.producer();
[destructuredProducer] = [{ send: () => undefined }];
void destructuredProducer.send({ topic: 'wrong.producer-destructured', messages: [] });
let destructuredConsumer = kafka.consumer({});
({ destructuredConsumer } = { destructuredConsumer: { subscribe: () => undefined } });
void destructuredConsumer.subscribe({ topic: 'wrong.consumer-destructured' });
let loopProducer = kafka.producer();
for (loopProducer of [{ send: () => undefined }]) {
  break;
}
void loopProducer.send({ topic: 'wrong.producer-loop-write', messages: [] });
function fake(axios, producer, consumer, Kafka, kafkaNs): void {
  void axios.get('https://wrong.invalid/axios');
  void producer.send({ topic: 'wrong.producer', messages: [] });
  void consumer.subscribe({ topic: 'wrong.consumer' });
  const localOne = new Kafka({});
  const localProducer = localOne.producer();
  void localProducer.send({ topic: 'wrong.constructor', messages: [] });
  const localTwo = new kafkaNs.Kafka({});
  const namespaceProducer = localTwo.producer();
  void namespaceProducer.send({ topic: 'wrong.namespace', messages: [] });
}
void fake;
`);
      const result = await tsExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      expect(result.nodes.filter((entry) => entry.kind === 'http_call').map((entry) => entry.name)).toEqual(['GET valid.test/x']);
      expect(result.nodes.filter((entry) => entry.kind === 'event_channel').map((entry) => entry.name).sort()).toEqual(['valid.listen', 'valid.topic']);
      expect(result.contractSkips).toEqual({
        dynamic_http_url: 0,
        dynamic_http_method: 0,
        dynamic_http_route: 0,
        dynamic_event_channel: 0,
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('drops supported client observations after callable assignment or deletion', async () => {
    const cases: Array<{ source: string; http?: string; event?: string }> = [
      { source: "import axios from 'axios'; void axios.get('https://valid.test/axios-before-write'); axios.get = () => undefined; void axios.get('https://wrong.invalid/axios-write');", http: 'GET valid.test/axios-before-write' },
      { source: "import axios from 'axios'; void axios.get('https://valid.test/axios-before-delete'); delete axios.get; void axios.get('https://wrong.invalid/axios-delete');", http: 'GET valid.test/axios-before-delete' },
      { source: "import axios from 'axios'; void axios({ url: 'https://valid.test/axios-root-before' }); axios = () => undefined; void axios({ url: 'https://wrong.invalid/axios-root' });", http: 'GET valid.test/axios-root-before' },
      { source: "import { Kafka } from 'kafkajs'; const kafka = new Kafka({}); const producer = kafka.producer(); void producer.send({ topic: 'valid.producer-before-write', messages: [] }); producer.send = () => undefined; void producer.send({ topic: 'wrong.producer-write', messages: [] });", event: 'valid.producer-before-write' },
      { source: "import { Kafka } from 'kafkajs'; const kafka = new Kafka({}); const producer = kafka.producer(); void producer.send({ topic: 'valid.producer-before-delete', messages: [] }); delete producer.send; void producer.send({ topic: 'wrong.producer-delete', messages: [] });", event: 'valid.producer-before-delete' },
      { source: "import { Kafka } from 'kafkajs'; const kafka = new Kafka({}); const consumer = kafka.consumer({}); void consumer.subscribe({ topic: 'valid.consumer-before-write' }); consumer.subscribe = () => undefined; void consumer.subscribe({ topic: 'wrong.consumer-write' });", event: 'valid.consumer-before-write' },
      { source: "import { Kafka } from 'kafkajs'; const kafka = new Kafka({}); const consumer = kafka.consumer({}); void consumer.subscribe({ topic: 'valid.consumer-before-delete' }); delete consumer.subscribe; void consumer.subscribe({ topic: 'wrong.consumer-delete' });", event: 'valid.consumer-before-delete' },
      { source: "void fetch('https://valid.test/fetch-before-write'); fetch = () => Promise.resolve(new Response()); void fetch('https://wrong.invalid/fetch-write');", http: 'GET valid.test/fetch-before-write' },
      { source: "void fetch('https://valid.test/fetch-before-delete'); delete fetch; void fetch('https://wrong.invalid/fetch-delete');", http: 'GET valid.test/fetch-before-delete' },
    ];
    for (const entry of cases) {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ts-client-invalidation-'));
      try {
        fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"client-invalidation","dependencies":{"axios":"1.0.0","kafkajs":"1.0.0"}}');
        fs.writeFileSync(path.join(repo, 'index.ts'), entry.source);
        const result = await tsExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
        expect(result.nodes.filter((node) => node.kind === 'http_call').map((node) => node.name)).toEqual(
          entry.http === undefined ? [] : [entry.http],
        );
        expect(result.nodes.filter((node) => node.kind === 'event_channel').map((node) => node.name)).toEqual(
          entry.event === undefined ? [] : [entry.event],
        );
        expect(result.contractSkips).toEqual({
          dynamic_http_url: 0,
          dynamic_http_method: 0,
          dynamic_http_route: 0,
          dynamic_event_channel: 0,
        });
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    }

    const siblingRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ts-client-invalidation-sibling-'));
    try {
      fs.writeFileSync(path.join(siblingRepo, 'package.json'), '{"name":"client-invalidation-sibling","dependencies":{"kafkajs":"1.0.0"}}');
      fs.writeFileSync(path.join(siblingRepo, 'index.ts'), `
import { Kafka } from 'kafkajs';
const kafka = new Kafka({});
const first = kafka.producer();
const second = kafka.producer();
first.send = () => undefined;
void first.send({ topic: 'wrong.first', messages: [] });
void second.send({ topic: 'valid.second', messages: [] });
`);
      const result = await tsExtractor.extract({ projectId: 'unused', repoPaths: [siblingRepo] });
      expect(result.nodes.filter((entry) => entry.kind === 'event_channel').map((entry) => entry.name)).toEqual(['valid.second']);
    } finally {
      fs.rmSync(siblingRepo, { recursive: true, force: true });
    }
  });

  it('accepts the named-default Axios import form', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ts-axios-named-default-'));
    try {
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"axios-named-default","dependencies":{"axios":"1.0.0"}}');
      fs.writeFileSync(path.join(repo, 'index.ts'), "import { default as client } from 'axios'; void client.get('https://valid.test/named-default');");
      const result = await tsExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      expect(result.nodes.filter((entry) => entry.kind === 'http_call').map((entry) => entry.name)).toEqual([
        'GET valid.test/named-default',
      ]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('applies loop and unary writes after their operand expressions', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ts-write-order-'));
    try {
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"write-order","dependencies":{"axios":"1.0.0","kafkajs":"1.0.0","express":"1.0.0"}}');
      fs.writeFileSync(path.join(repo, 'index.ts'), `
import axios, { default as unaryAxios } from 'axios';
import { Kafka } from 'kafkajs';
import express from 'express';
const kafka = new Kafka({});
let loopProducer = kafka.producer();
let unaryProducer = kafka.producer();
let loopConsumer = kafka.consumer({});
let unaryConsumer = kafka.consumer({});
let loopApp = express();
let unaryApp = express();
for (axios of [axios.get('https://valid.test/axios-loop-rhs')]) { axios.get('https://wrong.invalid/axios-loop-body'); }
for (fetch in { [String(fetch('https://valid.test/fetch-loop-rhs'))]: true }) { fetch('https://wrong.invalid/fetch-loop-body'); }
for (loopProducer of [loopProducer.send({ topic: 'valid.producer-loop-rhs', messages: [] })]) { loopProducer.send({ topic: 'wrong.producer-loop-body', messages: [] }); }
for (loopConsumer of [loopConsumer.subscribe({ topic: 'valid.consumer-loop-rhs' })]) { loopConsumer.subscribe({ topic: 'wrong.consumer-loop-body' }); }
for (loopApp of [loopApp.get('/valid-router-loop-rhs', () => undefined)]) { loopApp.get('/wrong-router-loop-body', () => undefined); }
void unaryAxios.get('https://valid.test/axios-unary-before');
unaryAxios.get++;
void unaryAxios.get('https://wrong.invalid/axios-unary-after');
void unaryProducer.send({ topic: 'valid.producer-unary-before', messages: [] });
unaryProducer.send++;
void unaryProducer.send({ topic: 'wrong.producer-unary-after', messages: [] });
void unaryConsumer.subscribe({ topic: 'valid.consumer-unary-before' });
++unaryConsumer.subscribe;
void unaryConsumer.subscribe({ topic: 'wrong.consumer-unary-after' });
unaryApp.get('/valid-router-unary-before', () => undefined);
++unaryApp.get;
unaryApp.get('/wrong-router-unary-after', () => undefined);
`);
      const identity = serviceIdentity(repo);
      const result = await tsExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      expect(result.nodes.filter((entry) => entry.kind === 'http_call').map((entry) => entry.name).sort()).toEqual([
        'GET valid.test/axios-loop-rhs',
        'GET valid.test/axios-unary-before',
        'GET valid.test/fetch-loop-rhs',
      ]);
      expect(result.nodes.filter((entry) => entry.kind === 'event_channel').map((entry) => entry.name).sort()).toEqual([
        'valid.consumer-loop-rhs',
        'valid.consumer-unary-before',
        'valid.producer-loop-rhs',
        'valid.producer-unary-before',
      ]);
      expect(result.nodes.filter((entry) => entry.kind === 'endpoint').map((entry) => entry.qualifiedName).sort()).toEqual([
        endpointQName(identity.id, 'GET', '/valid-router-loop-rhs'),
        endpointQName(identity.id, 'GET', '/valid-router-unary-before'),
      ].sort());
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('detaches and transfers reassigned access aliases without poisoning sibling roots', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ts-detached-alias-'));
    try {
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"detached-alias","dependencies":{"axios":"1.0.0","express":"1.0.0","kafkajs":"1.0.0"}}');
      fs.writeFileSync(path.join(repo, 'index.ts'), `
import axios from 'axios';
import express from 'express';
import { Kafka } from 'kafkajs';
let axiosAlias = axios;
axiosAlias = { get: () => undefined };
axiosAlias.get = () => undefined;
void axios.get('https://valid.test/original-axios');
let firstApp = express();
let secondApp = express();
let appAlias = firstApp;
appAlias = secondApp;
let laterAppAlias = appAlias;
laterAppAlias.get = (_route, callback) => callback();
firstApp.get('/valid-original-router', () => undefined);
secondApp.get('/wrong-transferred-router', () => undefined);
const kafka = new Kafka({});
let firstProducer = kafka.producer();
let secondProducer = kafka.producer();
let producerAlias = firstProducer;
producerAlias = secondProducer;
let laterProducerAlias = producerAlias;
laterProducerAlias.send = () => Promise.resolve([]);
void firstProducer.send({ topic: 'valid.original-producer', messages: [] });
void secondProducer.send({ topic: 'wrong.transferred-producer', messages: [] });
let replacedApp = express();
const retainedApp = replacedApp;
replacedApp = { get: (_route, callback) => callback() };
retainedApp.get('/valid-retained-router', () => undefined);
replacedApp.get('/wrong-replaced-router', () => undefined);
const holder = { router: express() };
const retainedPropertyApp = holder.router;
holder.router = { get: (_route, callback) => callback() };
retainedPropertyApp.get('/valid-retained-property-router', () => undefined);
holder.router.get('/wrong-replaced-property-router', () => undefined);
let factoryAssignedApp = { get: (_route, callback) => callback() };
factoryAssignedApp = express();
factoryAssignedApp.get('/valid-binding-factory-router', () => undefined);
const propertyFactoryHolder = { router: { get: (_route, callback) => callback() } };
propertyFactoryHolder.router = express();
propertyFactoryHolder.router.get('/valid-property-factory-router', () => undefined);
const propertyTransferSource = express();
const propertyTransferHolder = { router: { get: (_route, callback) => callback() } };
propertyTransferHolder.router = propertyTransferSource;
propertyTransferHolder.router.get('/valid-property-transfer-router', () => undefined);
propertyTransferSource.get = (_route, callback) => callback();
propertyTransferHolder.router.get('/wrong-property-transfer-source-mutated', () => undefined);
const inverseTransferSource = express();
const inverseTransferHolder = { router: { get: (_route, callback) => callback() } };
inverseTransferHolder.router = inverseTransferSource;
inverseTransferHolder.router.get = (_route, callback) => callback();
inverseTransferSource.get('/wrong-property-transfer-target-mutated', () => undefined);
let assignedProducer = { send: (_config) => Promise.resolve([]) };
assignedProducer = kafka.producer();
void assignedProducer.send({ topic: 'valid.assigned-producer', messages: [] });
let assignedConsumer = { subscribe: (_config) => Promise.resolve() };
assignedConsumer = kafka.consumer({});
void assignedConsumer.subscribe({ topic: 'valid.assigned-consumer' });
let assignmentResultApp = { get: (_route, callback) => callback() };
(assignmentResultApp = express()).get('/valid-assignment-result-router', () => undefined);
const assignmentResultHolder = { router: { get: (_route, callback) => callback() } };
(assignmentResultHolder.router = express()).get('/valid-property-assignment-result-router', () => undefined);
let assignmentResultProducer = { send: (_config) => Promise.resolve([]) };
void (assignmentResultProducer = kafka.producer()).send({ topic: 'valid.assignment-result-producer', messages: [] });
let assignmentResultConsumer = { subscribe: (_config) => Promise.resolve() };
void (assignmentResultConsumer = kafka.consumer({})).subscribe({ topic: 'valid.assignment-result-consumer' });
const mutatedAssignmentRouterSource = express();
mutatedAssignmentRouterSource.get = (_route, callback) => callback();
let mutatedAssignmentRouterAlias = express();
(mutatedAssignmentRouterAlias = mutatedAssignmentRouterSource).get('/wrong-mutated-assignment-result-router', () => undefined);
const deletedAssignmentRouterSource = express();
delete deletedAssignmentRouterSource.get;
let deletedAssignmentRouterAlias = express();
(deletedAssignmentRouterAlias = deletedAssignmentRouterSource).get('/wrong-deleted-assignment-result-router', () => undefined);
const mutatedAssignmentProducerSource = kafka.producer();
mutatedAssignmentProducerSource.send = (_config) => Promise.resolve([]);
let mutatedAssignmentProducerAlias = kafka.producer();
void (mutatedAssignmentProducerAlias = mutatedAssignmentProducerSource).send({ topic: 'wrong.mutated-assignment-result-producer', messages: [] });
const deletedAssignmentProducerSource = kafka.producer();
delete deletedAssignmentProducerSource.send;
let deletedAssignmentProducerAlias = kafka.producer();
void (deletedAssignmentProducerAlias = deletedAssignmentProducerSource).send({ topic: 'wrong.deleted-assignment-result-producer', messages: [] });
const mutatedAssignmentConsumerSource = kafka.consumer({});
mutatedAssignmentConsumerSource.subscribe = (_config) => Promise.resolve();
let mutatedAssignmentConsumerAlias = kafka.consumer({});
void (mutatedAssignmentConsumerAlias = mutatedAssignmentConsumerSource).subscribe({ topic: 'wrong.mutated-assignment-result-consumer' });
const deletedAssignmentConsumerSource = kafka.consumer({});
delete deletedAssignmentConsumerSource.subscribe;
let deletedAssignmentConsumerAlias = kafka.consumer({});
void (deletedAssignmentConsumerAlias = deletedAssignmentConsumerSource).subscribe({ topic: 'wrong.deleted-assignment-result-consumer' });
let chainedOuterApp = { get: (_route, callback) => callback() };
let chainedInnerApp = { get: (_route, callback) => callback() };
chainedOuterApp = chainedInnerApp = express();
chainedOuterApp.get('/valid-chained-outer-router', () => undefined);
chainedInnerApp.get('/valid-chained-inner-router', () => undefined);
let capturedAssignedApp = { get: (_route, callback) => callback() };
const capturedAssignmentApp = (capturedAssignedApp = express());
capturedAssignedApp.get('/valid-captured-assigned-router', () => undefined);
capturedAssignmentApp.get('/valid-captured-expression-router', () => undefined);
const chainedPropertyA = { router: { get: (_route, callback) => callback() } };
const chainedPropertyB = { router: { get: (_route, callback) => callback() } };
chainedPropertyA.router = chainedPropertyB.router = express();
chainedPropertyA.router.get('/valid-chained-property-a', () => undefined);
chainedPropertyB.router.get('/valid-chained-property-b', () => undefined);
let chainedOuterProducer = { send: (_config) => Promise.resolve([]) };
let chainedInnerProducer = { send: (_config) => Promise.resolve([]) };
chainedOuterProducer = chainedInnerProducer = kafka.producer();
void chainedOuterProducer.send({ topic: 'valid.chained-outer-producer', messages: [] });
void chainedInnerProducer.send({ topic: 'valid.chained-inner-producer', messages: [] });
let chainedOuterConsumer = { subscribe: (_config) => Promise.resolve() };
let chainedInnerConsumer = { subscribe: (_config) => Promise.resolve() };
chainedOuterConsumer = chainedInnerConsumer = kafka.consumer({});
void chainedOuterConsumer.subscribe({ topic: 'valid.chained-outer-consumer' });
void chainedInnerConsumer.subscribe({ topic: 'valid.chained-inner-consumer' });
let chainedResultAppA = { get: (_route, callback) => callback() };
let chainedResultAppB = { get: (_route, callback) => callback() };
(chainedResultAppA = chainedResultAppB = express()).get('/valid-chained-assignment-result-router', () => undefined);
let chainedResultProducerA = { send: (_config) => Promise.resolve([]) };
let chainedResultProducerB = { send: (_config) => Promise.resolve([]) };
void (chainedResultProducerA = chainedResultProducerB = kafka.producer()).send({ topic: 'valid.chained-assignment-result-producer', messages: [] });
let nestedProducerRoot = new Kafka({});
let nestedAssignmentProducer = { send: (_config) => Promise.resolve([]) };
void (nestedAssignmentProducer = (nestedProducerRoot = new Kafka({})).producer()).send({ topic: 'valid.nested-assignment-producer', messages: [] });
let nestedConsumerRoot = new Kafka({});
let nestedAssignmentConsumer = { subscribe: (_config) => Promise.resolve() };
void (nestedAssignmentConsumer = (nestedConsumerRoot = new Kafka({})).consumer({})).subscribe({ topic: 'valid.nested-assignment-consumer' });
const mutatedFactoryKafka = new Kafka({});
mutatedFactoryKafka.producer = () => ({ send: (_config) => Promise.resolve([]) });
void mutatedFactoryKafka.producer().send({ topic: 'wrong.mutated-kafka-factory', messages: [] });
const deletedFactoryKafka = new Kafka({});
delete deletedFactoryKafka.consumer;
void deletedFactoryKafka.consumer({}).subscribe({ topic: 'wrong.deleted-kafka-factory' });
const liveFactoryKafka = new Kafka({});
void liveFactoryKafka.producer().send({ topic: 'valid.live-kafka-factory-sibling', messages: [] });
const mutatedRouterFactoryHolder = { Router: express.Router };
mutatedRouterFactoryHolder.Router = () => ({ get: (_route, callback) => callback() });
mutatedRouterFactoryHolder.Router().get('/wrong-mutated-router-factory', () => undefined);
const deletedRouterFactoryHolder = { Router: express.Router };
delete deletedRouterFactoryHolder.Router;
deletedRouterFactoryHolder.Router().get('/wrong-deleted-router-factory', () => undefined);
const liveRouterFactoryNamespace = express;
liveRouterFactoryNamespace.Router().get('/valid-live-router-factory-sibling', () => undefined);
let unknownAssignmentResultApp = express();
(unknownAssignmentResultApp = { get: (_route, callback) => callback() }).get('/wrong-assignment-result-router', () => undefined);
let unknownAssignmentResultProducer = kafka.producer();
void (unknownAssignmentResultProducer = { send: (_config) => Promise.resolve([]) }).send({ topic: 'wrong.assignment-result-producer', messages: [] });
chainedOuterApp = chainedInnerApp = { get: (_route, callback) => callback() };
chainedOuterApp.get('/wrong-chained-outer-overwrite', () => undefined);
chainedInnerApp.get('/wrong-chained-inner-overwrite', () => undefined);
`);
      const identity = serviceIdentity(repo);
      const result = await tsExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      expect(result.nodes.filter((entry) => entry.kind === 'http_call').map((entry) => entry.name)).toEqual([
        'GET valid.test/original-axios',
      ]);
      expect(result.nodes.filter((entry) => entry.kind === 'endpoint').map((entry) => entry.qualifiedName)).toEqual([
        endpointQName(identity.id, 'GET', '/valid-original-router'),
        endpointQName(identity.id, 'GET', '/valid-retained-router'),
        endpointQName(identity.id, 'GET', '/valid-retained-property-router'),
        endpointQName(identity.id, 'GET', '/valid-binding-factory-router'),
        endpointQName(identity.id, 'GET', '/valid-property-factory-router'),
        endpointQName(identity.id, 'GET', '/valid-property-transfer-router'),
        endpointQName(identity.id, 'GET', '/valid-assignment-result-router'),
        endpointQName(identity.id, 'GET', '/valid-property-assignment-result-router'),
        endpointQName(identity.id, 'GET', '/valid-chained-outer-router'),
        endpointQName(identity.id, 'GET', '/valid-chained-inner-router'),
        endpointQName(identity.id, 'GET', '/valid-captured-assigned-router'),
        endpointQName(identity.id, 'GET', '/valid-captured-expression-router'),
        endpointQName(identity.id, 'GET', '/valid-chained-property-a'),
        endpointQName(identity.id, 'GET', '/valid-chained-property-b'),
        endpointQName(identity.id, 'GET', '/valid-chained-assignment-result-router'),
        endpointQName(identity.id, 'GET', '/valid-live-router-factory-sibling'),
      ]);
      expect(result.nodes.filter((entry) => entry.kind === 'event_channel').map((entry) => entry.name)).toEqual([
        'valid.original-producer',
        'valid.assigned-producer',
        'valid.assigned-consumer',
        'valid.assignment-result-producer',
        'valid.assignment-result-consumer',
        'valid.chained-outer-producer',
        'valid.chained-inner-producer',
        'valid.chained-outer-consumer',
        'valid.chained-inner-consumer',
        'valid.chained-assignment-result-producer',
        'valid.nested-assignment-producer',
        'valid.nested-assignment-consumer',
        'valid.live-kafka-factory-sibling',
      ]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('resolves ordered object config overrides before applying rejection tallies', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ts-object-config-order-'));
    try {
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"object-config-order","dependencies":{"axios":"1.0.0","kafkajs":"1.0.0"}}');
      fs.writeFileSync(path.join(repo, 'index.ts'), `
import axios from 'axios';
import { Kafka } from 'kafkajs';
const kafka = new Kafka({});
const producer = kafka.producer();
const consumer = kafka.consumer({});
void axios({ url: 'https://wrong.invalid/first-url', url: getUrl(), method: getMethod() });
void axios.request({ url: 'https://valid.test/dynamic-method', method: 'GET', method: getMethod() });
void fetch('https://valid.test/fetch-spread-after', { method: 'GET', ...getOptions() });
void axios({ ['url']: 'https://valid.test/computed', ['method']: 'POST' });
void axios({ ...getConfig(), url: 'https://valid.test/late-override', method: 'PUT' });
void fetch('https://valid.test/fetch-late-override', { ...getOptions(), method: 'PATCH' });
void axios({ get url() { return 'https://wrong.invalid/getter'; } });
void producer.send({ topic: 'wrong.first-topic', topic: getTopic(), messages: [] });
void consumer.subscribe({ topics: ['wrong.first-listen'], ...getConfig() });
void producer.send({ ...getConfig(), topic: 'valid.late-topic', messages: [] });
`);
      const result = await tsExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      expect(result.nodes.filter((entry) => entry.kind === 'http_call').map((entry) => entry.name).sort()).toEqual([
        'PATCH valid.test/fetch-late-override',
        'POST valid.test/computed',
        'PUT valid.test/late-override',
      ]);
      expect(result.nodes.filter((entry) => entry.kind === 'event_channel').map((entry) => entry.name)).toEqual([
        'valid.late-topic',
      ]);
      expect(result.contractSkips).toEqual({
        dynamic_http_url: 2,
        dynamic_http_method: 2,
        dynamic_http_route: 0,
        dynamic_event_channel: 2,
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not tally unrelated dynamic get-shaped calls as provider routes', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ts-unrelated-get-'));
    try {
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"ts-unrelated-get"}');
      fs.writeFileSync(path.join(repo, 'index.ts'), `
const key = getKey();
const values = new Map();
values.get(key);
const custom = { get(_key: unknown): unknown { return undefined; } };
custom.get(key);
const cache = { get(_key: unknown, fallback: string): string { return fallback; } };
cache.get(key, 'fallback');
const callbackCache = { get(_key: unknown, callback: () => void): void { callback(); } };
callbackCache.get(key, () => undefined);
callbackCache.get('/not-an-http-route', () => undefined);
interface Server { get(key: string, callback: () => void): void }
const typedCache: Server = callbackCache;
typedCache.get(key, () => undefined);
typedCache.get('/still-not-an-http-route', () => undefined);
interface App { get(key: string, callback: () => void): void }
const typedAppCache: App = callbackCache;
typedAppCache.get(key, () => undefined);
typedAppCache.get('/also-not-an-http-route', () => undefined);
`);
      const result = await tsExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      expect(result.nodes.filter((entry) => entry.kind === 'endpoint')).toHaveLength(0);
      expect(result.contractSkips).toEqual({
        dynamic_http_url: 0,
        dynamic_http_method: 0,
        dynamic_http_route: 0,
        dynamic_event_channel: 0,
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('accepts explicit local router types and imported Express/Fastify factories', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ts-router-provenance-'));
    try {
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"ts-router-provenance","dependencies":{"express":"1.0.0","fastify":"1.0.0"}}');
      fs.writeFileSync(path.join(repo, 'index.ts'), `
import express, { Router as ExpressRouter } from 'express';
import Fastify from 'fastify';
interface RouterLike {
  get(route: string, handler: () => void): void;
}
const router: RouterLike = { get(_route, _handler): void {} };
const expressApp = express();
const fastifyApp = Fastify();
function register(importedRouter: ExpressRouter): void {
  importedRouter.get('/parameter', () => undefined);
}
router.get('/local', () => undefined);
expressApp.get('/express', () => undefined);
fastifyApp.get('/fastify', () => undefined);
void register;
`);
      const identity = serviceIdentity(repo);
      const result = await tsExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      expect(result.nodes.filter((entry) => entry.kind === 'endpoint').map((entry) => entry.qualifiedName).sort()).toEqual([
        endpointQName(identity.id, 'GET', '/express'),
        endpointQName(identity.id, 'GET', '/fastify'),
        endpointQName(identity.id, 'GET', '/local'),
        endpointQName(identity.id, 'GET', '/parameter'),
      ].sort());
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('accepts namespace-import and CommonJS Express factories', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ts-router-module-provenance-'));
    try {
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"ts-router-module-provenance","dependencies":{"express":"1.0.0"}}');
      fs.writeFileSync(path.join(repo, 'namespace.ts'), `
import * as express from 'express';
const app = express();
app.get('/namespace-health', () => undefined);
`);
      fs.writeFileSync(path.join(repo, 'commonjs.js'), `
const express = require('express');
const app = express();
app.get('/commonjs-health', () => undefined);
const directApp = require('express')();
directApp.get('/direct-commonjs', () => undefined);
const directRouter = require('express').Router();
directRouter.get('/direct-router', () => undefined);
`);
      fs.writeFileSync(path.join(repo, 'reassigned.js'), `
let express = require('express');
express = () => ({ get: (_key, callback) => callback() });
const cache = express();
cache.get('/not-a-reassigned-router', () => undefined);
`);
      fs.writeFileSync(path.join(repo, 'shadowed.js'), `
function require(_module) {
  return () => ({ get: (_key, callback) => callback() });
}
const express = require('express');
const cache = express();
cache.get('/not-a-shadowed-require-router', () => undefined);
const dynamicModule = getModuleName();
const dynamicFactory = require(dynamicModule);
const dynamicCache = dynamicFactory();
dynamicCache.get('/not-a-dynamic-require-router', () => undefined);
`);
      const identity = serviceIdentity(repo);
      const result = await tsExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      const expected = [
        endpointQName(identity.id, 'GET', '/commonjs-health'),
        endpointQName(identity.id, 'GET', '/direct-commonjs'),
        endpointQName(identity.id, 'GET', '/direct-router'),
        endpointQName(identity.id, 'GET', '/namespace-health'),
      ].sort();
      expect(result.nodes.filter((entry) => entry.kind === 'endpoint').map((entry) => entry.qualifiedName).sort()).toEqual(expected);
      for (const endpoint of expected) {
        expect(result.edges.some((entry) => entry.relation === 'serves_route' && entry.to.qualifiedName === endpoint)).toBe(true);
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('propagates supported router provenance through properties, local type aliases, and value aliases', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ts-router-closure-'));
    try {
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"ts-router-closure","dependencies":{"express":"1.0.0"}}');
      fs.writeFileSync(path.join(repo, 'index.ts'), `
import express = require('express');
import type { Router as ExpressRouter } from 'express';
type Handler = () => void;
type RouterLike = { get(route: string, handler: Handler): void };
const app = express();
app.get('/import-equals', () => undefined);
const mounted = app;
mounted.get('/receiver-alias', () => undefined);
const router: RouterLike = { get(_route, _handler): void {} };
router.get('/local-type-alias', () => undefined);
class Controller {
  router: ExpressRouter = express.Router();
  register(): void {
    this.router.get('/class-field', () => undefined);
  }
}
void Controller;
`);
      const identity = serviceIdentity(repo);
      const result = await tsExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      expect(result.nodes.filter((entry) => entry.kind === 'endpoint').map((entry) => entry.qualifiedName).sort()).toEqual([
        endpointQName(identity.id, 'GET', '/class-field'),
        endpointQName(identity.id, 'GET', '/import-equals'),
        endpointQName(identity.id, 'GET', '/local-type-alias'),
        endpointQName(identity.id, 'GET', '/receiver-alias'),
      ].sort());
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('propagates router provenance through object properties, destructuring, and inline factories', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ts-router-property-closure-'));
    try {
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"ts-router-property-closure","dependencies":{"express":"1.0.0","fastify":"1.0.0"}}');
      fs.writeFileSync(path.join(repo, 'index.ts'), `
import express from 'express';
import Fastify from 'fastify';
const services = { router: express.Router(), app: Fastify() };
services.router.get('/object-router', () => undefined);
services.app.get('/object-fastify', () => undefined);
const { router: destructuredRouter } = services;
destructuredRouter.get('/destructured-router', () => undefined);
const nested = { services };
const { services: { router: nestedRouter } } = nested;
nestedRouter.get('/nested-destructured-router', () => undefined);
const receivers = [express.Router()];
const [arrayRouter] = receivers;
arrayRouter.get('/array-destructured-router', () => undefined);
const primary = express.Router();
const shorthand = { primary };
shorthand.primary.get('/shorthand-router', () => undefined);
class FactoryHolder {
  factory = express;
  app = this.factory();
  register(): void {
    this.app.get('/property-factory', () => undefined);
  }
}
express().get('/inline-express', () => undefined);
Fastify().get('/inline-fastify', () => undefined);
const bracket = { router: express.Router(), fastify: Fastify() };
bracket['router'].get('/element-express', () => undefined);
bracket['fastify'].get('/element-fastify', () => undefined);
const computed = { ['router']: express.Router(), ['fastify']: Fastify() };
computed.router.get('/computed-express', () => undefined);
computed.fastify.get('/computed-fastify', () => undefined);
const overwritten = { router: express.Router(), fastify: Fastify() };
overwritten['router'] = { get: (_key, callback) => callback() };
overwritten['fastify'] = { get: (_key, callback) => callback() };
overwritten.router.get('/not-an-element-express-router', () => undefined);
overwritten.fastify.get('/not-an-element-fastify-router', () => undefined);
const dynamicWrite = { router: express.Router(), fastify: Fastify() };
const dynamicKey = getDynamicKey();
dynamicWrite[dynamicKey] = { get: (_key, callback) => callback() };
dynamicWrite.router.get('/not-a-dynamic-element-express-router', () => undefined);
dynamicWrite.fastify.get('/not-a-dynamic-element-fastify-router', () => undefined);
void FactoryHolder;
`);
      const identity = serviceIdentity(repo);
      const result = await tsExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      expect(result.nodes.filter((entry) => entry.kind === 'endpoint').map((entry) => entry.qualifiedName).sort()).toEqual([
        endpointQName(identity.id, 'GET', '/array-destructured-router'),
        endpointQName(identity.id, 'GET', '/computed-express'),
        endpointQName(identity.id, 'GET', '/computed-fastify'),
        endpointQName(identity.id, 'GET', '/destructured-router'),
        endpointQName(identity.id, 'GET', '/element-express'),
        endpointQName(identity.id, 'GET', '/element-fastify'),
        endpointQName(identity.id, 'GET', '/inline-express'),
        endpointQName(identity.id, 'GET', '/inline-fastify'),
        endpointQName(identity.id, 'GET', '/object-fastify'),
        endpointQName(identity.id, 'GET', '/object-router'),
        endpointQName(identity.id, 'GET', '/nested-destructured-router'),
        endpointQName(identity.id, 'GET', '/property-factory'),
        endpointQName(identity.id, 'GET', '/shorthand-router'),
      ].sort());
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('preserves Express and Fastify provenance through transparent receiver wrappers', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ts-router-wrappers-'));
    try {
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"ts-router-wrappers","dependencies":{"express":"1.0.0","fastify":"1.0.0"}}');
      fs.writeFileSync(path.join(repo, 'index.ts'), `
import express, { Router as ExpressRouter } from 'express';
import Fastify, { FastifyInstance } from 'fastify';
const expressApp = express();
(expressApp).get('/paren-express', () => undefined);
(expressApp as ExpressRouter).get('/as-express', () => undefined);
(<ExpressRouter>expressApp).get('/type-assertion-express', () => undefined);
expressApp!.get('/non-null-express', () => undefined);
(expressApp satisfies ExpressRouter).get('/satisfies-express', () => undefined);
const fastifyApp = Fastify();
(fastifyApp).get('/paren-fastify', () => undefined);
(fastifyApp as FastifyInstance).get('/as-fastify', () => undefined);
(<FastifyInstance>fastifyApp).get('/type-assertion-fastify', () => undefined);
fastifyApp!.get('/non-null-fastify', () => undefined);
(fastifyApp satisfies FastifyInstance).get('/satisfies-fastify', () => undefined);
const holders = { express: express(), fastify: Fastify() };
(holders.express as ExpressRouter).get('/property-wrapper-express', () => undefined);
(holders['fastify'] as FastifyInstance).get('/element-wrapper-fastify', () => undefined);
(express() as ExpressRouter).get('/factory-wrapper-express', () => undefined);
(Fastify() as FastifyInstance).get('/factory-wrapper-fastify', () => undefined);
let replacedExpress = express();
(replacedExpress) = { get: (_route, callback) => callback() } as unknown as ExpressRouter;
(replacedExpress as ExpressRouter).get('/not-a-wrapped-express-router', () => undefined);
let replacedFastify = Fastify();
(replacedFastify) = { get: (_route, callback) => callback() } as unknown as FastifyInstance;
(replacedFastify as FastifyInstance).get('/not-a-wrapped-fastify-router', () => undefined);
`);
      const identity = serviceIdentity(repo);
      const result = await tsExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      expect(result.nodes.filter((entry) => entry.kind === 'endpoint').map((entry) => entry.qualifiedName).sort()).toEqual([
        endpointQName(identity.id, 'GET', '/as-express'),
        endpointQName(identity.id, 'GET', '/as-fastify'),
        endpointQName(identity.id, 'GET', '/element-wrapper-fastify'),
        endpointQName(identity.id, 'GET', '/factory-wrapper-express'),
        endpointQName(identity.id, 'GET', '/factory-wrapper-fastify'),
        endpointQName(identity.id, 'GET', '/non-null-express'),
        endpointQName(identity.id, 'GET', '/non-null-fastify'),
        endpointQName(identity.id, 'GET', '/paren-express'),
        endpointQName(identity.id, 'GET', '/paren-fastify'),
        endpointQName(identity.id, 'GET', '/property-wrapper-express'),
        endpointQName(identity.id, 'GET', '/satisfies-express'),
        endpointQName(identity.id, 'GET', '/satisfies-fastify'),
        endpointQName(identity.id, 'GET', '/type-assertion-express'),
        endpointQName(identity.id, 'GET', '/type-assertion-fastify'),
      ].sort());
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('invalidates overwritten and deleted Express and Fastify route methods', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ts-router-method-writes-'));
    try {
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"ts-router-method-writes","dependencies":{"express":"1.0.0","fastify":"1.0.0"}}');
      fs.writeFileSync(path.join(repo, 'index.ts'), `
import express from 'express';
import Fastify from 'fastify';
const expressDot = express();
expressDot.get = (_route, callback) => { callback(); return expressDot; };
expressDot.get('/not-an-express-dot-route', () => undefined);
const expressStatic = express();
expressStatic['get'] = (_route, callback) => { callback(); return expressStatic; };
expressStatic.get('/not-an-express-static-route', () => undefined);
const expressDynamic = express();
const expressKey = getExpressKey();
expressDynamic[expressKey] = (_route, callback) => { callback(); return expressDynamic; };
expressDynamic.get('/not-an-express-dynamic-route', () => undefined);
const expressDeleted = express();
delete expressDeleted.get;
expressDeleted.get('/not-an-express-deleted-route', () => undefined);
const fastifyDot = Fastify();
fastifyDot.get = (_route, callback) => { callback(); return fastifyDot; };
fastifyDot.get('/not-a-fastify-dot-route', () => undefined);
const fastifyStatic = Fastify();
fastifyStatic['get'] = (_route, callback) => { callback(); return fastifyStatic; };
fastifyStatic.get('/not-a-fastify-static-route', () => undefined);
const fastifyDynamic = Fastify();
const fastifyKey = getFastifyKey();
fastifyDynamic[fastifyKey] = (_route, callback) => { callback(); return fastifyDynamic; };
fastifyDynamic.get('/not-a-fastify-dynamic-route', () => undefined);
const fastifyDeleted = Fastify();
delete fastifyDeleted.get;
fastifyDeleted.get('/not-a-fastify-deleted-route', () => undefined);
`);
      const result = await tsExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      expect(result.nodes.filter((entry) => entry.kind === 'endpoint').map((entry) => entry.qualifiedName)).toEqual([]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps an untouched route method when another method is overwritten', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ts-router-method-control-'));
    try {
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"ts-router-method-control","dependencies":{"express":"1.0.0","fastify":"1.0.0"}}');
      fs.writeFileSync(path.join(repo, 'index.ts'), `
import express from 'express';
import Fastify from 'fastify';
const expressApp = express();
expressApp.get = (_route, callback) => { callback(); return expressApp; };
expressApp.post('/untouched-express-post', () => undefined);
const fastifyApp = Fastify();
fastifyApp.get = (_route, callback) => { callback(); return fastifyApp; };
fastifyApp.post('/untouched-fastify-post', () => undefined);
`);
      const identity = serviceIdentity(repo);
      const result = await tsExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      expect(result.nodes.filter((entry) => entry.kind === 'endpoint').map((entry) => entry.qualifiedName).sort()).toEqual([
        endpointQName(identity.id, 'POST', '/untouched-express-post'),
        endpointQName(identity.id, 'POST', '/untouched-fastify-post'),
      ].sort());
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('scopes route-member invalidation to the mutated runtime receiver path', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ts-router-instance-paths-'));
    try {
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"ts-router-instance-paths","dependencies":{"express":"1.0.0"}}');
      fs.writeFileSync(path.join(repo, 'index.ts'), `
import express from 'express';
interface AppLike {
  get(route: string, handler: () => void): void;
}
const firstTyped: AppLike = express();
const secondTyped: AppLike = express();
firstTyped.get('/valid-before-first-typed', () => undefined);
firstTyped.get = (_route, callback) => callback();
firstTyped.get('/not-first-typed', () => undefined);
secondTyped.get('/valid-second-typed', () => undefined);
const firstBracket: AppLike = express();
const secondBracket: AppLike = express();
firstBracket['get'] = (_route, callback) => callback();
firstBracket.get('/not-first-bracket', () => undefined);
secondBracket.get('/valid-second-bracket', () => undefined);
const firstDeleted: AppLike = express();
const secondDeleted: AppLike = express();
delete firstDeleted.get;
firstDeleted.get('/not-first-deleted', () => undefined);
secondDeleted.get('/valid-second-deleted', () => undefined);
class Controller {
  router = express();
}
const firstController = new Controller();
const secondController = new Controller();
firstController.router.get = (_route, callback) => callback();
firstController.router.get('/not-first-controller-method', () => undefined);
secondController.router.get('/valid-second-controller-method', () => undefined);
const thirdController = new Controller();
const fourthController = new Controller();
thirdController.router = { get: (_route, callback) => callback() } as typeof thirdController.router;
thirdController.router.get('/not-third-controller-router', () => undefined);
fourthController.router.get('/valid-fourth-controller-router', () => undefined);
const directAliasHolder = { router: express.Router() };
const directAliasSibling = { router: express.Router() };
const directAlias = directAliasHolder.router;
directAlias.get('/valid-before-direct-alias', () => undefined);
delete directAlias.get;
directAliasHolder.router.get('/not-direct-alias-holder', () => undefined);
directAliasSibling.router.get('/valid-direct-alias-sibling', () => undefined);
const destructuredHolder = { router: express.Router() };
const destructuredSibling = { router: express.Router() };
const { router: destructuredAlias } = destructuredHolder;
destructuredHolder.router.get = (_route, callback) => callback();
destructuredAlias.get('/not-destructured-alias', () => undefined);
destructuredSibling.router.get('/valid-destructured-sibling', () => undefined);
const nestedHolder = { nested: { router: express.Router() } };
const nestedSibling = { nested: { router: express.Router() } };
const nestedAlias = nestedHolder.nested;
nestedAlias.router.get = (_route, callback) => callback();
nestedHolder.nested.router.get('/not-nested-alias-holder', () => undefined);
nestedSibling.nested.router.get('/valid-nested-alias-sibling', () => undefined);
let replacedRoot = { router: express.Router() };
replacedRoot.router.get('/valid-before-replaced-root', () => undefined);
replacedRoot = { router: { get: (_route, callback) => callback() } as typeof replacedRoot.router };
replacedRoot.router.get('/not-replaced-root', () => undefined);
const rootSibling = { router: express.Router() };
rootSibling.router.get('/valid-root-sibling', () => undefined);
`);
      const identity = serviceIdentity(repo);
      const result = await tsExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      expect(result.nodes.filter((entry) => entry.kind === 'endpoint').map((entry) => entry.qualifiedName).sort()).toEqual([
        endpointQName(identity.id, 'GET', '/valid-before-direct-alias'),
        endpointQName(identity.id, 'GET', '/valid-before-first-typed'),
        endpointQName(identity.id, 'GET', '/valid-before-replaced-root'),
        endpointQName(identity.id, 'GET', '/valid-fourth-controller-router'),
        endpointQName(identity.id, 'GET', '/valid-destructured-sibling'),
        endpointQName(identity.id, 'GET', '/valid-direct-alias-sibling'),
        endpointQName(identity.id, 'GET', '/valid-nested-alias-sibling'),
        endpointQName(identity.id, 'GET', '/valid-root-sibling'),
        endpointQName(identity.id, 'GET', '/valid-second-bracket'),
        endpointQName(identity.id, 'GET', '/valid-second-controller-method'),
        endpointQName(identity.id, 'GET', '/valid-second-deleted'),
        endpointQName(identity.id, 'GET', '/valid-second-typed'),
      ].sort());
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

const node = (kind: string, qn: string) => out.nodes.find((n) => n.kind === kind && n.qualifiedName === qn);
const edge = (rel: string, fromQn: string, toQn: string) =>
  out.edges.find((e) => e.relation === rel && e.from.qualifiedName === fromQn && e.to.qualifiedName === toQn);

describe('ts extractor', () => {
  it('emits file nodes with content hashes', () => {
    const f = node('file', UTIL);
    expect(f).toBeDefined();
    expect(f?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(node('file', SERVER)).toBeDefined();
  });

  it('emits function nodes with defines + exports edges', () => {
    const fn = node('function', `${UTIL}#add`);
    expect(fn).toBeDefined();
    expect(fn?.signature).toContain('add(a: number, b: number)');
    expect(edge('defines', UTIL, `${UTIL}#add`)).toBeDefined();
    expect(edge('exports', UTIL, `${UTIL}#add`)).toBeDefined();
  });

  it('classifies PascalCase declarations in JSX files as components', () => {
    expect(node('component', `${CARD}#Card`)).toBeDefined();
  });

  it('resolves relative imports to file→file edges', () => {
    expect(edge('imports', SERVER, UTIL)).toBeDefined();
  });

  it('detects route registrations as endpoint nodes + serves_route', () => {
    const endpoint = endpointQName(IDENTITY.id, 'GET', '/health');
    expect(node('endpoint', endpoint)).toBeDefined();
    expect(edge('serves_route', SERVER, endpoint)).toBeDefined();
  });

  it('detects .from() table references as extracted', () => {
    const e = edge('references_table', SERVER, 'public.workouts');
    expect(e).toBeDefined();
    expect(e?.confidence).toBe('extracted');
  });

  it('detects SQL-in-literal table references as inferred', () => {
    const logs = edge('references_table', SERVER, 'public.exercise_logs');
    const users = edge('references_table', SERVER, 'public.users');
    expect(logs?.confidence).toBe('inferred');
    expect(users?.confidence).toBe('inferred');
  });

  it('maps Expo Router files to ROUTE endpoints', () => {
    const root = endpointQName(IDENTITY.id, 'ANY', '/');
    const profile = endpointQName(IDENTITY.id, 'ANY', '/profile/{}');
    expect(node('endpoint', root)).toBeDefined();
    expect(node('endpoint', profile)).toBeDefined();
    expect(edge('serves_route', PROFILE, profile)).toBeDefined();
  });

  it('normalizes Expo single and catch-all segments with exact matcher cardinality', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-expo-contract-'));
    try {
      fs.mkdirSync(path.join(repo, 'app', 'users'), { recursive: true });
      fs.mkdirSync(path.join(repo, 'app', 'files'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"expo-contract","dependencies":{"expo-router":"1.0.0"}}');
      fs.writeFileSync(path.join(repo, 'app', 'users', '[id].tsx'), 'export default function User(): null { return null; }\n');
      fs.writeFileSync(path.join(repo, 'app', 'files', '[...slug].tsx'), 'export default function File(): null { return null; }\n');
      const identity = serviceIdentity(repo);
      const result = await tsExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      expect(result.nodes.some((entry) => entry.qualifiedName === endpointQName(identity.id, 'ANY', '/users/{}'))).toBe(true);
      expect(result.nodes.some((entry) => entry.qualifiedName === endpointQName(identity.id, 'ANY', '/files/{**}'))).toBe(true);
      expect(routeMatches('/users/{}', '/users/42')).toBe(true);
      expect(routeMatches('/users/{}', '/users/a/b')).toBe(false);
      expect(routeMatches('/files/{**}', '/files/a')).toBe(true);
      expect(routeMatches('/files/{**}', '/files/a/b')).toBe(true);
      expect(routeMatches('/files/{**}', '/files')).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
