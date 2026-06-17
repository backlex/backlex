<?php

declare(strict_types=1);

// Self-contained test runner (no Composer/PHPUnit needed). Exits non-zero on any
// failure. Covers the same contract as the other SDK suites: the query builder
// compiles to byte-identical canonical JSON, and the HTTP layer wires
// paths/encoding/auth/errors correctly (via an injected transport).

require __DIR__ . '/../src/BacklexException.php';
require __DIR__ . '/../src/Filter.php';
require __DIR__ . '/../src/QueryBuilder.php';
require __DIR__ . '/../src/Collection.php';
require __DIR__ . '/../src/Auth.php';
require __DIR__ . '/../src/Storage.php';
require __DIR__ . '/../src/Realtime.php';
require __DIR__ . '/../src/Client.php';

use Backlex\BacklexException;
use Backlex\Client;
use Backlex\Filter as F;

$failures = 0;
function check(bool $cond, string $msg): void
{
    global $failures;
    if ($cond) {
        echo "ok   - {$msg}\n";
    } else {
        $failures++;
        echo "FAIL - {$msg}\n";
    }
}
// PHP `==` on arrays is order-independent deep equality — ideal for canonical JSON.
function eq($got, $want, string $msg): void
{
    check($got == $want, $msg);
}

// ---- Query builder (offline) ---------------------------------------------

eq(
    F::normalize(F::and_(F::eq('status', 'active'), F::gte('total', 100))),
    ['$and' => [['status' => ['_eq' => 'active']], ['total' => ['_gte' => 100]]]],
    'leaf + logical'
);
eq(F::rel('customer', F::eq('tier', 'gold')), ['customer.tier' => ['_eq' => 'gold']], 'relation hop prefixes keys');
eq(
    F::rel('customer', F::eq('tier', 'gold'), F::gte('age', 18)),
    ['$and' => [['customer.tier' => ['_eq' => 'gold']], ['customer.age' => ['_gte' => 18]]]],
    'relation hop, multiple conds'
);
eq(
    F::gte('placed_at', F::now(sub: ['months' => 1])),
    ['placed_at' => ['_gte' => ['$now' => ['sub' => ['months' => 1]]]]],
    'now relative date'
);
eq(F::normalize(['status' => 'active']), ['status' => ['_eq' => 'active']], 'implicit equality');
eq(F::normalize(['_and' => [['a' => 1]]]), ['$and' => [['a' => ['_eq' => 1]]]], 'alias _and -> $and');
eq(F::normalize(['_not' => ['a' => 1]]), ['$not' => ['a' => ['_eq' => 1]]], 'alias _not -> $not');
$once = F::normalize(['status' => 'active']);
eq(F::normalize($once), $once, 'normalize idempotent');

$q = (new Client('http://x'))->from('posts')->query()
    ->where(F::eq('published', true))
    ->select('id', 'title')
    ->orderBy('-created_at', 'id')
    ->limit(50)->offset(10)->withMeta('filter_count')
    ->toQuery();
check(
    $q['filter'] == ['published' => ['_eq' => true]]
        && $q['sort'] === ['-created_at', 'id']
        && $q['limit'] === 50 && $q['offset'] === 10 && $q['meta'] === 'filter_count',
    'toQuery assembly'
);

// ---- HTTP layer (injected transport) -------------------------------------

$last = ['method' => null, 'url' => null, 'headers' => [], 'body' => null];
function makeTransport(array &$last): callable
{
    return function (string $method, string $url, array $headers, ?string $body) use (&$last): array {
        $last['method'] = $method;
        $last['url'] = $url;
        $last['headers'] = $headers;
        $last['body'] = $body;
        $path = parse_url($url, PHP_URL_PATH);
        if ($path === '/api/items/missing') {
            return [404, '{"error":{"code":"NOT_FOUND","message":"no such collection"}}'];
        }
        if ($method === 'POST' && str_contains($path, '/sign-in/email')) { // email + email-otp
            return str_starts_with($path, '/api/t/')
                ? [200, '{"user":{"id":"u1","email":"a@b.c"},"token":"tok_123"}']
                : [200, '{"user":{"id":"u1","email":"a@b.c"}}'];
        }
        if ($method === 'DELETE') {
            return [200, '{"ok":true}'];
        }
        if ($method === 'POST' || $method === 'PATCH') {
            return [200, '{"data":{"id":"x1"}}'];
        }
        return [200, '{"data":[],"limit":50,"offset":0}'];
    };
}
function filterParam(string $url): ?string
{
    parse_str(parse_url($url, PHP_URL_QUERY) ?? '', $params);
    return $params['filter'] ?? null;
}
$transport = makeTransport($last);

$client = new Client('http://test', ['api_key' => 'pak_x', 'transport' => $transport]);
$client->from('orders')->query()->where(F::eq('status', 'active'))->orderBy('-created_at')->limit(5)->list();
check(
    $last['method'] === 'GET'
        && parse_url($last['url'], PHP_URL_PATH) === '/api/items/orders'
        && json_decode(filterParam($last['url']), true) == ['status' => ['_eq' => 'active']],
    'query string filter is not double-encoded'
);

$client = new Client('http://test', ['api_key' => 'pak_secret', 'transport' => $transport]);
$client->from('posts')->list();
check(in_array('Authorization: Bearer pak_secret', $last['headers'], true), 'api key bearer header');

$client = new Client('http://test', ['tenant' => 'myapp', 'transport' => $transport]);
$client->from('posts')->list();
check(in_array('X-Backlex-Tenant: myapp', $last['headers'], true), 'tenant header is sent');

$client = new Client('http://test', ['transport' => $transport]);
$client->from('posts')->query()->expand('author')->locale('tr')->search('hi')->list();
parse_str(parse_url($last['url'], PHP_URL_QUERY) ?? '', $qp);
check(($qp['expand'] ?? '') === 'author' && ($qp['locale'] ?? '') === 'tr' && ($qp['q'] ?? '') === 'hi', 'query extras serialize');

$client = new Client('http://test', ['transport' => $transport]);
$client->from('posts')->one('p1', ['expand' => ['author'], 'locale' => 'tr']);
parse_str(parse_url($last['url'], PHP_URL_QUERY) ?? '', $oneQp);
check(
    parse_url($last['url'], PHP_URL_PATH) === '/api/items/posts/p1'
        && ($oneQp['expand'] ?? '') === 'author' && ($oneQp['locale'] ?? '') === 'tr',
    'one() forwards expand/locale'
);

$client = new Client('http://test', ['transport' => $transport]);
$client->from('orders')->aggregate(['agg' => 'sum', 'field' => 'total']);
check(
    $last['method'] === 'POST' && parse_url($last['url'], PHP_URL_PATH) === '/api/items/orders/aggregate',
    'aggregate hits the right path'
);

$client = new Client('http://test', ['transport' => $transport]);
$client->from('posts')->publish('p1');
$pubOk = parse_url($last['url'], PHP_URL_PATH) === '/api/items/posts/p1/publish';
$client->from('posts')->unpublish('p1');
check($pubOk && str_contains($last['url'], 'unpublish=1'), 'publish / unpublish paths');

$client = new Client('http://test', ['transport' => $transport]);
$client->auth->requestPasswordReset('a@b.c');
check(parse_url($last['url'], PHP_URL_PATH) === '/api/auth/request-password-reset', 'password reset hits the right path');

$client = new Client('http://test', ['transport' => $transport]);
$client->auth->sendVerificationOTP('a@b.c');
$sendOk = parse_url($last['url'], PHP_URL_PATH) === '/api/auth/email-otp/send-verification-otp'
    && json_decode($last['body'], true)['type'] === 'sign-in';
$app = new Client('http://test', ['workspace' => 'myapp', 'transport' => $transport]);
$otpRes = $app->auth->signInEmailOTP('a@b.c', '123456');
check(
    $sendOk
        && parse_url($last['url'], PHP_URL_PATH) === '/api/t/myapp/auth/sign-in/email-otp'
        && $otpRes['token'] === 'tok_123' && $app->auth->token() === 'tok_123',
    'email-otp: send + app-mode sign-in captures token'
);

$client = new Client('http://test', ['transport' => $transport]);
$client->auth->changePassword('new', 'old');
check(parse_url($last['url'], PHP_URL_PATH) === '/api/auth/change-password', 'change password hits the right path');

$client = new Client('http://test', ['api_key' => 'pak_x', 'transport' => $transport]);
$posts = $client->from('posts');
$posts->create(['title' => 'Hi']);
$createOk = $last['method'] === 'POST'
    && parse_url($last['url'], PHP_URL_PATH) === '/api/items/posts'
    && json_decode($last['body'], true) == ['title' => 'Hi'];
$posts->update('p1', ['title' => 'Edit']);
$updateOk = $last['method'] === 'PATCH' && parse_url($last['url'], PHP_URL_PATH) === '/api/items/posts/p1';
$del = $posts->delete('p1');
check($createOk && $updateOk && $last['method'] === 'DELETE' && $del['ok'] === true, 'CRUD methods, paths, body');

$client = new Client('http://test', ['workspace' => 'myapp', 'transport' => $transport]);
$res = $client->auth->signIn('a@b.c', 'pw');
$signedIn = parse_url($last['url'], PHP_URL_PATH) === '/api/t/myapp/auth/sign-in/email'
    && $res['token'] === 'tok_123' && $client->auth->token() === 'tok_123';
$client->from('posts')->list();
$replayed = in_array('Authorization: Bearer tok_123', $last['headers'], true);
$client->auth->signOut();
check($signedIn && $replayed && $client->auth->token() === null, 'app-mode token capture + replay');

$client = new Client('http://test', ['api_key' => 'pak_x', 'transport' => $transport]);
$caught = false;
try {
    $client->from('missing')->list();
} catch (BacklexException $e) {
    $caught = $e->status === 404 && $e->code === 'NOT_FOUND' && $e->getMessage() === 'no such collection';
}
check($caught, 'error envelope -> BacklexException(404, NOT_FOUND)');

$client = new Client('http://test', ['transport' => $transport]);
$client->auth->signIn('a@b.c', 'pw');
check(
    parse_url($last['url'], PHP_URL_PATH) === '/api/auth/sign-in/email' && $client->auth->token() === null,
    'control-plane auth does not capture token'
);

echo $failures === 0 ? "\nALL PASSED\n" : "\n{$failures} FAILED\n";
exit($failures === 0 ? 0 : 1);
