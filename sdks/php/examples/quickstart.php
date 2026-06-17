<?php

declare(strict_types=1);

// Quickstart tour of the PHP SDK.
//   BACKLEX_URL=http://localhost:5173 BACKLEX_KEY=pak_... php examples/quickstart.php

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

$url = getenv('BACKLEX_URL') ?: 'http://localhost:5173';
$client = new Client($url, ['api_key' => getenv('BACKLEX_KEY') ?: null]);

// Fluent query builder → compiles to canonical JSON (same wire format as every other SDK).
$query = $client->from('posts')->query()
    ->where(F::and_(
        F::eq('published', true),
        F::gte('views', 100),
        F::rel('author', F::eq('tier', 'gold')),
        F::gte('created_at', F::now(sub: ['days' => 7])),
    ))
    ->select('id', 'title', 'author.name')
    ->orderBy('-created_at')
    ->limit(10)
    ->withMeta('filter_count');

try {
    $res = $query->list();
    echo 'got ' . count($res['data']) . " posts\n";
} catch (BacklexException $e) {
    echo "list failed: {$e->status} {$e->code} — {$e->getMessage()}\n";
}

// CRUD
// $created = $client->from('posts')->create(['title' => 'Hello']);

// Realtime (SSE — blocking in PHP; $onEvent returning false stops)
// $client->subscribe('items:posts', function (array $ev): void {
//     echo "event: {$ev['event']}\n";
// });
