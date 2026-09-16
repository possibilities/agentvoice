package com.arthack.agentvoice

/** Main-thread ownership for replaceable Activity work, independent of lifecycle epochs. */
internal class ActivityOperation {
    private var generation = 0L
    fun begin(): Long = ++generation
    fun owns(token: Long): Boolean = token == generation
    fun invalidate() { generation++ }
}
