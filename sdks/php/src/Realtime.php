<?php

declare(strict_types=1);

namespace Backlex;

/**
 * SSE realtime reader. PHP has no background threads, so this is the **blocking**
 * model: `listen` reads the stream and invokes $onEvent for each frame until the
 * connection drops or $onEvent returns `false`. Run it in your own process/loop.
 */
final class Realtime
{
    public function __construct(private Client $client)
    {
    }

    public function listen(string $channel, callable $onEvent, ?callable $onError = null): void
    {
        $url = $this->client->getBaseUrl() . "/api/realtime/{$channel}/subscribe";
        $headers = array_merge(['Accept: text/event-stream'], $this->client->authHeaders());

        $buffer = '';
        $data = [];
        $stop = false;

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_WRITEFUNCTION => function ($ch, string $chunk) use (&$buffer, &$data, &$stop, $onEvent, $onError): int {
                if ($stop) {
                    return -1;
                }
                $buffer .= $chunk;
                while (($pos = strpos($buffer, "\n")) !== false) {
                    $line = rtrim(substr($buffer, 0, $pos), "\r");
                    $buffer = substr($buffer, $pos + 1);
                    if ($line === '') {
                        if ($data) {
                            $payload = implode("\n", $data);
                            $data = [];
                            $ev = json_decode($payload, true);
                            if (is_array($ev)) {
                                if ($onEvent($ev) === false) {
                                    $stop = true;
                                    return -1;
                                }
                            } elseif ($onError) {
                                $onError(new BacklexException(0, 'PARSE', 'malformed event'));
                            }
                        }
                    } elseif ($line[0] === ':') {
                        // comment / heartbeat
                    } elseif (str_starts_with($line, 'data:')) {
                        $d = substr($line, 5);
                        if (str_starts_with($d, ' ')) {
                            $d = substr($d, 1);
                        }
                        $data[] = $d;
                    }
                }
                return strlen($chunk);
            },
        ]);
        $ok = curl_exec($ch);
        if ($ok === false && !$stop && $onError) {
            $onError(new BacklexException(0, 'NETWORK', curl_error($ch)));
        }
        curl_close($ch);
    }
}
