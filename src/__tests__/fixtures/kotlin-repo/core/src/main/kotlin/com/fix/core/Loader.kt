package com.fix.core

interface Refreshable {
    fun refresh()
}

sealed class Shape

data class Circle(val r: Double) : Shape()

object Loader {
    fun warm() {
        lookup()
    }
}

class Registry {
    companion object {
        fun open(): Int = lookup()
    }
}

annotation class Marker

class Widget(val name: String) {
    constructor(n: Int, extra: Int) : this("x") {
        lookup()
    }
}

class Dup

enum class Mode {
    IDLE,
    ACTIVE
}
