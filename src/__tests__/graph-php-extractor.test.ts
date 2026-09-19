/** php extractor over the committed wp-plugin fixture — pure, no DB. */
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { endpointQName, serviceIdentity, serviceSourceQName } from '../graph/contracts.js';
import { phpExtractor } from '../graph/extractors/php.js';
import { NODE_KINDS, GRAPH_RELATIONS, SHARED_KINDS } from '../graph/registry.js';
import type { ExtractorOutput } from '../graph/types.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'wp-plugin');
const CROSS_FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cross-service', 'php-api');
const IDENTITY = serviceIdentity(FIXTURE);
const SOURCE_BASE = serviceSourceQName(IDENTITY.id, 'wp-plugin');
const sourceFile = (rel: string): string => `${SOURCE_BASE}/${rel}`;
const sourceSymbol = (name: string): string => `${SOURCE_BASE}#${name}`;

let out: ExtractorOutput;
let crossOut: ExtractorOutput;

beforeAll(async () => {
  out = await phpExtractor.extract({ projectId: 'unused', repoPaths: [FIXTURE] });
  crossOut = await phpExtractor.extract({ projectId: 'unused', repoPaths: [CROSS_FIXTURE] });
});

const node = (kind: string, qn: string) => out.nodes.find((n) => n.kind === kind && n.qualifiedName === qn);
const edge = (rel: string, fromQn: string, toQn: string) =>
  out.edges.find((e) => e.relation === rel && e.from.qualifiedName === fromQn && e.to.qualifiedName === toQn);
const edgesTo = (rel: string, toQn: string) => out.edges.filter((e) => e.relation === rel && e.to.qualifiedName === toQn);

const SVC = sourceFile('core/tip-service.php');
const LISTENERS = sourceFile('modules/listeners.php');
const CLS = sourceSymbol('AcmeShop\\Core\\TipService');

describe('php extractor — language structure', () => {
  it('emits file nodes with a content hash', () => {
    const f = node('file', SVC);
    expect(f).toBeDefined();
    expect(f?.lang).toBe('php');
    expect(f?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('emits repo-scoped class and method nodes with defines edges', () => {
    expect(node('class', CLS)).toBeDefined();
    expect(node('function', `${CLS}::boot`)).toBeDefined();
    expect(edge('defines', SVC, CLS)).toBeDefined();
    expect(edge('defines', CLS, `${CLS}::boot`)).toBeDefined();
  });

  it('emits global function nodes', () => {
    expect(node('function', sourceSymbol('ww_free_fn'))).toBeDefined();
  });

  it('emits a cross-file inherits edge for extends, subclass → superclass', () => {
    // POSITIVE assertion, and deliberately cross-file: BaseService is declared in
    // core/base-service.php, TipService in core/tip-service.php. This is also the
    // ONLY coverage of resolveDeferred's non-inverted branch (ref.member ===
    // undefined), which nothing else reaches.
    expect(edge('inherits', CLS, sourceSymbol('AcmeShop\\Core\\BaseService'))).toBeDefined();
  });

  it('emits an inherits edge for implements', () => {
    expect(edge('inherits', CLS, sourceSymbol('AcmeShop\\Core\\Jsonable'))).toBeDefined();
  });

  it('does not invent an inherits edge for a type declared nowhere', () => {
    expect(edge('inherits', CLS, sourceSymbol('AcmeShop\\Core\\NotDeclaredAnywhere'))).toBeUndefined();
  });

  it('resolves require_once to an imports edge', () => {
    expect(edge('imports', SVC, sourceFile('core/helper.php'))).toBeDefined();
  });
});

describe('php extractor — hook graph', () => {
  it('emits one hook node that both directions meet at', () => {
    expect(node('hook', 'hook:acmeshop_tip_paid')).toBeDefined();
    expect(edge('fires', SVC, 'hook:acmeshop_tip_paid')).toBeDefined();
    expect(edgesTo('listens_to', 'hook:acmeshop_tip_paid').length).toBeGreaterThanOrEqual(3);
  });

  it('resolves [$this, method] callbacks — the 95% case', () => {
    expect(edge('listens_to', `${CLS}::boot`, 'hook:init')).toBeDefined();
  });

  it('resolves [self::class, method] callbacks', () => {
    expect(edge('listens_to', `${CLS}::filter_fields`, 'hook:woo_fields')).toBeDefined();
  });

  it('resolves a cross-file [Foo::class, m] callback — R2 regression guard', () => {
    // File-scoped qualified names would make this unresolvable, silently.
    expect(edge('listens_to', sourceSymbol('Cart_Recovery::notify'), 'hook:acmeshop_tip_paid')).toBeDefined();
  });

  it('resolves a plain string function callback declared in a LATER-sorting file', () => {
    // Ordering regression guard. `git ls-files` is byte-sorted, so
    // modules/listeners.php (the registration) is walked BEFORE
    // modules/recovery.php (the declaration of ww_free_fn). Resolving this
    // inline during the walk finds an empty index and silently emits nothing;
    // only deferred resolution produces this edge.
    expect(edge('listens_to', sourceSymbol('ww_free_fn'), 'hook:acmeshop_tip_paid')).toBeDefined();
  });

  it('resolves a named-class callback through a `use … as` alias', () => {
    // Covers resolveClassName's alias branch — R5's primary mechanism, which
    // no other fixture reaches.
    expect(edge('listens_to', sourceSymbol('AcmeShop\\Lib\\Helper::format'), 'hook:acmeshop_aliased')).toBeDefined();
  });

  it('reads double-quoted callback method names', () => {
    // array( Aliased::class, "format" ) — a double-quoted literal is an
    // encapsed_string, not a string, so a `string`-only reader misses it.
    const e = edge('listens_to', sourceSymbol('AcmeShop\\Lib\\Helper::format'), 'hook:acmeshop_aliased');
    expect(e).toBeDefined();
  });

  it("resolves a 'Class::method' string callback", () => {
    expect(edge('listens_to', sourceSymbol('AcmeShop\\Lib\\Helper::format'), 'hook:acmeshop_str_method')).toBeDefined();
  });

  it("resolves an array( 'Ns\\Class', 'method' ) string-class callback", () => {
    expect(edge('listens_to', sourceSymbol('AcmeShop\\Lib\\Helper::format'), 'hook:acmeshop_arr_string')).toBeDefined();
  });

  it('extracts from a mixed HTML/PHP view template', () => {
    // The HTML-aware grammar was chosen over php_only for exactly this file
    // shape; without a fixture the choice is untested.
    expect(node('file', sourceFile('views/tip-box.php'))).toBeDefined();
    expect(edge('listens_to', sourceSymbol('ww_free_fn'), 'hook:acmeshop_view_rendered')).toBeDefined();
  });

  it('reads a root-qualified \\add_action call', () => {
    // \add_action parses its callee as qualified_name, not name.
    expect(node('hook', 'hook:acmeshop_aliased')).toBeDefined();
  });

  it('attributes a closure callback to its file', () => {
    expect(edge('listens_to', LISTENERS, 'hook:acmeshop_tip_paid')).toBeDefined();
  });

  it('resolves an unimported short name via the fallback index, marked inferred', () => {
    // R5's SUCCESSFUL fallback branch. Solo is declared in AcmeShop\\Solo and
    // referenced from modules/listeners.php with no `use` import, so only the
    // repo-wide short-name index can resolve it — and the edge must be
    // downgraded to `inferred`, not claimed as `extracted`.
    const e = edge('listens_to', sourceSymbol('AcmeShop\\Solo\\Solo::handle'), 'hook:acmeshop_solo');
    expect(e).toBeDefined();
    expect(e?.confidence).toBe('inferred');
  });

  it('does not invent an edge for a variable callback or an ambiguous short name', () => {
    // $dynamic_callback and array('Dup','go') — Dup exists in two namespaces.
    const bogus = out.edges.filter(
      (e) => e.relation === 'listens_to' && e.from.qualifiedName.includes('Dup')
    );
    expect(bogus).toHaveLength(0);
  });

  it('renders a dynamic hook name as a template with inferred confidence', () => {
    const h = node('hook', 'hook:acmeshop_{$}_settled');
    expect(h).toBeDefined();
    expect(edge('fires', SVC, 'hook:acmeshop_{$}_settled')?.confidence).toBe('inferred');
  });
});

describe('php extractor — WordPress surfaces', () => {
  it('emits REST route endpoints', () => {
    const endpoint = endpointQName(IDENTITY.id, 'ANY', '/acmeshop/v1/tip');
    expect(node('endpoint', endpoint)).toBeDefined();
    expect(edge('serves_route', SVC, endpoint)).toBeDefined();
  });

  it('promotes wp_ajax_* hooks to endpoints as well as hooks', () => {
    expect(node('hook', 'hook:wp_ajax_acmeshop_tip')).toBeDefined();
    expect(node('endpoint', 'route:wp-ajax/acmeshop_tip')).toBeDefined();
  });

  it('reads the admin page slug by known index, not by shape', () => {
    // add_menu_page slug is at index 3; index 2 is the CAPABILITY. A shape scan
    // starting at 2 returns 'manage_options' and collapses every admin page in
    // the repo into one node.
    expect(node('endpoint', 'route:wp-admin/admin.php?page=acmeshop-tips')).toBeDefined();
    expect(node('endpoint', 'route:wp-admin/admin.php?page=manage_options')).toBeUndefined();
  });

  it('reads the add_submenu_page slug at index 4 past __()-wrapped titles', () => {
    expect(node('endpoint', 'route:wp-admin/admin.php?page=acmeshop-sub')).toBeDefined();
  });

  it('reads double-quoted asset handles and $deps entries', () => {
    expect(node('asset', 'asset:acmeshop-alias-js')).toBeDefined();
    expect(edge('depends_on', 'asset:acmeshop-alias-js', 'asset:jquery')).toBeDefined();
  });

  it('ignores ->query on a receiver that is not $wpdb', () => {
    // $logger->query("... {$wpdb->prefix}not_a_table ...") must NOT produce a
    // table edge — dispatching on the method name alone would attribute it.
    expect(out.edges.find((e) => e.to.qualifiedName === 'wptable:not_a_table')).toBeUndefined();
  });

  it('emits cron scheduled_job wired to its hook', () => {
    expect(node('scheduled_job', 'cron:acmeshop_cron')).toBeDefined();
    expect(edge('scheduled_by', 'hook:acmeshop_cron', 'cron:acmeshop_cron')).toBeDefined();
  });

  it('emits a shortcode node', () => {
    expect(node('shortcode', 'shortcode:acmeshop_tips')).toBeDefined();
  });

  it('emits option read and write edges', () => {
    expect(node('option', 'option:acmeshop_settings')).toBeDefined();
    expect(edge('reads_option', SVC, 'option:acmeshop_settings')).toBeDefined();
    expect(edge('writes_option', SVC, 'option:acmeshop_settings')).toBeDefined();
  });

  it('reaches $role->add_cap through the member-call path', () => {
    // Regression guard: restricting member calls to a $wpdb receiver made the
    // entire add_cap surface dead code.
    expect(node('capability', 'cap:manage_acmeshop_delivery')).toBeDefined();
  });

  it('emits a wp_table node, not a db-owned table node', () => {
    // R8: PHP cannot know the physical table name ($wpdb->prefix is
    // install-configurable) and the db extractor speaks PostgreSQL and MySQL
    // (plan 34), but never THIS install's DB.
    expect(node('wp_table', 'wptable:acmeshop_tips')).toBeDefined();
    expect(out.nodes.filter((n) => n.kind === 'table')).toHaveLength(0);
    expect(edge('references_table', SVC, 'wptable:acmeshop_tips')).toBeDefined();
  });

  it('resolves a self::CONST REST namespace — R13', () => {
    // 27 of AcmeShop's 31 register_rest_route sites pass self::REST_NAMESPACE.
    // A literal-only reader emits NO rest endpoint for any of them.
    expect(node('endpoint', endpointQName(IDENTITY.id, 'ANY', '/acmeshop/v1/points'))).toBeDefined();
  });

  it('resolves a self::CONST declared AFTER the method that reads it — R13', () => {
    // Late_Cron::CRON_HOOK is declared below boot(). This is the assertion that
    // forces a pre-scan: collecting constants inline during the walk finds an
    // empty table at this call site and emits nothing.
    expect(node('scheduled_job', 'cron:acmeshop_points_expiry')).toBeDefined();
  });

  it('does NOT resolve a cross-class Foo::CONST — the documented R13 boundary', () => {
    // Deliberate (decision 5e04ea93): the value would have to be deferred, and a
    // deferred value cannot build a node's qualifiedName. Skipped and tallied.
    expect(node('hook', 'hook:acmeshop_cross_class_hook')).toBeUndefined();
  });

  it('emits a capability secured_by edge', () => {
    expect(node('capability', 'cap:manage_acmeshop')).toBeDefined();
    expect(edge('secured_by', SVC, 'cap:manage_acmeshop')).toBeDefined();
  });

  it('emits asset nodes and a dependency edge', () => {
    expect(node('asset', 'asset:acmeshop-admin')).toBeDefined();
    expect(edge('depends_on', 'asset:acmeshop-admin', 'asset:jquery')).toBeDefined();
  });

  it('marks the $wpdb edge inferred — the prefix is not statically knowable', () => {
    expect(edge('references_table', SVC, 'wptable:acmeshop_tips')?.confidence).toBe('inferred');
  });
});

describe('php extractor — invariants', () => {
  it('rendezvous nodes carry no filePath — R7 guard', () => {
    const rendezvous = out.nodes.filter((n) =>
      ['hook', 'option', 'capability', 'shortcode', 'asset', 'wp_table'].includes(n.kind)
    );
    expect(rendezvous.length).toBeGreaterThan(0);
    for (const n of rendezvous) {
      expect(n.filePath, `${n.kind} ${n.qualifiedName} must not be file-owned`).toBeUndefined();
      expect(n.line).toBeUndefined();
    }
  });

  it('never emits a node with an empty name', () => {
    // add_action('', …) in the fixture. engine.ts:54 throws on an empty name and
    // aborts the WHOLE multi-extractor build, so this must be filtered at the
    // reader, not discovered at insert time.
    for (const n of out.nodes) {
      expect(n.name.trim(), `empty name on ${n.kind} ${n.qualifiedName}`).not.toBe('');
      expect(n.qualifiedName.trim()).not.toBe('');
    }
  });

  it('every rendezvous kind is a member of SHARED_KINDS', () => {
    for (const kind of ['hook', 'option', 'capability', 'shortcode', 'asset', 'wp_table']) {
      expect(SHARED_KINDS.has(kind), `${kind} must be splice-exempt`).toBe(true);
    }
  });

  it('tags nodes from tests/ paths and leaves production nodes untagged', () => {
    const testCls = node('class', sourceSymbol('AcmeShop\\Tests\\TipServiceTest'));
    expect(testCls?.metadata).toMatchObject({ test: true });
    expect(node('class', CLS)?.metadata).not.toMatchObject({ test: true });
  });

  it('does not attribute anonymous-class members to the enclosing class — A1', () => {
    // new class {…} in modules/anon.php declares missing_handler and const K.
    // Attributing either to Wrapper fabricates a method Wrapper does not have
    // (which then satisfies the methodQns existence check) and resolves a
    // self::K the named class never declared.
    expect(node('function', sourceSymbol('AcmeShop\\Anon\\Wrapper::missing_handler'))).toBeUndefined();
    expect(
      edge('listens_to', sourceSymbol('AcmeShop\\Anon\\Wrapper::missing_handler'), 'hook:acmeshop_anon_evt')
    ).toBeUndefined();
    expect(node('scheduled_job', 'cron:acmeshop_should_not_leak')).toBeUndefined();
  });

  it('tags file-owned WP surface nodes from tests/ paths — R9 regression guard (A2)', () => {
    // fileOwnedMeta reaches endpoint and scheduled_job producers; losing it in
    // any one handler previously had no failing test.
    expect(node('endpoint', endpointQName(IDENTITY.id, 'ANY', '/acmeshop/v1/test-probe'))?.metadata).toEqual({
      contract: 'http-endpoint-v1',
      service_id: IDENTITY.id,
      service_aliases: IDENTITY.aliases,
      method: 'ANY',
      path: '/acmeshop/v1/test-probe',
    });
    expect(node('scheduled_job', 'cron:acmeshop_test_cron')?.metadata).toMatchObject({ test: true });
    expect(node('endpoint', endpointQName(IDENTITY.id, 'ANY', '/acmeshop/v1/tip'))?.metadata).not.toMatchObject({ test: true });
  });

  it('emits only registered vocabulary', () => {
    for (const n of out.nodes) expect(NODE_KINDS).toContain(n.kind);
    for (const e of out.edges) expect(GRAPH_RELATIONS).toContain(e.relation);
    for (const k of phpExtractor.vocabulary.kinds) expect(NODE_KINDS).toContain(k);
    for (const r of phpExtractor.vocabulary.relations) expect(GRAPH_RELATIONS).toContain(r);
  });
});

describe('php service contracts', () => {
  const identity = serviceIdentity(CROSS_FIXTURE);
  const file = serviceSourceQName(identity.id, 'php-api/plugin.php');

  it('emits method-aware REST providers and proven WordPress/Guzzle clients', () => {
    expect(crossOut.nodes.find((entry) => entry.qualifiedName === endpointQName(identity.id, 'GET', '/acme/v1/health'))).toBeDefined();
    expect(crossOut.nodes.find((entry) => entry.qualifiedName === endpointQName(identity.id, 'GET', '/acme/v1/items/{}'))).toBeDefined();
    expect(crossOut.nodes.find((entry) => entry.qualifiedName === endpointQName(identity.id, 'HEAD', '/acme/v1/items/{}'))).toBeDefined();
    expect(crossOut.edges.some((entry) => entry.relation === 'serves_route' && entry.from.qualifiedName === file)).toBe(true);

    const calls = crossOut.nodes.filter((entry) => entry.kind === 'http_call');
    expect(calls).toHaveLength(5);
    expect(calls.map((entry) => entry.metadata?.method).sort()).toEqual(['GET', 'GET', 'PATCH', 'POST', 'POST']);
    expect(calls.every((entry) => entry.qualifiedName.startsWith(`http-call:${identity.id}:`))).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('discarded');
    expect(JSON.stringify(calls)).not.toContain('token=');
    expect(crossOut.nodes.some((entry) => entry.name.includes('ignored.invalid'))).toBe(false);
    expect(crossOut.contractSkips).toEqual({
      dynamic_http_url: 0,
      dynamic_http_method: 0,
      dynamic_http_route: 0,
      dynamic_event_channel: 0,
    });
  });

  it('keeps legacy action/page discriminators outside the HTTP metadata contract', () => {
    for (const qn of [
      'route:wp-ajax/acme_tip',
      'route:admin-post/acme_tip',
      'route:wp-admin/admin.php?page=acme-one',
      'route:wp-admin/admin.php?page=acme-two',
    ]) {
      const endpoint = crossOut.nodes.find((entry) => entry.qualifiedName === qn);
      expect(endpoint).toBeDefined();
      expect(endpoint?.metadata?.contract).toBeUndefined();
    }
  });

  it('requires global WordPress function and REST constant provenance', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-php-wp-provenance-'));
    try {
      fs.writeFileSync(path.join(repo, 'composer.json'), '{"name":"mai/php-wp-provenance"}');
      fs.writeFileSync(path.join(repo, 'plugin.php'), `<?php
namespace Acme;
use \\WP_REST_Server as Rest;
use function \\Acme\\custom_client as wp_remote_post;
use function \\WP_REST_Server as FunctionRest;
function WP_REMOTE_GET($url) {}
function REGISTER_REST_ROUTE($namespace, $route, $config) {}
function custom_client($url) {}
wp_remote_get('https://wrong.invalid/local-client');
wp_remote_post('https://wrong.invalid/imported-function');
register_rest_route('wrong/v1', '/local-provider', array('methods' => 'GET'));
\\wp_remote_get('https://valid.test/root-client');
\\register_rest_route('valid/v1', '/root-provider', array('methods' => 'GET'));
class Other { const READABLE = 'TRACE'; }
class WP_REST_Server { const READABLE = 'TRACE'; }
class FunctionRest { const READABLE = 'TRACE'; }
\\register_rest_route('wrong/v1', '/foreign-constant', array('methods' => Other::READABLE));
\\register_rest_route('wrong/v1', '/local-lookalike', array('methods' => WP_REST_Server::READABLE));
\\register_rest_route('wrong/v1', '/wrong-import-kind', array('methods' => FunctionRest::READABLE));
\\register_rest_route('valid/v1', '/wp-constant', array('methods' => \\WP_REST_Server::READABLE));
\\register_rest_route('valid/v1', '/aliased-wp-constant', array('methods' => Rest::READABLE));
`);
      const identity = serviceIdentity(repo);
      const result = await phpExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      expect(result.nodes.filter((entry) => entry.kind === 'http_call').map((entry) => entry.name)).toEqual([
        'GET valid.test/root-client',
      ]);
      expect(result.nodes.filter((entry) => entry.kind === 'endpoint' && entry.metadata?.contract === 'http-endpoint-v1')
        .map((entry) => entry.qualifiedName).sort()).toEqual([
        endpointQName(identity.id, 'GET', '/valid/v1/root-provider'),
        endpointQName(identity.id, 'GET', '/valid/v1/aliased-wp-constant'),
        endpointQName(identity.id, 'GET', '/valid/v1/wp-constant'),
      ].sort());
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

  it('partitions same-path nested PHP services independent of root order', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-php-owned-'));
    const child = path.join(parent, 'child');
    try {
      fs.mkdirSync(child, { recursive: true });
      fs.writeFileSync(path.join(parent, 'composer.json'), '{"name":"mai/parent-service"}');
      fs.writeFileSync(path.join(child, 'composer.json'), '{"name":"mai/child-service"}');
      fs.writeFileSync(path.join(parent, 'index.php'), "<?php register_rest_route('api/v1', '/health', array('methods' => 'GET')); require_once __DIR__ . '/child/index.php';\n");
      fs.writeFileSync(path.join(child, 'index.php'), "<?php register_rest_route('api/v1', '/health', array('methods' => 'GET'));\n");
      const forward = await phpExtractor.extract({ projectId: 'x', repoPaths: [parent, child] });
      const reverse = await phpExtractor.extract({ projectId: 'x', repoPaths: [child, parent] });
      const signature = (value: ExtractorOutput): string[] => value.nodes.map((entry) => entry.qualifiedName).sort();
      expect(signature(forward)).toEqual(signature(reverse));
      expect(forward.nodes.filter((entry) => entry.kind === 'file' && entry.filePath === fs.realpathSync.native(path.join(child, 'index.php')))).toHaveLength(1);
      expect(forward.nodes.some((entry) => entry.qualifiedName === endpointQName(serviceIdentity(parent).id, 'GET', '/api/v1/health'))).toBe(true);
      expect(forward.nodes.some((entry) => entry.qualifiedName === endpointQName(serviceIdentity(child).id, 'GET', '/api/v1/health'))).toBe(true);
      const parentFile = serviceSourceQName(serviceIdentity(parent).id, `${path.basename(parent)}/index.php`);
      const childFile = serviceSourceQName(serviceIdentity(child).id, 'child/index.php');
      for (const result of [forward, reverse]) {
        expect(result.edges.filter((entry) => entry.relation === 'imports'
          && entry.from.qualifiedName === parentFile
          && entry.to.qualifiedName === childFile)).toHaveLength(1);
      }
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('classifies dynamic URL, method, and provider route once without guessing', async () => {
    const cases: Array<{ source: string; field: keyof NonNullable<ExtractorOutput['contractSkips']> }> = [
      { source: '<?php $url = get_url(); wp_remote_get($url);', field: 'dynamic_http_url' },
      { source: "<?php $method = get_method(); wp_remote_request('https://api.test/x', array('method' => $method));", field: 'dynamic_http_method' },
      { source: "<?php $namespace = get_namespace(); register_rest_route($namespace, '/x', array());", field: 'dynamic_http_route' },
    ];
    for (const entry of cases) {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-php-contract-'));
      try {
        fs.writeFileSync(path.join(repo, 'composer.json'), '{"name":"mai/dynamic-php"}');
        fs.writeFileSync(path.join(repo, 'plugin.php'), entry.source);
        const result = await phpExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
        const expected = {
          dynamic_http_url: 0,
          dynamic_http_method: 0,
          dynamic_http_route: 0,
          dynamic_event_channel: 0,
        };
        expected[entry.field] = 1;
        expect(result.contractSkips).toEqual(expected);
        expect(result.nodes.filter((item) => item.kind === 'http_call' || (item.kind === 'endpoint' && item.metadata?.contract === 'http-endpoint-v1'))).toHaveLength(0);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  it('derives Guzzle provenance from scoped AST assignments and invalidates reassignment', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-php-guzzle-scope-'));
    try {
      fs.writeFileSync(path.join(repo, 'composer.json'), '{"name":"mai/php-guzzle-scope"}');
      fs.writeFileSync(path.join(repo, 'plugin.php'), `<?php
use GuzzleHttp\\Client;
$live = new Client();
$live->get('https://valid.test/x');
function fake($live) { $live->get('https://wrong.invalid/shadowed'); }
// $comment = new Client(
$comment->get('https://wrong.invalid/comment');
$reassigned = new Client();
$reassigned = make_client();
$reassigned->get('https://wrong.invalid/reassigned');
$captured = new Client();
$closure = function () use ($captured) { $captured->get('https://valid.test/captured'); };
function typed_client(Client $typed) { $typed->get('https://valid.test/typed'); }
$aliasSource = new Client();
$alias = $aliasSource;
$alias->get('https://valid.test/alias');
$foreach = new Client();
foreach (values() as $foreach) {}
$foreach->get('https://wrong.invalid/foreach');
$unset = new Client();
unset($unset);
$unset->get('https://wrong.invalid/unset');
$arrowClient = new Client();
$arrow = fn() => $arrowClient->get('https://valid.test/arrow');
$byRef = new Client();
$byRefClosure = function () use (&$byRef) { $byRef->get('https://valid.test/by-ref'); };
$keyedForeach = new Client();
foreach (values() as $key => $keyedForeach) {}
$keyedForeach->get('https://wrong.invalid/keyed-foreach');
$assignmentRhs = new Client();
$assignmentRhs = identity($assignmentRhs->get('https://valid.test/assignment-rhs'));
$assignmentRhs->get('https://wrong.invalid/assignment-after');
$foreachRhs = new Client();
foreach (array($foreachRhs->get('https://valid.test/foreach-rhs')) as $foreachRhs) {}
$foreachRhs->get('https://wrong.invalid/foreach-after');
$chainA = $chainB = new Client();
$chainA->get('https://valid.test/chain-a');
$chainB->get('https://valid.test/chain-b');
$dynamicRhs = new Client();
$dynamicUrl = get_url();
$dynamicRhs = identity($dynamicRhs->get($dynamicUrl));
$dynamicRhs->get('https://wrong.invalid/dynamic-after');
$self = new Client();
$self = $self;
$self->get('https://valid.test/self-assignment');
$parenSource = new Client();
$parenAlias = ($parenSource);
$parenAlias->get('https://valid.test/parenthesized-alias');
$refSource = new Client();
$refAlias =& $refSource;
$refAlias->get('https://valid.test/reference-alias');
$refSource->get('https://valid.test/reference-source-before');
$refSource = make_client();
$refAlias->get('https://wrong.invalid/reference-source-after');
$inverseSource = new Client();
$inverseAlias =& $inverseSource;
$inverseAlias->get('https://valid.test/reference-alias-before');
$inverseAlias = make_client();
$inverseSource->get('https://wrong.invalid/reference-alias-after');
$copySource = new Client();
$copyAlias = $copySource;
$copyAlias = make_client();
$copySource->get('https://valid.test/ordinary-copy-source');
$closureRefSource = new Client();
$closureRefAlias =& $closureRefSource;
$closureRef = function () use (&$closureRefSource, &$closureRefAlias) {
    $closureRefSource->get('https://valid.test/closure-reference-source-before');
    $closureRefAlias->get('https://valid.test/closure-reference-alias-before');
    $closureRefAlias = make_client();
    $closureRefSource->get('https://wrong.invalid/closure-reference-alias-after');
};
$closureInverseSource = new Client();
$closureInverseAlias =& $closureInverseSource;
$closureInverse = function () use (&$closureInverseSource, &$closureInverseAlias) {
    $closureInverseSource = make_client();
    $closureInverseAlias->get('https://wrong.invalid/closure-reference-source-after');
};
$mixedCaptureSource = new Client();
$mixedCaptureAlias =& $mixedCaptureSource;
$mixedCapture = function () use ($mixedCaptureSource, &$mixedCaptureAlias) {
    $mixedCaptureAlias = make_client();
    $mixedCaptureSource->get('https://valid.test/closure-value-capture-independent');
};
$chainRefA = new Client();
$chainRefB =& $chainRefA;
$chainRefC =& $chainRefB;
$chainRefClosure = function () use (&$chainRefA, &$chainRefB, &$chainRefC) {
    $chainRefC->get('https://valid.test/closure-chain-before');
    $chainRefB = make_client();
    $chainRefA->get('https://wrong.invalid/closure-chain-a-after');
    $chainRefC->get('https://wrong.invalid/closure-chain-c-after');
};
$globalClient = new Client();
function global_client_call() {
    global $globalClient;
    $globalClient->get('https://valid.test/global-client');
}
$globalRefA = new Client();
$globalRefB =& $globalRefA;
function global_reference_alias_write() {
    global $globalRefA, $globalRefB;
    $globalRefA->get('https://valid.test/global-reference-before');
    $globalRefB = make_client();
    $globalRefA->get('https://wrong.invalid/global-reference-alias-after');
}
$globalInverseA = new Client();
$globalInverseB =& $globalInverseA;
function global_reference_source_write() {
    global $globalInverseA, $globalInverseB;
    $globalInverseA = make_client();
    $globalInverseB->get('https://wrong.invalid/global-reference-source-after');
}
$globalNestedClient = new Client();
function global_nested_capture() {
    global $globalNestedClient;
    $nested = function () use (&$globalNestedClient) {
        $globalNestedClient->get('https://valid.test/global-nested-capture');
    };
}
$notGlobalClient = make_client();
function unrelated_global_call() {
    global $notGlobalClient;
    $notGlobalClient->get('https://wrong.invalid/unrelated-global');
}
function shadowed_global_parameter($globalClient) {
    $globalClient->get('https://wrong.invalid/shadowed-global-parameter');
}
function later_global_client_call() {
    global $laterGlobalClient;
    $laterGlobalClient->get('https://valid.test/later-global-client');
}
$laterGlobalClient = new Client();
$orderedGlobalClient = new Client();
function ordered_global_client_call() {
    $orderedGlobalClient->get('https://wrong.invalid/before-global-statement');
    global $orderedGlobalClient;
    $orderedGlobalClient->get('https://valid.test/after-global-statement');
}
$reboundGlobalClient = new Client();
function rebound_global_client_call() {
    $reboundGlobalClient = make_client();
    global $reboundGlobalClient;
    $reboundGlobalClient->get('https://valid.test/global-rebind');
}
$invalidatedGlobalClient = new Client();
$invalidatedGlobalClient = make_client();
function invalidated_global_client_call() {
    global $invalidatedGlobalClient;
    $invalidatedGlobalClient->get('https://wrong.invalid/invalidated-global');
}
function sibling_without_global_declaration() {
    $laterGlobalClient->get('https://wrong.invalid/sibling-without-global');
}
$plainGlobalWrapperControl = new Client();
function plain_global_wrapper_control_call() {
    global $plainGlobalWrapperControl;
    $plainGlobalWrapperControl->get('https://valid.test/plain-global-wrapper-control');
}
(($parenthesizedGlobalClient = new Client()));
function parenthesized_global_client_call() {
    global $parenthesizedGlobalClient;
    $parenthesizedGlobalClient->get('https://valid.test/parenthesized-global-client');
}
$colonClient = new Client();
foreach (values() as $value):
    $colonClient->get('https://valid.test/colon-body');
    wp_remote_get('https://valid.test/colon-wordpress');
endforeach;
`);
      const result = await phpExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      expect(result.nodes.filter((entry) => entry.kind === 'http_call').map((entry) => entry.name).sort()).toEqual([
        'GET valid.test/alias',
        'GET valid.test/assignment-rhs',
        'GET valid.test/arrow',
        'GET valid.test/by-ref',
        'GET valid.test/captured',
        'GET valid.test/chain-a',
        'GET valid.test/chain-b',
        'GET valid.test/closure-chain-before',
        'GET valid.test/closure-reference-alias-before',
        'GET valid.test/closure-reference-source-before',
        'GET valid.test/closure-value-capture-independent',
        'GET valid.test/colon-body',
        'GET valid.test/colon-wordpress',
        'GET valid.test/foreach-rhs',
        'GET valid.test/global-client',
        'GET valid.test/later-global-client',
        'GET valid.test/after-global-statement',
        'GET valid.test/global-rebind',
        'GET valid.test/global-nested-capture',
        'GET valid.test/global-reference-before',
        'GET valid.test/parenthesized-alias',
        'GET valid.test/ordinary-copy-source',
        'GET valid.test/plain-global-wrapper-control',
        'GET valid.test/parenthesized-global-client',
        'GET valid.test/reference-alias',
        'GET valid.test/reference-alias-before',
        'GET valid.test/reference-source-before',
        'GET valid.test/self-assignment',
        'GET valid.test/typed',
        'GET valid.test/x',
      ].sort());
      expect(result.contractSkips).toEqual({
        dynamic_http_url: 1,
        dynamic_http_method: 0,
        dynamic_http_route: 0,
        dynamic_event_channel: 0,
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('derives Guzzle construction provenance from grouped imports', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-php-guzzle-group-use-'));
    try {
      fs.writeFileSync(path.join(repo, 'composer.json'), '{"name":"mai/php-guzzle-group-use"}');
      fs.writeFileSync(path.join(repo, 'plugin.php'), `<?php
use GuzzleHttp\\{Client};
use GuzzleHttp\\Client as HTTPCLIENT;
$client = new Client();
$client->get('https://valid.test/grouped');
$mixedAlias = new httpclient();
$mixedAlias->get('https://valid.test/mixed-alias');
$mixedFullyQualified = new \\guzzlehttp\\client();
$mixedFullyQualified->get('https://valid.test/mixed-fully-qualified');
function mixed_typed(HTTPCLIENT $typed) { $typed->get('https://valid.test/mixed-typed'); }
`);
      const result = await phpExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      expect(result.nodes.filter((entry) => entry.kind === 'http_call').map((entry) => entry.name)).toEqual([
        'GET valid.test/grouped',
        'GET valid.test/mixed-alias',
        'GET valid.test/mixed-fully-qualified',
        'GET valid.test/mixed-typed',
      ]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('resolves Guzzle qualified names with PHP namespace and prefix-alias semantics', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-php-guzzle-qualified-'));
    try {
      fs.writeFileSync(path.join(repo, 'composer.json'), '{"name":"mai/php-guzzle-qualified"}');
      fs.writeFileSync(path.join(repo, 'plugin.php'), `<?php
namespace Acme;
use GuzzleHttp as GH;
$wrongRelative = new GuzzleHttp\\Client();
$wrongRelative->get('https://wrong.invalid/namespace-relative');
$validPrefix = new GH\\Client();
$validPrefix->get('https://valid.test/prefix-alias');
$validRoot = new \\gUzZlEhTtP\\cLiEnT();
$validRoot->get('https://valid.test/root-qualified');
function typed_prefix(GH\\Client $typed) { $typed->get('https://valid.test/typed-prefix'); }
`);
      const result = await phpExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      expect(result.nodes.filter((entry) => entry.kind === 'http_call').map((entry) => entry.name).sort()).toEqual([
        'GET valid.test/prefix-alias',
        'GET valid.test/root-qualified',
        'GET valid.test/typed-prefix',
      ]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('distinguishes absent, dynamic, and empty WordPress HTTP method inputs', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-php-method-shapes-'));
    try {
      fs.writeFileSync(path.join(repo, 'composer.json'), '{"name":"mai/php-method-shapes"}');
      fs.writeFileSync(path.join(repo, 'plugin.php'), `<?php
wp_remote_request('https://api.test/default');
wp_remote_request('https://api.test/dynamic', make_args());
wp_remote_request('https://api.test/empty', array('method' => ''));
wp_remote_get('');
`);
      const result = await phpExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      expect(result.nodes.filter((entry) => entry.kind === 'http_call').map((entry) => entry.name)).toEqual(['ANY api.test/default']);
      expect(result.contractSkips).toEqual({
        dynamic_http_url: 0,
        dynamic_http_method: 1,
        dynamic_http_route: 0,
        dynamic_event_channel: 0,
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('uses the final effective PHP array method after duplicate keys and unpacks', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-php-method-order-'));
    try {
      fs.writeFileSync(path.join(repo, 'composer.json'), '{"name":"mai/php-method-order"}');
      fs.writeFileSync(path.join(repo, 'plugin.php'), `<?php
wp_remote_request('https://valid.test/client-duplicate-dynamic', array('method' => 'GET', 'method' => get_method()));
wp_remote_request('https://valid.test/client-unpack-dynamic', array('method' => 'GET', ...get_args()));
wp_remote_request('https://valid.test/client-duplicate-recovered', array('method' => get_method(), 'method' => 'POST'));
wp_remote_request('https://valid.test/client-unpack-recovered', array(...get_args(), 'method' => 'PATCH'));
register_rest_route('api/v1', '/rest-duplicate-dynamic', array('methods' => 'GET', 'methods' => get_method()));
register_rest_route('api/v1', '/rest-unpack-dynamic', array('methods' => 'GET', ...get_config()));
register_rest_route('api/v1', '/rest-duplicate-recovered', array('methods' => get_method(), 'methods' => 'POST'));
register_rest_route('api/v1', '/rest-unpack-recovered', array(...get_config(), 'methods' => 'PATCH'));
`);
      const identity = serviceIdentity(repo);
      const result = await phpExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      expect(result.nodes.filter((entry) => entry.kind === 'http_call').map((entry) => entry.name).sort()).toEqual([
        'PATCH valid.test/client-unpack-recovered',
        'POST valid.test/client-duplicate-recovered',
      ]);
      expect(result.nodes.filter((entry) => entry.metadata?.contract === 'http-endpoint-v1').map((entry) => entry.qualifiedName).sort()).toEqual([
        endpointQName(identity.id, 'PATCH', '/api/v1/rest-unpack-recovered'),
        endpointQName(identity.id, 'POST', '/api/v1/rest-duplicate-recovered'),
      ].sort());
      expect(result.contractSkips).toEqual({
        dynamic_http_url: 0,
        dynamic_http_method: 4,
        dynamic_http_route: 0,
        dynamic_event_channel: 0,
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('flattens nested WordPress REST definitions and rejects nested dynamic methods', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-php-rest-list-'));
    try {
      fs.writeFileSync(path.join(repo, 'composer.json'), '{"name":"mai/php-rest-list"}');
      fs.writeFileSync(path.join(repo, 'plugin.php'), `<?php
register_rest_route('api/v1', '/items', array(array('methods' => 'GET'), array('methods' => 'POST')));
register_rest_route('api/v1', '/dynamic', array(array('methods' => get_method())));
register_rest_route('api/v1', '/keyed', array(0 => array('methods' => 'GET'), 1 => array('methods' => 'POST')));
register_rest_route('api/v1', '/keyed-dynamic', array(0 => array('methods' => get_method())));
register_rest_route('api/v1', '/numeric-strings', array('0' => array('methods' => 'GET'), '1' => array('methods' => 'POST')));
register_rest_route('api/v1', '/numeric-string-dynamic', array('0' => array('methods' => get_method())));
register_rest_route('api/v1', '/numeric-leading-zero', array('01' => array('methods' => 'GET')));
register_rest_route('api/v1', '/numeric-plus', array('+1' => array('methods' => 'POST')));
register_rest_route('api/v1', '/numeric-decimal', array('1.5' => array('methods' => 'PATCH')));
register_rest_route('api/v1', '/numeric-exponent', array('1e2' => array('methods' => 'DELETE')));
register_rest_route('api/v1', '/numeric-space', array(' 1' => array('methods' => 'HEAD')));
register_rest_route('api/v1', '/numeric-dynamic', array('01' => array('methods' => get_method())));
register_rest_route('api/v1', '/common-args', array('args' => array('id' => array()), 0 => array('methods' => 'GET'), 1 => array('methods' => 'POST')));
register_rest_route('api/v1', '/direct-callback', array('callback' => 'handler'));
register_rest_route('api/v1', '/numeric-float', array(1.5 => array('methods' => 'GET')));
register_rest_route('api/v1', '/numeric-true', array(true => array('methods' => 'POST')));
register_rest_route('api/v1', '/numeric-false', array(false => array('methods' => 'HEAD')));
register_rest_route('api/v1', '/numeric-negative', array(-2 => array('methods' => 'PATCH')));
register_rest_route('api/v1', '/numeric-collision', array(1.5 => array('methods' => 'GET'), true => array('methods' => 'POST')));
register_rest_route('api/v1', '/numeric-collision-reversed', array(true => array('methods' => 'POST'), 1.5 => array('methods' => 'GET')));
register_rest_route('api/v1', '/numeric-unresolved-key', array(get_key() => array('methods' => 'GET')));
register_rest_route('api/v1', '/numeric-underscore', array(1_000 => array('methods' => 'GET')));
register_rest_route('api/v1', '/numeric-octal-collision', array(010 => array('methods' => 'GET'), 8 => array('methods' => 'POST')));
register_rest_route('api/v1', '/numeric-spaced-negative', array(- 2 => array('methods' => 'PATCH')));
register_rest_route('api/v1', '/numeric-negative-zero-distinct', array('-0' => array('methods' => 'GET'), 0 => array('methods' => 'POST')));
register_rest_route('api/v1', '/numeric-hex', array(0x10 => array('methods' => 'GET')));
register_rest_route('api/v1', '/numeric-binary', array(0b10 => array('methods' => 'POST')));
register_rest_route('api/v1', '/numeric-large-collision', array(9223372036854775807 => array('methods' => 'GET'), '9223372036854775807' => array('methods' => 'POST')));
register_rest_route('api/v1', '/numeric-overflow-collision', array(9223372036854775808 => array('methods' => 'PATCH'), -9223372036854775808 => array('methods' => 'DELETE')));
register_rest_route('api/v1', '/numeric-negative-auto-collision', array(-5 => array('methods' => 'GET'), array('methods' => 'POST'), -4 => array('methods' => 'PATCH')));
register_rest_route('api/v1', '/numeric-negative-auto-forward', array(-5 => array('methods' => 'GET'), -4 => array('methods' => 'PATCH'), array('methods' => 'POST')));
register_rest_route('api/v1', '/numeric-negative-one-boundary', array(-1 => array('methods' => 'GET'), array('methods' => 'POST'), 0 => array('methods' => 'DELETE')));
register_rest_route('api/v1', '/numeric-max-only', array(9223372036854775807 => array('methods' => 'GET')));
register_rest_route('api/v1', '/numeric-max-implicit', array(9223372036854775807 => array('methods' => 'GET'), array('methods' => 'POST')));
register_rest_route('api/v1', '/numeric-max-lower-implicit', array(9223372036854775807 => array('methods' => 'GET'), 5 => array('methods' => 'PATCH'), array('methods' => 'POST')));
register_rest_route('api/v1', '/numeric-max-minus-one-one-implicit', array(9223372036854775806 => array('methods' => 'GET'), array('methods' => 'POST')));
register_rest_route('api/v1', '/numeric-max-minus-one-two-implicit', array(9223372036854775806 => array('methods' => 'GET'), array('methods' => 'POST'), array('methods' => 'PATCH')));
register_rest_route('api/v1', '/numeric-max-minus-two-three-implicit', array(9223372036854775805 => array('methods' => 'GET'), array('methods' => 'POST'), array('methods' => 'PATCH'), array('methods' => 'DELETE')));
`);
      const identity = serviceIdentity(repo);
      const result = await phpExtractor.extract({ projectId: 'unused', repoPaths: [repo] });
      expect(result.nodes.filter((entry) => entry.metadata?.contract === 'http-endpoint-v1').map((entry) => entry.qualifiedName).sort()).toEqual([
        endpointQName(identity.id, 'GET', '/api/v1/items'),
        endpointQName(identity.id, 'GET', '/api/v1/keyed'),
        endpointQName(identity.id, 'GET', '/api/v1/common-args'),
        endpointQName(identity.id, 'GET', '/api/v1/numeric-leading-zero'),
        endpointQName(identity.id, 'GET', '/api/v1/numeric-strings'),
        endpointQName(identity.id, 'GET', '/api/v1/numeric-float'),
        endpointQName(identity.id, 'GET', '/api/v1/numeric-collision-reversed'),
        endpointQName(identity.id, 'GET', '/api/v1/numeric-underscore'),
        endpointQName(identity.id, 'GET', '/api/v1/numeric-negative-zero-distinct'),
        endpointQName(identity.id, 'GET', '/api/v1/numeric-hex'),
        endpointQName(identity.id, 'GET', '/api/v1/numeric-negative-auto-collision'),
        endpointQName(identity.id, 'GET', '/api/v1/numeric-negative-auto-forward'),
        endpointQName(identity.id, 'GET', '/api/v1/numeric-negative-one-boundary'),
        endpointQName(identity.id, 'GET', '/api/v1/numeric-max-only'),
        endpointQName(identity.id, 'GET', '/api/v1/numeric-max-minus-one-one-implicit'),
        endpointQName(identity.id, 'HEAD', '/api/v1/numeric-space'),
        endpointQName(identity.id, 'HEAD', '/api/v1/numeric-false'),
        endpointQName(identity.id, 'PATCH', '/api/v1/numeric-decimal'),
        endpointQName(identity.id, 'PATCH', '/api/v1/numeric-negative'),
        endpointQName(identity.id, 'PATCH', '/api/v1/numeric-spaced-negative'),
        endpointQName(identity.id, 'PATCH', '/api/v1/numeric-negative-auto-collision'),
        endpointQName(identity.id, 'PATCH', '/api/v1/numeric-negative-auto-forward'),
        endpointQName(identity.id, 'POST', '/api/v1/items'),
        endpointQName(identity.id, 'POST', '/api/v1/common-args'),
        endpointQName(identity.id, 'POST', '/api/v1/keyed'),
        endpointQName(identity.id, 'POST', '/api/v1/numeric-plus'),
        endpointQName(identity.id, 'POST', '/api/v1/numeric-strings'),
        endpointQName(identity.id, 'POST', '/api/v1/numeric-true'),
        endpointQName(identity.id, 'POST', '/api/v1/numeric-collision'),
        endpointQName(identity.id, 'POST', '/api/v1/numeric-octal-collision'),
        endpointQName(identity.id, 'POST', '/api/v1/numeric-negative-zero-distinct'),
        endpointQName(identity.id, 'POST', '/api/v1/numeric-binary'),
        endpointQName(identity.id, 'POST', '/api/v1/numeric-large-collision'),
        endpointQName(identity.id, 'POST', '/api/v1/numeric-negative-auto-forward'),
        endpointQName(identity.id, 'POST', '/api/v1/numeric-max-minus-one-one-implicit'),
        endpointQName(identity.id, 'DELETE', '/api/v1/numeric-exponent'),
        endpointQName(identity.id, 'DELETE', '/api/v1/numeric-overflow-collision'),
        endpointQName(identity.id, 'DELETE', '/api/v1/numeric-negative-one-boundary'),
        endpointQName(identity.id, 'ANY', '/api/v1/direct-callback'),
      ].sort());
      expect(result.contractSkips).toEqual({
        dynamic_http_url: 0,
        dynamic_http_method: 9,
        dynamic_http_route: 0,
        dynamic_event_channel: 0,
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
