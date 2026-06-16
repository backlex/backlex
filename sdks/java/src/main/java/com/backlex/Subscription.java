package com.backlex;

import java.io.InputStream;

/**
 * Handle for an active realtime subscription. {@link #close()} unsubscribes — the
 * same contract as the TS SDK's returned unsubscribe function. Implements
 * {@link AutoCloseable} for try-with-resources.
 */
public final class Subscription implements AutoCloseable {

    private volatile boolean stopped = false;
    private volatile InputStream current;
    private Thread thread;

    void attachThread(Thread t) {
        this.thread = t;
    }

    void setStream(InputStream s) {
        this.current = s;
    }

    boolean isStopped() {
        return stopped;
    }

    @Override
    public void close() {
        stopped = true;
        InputStream s = current;
        if (s != null) {
            try {
                s.close();
            } catch (Exception ignored) {
                // best-effort: closing the stream breaks the blocking read
            }
        }
        if (thread != null) {
            thread.interrupt();
        }
    }
}
