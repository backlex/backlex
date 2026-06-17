package com.backlex;

/** A realtime event frame: {@code {"event": ..., "data": {...}}}. */
public class ItemEvent<T> {
    public String event; // "created" | "updated" | "deleted"
    public T data;
}
