package com.backlex

import java.io.Closeable
import java.io.InputStream

/**
 * Handle for an active realtime subscription. [close] unsubscribes — the same
 * contract as the TS SDK's returned unsubscribe function. Implements [Closeable]
 * for `use { }`.
 */
class Subscription : Closeable {
    @Volatile
    var stopped: Boolean = false
        private set

    @Volatile
    private var current: InputStream? = null
    private var thread: Thread? = null

    internal fun attachThread(t: Thread) {
        thread = t
    }

    internal fun setStream(s: InputStream) {
        current = s
    }

    override fun close() {
        stopped = true
        try {
            current?.close() // closing the stream breaks the blocking read
        } catch (_: Exception) {
        }
        thread?.interrupt()
    }
}
